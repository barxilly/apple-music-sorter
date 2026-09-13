// ---------------------------------------------------------------------------
// What the categorising actually costs.
//
// The prices themselves live in config.ts, per provider, so this file only
// knows how to do the arithmetic. If a provider declares no pricing, the
// display simply hides the cost rather than inventing a number.
//
// Reasoning tokens are billed as output tokens, so they're already counted via
// `completion_tokens`.
// ---------------------------------------------------------------------------

import type { Rates } from "./config.ts";

const MILLION = 1_000_000;

/** Approximate rate at the time of writing; only used if the lookup fails. */
const FALLBACK_USD_TO_GBP = 0.74;

export type Usage = {
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
};

export const EMPTY_USAGE: Usage = { cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0 };

/**
 * Cost of a set of token counts at the given rates. Cache hits can be 50x
 * cheaper than misses, so they are never lumped together.
 */
export function costUsd(usage: Usage, rates: Rates): number {
  const cachedInput = rates.cachedInput ?? rates.input;
  return (
    (usage.cacheHitTokens / MILLION) * cachedInput +
    (usage.cacheMissTokens / MILLION) * rates.input +
    (usage.outputTokens / MILLION) * rates.output
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
