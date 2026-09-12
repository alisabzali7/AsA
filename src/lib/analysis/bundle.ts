/**
 * Typed intelligence bundle for one symbol/timeframe — deterministic,
 * computed only from canonical candles + TTT stats with provenance ages.
 * This is the "evidence document" the strategy, psychology and AI consume.
 */
import type { Candle, SymbolStats, Provenance } from "../domain/types";
import { analyzeStructure, type StructureResult } from "./structure";
import { lastEma, rsi, atr } from "./indicators";

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
  last_close: number;
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
  };
  computed_at_ms: number;
}

export function buildBundle(opts: {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  stats?: SymbolStats;
  seriesProvenance?: { fetched_at_ms: number; native: boolean; derived_source_tf?: string };
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
  const windowValid = n > 0 && priceMin < Infinity;
  const last = n > 0 ? candles[n - 1] : null;

  const rsiArr = rsi(closes, 14);
  const atrArr = atr(candles, 14);
  const vols = candles.map((c) => c.v);
  const volAvg = vols.length >= 20 ? vols.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;

  const bundle: AnalysisBundle = {
    symbol,
    timeframe,
    bars: n,
    last_close: last?.c ?? NaN,
    candle_window: {
      t_min: n ? candles[0].t : 0,
      t_max: n ? candles[n - 1].t : 0,
      price_min: windowValid ? priceMin : 0,
      price_max: windowValid ? priceMax : 0,
    },
    indicators: {
      ema20: lastEma(closes, 20),
      ema50: lastEma(closes, 50),
      rsi14: rsiArr.length ? rsiArr[rsiArr.length - 1] : null,
      atr14: atrArr.length ? atrArr[atrArr.length - 1] : null,
      atr14_pct: atrArr.length && last ? (atrArr[atrArr.length - 1] ?? null) !== null && last.c > 0 ? ((atrArr[atrArr.length - 1] as number) / last.c) * 100 : null : null,
      volume_avg20: volAvg,
      last_volume_ratio: volAvg && volAvg > 0 && last ? last.v / volAvg : null,
    },
    structure: n >= 20 ? analyzeStructure(candles) : { trend: "range", reason: "insufficient bars", last_bos: null, last_choch: null, sr_levels: [], fvgs: [], order_blocks: [], swing_points: [], last_swing_high: null, last_swing_low: null, fib: [] },
    stats: {
      change24hPct: stats?.change24hPct ?? null,
      volume24hQuote: stats?.volume24hQuote ?? null,
      markPrice: stats?.markPrice ?? null,
      fundingRate: stats?.fundingRate ?? null,
    },
    provenance: {
      series_fetched_ms: seriesFetched ?? 0,
      stats_fetched_ms: stats?.provenance.fetched_at_ms ?? null,
      series_age_ms: seriesFetched ? now - seriesFetched : null,
      stats_age_ms: stats?.provenance.fetched_at_ms ? now - stats.provenance.fetched_at_ms : null,
      native: opts.seriesProvenance?.native ?? false,
      derived_source_tf: opts.seriesProvenance?.derived_source_tf,
    },
    computed_at_ms: now,
  };
  return bundle;
}

export type { Provenance };
