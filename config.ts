// ---------------------------------------------------------------------------
// Everything you're likely to want to change, in one place.
//
// Nothing secret lives here - API keys still come from .env, named by
// `provider.apiKeyEnv` below.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";

/** USD per 1M tokens. */
export type Rates = { input: number; cachedInput: number; output: number };

export type Pricing = {
  /** Which rates apply right now. */
  ratesAt: (at: Date) => Rates;
  /** Optional short label for the current rates, e.g. "peak". */
  labelAt?: (at: Date) => string;
};

/**
 * Any OpenAI-compatible endpoint. DeepSeek is the default because it is cheap
 * and its reasoning helps with genuinely ambiguous tracks.
 */
export type Provider = {
  /** Display name only. */
  name: string;
  baseURL: string;
  /** Env var holding the API key. Omit for servers that don't need one. */
  apiKeyEnv?: string;
  model: string;
  /** Reply cap. Must leave room for reasoning when thinking is enabled. */
  maxTokens: number;
  /** Reply cap for the retry attempt. */
  retryMaxTokens: number;
  /**
   * Extra body fields merged into every request. This is where provider
   * specific knobs go - DeepSeek's `thinking` and `reasoning_effort`, for
   * example. The OpenAI SDK forwards unknown keys as-is.
   */
  requestOptions?: Record<string, unknown>;
  /** Replaces `requestOptions` on the retry, e.g. to switch thinking off.
   *  Repeat anything you still need (tools, extra params) - it's a replacement,
   *  not a merge. */
  retryRequestOptions?: Record<string, unknown>;
  /** Send `response_format: { type: "json_object" }`. */
  jsonMode?: boolean;
  /** Omit entirely to hide the cost display. */
  pricing?: Pricing;
};

export type Config = {
  /**
   * Your playlist: paste the whole share link, or just the id.
   *
   *   pl.xxxx  = Apple's catalog / a shared playlist (developer token only)
   *   p.xxxx   = a playlist in YOUR library (also needs the user token)
   */
  playlist: string;
  /** Only needed if the id prefix guesses wrong. */
  playlistSource?: "library" | "catalog";
  /** How many tracks to read off the top. */
  limit: number;
  /** The categories. These become your playlist names, so name them well. */
  buckets: string[];
  /** How many categories a single song may have. */
  maxBucketsPerSong: number;
  /** Songs per model request. See the note in `config` below. */
  batchSize: number;
  /** Where the intermediate results are written. */
  outFile: string;
  /** Anything slower than this gets called out on the display. */
  slowRequestMs: number;
  provider: Provider;
};

/**
 * Shape of config.json. Every field is optional - the defaults below fill the
 * gaps - but you'll want at least `playlist` and `buckets`.
 */
export type FileConfig = {
  /** A share link or a bare id. `pl.` = catalog, `p.` = your library. */
  playlist?: string;
  /** Only needed if the id prefix guesses wrong. */
  playlistSource?: "library" | "catalog";
  limit?: number;
  buckets?: string[];
  maxBucketsPerSong?: number;
  batchSize?: number;
  outFile?: string;
  slowRequestMs?: number;
  /** A preset name from PROVIDERS below. */
  provider?: string;
  /**
   * Merged over the preset. Shallow, so supplying `requestOptions` replaces the
   * preset's entirely rather than merging key by key.
   */
  providerOverride?: Partial<Provider>;
};

// --- Playlist helpers -------------------------------------------------------

