

// ---------------------------------------------------------------------------
// Search layer.
//
// Key rule: a FAILED search must never look like an EMPTY search. If we return
// [] when we're rate-limited, the model concludes "no such song exists" and
// falls back to guessing - the exact behaviour we're trying to eliminate.
// So providers throw on failure; "no results" is only reported when a provider
// genuinely answered with nothing.
// ---------------------------------------------------------------------------

const UA = "apple-music-sorter/1.0";

/** Filler words that drag Wikipedia's full-text relevance off-target. */
const WIKI_NOISE = /\b(song|songs|genre|mood|lyrics|meaning|review|reviews|about|info|details|track|tracks)\b/gi;

export type SearchHit = { title: string; url: string; snippet: string };
export type SearchResponse = { provider: string; results: SearchHit[] };

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapUrl(href: string): string {
  const wrapped = href.match(/[?&]uddg=([^&]+)/);
  if (wrapped?.[1]) return decodeURIComponent(wrapped[1]);
  return href.startsWith("//") ? `https:${href}` : href;
}

// --- Providers -------------------------------------------------------------

// Self-hosted SearXNG (see docker-compose.yml). Aggregates Google/Brave/etc.
// from our own IP, so it isn't subject to the scraping rate limits below.
let searxngDownUntil = 0;
const SEARXNG_COOLDOWN_MS = 60 * 1000;

async function searchSearxng(query: string, maxResults: number): Promise<SearchHit[]> {
  if (Date.now() < searxngDownUntil) {
    throw new Error("instance unreachable after a recent failure");
  }

  const base = process.env.SEARXNG_URL ?? "http://localhost:8888";
  const url = new URL("/search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "en");

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    searxngDownUntil = Date.now() + SEARXNG_COOLDOWN_MS;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`unreachable at ${base} (${reason}). Is the container up?`);
  }

  // By far the most common setup mistake: JSON output is off by default.
  if (res.status === 403) {
    throw new Error("JSON format is disabled - add 'json' to search.formats in searxng/settings.yml");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (data.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

async function searchTavily(query: string, maxResults: number): Promise<SearchHit[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY not set");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic" }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

async function searchBrave(query: string, maxResults: number): Promise<SearchHit[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("BRAVE_API_KEY not set");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));

  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: stripHtml(r.description ?? ""),
  }));
}

// DDG rate-limits by IP and the block outlives a single request, so remember it
// and stop paying for a doomed round-trip on every song in the batch.
let duckDuckGoBlockedUntil = 0;
const DDG_COOLDOWN_MS = 10 * 60 * 1000;

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchHit[]> {
  if (Date.now() < duckDuckGoBlockedUntil) {
    throw new Error("temporarily disabled after a recent rate limit");
  }

  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();

  // When rate-limited, DDG serves a ~14KB "anomaly" challenge page. That's a
  // failure, not an empty result set.
  if (/anomaly|unusual traffic|challenge/i.test(html) && !html.includes("result__a")) {
    duckDuckGoBlockedUntil = Date.now() + DDG_COOLDOWN_MS;
    throw new Error("served a bot-challenge page (rate limited)");
  }

  const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];

  const hits = titles.slice(0, maxResults).map((m, i) => ({
    title: stripHtml(m[2] ?? ""),
    url: unwrapUrl(m[1] ?? ""),
    snippet: stripHtml(snippets[i]?.[1] ?? ""),
  }));

  // Zero hits with no "no results" marker means the markup changed - also a failure.
  if (hits.length === 0 && !/No\s+results?\./i.test(html)) {
    throw new Error("no parseable results (markup may have changed)");
  }
  return hits;
}

async function wikiSummary(title: string): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      { headers: { "User-Agent": UA } },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { extract?: string };
    return body.extract;
  } catch {
    return undefined;
  }
}

async function wikiSearchRaw(srsearch: string, limit: number): Promise<SearchHit[]> {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", srsearch);
  url.searchParams.set("srlimit", String(limit));
  url.searchParams.set("format", "json");

  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = (await res.json()) as { query?: { search?: { title?: string; snippet?: string }[] } };
  return (data.query?.search ?? []).map((s) => ({
    title: s.title ?? "",
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent((s.title ?? "").replace(/ /g, "_"))}`,
    snippet: stripHtml(s.snippet ?? ""),
  }));
}

/** True when some result's title appears verbatim in the query - i.e. we clearly landed on-topic. */
function titleMatchesQuery(hits: SearchHit[], query: string): boolean {
  const needle = query.toLowerCase();
  return hits.some((h) => h.title.length > 3 && needle.includes(h.title.toLowerCase()));
}

async function searchWikipedia(query: string, maxResults: number): Promise<SearchHit[]> {
  // Over-fetch: full-text search happily ranks a famous artist above the one
  // specific song we asked for.
  const limit = Math.max(maxResults * 2, 10);
  let hits = await wikiSearchRaw(query, limit);

  // Wikipedia's relevance is easily dragged off-target by filler words, which
  // the model may still include despite the tool description. If nothing came
  // back obviously on-topic, retry once with the filler stripped.
  if (!titleMatchesQuery(hits, query)) {
    const cleaned = query.replace(WIKI_NOISE, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length > 3 && cleaned.toLowerCase() !== query.toLowerCase()) {
      const retry = await wikiSearchRaw(cleaned, limit);
      if (titleMatchesQuery(retry, query)) hits = retry;
    }
  }

  // Promote a verbatim title match over the noisier relevance ranking.
  const needle = query.toLowerCase();
  const exact = hits.findIndex((h) => h.title.length > 3 && needle.includes(h.title.toLowerCase()));
  if (exact > 0) {
    const [match] = hits.splice(exact, 1);
    if (match) hits.unshift(match);
  }

  hits = hits.slice(0, maxResults);

  // The article summary beats a search snippet - it usually names artist and
  // genre in the first sentence. Best-effort.
  if (hits[0]) hits[0].snippet = (await wikiSummary(hits[0].title)) ?? hits[0].snippet;

  return hits;
}

// --- The chain -------------------------------------------------------------

/**
 * Try each provider in order of quality, returning the first that answers.
 * Keyed providers are skipped when their key is absent. Throws if every
 * provider fails, so callers can tell "broken" apart from "empty".
 */
async function webSearch(query: string, maxResults = 5): Promise<SearchResponse> {
  const providers: { name: string; run: (q: string, n: number) => Promise<SearchHit[]> }[] = [
    { name: "searxng", run: searchSearxng },
    { name: "tavily", run: searchTavily },
    { name: "brave", run: searchBrave },
    { name: "duckduckgo", run: searchDuckDuckGo },
    { name: "wikipedia", run: searchWikipedia },
  ];

  const failures: string[] = [];

  for (const provider of providers) {
    try {
      const results = await provider.run(query, maxResults);
      if (results.length > 0) return { provider: provider.name, results };
      failures.push(`${provider.name}: no results`);
    } catch (err) {
      failures.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`all providers failed (${failures.join("; ")})`);
}

export { webSearch };