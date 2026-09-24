/**
 * ANALYSIS INPUT CONTRACT (Team 01 / Task 03).
 *
 * The single boundary every analysis producer (analysis route, MTF route, AI
 * route, live scanner) crosses before candles reach indicators/structure/
 * strategy evaluation.
 *
 * Why it exists (verified defects):
 *  1. TTT UDF responses END WITH THE CURRENTLY FORMING BAR (the engine's
 *     close detection relies on that). Every analysis path fed that forming
 *     bar into closed-bar logic (EMA/RSI/ATR/BOS/strategy rules) as if it had
 *     closed.
 *  2. Freshness was measured from `fetched_at_ms` (when AsA received the
 *     response). A successful request that returns a series whose newest bar
 *     is days old looked "fresh". Freshness is now measured from the SOURCE
 *     timestamp: the close instant of the last closed bar.
 *
 * Pure and deterministic: `nowMs` is injectable.
 */
import type { Candle, CandleSeries } from "../domain/types";
import { getTimeframe } from "../domain/timeframes";

export type InputFreshness = "FRESH" | "STALE" | "UNAVAILABLE";

export interface AnalysisInput {
  symbol: string;
  timeframe: string;
  /** CLOSED bars only, ascending */
  candles: Candle[];
  closed_bars: number;
  /** true when the venue's newest (still-forming) bar was removed */
  forming_bar_excluded: boolean;
  /** open time (epoch s) of the last CLOSED bar, null when none */
  last_closed_open_ts: number | null;
  /** close instant (epoch ms) of the last closed bar = source timestamp */
  source_ts_ms: number | null;
  /** now - source_ts_ms; null when no closed bar */
  data_age_ms: number | null;
  freshness: InputFreshness;
  native: boolean;
  derived_source_tf?: string;
  fetched_at_ms: number | null;
  reason?: string;
}

/**
 * A closed-bar series is STALE once its last closed bar ended more than
 * `STALE_BARS` bar-periods ago (i.e. at least one further bar should already
 * have closed and been observed). Two periods of tolerance absorb refresh
 * latency without letting a stopped source pass as current.
 */
export const STALE_BARS = 2;

export function tfSeconds(tf: string): number | null {
  const spec = getTimeframe(tf);
  return spec ? spec.minutes * 60 : null;
}

/** Drop every bar that has not closed at `nowMs` (open + period > now). */
export function closedOnly(candles: Candle[], tf: string, nowMs: number = Date.now()): { closed: Candle[]; excluded: number } {
  const step = tfSeconds(tf);
  if (step === null) return { closed: [], excluded: candles.length };
  const nowSec = nowMs / 1000;
  let end = candles.length;
  while (end > 0 && candles[end - 1].t + step > nowSec) end--;
  return { closed: end === candles.length ? candles : candles.slice(0, end), excluded: candles.length - end };
}

export function freshnessOf(sourceTsMs: number | null, tf: string, nowMs: number = Date.now()): { freshness: InputFreshness; age_ms: number | null } {
  const step = tfSeconds(tf);
  if (sourceTsMs === null || step === null) return { freshness: "UNAVAILABLE", age_ms: null };
  const age = nowMs - sourceTsMs;
  return { freshness: age <= STALE_BARS * step * 1000 ? "FRESH" : "STALE", age_ms: age };
}

/**
 * Build the analysis input for one symbol/timeframe from a stored series.
 * Refuses (freshness UNAVAILABLE, zero bars) when the series belongs to a
 * different symbol/timeframe — cross-series contamination can never reach
 * analysis.
 */
export function prepareAnalysisInput(
  symbol: string,
  timeframe: string,
  series: CandleSeries | null | undefined,
  nowMs: number = Date.now(),
): AnalysisInput {
  const empty = (reason: string): AnalysisInput => ({
    symbol, timeframe, candles: [], closed_bars: 0, forming_bar_excluded: false,
    last_closed_open_ts: null, source_ts_ms: null, data_age_ms: null, freshness: "UNAVAILABLE",
    native: series?.native ?? false, derived_source_tf: series?.derived_source_tf,
    fetched_at_ms: series?.fetched_at_ms ?? null, reason,
  });
  if (!series) return empty("series unavailable");
  if (series.symbol !== symbol || series.timeframe !== timeframe) {
    return empty(`series identity mismatch: got ${series.symbol}@${series.timeframe}, expected ${symbol}@${timeframe}`);
  }
  const step = tfSeconds(timeframe);
  if (step === null) return empty(`unsupported timeframe '${timeframe}'`);
  const { closed, excluded } = closedOnly(series.candles, timeframe, nowMs);
  if (closed.length === 0) return { ...empty("no closed bars"), forming_bar_excluded: excluded > 0 };
  const last = closed[closed.length - 1];
  const sourceTs = (last.t + step) * 1000;
  const f = freshnessOf(sourceTs, timeframe, nowMs);
  return {
    symbol, timeframe, candles: closed, closed_bars: closed.length,
    forming_bar_excluded: excluded > 0,
    last_closed_open_ts: last.t, source_ts_ms: sourceTs, data_age_ms: f.age_ms, freshness: f.freshness,
    native: series.native, derived_source_tf: series.derived_source_tf, fetched_at_ms: series.fetched_at_ms,
    reason: f.freshness === "STALE" ? `last closed ${timeframe} bar ended ${Math.round((f.age_ms ?? 0) / 1000)}s ago (> ${STALE_BARS} bars)` : undefined,
  };
}
