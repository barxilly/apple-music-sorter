// ---------------------------------------------------------------------------
// What the categorising actually costs.
//
// Prices are USD per 1M tokens, from DeepSeek's published table for
// deepseek-flash (api-docs.deepseek.com/quick_start/pricing):
//
//                       cache hit   cache miss   output
//   peak                 $0.006       $0.30      $1.20
//   off-peak             $0.003       $0.15      $0.60
//
// Off-peak is exactly half of peak. Peak is 01:00-04:00 and 06:00-10:00 UTC,
// Monday to Friday; every other hour - and all weekend - is off-peak.
//
// Reasoning tokens are billed as output tokens, so they're already counted via
// `completion_tokens`.
// ---------------------------------------------------------------------------

const PRICE = {
  peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
} as const;

const MILLION = 1_000_000;

/** Approximate rate at the time of writing; only used if the lookup fails. */
const FALLBACK_USD_TO_GBP = 0.74;

export type Usage = {
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
};

export const EMPTY_USAGE: Usage = { cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0 };

export function isPeak(date: Date = new Date()): boolean {
  const day = date.getUTCDay(); // 0 = Sunday
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function costUsd(usage: Usage): number {
  const rate = isPeak() ? PRICE.peak : PRICE.offPeak;
  return (
    (usage.cacheHitTokens / MILLION) * rate.cacheHit +
    (usage.cacheMissTokens / MILLION) * rate.cacheMiss +
    (usage.outputTokens / MILLION) * rate.output
  );
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    cacheMissTokens: a.cacheMissTokens + b.cacheMissTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export function totalTokens(usage: Usage): number {
  return usage.cacheHitTokens + usage.cacheMissTokens + usage.outputTokens;
}

/**
 * Pull DeepSeek's cache-aware token counts out of an API response. Cache hits
 * are 50x cheaper than misses, so lumping them together would wildly overstate
 * the cost once prompt caching kicks in.
 */
export function usageFrom(raw: unknown): Usage {
  const usage = raw as
    | {
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
      }
    | undefined;

  const cacheHitTokens = usage?.prompt_cache_hit_tokens ?? 0;
  const cacheMissTokens =
    usage?.prompt_cache_miss_tokens ?? Math.max(0, (usage?.prompt_tokens ?? 0) - cacheHitTokens);

  return { cacheHitTokens, cacheMissTokens, outputTokens: usage?.completion_tokens ?? 0 };
}

/**
 * Live USD -> GBP. Two free, keyless sources, then a hardcoded fallback so the
 * cost display doesn't die just because an FX API is having a bad day.
 */
export async function usdToGbp(): Promise<{ rate: number; source: string }> {
  const sources: { name: string; url: string }[] = [
    { name: "exchangerate-api", url: "https://open.er-api.com/v6/latest/USD" },
    { name: "frankfurter", url: "https://api.frankfurter.dev/v1/latest?from=USD&to=GBP" },
  ];

  for (const source of sources) {
    try {
      const res = await fetch(source.url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { rates?: { GBP?: number } };
      const rate = Number(body.rates?.GBP);
      if (Number.isFinite(rate) && rate > 0) return { rate, source: source.name };
    } catch {
      // Fall through to the next source.
    }
  }

  return { rate: FALLBACK_USD_TO_GBP, source: "fallback" };
}

/** Petty cash needs more decimals than you'd think. */
export function formatGbp(amount: number): string {
  if (amount >= 1) return `£${amount.toFixed(2)}`;
  if (amount >= 0.01) return `£${amount.toFixed(4)}`;
  if (amount > 0) return `£${amount.toFixed(5)}`;
  return "£0.00";
}
