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
import {
  addUsage,
  costUsd,
  EMPTY_USAGE,
  formatGbp,
  isPeak,
  totalTokens,
  usageFrom,
  usdToGbp,
  type Usage,
} from "./cost.ts";
import { Progress } from "./tui.ts";

/**
 * Your LIBRARY playlist - not the catalog/shared copy. Library entries carry a
 * libraryId, and that is what lets the generated playlists point at the copies
 * you already have, instead of letting Apple re-match each song.
 */
const PLAYLIST_ID = "p.3VKWW2eCb7Eql41";
/** `library` = your own playlist (needs the user token); `catalog` = Apple's. */
const PLAYLIST_SOURCE: "library" | "catalog" = "library";
/** How many tracks to pull off the top of the playlist. */
const LIMIT = 1241;
const OUT_FILE = "categorised.json";

/**
 * Songs per request. Small enough that the bar actually moves and that a bad
 * reply only costs one chunk, large enough to stay cheap.
 */
const BATCH_SIZE = 1;

/** The buckets songs get sorted into. Edit this list to change the scheme. */
const BUCKETS = ["energetic", "chill", "sad", "cunty", "nostalgic"] as const;
type Bucket = (typeof BUCKETS)[number];

/** A song may be filed under at most this many buckets. */
const MAX_BUCKETS_PER_SONG = 2;

const MODEL = "deepseek-flash";

/**
 * Thinking is ON at LOW effort: enough reasoning to help with genuinely
 * ambiguous tracks, without the runaway token burn of the default high effort.
 * A one-song answer is tiny, so 2000 tokens is roomy.
 */
const MAX_TOKENS = 2000;

/**
 * Safety net. If thinking overruns the budget it can leave `content` empty -
 * the whole budget spent on reasoning and no answer. When that happens we
 * retry the same request with thinking switched off.
 */
const RETRY_MAX_TOKENS = 16000;

/**
 * Bucketing a song needs no tool calls - the model already knows what ABBA
 * sounds like, and a web search per track would be slow and pointless. Kept as
 * an explicit slot so the retry keeps whatever this becomes instead of silently
 * dropping it.
 */
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = undefined;

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
   * Everything except the thinking settings, so the retry varies ONLY those -
   * messages, JSON schema and `tools` all stay exactly as they were.
   */
  const shared = {
    model: MODEL,
    response_format: { type: "json_object" as const },
    messages,
    tools: TOOLS,
  };

  const request = (
    thinking: { type: "enabled" | "disabled" },
    maxTokens: number,
    effort?: "low" | "high" | "max",
  ) =>
    openai.chat.completions.create({
      ...shared,
      max_tokens: maxTokens,
      // `thinking` is not part of the OpenAI schema, so the SDK has no typed
      // field for it and it rides along as an extra body key.
      thinking,
      reasoning_effort: effort,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

  let completion = await request({ type: "enabled" }, MAX_TOKENS, "low");
  let choice = completion.choices?.[0];
  let content = choice?.message?.content;
  let retried = false;

  if (!content) {
    // Thinking ate the budget and left no room for the answer. Same request,
    // thinking off, tools intact.
    retried = true;
    completion = await request({ type: "disabled" }, RETRY_MAX_TOKENS);
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
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("Missing DEEPSEEK_API_KEY.");

  const tracks = await getPlaylist(PLAYLIST_ID, { source: PLAYLIST_SOURCE, limit: LIMIT });
  if (tracks.length === 0) throw new Error("Playlist came back empty - nothing to categorise.");

  // Songs with neither id are uploads Apple never matched to the catalog, so
  // they cannot be put into a new playlist at all.
  const unreusable = tracks.filter((track) => !track.libraryId && !track.catalogId).length;
  if (unreusable > 0) console.log(`${unreusable} track(s) have no reusable id and will be skipped.\n`);

  console.log(`Buckets: ${BUCKETS.join(", ")}\n`);

  const openai = new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
  });

  const batchCount = Math.ceil(tracks.length / BATCH_SIZE);

  const { rate: usdGbp, source: fxSource } = await usdToGbp();
  console.log(
    `Pricing: deepseek-flash ${isPeak() ? "PEAK" : "off-peak"} · ` +
      `FX USD→GBP ${usdGbp.toFixed(4)} (${fxSource})\n`,
  );

  ui = new Progress("Categorising", tracks.length).start();

  const byIndex = new Map<number, Bucket[]>();
  let usage: Usage = EMPTY_USAGE;
  let retries = 0;

  for (let offset = 0; offset < tracks.length; offset += BATCH_SIZE) {
    const batch = tracks.slice(offset, offset + BATCH_SIZE);
    const first = batch[0];
    ui.setStatus(
      `batch ${Math.floor(offset / BATCH_SIZE) + 1}/${batchCount} · ${first?.artist ?? ""} - ${first?.name ?? ""}`,
    );

    const result = await categoriseBatch(openai, batch);
    for (const [localIndex, buckets] of result.byIndex) byIndex.set(offset + localIndex, buckets);
    usage = addUsage(usage, result.usage);
    if (result.retried) retries += 1;

    // Project the final bill from what we've spent so far. Each song costs so
    // little that the estimate settles down quickly - handy before pointing
    // this at a playlist 30x bigger.
    const spent = costUsd(usage) * usdGbp;
    const fraction = (offset + batch.length) / tracks.length;

    ui.advance(batch.length, {
      tokens: totalTokens(usage),
      cost: formatGbp(spent),
      estimate: formatGbp(fraction > 0 ? spent / fraction : spent),
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
        playlist: PLAYLIST_ID,
        source: PLAYLIST_SOURCE,
        model: MODEL,
        thinking: "low effort (retry: disabled)",
        retries,
        buckets: BUCKETS,
        generatedAt: new Date().toISOString(),
        pricing: {
          peak: isPeak(),
          usdToGbp,
          costUsd: Number(costUsd(usage).toFixed(6)),
          costGbp: Number((costUsd(usage) * usdGbp).toFixed(6)),
          tokens: usage,
        },
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
