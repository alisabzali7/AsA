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
 *  3. (Team 02 recovery) The closed-bar cut used `nowMs` only. A CACHED series
 *     (candleManager serves caches up to 45 s old) still ends with the bar that
 *     was FORMING when it was fetched; if that bar's close instant fell between
 *     the fetch and `nowMs`, its mid-bar snapshot was treated as a closed bar.
 *     The cut instant is now min(nowMs, series.fetched_at_ms): a bar is closed
 *     only if it had closed when the data was OBSERVED.
 *
 *  4. (Task 09) Closed-bar trimming works from the END of the array and
 *     assumes strictly ascending open times. A duplicate or out-of-order
 *     timestamp would let a not-yet-closed bar hide mid-array (lookahead) and
 *     corrupt every rolling calculation. The input now REFUSES such a series
 *     (reason_code INVALID_SERIES) instead of analysing it; upstream
 *     `mergeCandles` dedupes/sorts, this is the boundary check.
 *
 * Every refusal carries a machine-readable `reason_code` so consumers never
 * have to parse the human `reason` text.
 *
 * Pure and deterministic: `nowMs` is injectable.
 */
import type { Candle, CandleSeries } from "../domain/types";
import { getTimeframe } from "../domain/timeframes";
import { ohlcvDefect } from "../domain/candle-validity";

export type InputFreshness = "FRESH" | "STALE" | "UNAVAILABLE";

/**
 * Why an input is (not) analysable — machine-readable companion of `reason`.
 *   OK                    closed bars present (freshness may still be STALE)
 *   SERIES_UNAVAILABLE    no series in the store / fetch failed (NO DATA)
 *   IDENTITY_MISMATCH     series belongs to another symbol/timeframe
 *   UNSUPPORTED_TIMEFRAME timeframe unknown to the timeframe registry
 *   INVALID_SERIES        non-finite / duplicate / out-of-order open times,
 *                         an invalid bar (barViolation) or a bar that opens
 *                         after the observation instant (future bar)
 *   NO_CLOSED_BARS        series exists but no bar had closed at the cut
 */
export type InputReasonCode = "OK" | "SERIES_UNAVAILABLE" | "IDENTITY_MISMATCH" | "UNSUPPORTED_TIMEFRAME" | "INVALID_SERIES" | "NO_CLOSED_BARS";

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
  reason_code: InputReasonCode;
}

/**
 * First timestamp-integrity violation in a candle array, or null when every
 * open time is finite and strictly ascending.
 */
export function timestampViolation(candles: Candle[]): string | null {
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i] as Candle | null | undefined;
    if (!k || typeof k !== "object") return `malformed bar at index ${i}`;
    const t = k.t;
    if (typeof t !== "number" || !Number.isFinite(t)) return `non-finite open time at index ${i}`;
    if (i > 0) {
      const p = candles[i - 1].t;
      if (t === p) return `duplicate open time ${t} at index ${i}`;
      if (t < p) return `out-of-order open time ${t} < ${p} at index ${i}`;
    }
  }
  return null;
}

/**
 * First invalid BAR (canonical rule: domain/candle-validity ohlcvDefect, shared
 * with the venue normaliser ttt/udf.ts and market/history.ts) so derived,
 * stored, replayed and caller-supplied series meet the same rules as native
 * TTT bars: finite OHLCV, strictly positive prices, non-negative volume, open
 * aligned to the timeframe, high ≥ max(open, close), low ≤ min(open, close).
 * Fail closed: one invalid bar refuses the whole series (no repair, no skip).
 */
export function barViolation(candles: Candle[], stepSec: number): string | null {
  for (let i = 0; i < candles.length; i++) {
    const defect = ohlcvDefect(candles[i]);
    if (defect !== null) return `${defect} at index ${i}`;
    const t = candles[i].t;
    if (t % stepSec !== 0) return `open time ${t} not aligned to the ${stepSec}s timeframe at index ${i}`;
  }
  return null;
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
  const empty = (reason: string, reason_code: InputReasonCode): AnalysisInput => ({
    symbol, timeframe, candles: [], closed_bars: 0, forming_bar_excluded: false,
    last_closed_open_ts: null, source_ts_ms: null, data_age_ms: null, freshness: "UNAVAILABLE",
    native: series?.native ?? false, derived_source_tf: series?.derived_source_tf,
    fetched_at_ms: series?.fetched_at_ms ?? null, reason, reason_code,
  });
  if (!series) return empty("series unavailable", "SERIES_UNAVAILABLE");
  if (series.symbol !== symbol || series.timeframe !== timeframe) {
    return empty(`series identity mismatch: got ${series.symbol}@${series.timeframe}, expected ${symbol}@${timeframe}`, "IDENTITY_MISMATCH");
  }
  const step = tfSeconds(timeframe);
  if (step === null) return empty(`unsupported timeframe '${timeframe}'`, "UNSUPPORTED_TIMEFRAME");
  if (!Array.isArray(series.candles)) return empty("invalid series: candles is not an array — refusing to analyse", "INVALID_SERIES");
  const violation = timestampViolation(series.candles) ?? barViolation(series.candles, step);
  if (violation !== null) return empty(`invalid series: ${violation} — refusing to analyse`, "INVALID_SERIES");
  const observedMs = Number.isFinite(series.fetched_at_ms) && series.fetched_at_ms > 0 ? series.fetched_at_ms : null;
  const cutMs = observedMs !== null ? Math.min(nowMs, observedMs) : nowMs;
  // A bar opening AFTER the series was OBSERVED (fetched_at_ms) cannot exist:
  // refuse, never silently drop it as if it were the forming bar. Bars after
  // an earlier EVALUATION instant (as-of replay over stored data) are
  // legitimate and are trimmed by the closed-bar cut below.
  const newest = series.candles[series.candles.length - 1];
  if (newest && observedMs !== null && newest.t * 1000 > observedMs) {
    return empty(`invalid series: bar opening at ${newest.t} is after the observation instant ${Math.floor(observedMs / 1000)} (future bar) — refusing to analyse`, "INVALID_SERIES");
  }
  const { closed, excluded } = closedOnly(series.candles, timeframe, cutMs);
  if (closed.length === 0) return { ...empty("no closed bars", "NO_CLOSED_BARS"), forming_bar_excluded: excluded > 0 };
  const last = closed[closed.length - 1];
  const sourceTs = (last.t + step) * 1000;
  const f = freshnessOf(sourceTs, timeframe, nowMs);
  return {
    symbol, timeframe, candles: closed, closed_bars: closed.length,
    forming_bar_excluded: excluded > 0,
    last_closed_open_ts: last.t, source_ts_ms: sourceTs, data_age_ms: f.age_ms, freshness: f.freshness,
    native: series.native, derived_source_tf: series.derived_source_tf, fetched_at_ms: series.fetched_at_ms,
    reason: f.freshness === "STALE" ? `last closed ${timeframe} bar ended ${Math.round((f.age_ms ?? 0) / 1000)}s ago (> ${STALE_BARS} bars)` : undefined,
    reason_code: "OK",
  };
}
