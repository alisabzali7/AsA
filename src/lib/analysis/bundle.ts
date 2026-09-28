/**
 * Typed intelligence bundle for one symbol/timeframe — deterministic,
 * computed only from canonical CLOSED candles + TTT stats with provenance.
 * This is the "evidence document" the chart, the AI and MTF synthesis consume.
 *
 * FIELD CONTRACT (Team 02 recovery, schema asa.analysis.bundle.v2)
 * - Every numeric field is finite or null. null ALWAYS means "not available";
 *   the reason is in `indicator_status` / structure.reason / momentum.reason.
 *   There are no numeric sentinels (0, -1, first value) anywhere.
 * - `as_of_t` is the open time (epoch s) of the last CLOSED bar every value
 *   describes; `provenance.source_ts_ms` is that bar's close instant.
 * - Technical values depend ONLY on `candles`. `computed_at_ms` and the
 *   `*_age_ms` fields are metadata (injectable via `nowMs`) and never feed a
 *   calculation.
 * - The bundle carries TECHNICAL EVIDENCE only: no entry, stop, target,
 *   position, score or probability.
 */
import type { Candle, SymbolStats, Provenance } from "../domain/types";
import { analyzeStructure, emptyStructure, findSwings, STRUCTURE_PARAMS, type StructureResult } from "./structure";
import { ema, rsi, atr, sma, requiredSamples } from "./indicators";
import { legMomentum, type MomentumResult } from "./momentum";
import { detectRsiDivergences, type DivergenceResult } from "./divergence";
import type { AnalysisInput, InputFreshness } from "./input";

export const BUNDLE_SCHEMA = "asa.analysis.bundle.v2" as const;

export interface BundleIndicators {
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  atr14_pct: number | null;
  volume_avg20: number | null;
  last_volume_ratio: number | null;
}

export type IndicatorState = "OK" | "INSUFFICIENT_HISTORY" | "UNDEFINED";

export interface IndicatorStatus {
  state: IndicatorState;
  /** closed bars required before the first valid value */
  required_bars: number;
  reason: string | null;
}

export interface AnalysisBundle {
  schema: typeof BUNDLE_SCHEMA;
  symbol: string;
  timeframe: string;
  bars: number;
  /** open time (epoch s) of the last closed bar; null only for an empty input */
  as_of_t: number | null;
  last_close: number | null;
  /** null when there is no valid candle window (never a 0-filled box) */
  candle_window: { t_min: number; t_max: number; price_min: number; price_max: number } | null;
  indicators: BundleIndicators;
  indicator_status: Record<keyof BundleIndicators, IndicatorStatus>;
  structure: StructureResult;
  momentum: MomentumResult;
  divergence: DivergenceResult;
  stats: {
    change24hPct: number | null;
    volume24hQuote: number | null;
    markPrice: number | null;
    fundingRate: number | null;
  };
  provenance: {
    /** when AsA received the series; null when unknown (never 0) */
    series_fetched_ms: number | null;
    stats_fetched_ms: number | null;
    series_age_ms: number | null;
    stats_age_ms: number | null;
    native: boolean;
    derived_source_tf?: string;
    /**
     * SOURCE freshness (Task 03): close instant of the last CLOSED bar and its
     * age. `series_age_ms` above is only the retrieval age and must never be
     * read as market freshness. UNAVAILABLE when the bundle was built without
     * the analysis-input contract (tests / legacy callers).
     */
    source_ts_ms: number | null;
    data_age_ms: number | null;
    freshness: InputFreshness;
    closed_bars_only: boolean;
    forming_bar_excluded: boolean;
    /** calculation identities, for evidence lineage */
    engines: { structure: string; momentum: string; divergence: string };
    /**
     * Snapshot identity (Task 09): deterministic 53-bit hash (hex) of
     * symbol, timeframe, engine versions and every OHLCV field of the closed
     * window. Two consumers holding bundles with the same fingerprint were
     * computed from the SAME candles by the SAME engines; a chart and a
     * decision consumer can prove they describe one snapshot. It is an
     * identity check, not a security hash.
     */
    input_fingerprint: string;
    /**
     * `stats` (24h change/volume, mark price, funding) is a LIVE venue
     * snapshot taken at `stats_fetched_ms` — NOT a closed-bar value and NOT
     * aligned to `as_of_t`. Consumers must not treat it as as-of evidence.
     */
    stats_basis: "LIVE_VENUE_SNAPSHOT";
  };
  computed_at_ms: number;
}

const finiteOrNull = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v;

/**
 * cyrb53-style deterministic hash over the raw IEEE-754 words of the window.
 * No clock, no randomness: identical inputs → identical fingerprint.
 */
