// ---------------------------------------------------------------------------
// Apple Music layer.
//
// We talk to the REST API (api.music.apple.com) rather than AppleScript,
// because AppleScript only exists on macOS. This works on Linux.
//
// Same rule as the search layer in webTool.ts: a FAILED request must never look
// like an EMPTY result. An auth failure and a genuinely empty playlist are
// completely different situations, so every non-2xx response throws.
//
// Auth needs two things:
//   - a DEVELOPER token  - a short-lived ES256 JWT we sign ourselves from your
//                          MusicKit private key (no dependencies needed).
//   - a MUSIC-USER-TOKEN  - proves which Apple Music account to act on. This
//                          one has to come from MusicKit JS in a browser; see
//                          the README note / .env example.
// Library playlists need both. Catalog playlists only need the developer token.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

const API = "https://api.music.apple.com";

/** Apple accepts at most 100 entries per write request. */
const MAX_TRACKS_PER_WRITE = 100;

/** Developer tokens may live up to 6 months; refresh a day early to be safe. */
const TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;
const TOKEN_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

// --- Public types ----------------------------------------------------------

/** A track, flattened to the fields the sorter actually cares about. */
export type Track = {
  /**
   * Apple Music **catalog** song id. This is the id you feed back into
   * `makePlaylist`. Falls back to the library id for uploaded/regional tracks
   * that don't exist in the catalog (those cannot be re-added via the API).
   */
  id: string;
  /** Present only for tracks that came out of your library. */
  libraryId?: string;
  name: string;
  artist: string;
  album: string;
  durationMs: number;
  isrc?: string;
};

/**
 * Something `makePlaylist` can add. Either a bare catalog song id, or an object
 * with an `id` (a `Track` from `getPlaylist` satisfies this structurally).
 */
export type SongRef = string | { id: string };

export type GetPlaylistOptions = {
  /**
   * `"library"` (default) = one of *your* playlists, needs the user token.
   * `"catalog"` = an Apple-curated playlist, developer token only.
   */
  source?: "library" | "catalog";
  /** Stop after this many tracks. Default: read the whole playlist. */
  limit?: number;
};

export type MakePlaylistOptions = {
  description?: string;
};

// --- Config ----------------------------------------------------------------

type AppleConfig = {
  teamId: string;
  keyId: string;
  privateKey: string;
  userToken?: string;
  storefront: string;
};

let cachedConfig: AppleConfig | null = null;

function required(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. ${hint}`);
  return value;
}

/** Read + validate the Apple Music credentials from the environment. */
function loadConfig(): AppleConfig {
  if (cachedConfig) return cachedConfig;

  // The key is easiest to point at as a file, but a .env var works too. Env
  // files can't hold real newlines comfortably, so accept escaped "\n" there.
  const keyPath = process.env.APPLE_PRIVATE_KEY_PATH?.trim();
  const privateKey = keyPath
    ? readFileSync(keyPath, "utf8")
    : required("APPLE_PRIVATE_KEY", "Paste your MusicKit .p8 key, or set APPLE_PRIVATE_KEY_PATH.").replace(
        /\\n/g,
        "\n",
      );

  cachedConfig = {
    teamId: required("APPLE_TEAM_ID", "Find it in your Apple Developer account membership page."),
    keyId: required("APPLE_KEY_ID", "The 10-character Key ID of your MusicKit private key."),
    privateKey,
    userToken: process.env.APPLE_MUSIC_USER_TOKEN?.trim() || undefined,
    storefront: (process.env.APPLE_STOREFRONT?.trim() || "us").toLowerCase(),
  };

  return cachedConfig;
}

// --- Developer token (ES256 JWT, hand-rolled) -------------------------------

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strip the PEM armour and decode the DER bytes inside. */
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
}

let cachedDeveloperToken: { value: string; expiresAt: number } | null = null;

/**
 * Build (and cache) the developer token Apple wants in `Authorization: Bearer`.
 * WebCrypto's ECDSA returns the raw r||s pair, which is exactly what JWS ES256
 * expects, so no JWT library is required.
 */
async function developerToken(config: AppleConfig): Promise<string> {
  if (cachedDeveloperToken && Date.now() < cachedDeveloperToken.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return cachedDeveloperToken.value;
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;
  const signingInput = `${base64url(JSON.stringify({ alg: "ES256", kid: config.keyId, typ: "JWT" }))}.${base64url(
    JSON.stringify({ iss: config.teamId, iat: issuedAt, exp: expiresAt }),
  )}`;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(config.privateKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`APPLE_PRIVATE_KEY is not a valid PKCS#8 EC private key (${reason}). Is it the whole .p8 file?`);
  }

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );

  const value = `${signingInput}.${base64url(new Uint8Array(signature))}`;
  cachedDeveloperToken = { value, expiresAt: expiresAt * 1000 };
  return value;
}

/**
 * The signed ES256 developer token for your MusicKit key.
 * Exported so a script can hand it to MusicKit JS in a browser and mint a
 * Music-User-Token (see getUserToken.ts).
 */
export async function getDeveloperToken(): Promise<string> {
  return developerToken(loadConfig());
}

// --- HTTP -------------------------------------------------------------------

type AppleResponse<T> = { data?: T[]; next?: string };

