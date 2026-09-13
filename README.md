# apple-music-sorter

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

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

Optional API keys go in `.env`; any provider without a key is skipped:

```
DEEPSEEK_API_KEY=...
SEARXNG_URL=http://localhost:8888
# TAVILY_API_KEY=...
# BRAVE_API_KEY=...
```

## Design note

Providers **throw** on failure rather than returning an empty list. This is
deliberate: an empty result set reads to the model as "this song doesn't exist",
and it responds by hallucinating. A `search_unavailable` error tells it to admit
it couldn't verify instead. DuckDuckGo is the clearest example — when it
rate-limits an IP it serves a CAPTCHA challenge page, which is very easy to
mistake for "no results".

---

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
