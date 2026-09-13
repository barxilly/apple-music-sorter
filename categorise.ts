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

const PLAYLIST_ID = "pl.u-Ymb00Bycg9BkmXb";
/** How many tracks to pull off the top of the playlist. */
const LIMIT = 15;
const OUT_FILE = "categorised.json";

/** The buckets songs get sorted into. Edit this list to change the scheme. */
const BUCKETS = ["energetic", "calm", "sad", "happy"] as const;
type Bucket = (typeof BUCKETS)[number];

const MODEL = "deepseek-flash";

/**
 * deepseek-flash is a REASONING model: it spends tokens thinking before it
 * writes the answer. A small cap leaves `message.content` empty, so keep this
 * roomy - a handful of songs costs a few hundred reasoning tokens.
 */
const MAX_TOKENS = 4000;

type BucketRow = { n?: number; bucket?: string };

async function categorise(tracks: Track[]): Promise<Map<number, Bucket>> {
  const openai = new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
  });

  // Number the songs so the reply can refer to them by index. Cheaper and far
  // more reliable than asking the model to echo titles back.
  const list = tracks.map((track, i) => `${i + 1}. ${track.artist} - ${track.name}`).join("\n");

  const completion = await openai.chat.completions.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You sort songs into mood buckets. Available buckets: ${BUCKETS.join(", ")}. ` +
          `Pick the single best bucket for each song, judging by how it feels to listen to. ` +
          `Reply with JSON only, shaped {"results":[{"n":<number>,"bucket":"<bucket>"}]}.`,
      },
      { role: "user", content: list },
    ],
  });

  const choice = completion.choices?.[0];
  const content = choice?.message?.content;

  if (!content) {
    const usage = completion.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
    throw new Error(
      `Model returned no content (finish_reason=${choice?.finish_reason}). ` +
        `If that was "length", raise MAX_TOKENS - reasoning alone used ` +
        `${usage?.completion_tokens_details?.reasoning_tokens ?? "?"} tokens.`,
    );
  }

  const parsed = JSON.parse(content) as { results?: BucketRow[] };
  if (!Array.isArray(parsed.results) || parsed.results.length === 0) {
    throw new Error(`Model did not return a results array. Got: ${content.slice(0, 200)}`);
  }

  const byIndex = new Map<number, Bucket>();
  for (const row of parsed.results) {
    const n = Number(row.n);
    if (!Number.isInteger(n) || n < 1 || n > tracks.length) continue;
    if (!BUCKETS.includes(row.bucket as Bucket)) continue;
    byIndex.set(n, row.bucket as Bucket);
  }

  // Fail loudly rather than quietly dropping a song - a missing bucket would
  // silently leave that track out of the sorted playlists later.
  const missing = tracks.map((_, i) => i + 1).filter((n) => !byIndex.has(n));
  if (missing.length > 0) {
    throw new Error(`Model skipped ${missing.length} song(s): ${missing.join(", ")}.`);
  }

  return byIndex;
}

try {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("Missing DEEPSEEK_API_KEY.");

  const tracks = await getPlaylist(PLAYLIST_ID, { source: "catalog", limit: LIMIT });
  if (tracks.length === 0) throw new Error("Playlist came back empty - nothing to categorise.");

  console.log(`Categorising ${tracks.length} tracks into: ${BUCKETS.join(", ")}\n`);

  const byIndex = await categorise(tracks);

  const results = tracks.map((track, i) => ({
    name: track.name,
    artist: track.artist,
    album: track.album,
    id: track.id,
    durationMs: track.durationMs,
    bucket: byIndex.get(i + 1)!,
  }));

  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        playlist: PLAYLIST_ID,
        model: MODEL,
        buckets: BUCKETS,
        generatedAt: new Date().toISOString(),
        results,
      },
      null,
      2,
    ),
    "utf8",
  );

  for (const bucket of BUCKETS) {
    const group = results.filter((r) => r.bucket === bucket);
    if (group.length === 0) continue;
    console.log(`${bucket} (${group.length})`);
    for (const r of group) console.log(`   ${r.artist} - ${r.name}`);
    console.log();
  }

  console.log(`Wrote ${results.length} categorised tracks to ${OUT_FILE}.`);
} catch (err) {
  console.error(`Categorisation failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
