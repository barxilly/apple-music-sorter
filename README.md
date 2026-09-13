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

All tuning lives in the constants at the top of `categorise.ts`.

| Constant | Default | Notes |
|---|---|---|
| `PLAYLIST_ID` | `p.3VKWW2eCb7Eql41` | The tail of the playlist's share URL. `p.` = your library, `pl.` = catalog/shared |
| `PLAYLIST_SOURCE` | `"library"` | `library` = your playlist (needs the user token), `catalog` = Apple's |
| `LIMIT` | `1241` | How many tracks to read off the top |
| `BUCKETS` | 5 moods | Also used verbatim as playlist names |
| `MAX_BUCKETS_PER_SONG` | `2` | Up to two categories per song |
| `BATCH_SIZE` | `1` | Songs per model request |
| `MODEL` | `deepseek-flash` | |
| `MAX_TOKENS` / `RETRY_MAX_TOKENS` | `2000` / `16000` | See [Thinking mode](#thinking-mode) |
| `OUT_FILE` | `categorised.json` | Intermediate results |

### Keep `PLAYLIST_SOURCE` as `"library"`

Library tracks carry a `libraryId`, and the generated playlists are built with
it, so they reference the copies you **already have**. If you read the catalog
copy instead you get catalog ids, which Apple re-resolves when adding — that can
match a different release and make you download a song you already own.

### Bucket wording matters

With wording like "give 1 or 2 buckets", the model returned two for *every*
song, which would leave each playlist holding ~40% of the library. The current
prompt asks for one bucket, with a second as the exception. If your playlists
come out too large, that instruction is the knob to turn.

`BUCKETS` entries become playlist names, so pick names you're happy to see in
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
answer, and that thinking is billed at output rates. Categorising is left at
`reasoning_effort: "low"`.

Sometimes it thinks so long that it spends the entire `MAX_TOKENS` budget and
returns **empty content**. When that happens the script retries the exact same
request with thinking switched off (`RETRY_MAX_TOKENS`), keeping the messages,
JSON schema and tools untouched. The run only fails if both attempts come back
empty.

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