async function appleFetch<T>(
  path: string,
  init: RequestInit & { auth?: "developer" | "user" } = {},
): Promise<AppleResponse<T>> {
  const { auth = "user", ...rest } = init;
  const config = loadConfig();

  const headers = new Headers(rest.headers);
  headers.set("Authorization", `Bearer ${await developerToken(config)}`);

  if (auth === "user") {
    if (!config.userToken) {
      throw new Error(
        "No APPLE_MUSIC_USER_TOKEN set. Library playlists need a Music-User-Token (from MusicKit JS); " +
          "only catalog lookups work without one.",
      );
    }
    headers.set("Music-User-Token", config.userToken);
  }

  const url = path.startsWith("http") ? path : `${API}${path}`;

  let res: Response;
  try {
    res = await fetch(url, { ...rest, headers, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach Apple Music (${reason}).`);
  }

  const method = rest.method ?? "GET";

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Apple Music rejected the credentials (HTTP ${res.status}) on ${method} ${path}. ` +
        `The developer token or Music-User-Token is expired or wrong.`,
    );
  }
  // Apple signals a bad developer token with 400 + "Invalid developer token".
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Apple Music ${method} ${path} failed: HTTP ${res.status}${body ? ` - ${body.slice(0, 300)}` : ""}`);
  }

  if (res.status === 204) return {};

  return (await res.json()) as AppleResponse<T>;
}

// --- Track mapping ----------------------------------------------------------

type RawTrack = {
  id?: string;
  type?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    isrc?: string;
    playParams?: { catalogId?: string; id?: string };
  };
};

function toTrack(item: RawTrack): Track {
  const attributes = item.attributes ?? {};
  const catalogId = attributes.playParams?.catalogId;
  const isLibrary = item.type === "library-songs";

  return {
    id: catalogId ?? item.id ?? "",
    libraryId: isLibrary ? attributes.playParams?.id ?? item.id : undefined,
    name: attributes.name ?? "(unknown track)",
    artist: attributes.artistName ?? "(unknown artist)",
    album: attributes.albumName ?? "",
    durationMs: attributes.durationInMillis ?? 0,
    isrc: attributes.isrc,
  };
}

// --- The two functions you asked for ----------------------------------------

/**
 * Pull every track out of a playlist, following Apple's pagination.
 *
 * Catalog:  getPlaylist("pl.abc123", { source: "catalog" })
 * Library:  getPlaylist("p.abc123")   // needs APPLE_MUSIC_USER_TOKEN
 *
 * An empty array means the playlist really is empty. Anything that went wrong
 * throws instead.
 */
export async function getPlaylist(playlistId: string, options: GetPlaylistOptions = {}): Promise<Track[]> {
  const { source = "library", limit = Infinity } = options;
  if (!playlistId.trim()) throw new Error("getPlaylist needs a playlist id.");

  const config = loadConfig();
  const collection =
    source === "catalog"
      ? `/v1/catalog/${config.storefront}/playlists/${playlistId.trim()}`
      : `/v1/me/library/playlists/${playlistId.trim()}`;

  const tracks: Track[] = [];
  const pending: string[] = [`${collection}/tracks?limit=${MAX_TRACKS_PER_WRITE}`];

  while (pending.length > 0 && tracks.length < limit) {
    const path = pending.shift();
    if (!path) break;

    const page = await appleFetch<RawTrack>(path, {
      auth: source === "catalog" ? "developer" : "user",
    });

    for (const item of page.data ?? []) {
      tracks.push(toTrack(item));
      if (tracks.length >= limit) break;
    }

    // Apple hands back the path for the next page; follow it until it stops.
    if (page.next) pending.push(page.next);
  }

  return tracks;
}

/**
 * Create a new playlist in your library containing the given songs, in order.
 *
 *   const tracks = await getPlaylist("p.big");
 *   await makePlaylist("Chilled", tracks.filter((t) => t.tempo < 100));
 *
 * Songs are catalog entries (`{ id }` or a `Track`). Playlists longer than 100
 * tracks are created in one go and topped up in batches.
 */
export async function makePlaylist(
  name: string,
  songs: SongRef[],
  options: MakePlaylistOptions = {},
): Promise<{ id: string; name: string; trackCount: number }> {
  const playlistName = name.trim();
  if (!playlistName) throw new Error("makePlaylist needs a playlist name.");
  if (songs.length === 0) throw new Error("makePlaylist needs at least one song.");

  const refs = songs.map((song) => {
    const id = (typeof song === "string" ? song : song.id).trim();
    if (!id) throw new Error("makePlaylist received a song with no id.");
    return { id, type: "songs" as const };
  });

  const created = await appleFetch<{ id?: string; attributes?: { name?: string } }>("/v1/me/library/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attributes: { name: playlistName, description: options.description ?? "" },
      relationships: { tracks: { data: refs.slice(0, MAX_TRACKS_PER_WRITE) } },
    }),
  });

  const playlist = created.data?.[0];
  if (!playlist?.id) {
    throw new Error("Apple Music accepted the request but returned no playlist id.");
  }

  for (let offset = MAX_TRACKS_PER_WRITE; offset < refs.length; offset += MAX_TRACKS_PER_WRITE) {
    await appleFetch(`/v1/me/library/playlists/${playlist.id}/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: refs.slice(offset, offset + MAX_TRACKS_PER_WRITE) }),
    });
  }

  return { id: playlist.id, name: playlist.attributes?.name ?? playlistName, trackCount: refs.length };
}
