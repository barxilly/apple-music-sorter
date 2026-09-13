// ---------------------------------------------------------------------------
// Everything you're likely to want to change, in one place.
//
// Nothing secret lives here - API keys still come from .env, named by
// `provider.apiKeyEnv` below.
// ---------------------------------------------------------------------------

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

// --- Your settings ----------------------------------------------------------

/**
 * Escape hatch so you can try things without editing this file, e.g.
 *
 *   LIMIT=5 bun run categorise
 *   OUT_FILE=/tmp/trial.json LIMIT=5 bun run categorise
 *
 * A missing or unparseable value falls back to the default.
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config: Config = {
  // Paste a share link or a bare id.
  playlist: "p.3VKWW2eCb7Eql41",
  limit: envNumber("LIMIT", 1241),

  buckets: ["energetic", "chill", "sad", "cunty", "nostalgic"],
  maxBucketsPerSong: 2,

  /**
   * Leave this at 1. Batching looks like it should save money, but reasoning is
   * charged per SONG, not per request, so a bigger batch costs about the same
   * while adding prompt tokens back on top. Worse, a 5-song batch needs roughly
   * the whole token cap just to think, so requests start failing and retrying -
   * which is measurably slower AND more expensive. Measured over 20 songs:
   * batch 1 = 56s and ~£0.00019/song; batch 5 = 79s and noticeably more.
   */
  batchSize: envNumber("BATCH_SIZE", 1),

  /** Where the intermediate results go. Override with OUT_FILE=... */
  outFile: process.env.OUT_FILE ?? "categorised.json",
  slowRequestMs: 15_000,

  /**
   * Swap for PROVIDERS.openai, PROVIDERS.openrouter, PROVIDERS.ollama, or your
   * own object. Keep `model` and `requestOptions` in step with your choice -
   * a non-reasoning model wants `requestOptions` removed.
   */
  provider: PROVIDERS.deepseek,
};
