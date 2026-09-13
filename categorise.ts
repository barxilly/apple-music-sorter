// ---------------------------------------------------------------------------
// Categorise the first N tracks of a playlist and save the result to a file.
//
//   bun run categorise
//
// Bun loads .env automatically. Under plain node use:
//   node --env-file=.env categorise.ts
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import OpenAI from "openai";
import { getPlaylist, type Track } from "./appleMusic.ts";
import { config, parsePlaylist } from "./config.ts";
import {
  addUsage,
  costUsd,
  EMPTY_USAGE,
  formatGbp,
  totalTokens,
  usageFrom,
  usdToGbp,
  type Usage,
} from "./cost.ts";
import { Progress } from "./tui.ts";

// Everything tunable lives in config.ts - nothing below needs editing to point
// this at a different playlist or model.
const { provider } = config;
const OUT_FILE = config.outFile;
const SLOW_REQUEST_MS = config.slowRequestMs;
const BATCH_SIZE = config.batchSize;
const BUCKETS = config.buckets;
const MAX_BUCKETS_PER_SONG = config.maxBucketsPerSong;

/** Buckets are user-defined now, so a bucket is just a string. */
type Bucket = string;

const PLAYLIST = parsePlaylist(config.playlist);
/** `library` = your own playlist (needs the user token); `catalog` = Apple's. */
const PLAYLIST_SOURCE: "library" | "catalog" = config.playlistSource ?? PLAYLIST.source;

/** One line of the model's reply: 1-2 bucket names for a single song. */
type BucketRow = { n?: number; buckets?: string[] };

/**
 * Categorise one batch of tracks. Indices in the reply are local to the batch,
 * so the caller offsets them back into the full playlist.
 */
