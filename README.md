# apple-music-sorter

> [!IMPORTANT]
> This code is almost-entirely AI generated, I don't take credit for it, nor do I recommend blind usage.

Takes one big Apple Music playlist, asks DeepSeek to sort each track into mood
buckets, then creates one playlist per bucket in your library.

## How it works

```
your library playlist  (p.xxxx)
        |  getPlaylist()                appleMusic.ts
        v
your tracks
        |  DeepSeek, one song per request   categorise.ts
        v
categorised.json  (bucket(s) + catalog/library ids + isrc per track)
        |  makePlaylist()                playlists.ts
        v
energetic / chill / sad / cunty / nostalgic
```

Three separate steps on purpose: categorising costs money, creating playlists
doesn't. You can re-run the cheap half as often as you like.

## Requirements

- [Bun](https://bun.com) (Node 22+ also works, see [Running under Node](#running-under-node))
- An Apple Music subscription
- An Apple Developer account (the free tier is fine) to create a MusicKit key
- A DeepSeek API key

## Setup

### 1. Dependencies

```bash
bun install
```

### 2. Apple Music credentials

You need **two** tokens. You generate the developer token yourself; the user
token has to come out of a browser.

**a. Developer token.** In the Apple Developer portal create a Key with
*MusicKit* enabled and download the `.p8` — you only get one chance to download
it. Then set:

| Variable | Where to find it |
|---|---|
| `APPLE_TEAM_ID` | Membership details — a 10-character team id |
| `APPLE_KEY_ID` | The Key ID of the MusicKit key |
| `APPLE_PRIVATE_KEY_PATH` | Path to the `.p8` you just saved |

(Alternatively put the whole key in `APPLE_PRIVATE_KEY`; `\n` escapes are
accepted.)

**b. User token.** Apple only issues one to MusicKit JS running in a real
browser, so there is no headless option:

```bash
bun run token --serve
```

Open <http://localhost:8899>, click **Authorize**, sign in, and paste the value
it prints into `.env`. Without `--serve` the script just writes
`music-token.html` for you to host yourself — `file://` tends to break Apple's
sign-in popup. If your Bun swallows the flag, the same thing works as
`SERVE=1 bun run token`.

> Do **not** run this snippet in the console on music.apple.com. That page has
already configured MusicKit with Apple's own developer token, so you get a token
bound to *Apple's* app and every request you make fails with
`403 Invalid authentication`.

User tokens last a few months. When one expires every call returns 403.

### 3. Environment

`.env` is git-ignored. Everything the code reads:

```dotenv
# --- required ---
DEEPSEEK_API_KEY=sk-...
APPLE_TEAM_ID=XXXXXXXXXX
APPLE_KEY_ID=XXXXXXXXXX
APPLE_PRIVATE_KEY_PATH=./AuthKey_XXXXXXXXXX.p8
APPLE_MUSIC_USER_TOKEN=...

# --- optional ---
APPLE_STOREFRONT=gb                    # default "us"; only affects catalog reads
SEARXNG_URL=http://localhost:8888      # only used by index.ts
# TAVILY_API_KEY=...
# BRAVE_API_KEY=...
```

Missing required values fail immediately with a message naming the variable.

## Usage

```bash
bun run categorise           # read the playlist, bucket every song, write categorised.json
bun run playlists --dry      # show what would be created, touch nothing
bun run playlists            # create the playlists, then verify them
bun run playlists --verify   # re-check existing playlists against categorised.json
bun run playlists --force    # create even when a playlist of that name exists
```

Every flag also works as an environment variable: `DRY=1`, `VERIFY=1`,
`FORCE=1`. `--dry` and `--verify` are read-only.

A typical run:

```bash
bun run categorise
bun run playlists --dry     # sanity-check the sizes first
bun run playlists
```

## Config

**Everything tunable lives in `config.ts`.** Nothing else needs editing to point
this at a different playlist or model.

```ts
export const config: Config = {
  playlist: "p.3VKWW2eCb7Eql41",   // share link or bare id
  limit: 1241,                     // tracks to read off the top
  buckets: ["energetic", "chill", "sad", "cunty", "nostalgic"],
  maxBucketsPerSong: 2,
  batchSize: 1,                    // see the warning in the file
  outFile: "categorised.json",
  slowRequestMs: 15_000,
  provider: PROVIDERS.deepseek,
};
```

| Setting | Notes |
|---|---|
| `playlist` | Paste the whole share link **or** just the id. `pl.` = catalog/shared, `p.` = your library |
| `playlistSource` | Optional. Only set it if the id prefix guesses wrong |
| `limit` | How many tracks to read off the top |
| `buckets` | Your categories — used verbatim as playlist names |
| `maxBucketsPerSong` | Up to two means a song can appear in two playlists |
| `batchSize` | Leave at `1`; see below |
| `outFile` | Where categorising writes its intermediate results |
| `provider` | Which model to use |

### Trial runs without editing anything

`limit`, `batchSize` and `outFile` can be overridden per run:

```bash
LIMIT=5 bun run categorise
OUT_FILE=/tmp/trial.json LIMIT=5 bun run categorise   # keeps your real results
```

### Using a different model

Anything OpenAI-compatible works. Presets are in `PROVIDERS`:

```ts
provider: PROVIDERS.openai,     // needs OPENAI_API_KEY
provider: PROVIDERS.openrouter, // needs OPENROUTER_API_KEY
provider: PROVIDERS.ollama,     // local, free, no key
```

Or define your own:

```ts
provider: {
  name: "Groq",
  baseURL: "https://api.groq.com/openai/v1",
  apiKeyEnv: "GROQ_API_KEY",
  model: "llama-3.3-70b-versatile",
  maxTokens: 2000,
  retryMaxTokens: 4000,
  jsonMode: true,
},
```

Two things to keep in step with your choice:

- **`requestOptions`** are merged into every request body, which is how
  provider-specific knobs get through (`thinking`, `reasoning_effort`, `tools`).
  A plain non-reasoning model wants this left off entirely.
- **`retryRequestOptions`** *replaces* `requestOptions` on the retry, rather
  than merging — so repeat anything you still need there.

`pricing` is optional. Give it a `ratesAt(at)` function and the display shows
live cost; leave it out and the cost columns simply disappear rather than
showing a wrong number.

### Keep the playlist in your library

Library tracks carry a `libraryId`, and the generated playlists are built with
it, so they reference the copies you **already have**. If you read the catalog
copy instead you get catalog ids, which Apple re-resolves when adding — that can
match a different release and make you download a song you already own.

### Bucket wording matters

With wording like "give 1 or 2 buckets", the model returned two for *every*
song, which would leave each playlist holding ~40% of the library. The current
prompt asks for one bucket, with a second as the exception. If your playlists
come out too large, that instruction is the knob to turn.

`buckets` entries become playlist names, so pick names you're happy to see in
your library.

## Cost

The TUI shows live spend and a projected total (`est`) in GBP, converted at a
rate fetched from exchangerate-api (falling back to frankfurter, then a
hardcoded constant).

`deepseek-flash` pricing, USD per 1M tokens:

| | cache hit | cache miss | output |
|---|---|---|---|
| peak | $0.006 | $0.30 | $1.20 |
| off-peak | $0.003 | $0.15 | $0.60 |

Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday; everything else (and all
weekend) is off-peak, at exactly half price. Cache hits are **50× cheaper** than
misses, so `cost.ts` tracks them separately rather than lumping all input
together.

For scale, 100 songs costs roughly **£0.01–0.02** and the full ~1240-track
playlist about **£0.15–0.25**. Reasoning tokens are billed as output tokens and
are already included.

## Thinking mode

`deepseek-flash` is a reasoning model: it emits a chain of thought before the
answer, and that thinking is billed at output rates. The default provider is
configured to keep it at `reasoning_effort: "low"`, via `requestOptions` in
`config.ts`.

Sometimes it thinks so long that it spends the entire token budget and returns
**empty content**. When that happens the script retries the same request with
`retryRequestOptions` (for DeepSeek: thinking switched off) and a larger
`retryMaxTokens`. The run only fails if both attempts come back empty.

This is why raising `batchSize` backfires: several songs' worth of reasoning
still has to fit inside one reply cap, so a large batch starts failing and
retrying rather than saving anything.

## The progress display

```
⠴ Categorising ██████████████████░░░░░░░░ 72/100  72%
   31.2s │  2.3/s · 0.43s/song │ £0.00214 │ est £0.00297 │ 1.4k tok │ ▁▃▄▆█ │ batch 72/100 · ABBA - Waterloo
✔ Categorising 100/100 in 43.1s  (2.32 songs/s · 0.43 s/song · 1.9k tok · £0.00297)
```

Spinner, bar, throughput both ways, ETA, token count, running spend, projected
total, a sparkline of recent throughput and the current track. It draws to
stderr so stdout stays pipeable, and degrades to plain lines when not attached
to a terminal. Set `NO_COLOR=1` to disable colour.

## Files

| File | Role |
|---|---|
| `config.ts` | **Your settings** — playlist, buckets, batch size, model/provider, pricing |
| `appleMusic.ts` | Apple Music REST client: `getPlaylist`, `makePlaylist`, `listLibraryPlaylists`, developer-token JWT |
| `categorise.ts` | Reads the playlist, buckets each song with DeepSeek, writes `categorised.json` |
| `playlists.ts` | Reads `categorised.json`, creates and verifies one playlist per bucket |
| `cost.ts` | DeepSeek prices, peak/off-peak logic, USD→GBP, usage parsing |
| `tui.ts` | Dependency-free progress display |
| `getUserToken.ts` | Generates the page that mints `APPLE_MUSIC_USER_TOKEN` |
| `index.ts`, `webTool.ts` | The original experiment: mood classification with a `web_search` tool |

## Known limitations

**Playlists cannot be deleted through the API.**
`DELETE /v1/me/library/playlists/{id}` returns `401` with an empty body even
with a valid token (a `GET` on the same id returns `200`). So test runs leave
permanent playlists, and `--force` creates duplicates you'll have to remove by
hand in the Music app. This is why the default behaviour is to *skip* a bucket
whose playlist already exists.

**Uploaded tracks can't be re-added.** Songs Apple never matched to the catalog
have no `catalogId` and no `libraryId`. They're counted and reported as
`unusable` rather than silently dropped.

**Results aren't perfectly reproducible.** Bucket assignments can shift between
runs, especially for tracks that sit between two moods.

**A run is only as good as the `libraryId`.** If the playlist isn't in your
library (a `catalog` source), the fallback path re-resolves by catalog id and
can hit the re-download problem described above.

**`index.ts` imports `dotenv`**, which isn't a declared dependency. Bun loads
`.env` automatically, so that import is redundant — remove it if a clean
install fails to resolve it.

### Running under Node

Bun is assumed throughout. Under Node 22+ you can use the built-in type
stripping and env loading instead:

```bash
node --env-file=.env categorise.ts
node --env-file=.env playlists.ts --dry
```

Node's strip-only mode can't run class *parameter properties* — that's why
`tui.ts` declares its fields longhand.

## Search backend (SearXNG)

The script gives the model a `web_search` tool. It prefers a self-hosted
[SearXNG](https://docs.searxng.org/) instance and falls back down a chain of
providers when that isn't available:

```
searxng  ->  tavily  ->  brave  ->  duckduckgo  ->  wikipedia
(you)        (key)      (key)      (scraped)       (keyless)
```

Start it:

```bash
docker compose up -d
```

It listens on **http://localhost:8888**, bound to `127.0.0.1` only. Point
`SEARXNG_URL` elsewhere if you host it on another machine.

Two settings in `searxng/settings.yml` matter, and the code fails loudly if
either is wrong:

- `search.formats` **must** include `json` — it's off by default, and
  `?format=json` returns a 403 without it.
- `server.limiter` **must** be `false` — the limiter treats server-side callers
  as suspicious and blocks them.

Optional API keys go in `.env` — see the [Environment](#3-environment)
section; any provider without a key is skipped.

## Design note

Providers **throw** on failure rather than returning an empty list. This is
deliberate: an empty result set reads to the model as "this song doesn't exist",
and it responds by hallucinating. A `search_unavailable` error tells it to admit
it couldn't verify instead. DuckDuckGo is the clearest example — when it
rate-limits an IP it serves a CAPTCHA challenge page, which is very easy to
mistake for "no results".

---

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