/** Pull the id out of a share link and work out where it lives. */
export function parsePlaylist(input: string): { id: string; source: "library" | "catalog" } {
  const withoutQuery = input.trim().split(/[?#]/)[0] ?? "";
  const candidate = withoutQuery.split("/").filter(Boolean).pop() ?? "";

  if (!/^[a-z]{1,2}\.[A-Za-z0-9._-]+$/i.test(candidate)) {
    throw new Error(
      `Could not find a playlist id in ${JSON.stringify(input)}. ` +
        `Paste the full share link, or the id on its own - it looks like ` +
        `"pl.u-AbC123" (catalog) or "p.AbC123" (your library).`,
    );
  }

  return { id: candidate, source: candidate.startsWith("pl.") ? "catalog" : "library" };
}

// --- Provider presets -------------------------------------------------------

// DeepSeek halves its prices at quiet times: peak is 01:00-04:00 and
// 06:00-10:00 UTC, Monday to Friday. Everything else, and all weekend, is
// off-peak.
const DEEPSEEK_PEAK: Rates = { input: 0.3, cachedInput: 0.006, output: 1.2 };
const DEEPSEEK_OFF_PEAK: Rates = { input: 0.15, cachedInput: 0.003, output: 0.6 };

function deepseekIsPeak(at: Date): boolean {
  const day = at.getUTCDay(); // 0 = Sunday
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export const PROVIDERS: Record<"deepseek" | "openai" | "openrouter" | "ollama", Provider> = {
  deepseek: {
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    model: "deepseek-flash",
    maxTokens: 2000,
    retryMaxTokens: 16000,
    jsonMode: true,
    // `thinking` isn't part of the OpenAI schema, so it rides along as an extra
    // body key. Low effort is enough for a one-word answer.
    requestOptions: { thinking: { type: "enabled" }, reasoning_effort: "low" },
    // Thinking can eat the whole budget and leave no answer. Same request,
    // thinking off.
    retryRequestOptions: { thinking: { type: "disabled" } },
    pricing: {
      ratesAt: (at) => (deepseekIsPeak(at) ? DEEPSEEK_PEAK : DEEPSEEK_OFF_PEAK),
      labelAt: (at) => (deepseekIsPeak(at) ? "peak" : "off-peak"),
    },
  },

  openai: {
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    model: "gpt-4o-mini",
    maxTokens: 2000,
    retryMaxTokens: 4000,
    jsonMode: true,
    // Example of a reasoning model: uses `reasoning_effort` with no
    // DeepSeek-style thinking block.
    // model: "o4-mini", requestOptions: { reasoning_effort: "low" },
  },

  openrouter: {
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    model: "openai/gpt-4o-mini",
    maxTokens: 2000,
    retryMaxTokens: 4000,
    jsonMode: true,
  },

  ollama: {
    name: "Ollama (local, free)",
    baseURL: "http://localhost:11434/v1",
    // No key needed for a local server.
    model: "llama3.1",
    maxTokens: 2000,
    retryMaxTokens: 4000,
    jsonMode: true,
  },
};

// --- Loading config.json ----------------------------------------------------

/**
 * Escape hatch so you can try things without editing config.json, e.g.
 *
 *   LIMIT=5 bun run categorise
 *   OUT_FILE=/tmp/trial.json LIMIT=5 bun run categorise
 *
 * A missing or unparseable value falls back to the file/default value.
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadFile(): FileConfig {
  const path = process.env.CONFIG_FILE ?? "config.json";

  if (!existsSync(path)) {
    throw new Error(
      `No ${path}. Copy config.example.json to ${path} and put your own playlist ` +
        `link and buckets in it. That file is git-ignored - which is exactly where ` +
        `anything personal belongs.`,
    );
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${path} is not valid JSON: ${reason}`);
  }
}

function buildProvider(name: string, override?: Partial<Provider>): Provider {
  const preset = (PROVIDERS as Record<string, Provider | undefined>)[name];

  if (!preset && !override?.baseURL) {
    throw new Error(
      `Unknown provider "${name}". Use one of: ${Object.keys(PROVIDERS).join(", ")} - ` +
        `or add a "providerOverride" with at least a baseURL to define your own.`,
    );
  }

  const merged = { ...preset, ...override } as Provider;
  return { ...merged, name: override?.name ?? preset?.name ?? name };
}

const file = loadFile();

if (!file.playlist) {
  throw new Error(`config.json has no "playlist" - see config.example.json.`);
}

export const config: Config = {
  playlist: file.playlist,
  playlistSource: file.playlistSource,
  limit: envNumber("LIMIT", file.limit ?? 100),
  buckets: file.buckets ?? ["energetic", "calm", "sad"],
  maxBucketsPerSong: file.maxBucketsPerSong ?? 2,
  batchSize: envNumber("BATCH_SIZE", file.batchSize ?? 1),
  outFile: process.env.OUT_FILE ?? file.outFile ?? "categorised.json",
  slowRequestMs: file.slowRequestMs ?? 15_000,
  provider: buildProvider(file.provider ?? "deepseek", file.providerOverride),
};