async function categoriseBatch(
  openai: OpenAI,
  batch: Track[],
): Promise<{ byIndex: Map<number, Bucket[]>; usage: Usage; retried: boolean }> {
  // Number the songs so the reply can refer to them by index. Cheaper and far
  // more reliable than asking the model to echo titles back.
  const list = batch.map((track, i) => `${i + 1}. ${track.artist} - ${track.name}`).join("\n");

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        `You sort songs into mood buckets. Available buckets: ${BUCKETS.join(", ")}. ` +
        `Give each song the ONE bucket that fits it best, judging by how it feels to listen to. ` +
        `A second bucket is the exception, not the rule: add one only when the song is ` +
        `genuinely a strong fit for both, and never more than two. If in doubt, give one. ` +
        `List them best fit first. ` +
        `Reply with JSON only, shaped {"results":[{"n":<number>,"buckets":["<bucket>", ...]}]}.`,
    },
    { role: "user", content: list },
  ];

  /**
   * Everything that stays the same across attempts. Provider-specific knobs
   * ride along in `requestOptions` - the OpenAI SDK forwards unknown body keys
   * untouched, which is how DeepSeek's `thinking` gets through.
   */
  const base = {
    model: provider.model,
    messages,
    ...(provider.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
  };

  const request = (options: Record<string, unknown> | undefined, maxTokens: number) =>
    openai.chat.completions.create({
      ...base,
      max_tokens: maxTokens,
      ...options,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

  let completion = await request(provider.requestOptions, provider.maxTokens);
  let choice = completion.choices?.[0];
  let content = choice?.message?.content;
  let retried = false;

  if (!content) {
    // First attempt came back empty - usually thinking ate the whole budget.
    // Retry with the provider's fallback options (for DeepSeek, thinking off).
    retried = true;
    completion = await request(provider.retryRequestOptions ?? provider.requestOptions, provider.retryMaxTokens);
    choice = completion.choices?.[0];
    content = choice?.message?.content;
  }

  if (!content) {
    const usage = completion.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
    throw new Error(
      `Model returned no content even after retrying (finish_reason=${choice?.finish_reason}). ` +
        `Reasoning used ${usage?.completion_tokens_details?.reasoning_tokens ?? "?"} tokens.`,
    );
  }

  const parsed = JSON.parse(content) as { results?: BucketRow[] };
  if (!Array.isArray(parsed.results) || parsed.results.length === 0) {
    throw new Error(`Model did not return a results array. Got: ${content.slice(0, 200)}`);
  }

  const byIndex = new Map<number, Bucket[]>();
  for (const row of parsed.results) {
    const n = Number(row.n);
    if (!Number.isInteger(n) || n < 1 || n > batch.length) continue;

    // Keep only buckets we know, drop duplicates, and honour the cap - a chatty
    // model shouldn't be able to file a song under everything at once.
    const chosen = (row.buckets ?? [])
      .filter((name): name is Bucket => BUCKETS.includes(name as Bucket))
      .filter((name, i, list) => list.indexOf(name) === i)
      .slice(0, MAX_BUCKETS_PER_SONG);

    if (chosen.length === 0) continue;
    byIndex.set(n, chosen);
  }

  // Fail loudly rather than quietly dropping a song - a missing bucket would
  // silently leave that track out of the sorted playlists later.
  const missing = batch.map((_, i) => i + 1).filter((n) => !byIndex.has(n));
  if (missing.length > 0) {
    throw new Error(`Model skipped ${missing.length} song(s): ${missing.join(", ")}.`);
  }

  return { byIndex, usage: usageFrom(completion.usage), retried };
}

let ui: Progress | undefined;

try {
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : "not-needed";
  if (provider.apiKeyEnv && !apiKey) {
    throw new Error(`Missing ${provider.apiKeyEnv}. Add it to .env, or pick another provider in config.ts.`);
  }

  const tracks = await getPlaylist(PLAYLIST.id, { source: PLAYLIST_SOURCE, limit: config.limit });
  if (tracks.length === 0) throw new Error("Playlist came back empty - nothing to categorise.");

  // Songs with neither id are uploads Apple never matched to the catalog, so
  // they cannot be put into a new playlist at all.
  const unreusable = tracks.filter((track) => !track.libraryId && !track.catalogId).length;
  if (unreusable > 0) console.log(`${unreusable} track(s) have no reusable id and will be skipped.\n`);

  console.log(`Playlist: ${PLAYLIST.id} (${PLAYLIST_SOURCE}), reading ${config.limit} track(s)`);
  console.log(`Provider: ${provider.name} - ${provider.model}`);
  console.log(`Buckets : ${BUCKETS.join(", ")}\n`);

  const openai = new OpenAI({ baseURL: provider.baseURL, apiKey });

  const batchCount = Math.ceil(tracks.length / BATCH_SIZE);

  const now = new Date();
  const pricing = provider.pricing;
  const rates = pricing?.ratesAt(now) ?? null;
  const rateLabel = pricing?.labelAt?.(now) ?? "";
  const { rate: usdGbp, source: fxSource } = await usdToGbp();

  console.log(
    rates
      ? `Pricing: ${provider.model}${rateLabel ? ` (${rateLabel})` : ""} · ` +
          `FX USD→GBP ${usdGbp.toFixed(4)} (${fxSource})\n`
      : `Pricing: none configured for ${provider.name} - cost display hidden\n`,
  );

  ui = new Progress("Categorising", tracks.length).start();

  const byIndex = new Map<number, Bucket[]>();
  let usage: Usage = EMPTY_USAGE;
  let retries = 0;
  let slowRequests = 0;

  for (let offset = 0; offset < tracks.length; offset += BATCH_SIZE) {
    const batch = tracks.slice(offset, offset + BATCH_SIZE);
    const first = batch[0];
    ui.setStatus(
      `batch ${Math.floor(offset / BATCH_SIZE) + 1}/${batchCount} · ${first?.artist ?? ""} - ${first?.name ?? ""}`,
    );

    const requestStartedAt = Date.now();
    const result = await categoriseBatch(openai, batch);
    const requestMs = Date.now() - requestStartedAt;

    if (requestMs > SLOW_REQUEST_MS) {
      slowRequests += 1;
      ui.log(
        `slow request: ${(requestMs / 1000).toFixed(1)}s for ` +
          `"${first?.artist ?? ""} - ${first?.name ?? ""}" (normal is 1-3s)`,
      );
    }

    for (const [localIndex, buckets] of result.byIndex) byIndex.set(offset + localIndex, buckets);
    usage = addUsage(usage, result.usage);
    if (result.retried) retries += 1;

    // Project the final bill from what we've spent so far. Each song costs so
    // little that the estimate settles down quickly - handy before pointing
    // this at a playlist 30x bigger.
    const spent = rates ? costUsd(usage, rates) * usdGbp : 0;
    const fraction = (offset + batch.length) / tracks.length;

    ui.advance(batch.length, {
      tokens: totalTokens(usage),
      ...(rates
        ? { cost: formatGbp(spent), estimate: formatGbp(fraction > 0 ? spent / fraction : spent) }
        : {}),
    });
  }

  ui.succeed();
  ui = undefined;

  const results = tracks.map((track, i) => ({
    name: track.name,
    artist: track.artist,
    album: track.album,
    id: track.id,
    // Both ids are kept: libraryId is the copy you already have, catalogId the
    // catalog equivalent. Re-adding by libraryId is what avoids re-downloads.
    catalogId: track.catalogId,
    libraryId: track.libraryId,
    // ISRC identifies the actual recording, so it settles "is this a different
    // version or just a different album wrapper?" without any guessing.
    isrc: track.isrc,
    durationMs: track.durationMs,
    buckets: byIndex.get(i + 1)!,
  }));

  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        playlist: PLAYLIST.id,
        source: PLAYLIST_SOURCE,
        provider: provider.name,
        model: provider.model,
        requestOptions: provider.requestOptions ?? null,
        retryRequestOptions: provider.retryRequestOptions ?? null,
        retries,
        slowRequests,
        buckets: BUCKETS,
        generatedAt: new Date().toISOString(),
        pricing: rates
          ? {
              label: rateLabel || undefined,
              usdToGbp,
              costUsd: Number(costUsd(usage, rates).toFixed(6)),
              costGbp: Number((costUsd(usage, rates) * usdGbp).toFixed(6)),
              tokens: usage,
            }
          : { usdToGbp, tokens: usage },
        results,
      },
      null,
      2,
    ),
    "utf8",
  );

  for (const bucket of BUCKETS) {
    const group = results.filter((r) => r.buckets.includes(bucket));
    if (group.length === 0) continue;
    console.log(`${bucket} (${group.length})`);
    for (const r of group) console.log(`   ${r.artist} - ${r.name}`);
    console.log();
  }

  const placements = results.reduce((sum, r) => sum + r.buckets.length, 0);
  console.log(`Wrote ${results.length} categorised tracks (${placements} playlist placements) to ${OUT_FILE}.`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // The progress display owns its own teardown, so let it report if it's live.
  if (ui) ui.fail(message);
  else console.error(`Categorisation failed: ${message}`);
  process.exit(1);
}
