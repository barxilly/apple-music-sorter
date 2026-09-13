// ---------------------------------------------------------------------------
// Turn a categorised.json into one Apple Music playlist per bucket.
//
//   bun run playlists           # create the playlists, then verify them
//   bun run playlists --dry     # show what it would do, create nothing
//   bun run playlists --verify  # check existing playlists against categorised.json
//   bun run playlists --force   # create even if a playlist of that name exists
//
// Deliberately separate from categorise.ts: categorising costs model tokens,
// creating playlists costs nothing. Keeping them apart means you can re-run
// this as often as you like while iterating on names or grouping.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { getPlaylist, listLibraryPlaylists, makePlaylist, type SongRef } from "./appleMusic.ts";
import { config } from "./config.ts";

// Kept in step with categorise.ts through config.ts.
const IN_FILE = config.outFile;

type CategorisedTrack = {
  name: string;
  artist: string;
  id: string;
  catalogId?: string;
  libraryId?: string;
  /** The 1-2 buckets this song belongs to. */
  buckets?: string[];
  /** Older files stored a single bucket; still read so they keep working. */
  bucket?: string;
};
type CategorisedFile = { playlist?: string; buckets?: string[]; results?: CategorisedTrack[] };

/** One track queued for a playlist, with the id we'll match it on. */
type Planned = { key: string; label: string; ref: SongRef };

const args = process.argv.slice(2);
const DRY = args.includes("--dry") || process.env.DRY === "1";
const FORCE = args.includes("--force") || process.env.FORCE === "1";
const VERIFY = args.includes("--verify") || process.env.VERIFY === "1";

/**
 * Read a playlist back and check it holds exactly the catalog ids we sent.
 *
 * Apple matches an added song against your library, so a track can come back
 * pointing at a DIFFERENT catalog entry for the same recording - the classic
 * "wrong version" symptom. This turns that into something you can see rather
 * than something you have to suspect.
 */
async function verifyPlaylist(playlistId: string, expected: Planned[]): Promise<void> {
  const actual = await getPlaylist(playlistId);

  // Match on either id kind: a matched library entry exposes both.
  const present = new Set<string>();
  for (const track of actual) {
    if (track.libraryId) present.add(track.libraryId);
    if (track.catalogId) present.add(track.catalogId);
    if (track.id) present.add(track.id);
  }

  const missed = expected.filter((entry) => !present.has(entry.key));

  if (missed.length === 0) {
    console.log(`   ok - all ${expected.length} tracks are present in the playlist`);
    return;
  }

  console.log(`   MISMATCH - ${expected.length - missed.length}/${expected.length} of the tracks we sent are present:`);
  for (const entry of missed.slice(0, 8)) {
    console.log(`      missing ${entry.key}  ${entry.label}  (sent as ${entry.ref.type ?? "songs"})`);
  }
}

try {
  const data = JSON.parse(readFileSync(IN_FILE, "utf8")) as CategorisedFile;
  const results = data.results ?? [];
  if (results.length === 0) throw new Error(`${IN_FILE} has no results - run the categoriser first.`);

  // Preserve the bucket order the categoriser used rather than whatever order
  // the JSON happened to serialise them in.
  const buckets = data.buckets?.length
    ? data.buckets
    : [...new Set(results.flatMap((track) => track.buckets ?? (track.bucket ? [track.bucket] : [])))];

  const groups = new Map<string, Planned[]>();
  let unusable = 0;

  for (const track of results) {
    const label = `${track.artist} - ${track.name}`;

    // Prefer the library id: it points at the copy already in your library, so
    // Apple doesn't re-match the song to another release and make you download
    // something you already have.
    let planned: Planned | undefined;
    if (track.libraryId) {
      planned = { key: track.libraryId, label, ref: { id: track.libraryId, type: "library-songs" } };
    } else if (track.catalogId) {
      planned = { key: track.catalogId, label, ref: { id: track.catalogId, type: "songs" } };
    } else if (track.id) {
      planned = { key: track.id, label, ref: { id: track.id, type: "songs" } };
    }

    if (!planned) {
      unusable += 1;
      continue;
    }

    // A song with two categories goes into both playlists. It's the same
    // library item either way, so it's still just one download.
    const songBuckets = track.buckets ?? (track.bucket ? [track.bucket] : []);
    for (const name of songBuckets) {
      const existingGroup = groups.get(name);
      if (existingGroup) existingGroup.push(planned);
      else groups.set(name, [planned]);
    }
  }

  const all = [...groups.values()].flat();
  const viaLibrary = all.filter((entry) => entry.ref.type === "library-songs").length;

  // Read-only, so it's safe to do even in a dry run - the point is to catch
  // duplicates before they happen.
  const taken = new Map<string, string>();
  for (const playlist of await listLibraryPlaylists()) {
    taken.set(playlist.name.toLowerCase(), playlist.id);
  }

  const origin = data.playlist ? ` from ${data.playlist}` : "";
  console.log(`${results.length} categorised tracks${origin} -> ${groups.size} playlist(s)`);
  console.log(
    `${all.length} placements; ${viaLibrary} by library id (your existing copies)` +
      `${all.length - viaLibrary > 0 ? `, ${all.length - viaLibrary} fall back to catalog ids` : ""}` +
      `${unusable > 0 ? `, ${unusable} track(s) unusable` : ""}\n`,
  );

  let created = 0;
  let skipped = 0;

  for (const bucket of buckets) {
    const group = groups.get(bucket) ?? [];
    if (group.length === 0) {
      console.log(`-  ${bucket}: no songs, skipped`);
      continue;
    }

    const clash = taken.get(bucket.toLowerCase());

    if (VERIFY) {
      if (!clash) {
        console.log(`?  ${bucket}: no playlist called "${bucket}" to verify`);
        continue;
      }
      console.log(`?  ${bucket}: verifying "${bucket}" (${clash})`);
      await verifyPlaylist(clash, group);
      continue;
    }

    if (clash && !FORCE) {
      console.log(`=  ${bucket}: a playlist called "${bucket}" already exists (${clash}), skipped`);
      console.log(`   (--verify to check it, or --force to create a second one anyway)`);
      skipped += 1;
      continue;
    }

    if (DRY) {
      console.log(`+  ${bucket}: would create a playlist with ${group.length} track(s)`);
      continue;
    }

    const playlist = await makePlaylist(
      bucket,
      group.map((entry) => entry.ref),
      { description: `Auto-sorted${origin}` },
    );
    console.log(`+  ${bucket}: created "${playlist.name}" with ${playlist.trackCount} track(s) -> ${playlist.id}`);
    await verifyPlaylist(playlist.id, group);
    created += 1;
  }

  console.log(DRY ? "\nDry run - nothing was changed." : `\nDone. ${created} created, ${skipped} skipped.`);
} catch (err) {
  console.error(`Playlist creation failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
