/**
 * Typed intelligence bundle for one symbol/timeframe — deterministic,
 * computed only from canonical candles + TTT stats with provenance ages.
 * This is the "evidence document" the strategy, psychology and AI consume.
 *
 * Hardened contract (Task 08):
 * - last_close: number | null (finite number when candles exist and last close is finite; null when empty or non-finite).
 * - Finite numeric invariant: no NaN or Infinity is ever emitted in any numeric field.
 * - JSON-safe: serializes and deserializes without loss or unintended coercion.
 */
import type { Candle, SymbolStats, Provenance } from "../domain/types";
import { analyzeStructure, type StructureResult } from "./structure";
import { lastEma, rsi, atr } from "./indicators";
import type { AnalysisInput, InputFreshness } from "./input";

export interface BundleIndicators {
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  atr14_pct: number | null;
  volume_avg20: number | null;
  last_volume_ratio: number | null;
}

export interface AnalysisBundle {
  symbol: string;
  timeframe: string;
  bars: number;
  last_close: number | null;
  candle_window: { t_min: number; t_max: number; price_min: number; price_max: number };
  indicators: BundleIndicators;
  structure: StructureResult;
  stats: {
    change24hPct: number | null;
    volume24hQuote: number | null;
    markPrice: number | null;
    fundingRate: number | null;
  };
  provenance: {
    series_fetched_ms: number;
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
  };
  computed_at_ms: number;
}

export function buildBundle(opts: {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  stats?: SymbolStats;
  seriesProvenance?: { fetched_at_ms: number; native: boolean; derived_source_tf?: string };
  input?: AnalysisInput;
}): AnalysisBundle {
  const { symbol, timeframe, candles, stats } = opts;
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const now = Date.now();
  const seriesFetched = opts.seriesProvenance?.fetched_at_ms ?? null;

  let priceMin = Infinity, priceMax = -Infinity;
  for (const c of candles) {
    if (c.h > priceMax) priceMax = c.h;
    if (c.l < priceMin) priceMin = c.l;
  }
  const windowValid = n > 0 && priceMin < Infinity && Number.isFinite(priceMin) && Number.isFinite(priceMax);
  const last = n > 0 ? candles[n - 1] : null;
  const lastClose = last && Number.isFinite(last.c) ? last.c : null;

  const rsiArr = rsi(closes, 14);
  const atrArr = atr(candles, 14);
  const vols = candles.map((c) => c.v);
  const volAvg = vols.length >= 20 && vols.every(Number.isFinite)
    ? vols.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;

  const bundle: AnalysisBundle = {
    symbol,
    timeframe,
    bars: n,
    last_close: lastClose,
    candle_window: {
      t_min: n && Number.isFinite(candles[0].t) ? candles[0].t : 0,
      t_max: n && Number.isFinite(candles[n - 1].t) ? candles[n - 1].t : 0,
      price_min: windowValid ? priceMin : 0,
      price_max: windowValid ? priceMax : 0,
    },
    indicators: {
      ema20: lastEma(closes, 20),
      ema50: lastEma(closes, 50),
      rsi14: rsiArr.length ? rsiArr[rsiArr.length - 1] : null,
      atr14: atrArr.length ? atrArr[atrArr.length - 1] : null,
      atr14_pct: atrArr.length && last && lastClose !== null && lastClose > 0 && (atrArr[atrArr.length - 1] ?? null) !== null
        ? ((atrArr[atrArr.length - 1] as number) / lastClose) * 100
        : null,
      volume_avg20: volAvg,
      last_volume_ratio: volAvg && volAvg > 0 && last && Number.isFinite(last.v) ? last.v / volAvg : null,
    },
    structure: n >= 20 ? analyzeStructure(candles) : { trend: "range", reason: "insufficient bars", last_bos: null, last_choch: null, sr_levels: [], fvgs: [], order_blocks: [], swing_points: [], last_swing_high: null, last_swing_low: null, fib: [] },
    stats: {
      change24hPct: stats && Number.isFinite(stats.change24hPct) ? stats.change24hPct : null,
      volume24hQuote: stats && Number.isFinite(stats.volume24hQuote) ? stats.volume24hQuote : null,
      markPrice: stats && Number.isFinite(stats.markPrice) ? stats.markPrice : null,
      fundingRate: stats && Number.isFinite(stats.fundingRate) ? stats.fundingRate : null,
    },
    provenance: {
      series_fetched_ms: seriesFetched ?? 0,
      stats_fetched_ms: stats?.provenance.fetched_at_ms ?? null,
      series_age_ms: seriesFetched ? now - seriesFetched : null,
      stats_age_ms: stats?.provenance.fetched_at_ms ? now - stats.provenance.fetched_at_ms : null,
      native: opts.seriesProvenance?.native ?? false,
      derived_source_tf: opts.seriesProvenance?.derived_source_tf,
      source_ts_ms: opts.input?.source_ts_ms ?? null,
      data_age_ms: opts.input?.data_age_ms ?? null,
      freshness: opts.input?.freshness ?? "UNAVAILABLE",
      closed_bars_only: opts.input !== undefined,
      forming_bar_excluded: opts.input?.forming_bar_excluded ?? false,
    },
    computed_at_ms: now,
  };
  return bundle;
}

/**
 * Build a bundle from the analysis-input contract. Returns null when no closed
 * bar exists — an empty input is NOT an analysis (no empty-but-valid object).
 */
export function buildBundleFromInput(input: AnalysisInput, stats?: SymbolStats): AnalysisBundle | null {
  if (input.candles.length === 0) return null;
  return buildBundle({
    symbol: input.symbol,
    timeframe: input.timeframe,
    candles: input.candles,
    stats,
    seriesProvenance: input.fetched_at_ms === null ? undefined : { fetched_at_ms: input.fetched_at_ms, native: input.native, derived_source_tf: input.derived_source_tf },
    input,
  });
}

export type { Provenance };