export function bundleInputFingerprint(symbol: string, timeframe: string, candles: Candle[], engines: string): string {
  let h1 = 0xdeadbeef ^ candles.length, h2 = 0x41c6ce57 ^ candles.length;
  const mix = (w: number) => {
    h1 = Math.imul(h1 ^ w, 2654435761);
    h2 = Math.imul(h2 ^ w, 1597334677);
  };
  const head = `${symbol}|${timeframe}|${engines}`;
  for (let i = 0; i < head.length; i++) mix(head.charCodeAt(i));
  const f = new Float64Array(6);
  const u = new Uint32Array(f.buffer);
  for (const c of candles) {
    f[0] = c.t; f[1] = c.o; f[2] = c.h; f[3] = c.l; f[4] = c.c; f[5] = c.v;
    for (let k = 0; k < 12; k++) mix(u[k]);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

function lastOf(a: (number | null)[]): number | null {
  return a.length ? finiteOrNull(a[a.length - 1]) : null;
}

/**
 * Wilder RSI is 0/0 when there was no price change at all since the series
 * start (avg gain = avg loss = 0). indicators.rsi reports 50 for that case by
 * an ENGINEERING_DEFINED convention (not source-derived; other platforms use
 * 100 or NaN). The status says so explicitly so no consumer mistakes the 50
 * for a measured neutral reading.
 */
function flatRsiStatus(st: IndicatorStatus, value: number | null, closes: number[]): IndicatorStatus {
  if (st.state !== "OK" || value !== 50 || closes.length === 0) return st;
  if (!closes.every((c) => c === closes[0])) return st;
  return { ...st, reason: "no price change across the window: RSI is 0/0; 50 reported by ENGINEERING_DEFINED convention" };
}

function status(value: number | null, required: number, have: number, undefinedReason: string): IndicatorStatus {
  if (value !== null) return { state: "OK", required_bars: required, reason: null };
  if (have < required) return { state: "INSUFFICIENT_HISTORY", required_bars: required, reason: `warmup: needs ${required} closed bars, have ${have}` };
  return { state: "UNDEFINED", required_bars: required, reason: undefinedReason };
}

/**
 * Canonical per-bar indicator series of ONE bundle computation, aligned to the
 * bundle's closed candles (same index). Not serialized with the bundle; the
 * chart overlay projects it (Task 10) so the chart never needs a second
 * indicator calculation. null = warmup / undefined (never 0).
 */
export interface BundleSeries {
  t: number[];
  ema20: (number | null)[];
  ema50: (number | null)[];
}

export function buildBundle(opts: Parameters<typeof buildBundleArtifacts>[0]): AnalysisBundle {
  return buildBundleArtifacts(opts).bundle;
}

export function buildBundleArtifacts(opts: {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  stats?: SymbolStats;
  seriesProvenance?: { fetched_at_ms: number; native: boolean; derived_source_tf?: string };
  input?: AnalysisInput;
  /** metadata clock; defaults to Date.now(). Never affects technical values. */
  nowMs?: number;
}): { bundle: AnalysisBundle; series: BundleSeries } {
  const { symbol, timeframe, candles, stats } = opts;
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const now = opts.nowMs ?? Date.now();
  const seriesFetched = opts.seriesProvenance?.fetched_at_ms ?? null;

  let priceMin = Infinity, priceMax = -Infinity;
  let windowFinite = n > 0;
  for (const c of candles) {
    if (!Number.isFinite(c.h) || !Number.isFinite(c.l) || !Number.isFinite(c.t)) { windowFinite = false; break; }
    if (c.h > priceMax) priceMax = c.h;
    if (c.l < priceMin) priceMin = c.l;
  }
  const last = n > 0 ? candles[n - 1] : null;
  const lastClose = last ? finiteOrNull(last.c) : null;

  const rsiArr = rsi(closes, 14);
  const atrArr = atr(candles, 14);
  const vols = candles.map((c) => c.v);
  const volAvgArr = sma(vols, 20);

  // each canonical series is computed ONCE per bundle and shared with
  // structure (trend classification) and the chart overlay (Task 10)
  const ema20Arr = ema(closes, 20);
  const ema50Arr = ema(closes, 50);
  const ema20 = lastOf(ema20Arr);
  const ema50 = lastOf(ema50Arr);
  const rsi14 = lastOf(rsiArr);
  const atr14 = lastOf(atrArr);
  const atr14Pct = atr14 !== null && lastClose !== null && lastClose > 0 ? (atr14 / lastClose) * 100 : null;
  const volAvg = lastOf(volAvgArr);
  const lastVol = last ? finiteOrNull(last.v) : null;
  const volRatio = volAvg !== null && volAvg > 0 && lastVol !== null ? lastVol / volAvg : null;

  const nonFinite = "non-finite value in the input window";
  const indicator_status: AnalysisBundle["indicator_status"] = {
    ema20: status(ema20, requiredSamples("ema", 20)!, n, nonFinite),
    ema50: status(ema50, requiredSamples("ema", 50)!, n, nonFinite),
    rsi14: flatRsiStatus(status(rsi14, requiredSamples("rsi", 14)!, n, nonFinite), rsi14, closes),
    atr14: status(atr14, requiredSamples("atr", 14)!, n, nonFinite),
    atr14_pct: status(atr14Pct, requiredSamples("atr", 14)!, n, atr14 === null ? nonFinite : "last close ≤ 0: percentage undefined"),
    volume_avg20: status(volAvg, requiredSamples("sma", 20)!, n, nonFinite),
    last_volume_ratio: status(volRatio, requiredSamples("sma", 20)!, n, volAvg === 0 ? "20-bar average volume is 0: ratio undefined" : nonFinite),
  };

  // ONE swing detection feeds structure, momentum and divergence
  const swings = n >= STRUCTURE_PARAMS.min_structure_bars ? findSwings(candles, STRUCTURE_PARAMS.swing_left, STRUCTURE_PARAMS.swing_right) : [];
  const structure = n >= STRUCTURE_PARAMS.min_structure_bars
    ? analyzeStructure(candles, { atr14: atrArr, ema20: ema20Arr, ema50: ema50Arr, swings })
    : emptyStructure(`insufficient bars: ${n} < ${STRUCTURE_PARAMS.min_structure_bars}`);
  const momentum = legMomentum(candles, swings, atrArr);
  const divergence = detectRsiDivergences(candles, swings, rsiArr);

  const bundle: AnalysisBundle = {
    schema: BUNDLE_SCHEMA,
    symbol,
    timeframe,
    bars: n,
    as_of_t: last && Number.isFinite(last.t) ? last.t : null,
    last_close: lastClose,
    candle_window: windowFinite
      ? { t_min: candles[0].t, t_max: candles[n - 1].t, price_min: priceMin, price_max: priceMax }
      : null,
    indicators: {
      ema20,
      ema50,
      rsi14,
      atr14,
      atr14_pct: atr14Pct,
      volume_avg20: volAvg,
      last_volume_ratio: volRatio,
    },
    indicator_status,
    structure,
    momentum,
    divergence,
    stats: {
      change24hPct: stats ? finiteOrNull(stats.change24hPct) : null,
      volume24hQuote: stats ? finiteOrNull(stats.volume24hQuote) : null,
      markPrice: stats ? finiteOrNull(stats.markPrice) : null,
      fundingRate: stats ? finiteOrNull(stats.fundingRate) : null,
    },
    provenance: {
      series_fetched_ms: seriesFetched,
      stats_fetched_ms: stats?.provenance.fetched_at_ms ?? null,
      series_age_ms: seriesFetched !== null ? now - seriesFetched : null,
      stats_age_ms: stats?.provenance.fetched_at_ms ? now - stats.provenance.fetched_at_ms : null,
      native: opts.seriesProvenance?.native ?? false,
      derived_source_tf: opts.seriesProvenance?.derived_source_tf,
      source_ts_ms: opts.input?.source_ts_ms ?? null,
      data_age_ms: opts.input?.data_age_ms ?? null,
      freshness: opts.input?.freshness ?? "UNAVAILABLE",
      closed_bars_only: opts.input !== undefined,
      forming_bar_excluded: opts.input?.forming_bar_excluded ?? false,
      engines: { structure: structure.engine_version, momentum: momentum.version, divergence: divergence.version },
      input_fingerprint: bundleInputFingerprint(symbol, timeframe, candles, `${structure.engine_version}/${momentum.version}/${divergence.version}`),
      stats_basis: "LIVE_VENUE_SNAPSHOT",
    },
    computed_at_ms: now,
  };
  return { bundle, series: { t: candles.map((c) => c.t), ema20: ema20Arr, ema50: ema50Arr } };
}

/**
 * Build a bundle from the analysis-input contract. Returns null when no closed
 * bar exists — an empty input is NOT an analysis (no empty-but-valid object).
 */
export function buildBundleFromInput(input: AnalysisInput, stats?: SymbolStats, nowMs?: number): AnalysisBundle | null {
  return buildArtifactsFromInput(input, stats, nowMs)?.bundle ?? null;
}

/** bundle + its canonical series from the analysis-input contract (null when no closed bar) */
export function buildArtifactsFromInput(input: AnalysisInput, stats?: SymbolStats, nowMs?: number): { bundle: AnalysisBundle; series: BundleSeries } | null {
  if (input.candles.length === 0) return null;
  return buildBundleArtifacts({
    symbol: input.symbol,
    timeframe: input.timeframe,
    candles: input.candles,
    stats,
    seriesProvenance: input.fetched_at_ms === null ? undefined : { fetched_at_ms: input.fetched_at_ms, native: input.native, derived_source_tf: input.derived_source_tf },
    input,
    nowMs,
  });
}

export type { Provenance };
