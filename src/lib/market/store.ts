/**
 * Canonical in-memory market state — the application's live "truth layer".
 * Every entry carries provenance + age. Nothing here is ever fabricated:
 * fields stay null with a reason until TTT supplies a value.
 */
import {
  type SymbolStats,
  type TradePrint,
  type OrderBook,
  type Provenance,
  type MarketStatusRow,
  type AppState,
  type MetricTruth,
  type CandleSeries,
  type SeriesCoverage,
} from "../domain/types";
import { isOperationalSymbol, operationalUniverse } from "./operational-universe";
import { MINUTE_MS } from "../domain/timeframes";
import { eventBus } from "../events";

export interface SymbolMeta {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  category: string;
  name: string;
  /** venue constraint; null when TTT did not supply it (never a guess) */
  tickSize: number | null;
  stepSize: number | null;
  maxLeverage: number | null;
  maintenanceMarginRate: number | null;
  makerFeeCoefficient: number | null;
  takerFeeCoefficient: number | null;
  isActive: boolean;
}

/** STATIC freshness thresholds (data cadence derived from engine loops). */
export const STATS_SWEEP_MS = 7_000;
/**
 * SOURCE staleness (Task 03). Each TTT stats row carries its own `timestamp`.
 * A halted/frozen market keeps being served in every successful sweep with an
 * old timestamp (observed: TONUSDT row a week behind the rest). Retrieval age
 * alone would call it LIVE. A row whose own timestamp is older than this is
 * STALE regardless of how recently it was fetched.
 */
export const STATS_SOURCE_STALE_MS = 10 * 60_000;

/** Classify one stats row by BOTH retrieval age and source age. */
export function statsRowState(s: { provenance: { fetched_at_ms: number; source_ts_ms?: number } }, nowMs: number): { state: AppState; fetch_age_ms: number; source_age_ms: number | null; reason?: string } {
  const fetchAge = nowMs - s.provenance.fetched_at_ms;
  const src = s.provenance.source_ts_ms;
  const sourceAge = typeof src === "number" && Number.isFinite(src) ? nowMs - src : null;
  if (fetchAge > 5 * STATS_SWEEP_MS) return { state: "STALE", fetch_age_ms: fetchAge, source_age_ms: sourceAge, reason: `last successful fetch ${Math.round(fetchAge / 1000)}s ago` };
  if (sourceAge !== null && sourceAge > STATS_SOURCE_STALE_MS) {
    return { state: "STALE", fetch_age_ms: fetchAge, source_age_ms: sourceAge, reason: `venue row timestamp is ${Math.round(sourceAge / 1000)}s old (source not updating)` };
  }
  return { state: "LIVE", fetch_age_ms: fetchAge, source_age_ms: sourceAge };
}

export class MarketStore {
  catalog = new Map<string, SymbolMeta>();
  stats = new Map<string, SymbolStats>();
  /** last successful stats sweep */
  lastStatsSweepAtMs: number | null = null;
  /** 429 / error counters (observability) */
  tttErrors: { at_ms: number; kind: string; endpoint: string; message: string }[] = [];

  // focus lanes (only the focused symbol; TTT is the retention layer)
  focusSymbol: string = "BTCUSDT";
  tape: TradePrint[] = [];
  orderBook: OrderBook | null = null;
  orderBookFetchedAtMs: number | null = null;
  tapeFetchedAtMs: number | null = null;
  fundingHistory: { symbol: string; page: unknown; provenance: Provenance } | null = null;

  // candles
  seriesCache = new Map<string, CandleSeries>(); // `${symbol}|${tf}`
  coverage = new Map<string, SeriesCoverage>(); // `${symbol}|${tf}`

  setFocus(symbol: string): void {
    if (!isOperationalSymbol(symbol) || symbol === this.focusSymbol) return;
    this.focusSymbol = symbol;
    this.tape = [];
    this.orderBook = null;
    this.tapeFetchedAtMs = null;
    this.orderBookFetchedAtMs = null;
    // the funding page belongs to the previous focus; never serve it for the new one
    this.fundingHistory = null;
  }

  // ---------------------------------------------------------------- catalog
  ingestCatalog(raw: { symbol: string; baseAsset: string; quoteAsset: string; category: string; name: string; tickSize: string | number | null; stepSize: string | number | null; maxLeverage: number | null; maintenanceMarginRate: string | number | null; makerFeeCoefficient: string | number | null; takerFeeCoefficient: string | number | null; isActive: boolean }[]): number {
    let n = 0;
    for (const m of raw) {
      if (!isOperationalSymbol(m.symbol)) continue; // TONUSDT & co excluded here
      this.catalog.set(m.symbol, {
        symbol: m.symbol,
        baseAsset: m.baseAsset,
        quoteAsset: m.quoteAsset,
        category: m.category,
        name: m.name,
        // NaN (missing/unparseable) becomes NULL — a missing constraint is
        // never represented as a number.
        tickSize: nn(num(m.tickSize)),
        stepSize: nn(num(m.stepSize)),
        maxLeverage: nn(num(m.maxLeverage)),
        maintenanceMarginRate: nn(num(m.maintenanceMarginRate)),
        makerFeeCoefficient: nn(num(m.makerFeeCoefficient)),
        takerFeeCoefficient: nn(num(m.takerFeeCoefficient)),
        isActive: m.isActive,
      });
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ stats
  ingestStats(row: SymbolStats): void {
    this.stats.set(row.symbol, row);
  }

  getStats(symbol: string): SymbolStats | undefined {
    return this.stats.get(symbol);
  }

  /** Age in ms of the freshest price for a symbol (null when never measured). */
  priceAgeMs(symbol: string): number | null {
    const s = this.stats.get(symbol);
    if (!s) return null;
    return Date.now() - s.provenance.fetched_at_ms;
  }

  /** Live board rows for the DYNAMIC operational universe, truthfully labelled. */
  liveRows(): MarketStatusRow[] {
    const now = Date.now();
    const rows: MarketStatusRow[] = [];
    for (const symbol of operationalUniverse()) {
      const s = this.stats.get(symbol);
      if (!s || s.lastPrice === null) {
        rows.push({ symbol, price: null, state: "CONNECTING", age_ms: null, source: "ttt", endpoint: null, received_ts_ms: null, price_source_ts_ms: null, reason: "no stats measurement yet" });
        continue;
      }
      const cls = statsRowState(s, now);
      const age = cls.fetch_age_ms;
      rows.push({
        symbol,
        price: s.lastPrice,
        state: cls.state,
        age_ms: age,
        reason: cls.reason,
        source: "ttt",
        endpoint: "/futures/markets/stats",
        received_ts_ms: s.provenance.fetched_at_ms,
        price_source_ts_ms: s.provenance.source_ts_ms ?? null,
      });
    }
    return rows;
  }

  liveSymbolCount(): { live: number; total: number } {
    let live = 0;
    for (const r of this.liveRows()) if (r.state === "LIVE" && r.price !== null) live++;
    return { live, total: operationalUniverse().length };
  }

  // ---------------------------------------------------------------- candles
  seriesKey(symbol: string, tf: string): string {
    return `${symbol}|${tf}`;
  }
  getSeries(symbol: string, tf: string): CandleSeries | undefined {
    return this.seriesCache.get(this.seriesKey(symbol, tf));
  }
  putSeries(series: CandleSeries): void {
    this.seriesCache.set(this.seriesKey(series.symbol, series.timeframe), series);
    eventBus.emit("candles.updated", { symbol: series.symbol, timeframe: series.timeframe, bars: series.candles.length });
  }

  coverageRow(symbol: string, tf: string): SeriesCoverage | undefined {
    return this.coverage.get(this.seriesKey(symbol, tf));
  }

  /**
   * Per-symbol/timeframe coverage object (master §54). bar_count/gaps are
   * truthful; native_or_derived reflects the actual data served.
   */
  computeCoverage(symbol: string, tf: string, series: CandleSeries | undefined, fetchedAt: number | null): SeriesCoverage {
    const key = this.seriesKey(symbol, tf);
    if (!series || series.candles.length === 0) {
      return { symbol, timeframe: tf, first_ts_ms: null, last_ts_ms: null, bar_count: 0, gap_count: 0, duplicates: 0, native_or_derived: series && series.native === false ? "DERIVED" : "NATIVE", derivation_source_tf: series?.derived_source_tf, source: "ttt", last_fetch_ms: fetchedAt, status: "PENDING", target_bars: 0, reason: "no bars yet" };
    }
    const candles = series.candles;
    let gaps = 0;
    const stepSec = tfMinutesFor(tf);
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].t - candles[i - 1].t > stepSec * 1.5) gaps++;
    }
    const cov: SeriesCoverage = {
      symbol,
      timeframe: tf,
      first_ts_ms: candles[0].t * 1000,
      last_ts_ms: candles[candles.length - 1].t * 1000,
      bar_count: candles.length,
      gap_count: gaps,
      duplicates: 0,
      native_or_derived: series.native ? "NATIVE" : "DERIVED",
      derivation_source_tf: series.derived_source_tf,
      source: "ttt",
      last_fetch_ms: fetchedAt ?? series.fetched_at_ms,
      status: gaps > Math.max(2, candles.length * 0.05) ? "PARTIAL" : "OK",
      target_bars: 0,
    };
    this.coverage.set(key, cov);
    return cov;
  }

  clearSeries(symbol: string, tf: string): void {
    this.seriesCache.delete(this.seriesKey(symbol, tf));
    this.coverage.delete(this.seriesKey(symbol, tf));
  }

  // ------------------------------------------------------------- derivative
  /**
   * Dynamic capability/matrix entry for one metric of one symbol.
   * Answers: capability? availability? currently measured? (§48)
   */
  metricTruth(symbol: string, metric: string): MetricTruth {
    const s = this.stats.get(symbol);
    const cat = this.catalog.get(symbol);
    const measured = (v: number | null | undefined): boolean => v !== null && v !== undefined && Number.isFinite(v);
    const statsMetric = (label: string, v: number | null | undefined): MetricTruth => {
      const ok = measured(v);
      return {
        capability: true,
        availability: ok ? "available" : s ? "unavailable" : "unknown",
        currently_measured: ok,
        verdict: ok ? "MEASURED" : "UNAVAILABLE",
        source: "ttt",
        endpoint: "/futures/markets/stats",
        measured_at_ms: ok ? s?.provenance.fetched_at_ms : undefined,
        reason: ok ? undefined : s ? `${label} is not measured in the latest TTT stats row` : "no stats row yet",
      };
    };
    const focusMetric = (label: string, fetchedAt: number | null, endpoint: string): MetricTruth => {
      const focus = symbol === this.focusSymbol;
      const ok = focus && fetchedAt !== null;
      return {
        capability: true,
        availability: ok ? "available" : "unavailable",
        currently_measured: ok,
        verdict: ok ? "MEASURED" : "UNAVAILABLE",
        source: "ttt",
        endpoint,
        measured_at_ms: ok ? fetchedAt : undefined,
        reason: ok ? undefined : focus ? `${label} has not been measured yet` : "focus-symbol lane only",
      };
    };
    switch (metric) {
      case "last_price":
        return statsMetric("last_price", s?.lastPrice);
      case "stats_24h": {
        const ok = measured(s?.change24hPct) && measured(s?.volume24hQuote);
        return {
          capability: true,
          availability: ok ? "available" : s ? "unavailable" : "unknown",
          currently_measured: ok,
          verdict: ok ? "MEASURED" : "UNAVAILABLE",
          source: "ttt",
          endpoint: "/futures/markets/stats",
          measured_at_ms: ok ? s?.provenance.fetched_at_ms : undefined,
          reason: ok ? undefined : s ? "24h change/volume are not both measured in the latest TTT stats row" : "no stats row yet",
        };
      }
      case "ohlcv":
        return { capability: true, availability: "unknown", currently_measured: false, verdict: "UNAVAILABLE", source: "ttt", endpoint: "/futures/udf/history", reason: "per-series; see coverage" };
      case "trades":
        return focusMetric("trades", this.tapeFetchedAtMs, "/futures/markets/trades");
      case "orderbook":
        return focusMetric("orderbook", this.orderBookFetchedAtMs, "/futures/markets/orderbook");
      case "funding":
        return statsMetric("funding", s?.fundingRate);
      case "funding_history":
        return focusMetric("funding_history", this.fundingHistory?.symbol === symbol ? this.fundingHistory.provenance.fetched_at_ms : null, "/futures/markets/funding-history");
      case "open_interest": {
        const out = statsMetric("open_interest", s?.openInterest);
        if (out.currently_measured) out.reason = "upstream field openInterest; semantics = base units per upstream naming";
        return out;
      }
      case "mark_price":
        return statsMetric("mark_price", s?.markPrice);
      case "index_price":
        return statsMetric("index_price", s?.indexPrice);
      case "basis": {
        const both = measured(s?.markPrice) && measured(s?.indexPrice);
        return { capability: true, availability: both ? "available" : s ? "unavailable" : "unknown", currently_measured: both, verdict: both ? "DERIVED" : "UNAVAILABLE", source: "ttt", endpoint: "/futures/markets/stats", derived: both, derivation_source: "mark,index", reason: both ? undefined : "mark/index not both measured", measured_at_ms: both ? s?.provenance.fetched_at_ms : undefined };
      }
      case "liquidations":
        return { capability: false, availability: "unavailable", currently_measured: false, verdict: "UNAVAILABLE", reason: "no documented public TTT endpoint for liquidations (probe 2026-09-05)" };
      case "long_short_ratio":
        return { capability: false, availability: "unavailable", currently_measured: false, verdict: "UNAVAILABLE", reason: "no documented public TTT endpoint for L/S ratio" };
      case "taker_volume":
        return { capability: true, availability: "unknown", currently_measured: false, verdict: "UNVERIFIED", reason: "trade prints carry side but aggressor semantics are not documented — not counted" };
      case "cvd":
        return { capability: false, availability: "unavailable", currently_measured: false, verdict: "UNAVAILABLE", reason: "CVD needs verified taker-side semantics; not inferred" };
      case "oi_snapshots": {
        return { capability: true, availability: "unknown", currently_measured: false, verdict: "UNAVAILABLE", derived: true, derivation_source: "stats.openInterest ring", reason: "delta/velocity derived from AsA snapshot ring; no current OI snapshot metric is exposed here" };
      }
      case "leverage_tiers":
        return { capability: true, availability: cat !== undefined ? "available" : "unknown", currently_measured: cat !== undefined, verdict: cat !== undefined ? "MEASURED" : "UNAVAILABLE", source: "ttt", endpoint: "/futures/markets", reason: cat ? undefined : "catalog not loaded" };
      default:
        return { capability: false, availability: "unknown", currently_measured: false, verdict: "UNAVAILABLE", reason: `metric '${metric}' not recognized` };
    }
  }

  recordError(kind: string, endpoint: string, message: string): void {
    this.tttErrors.push({ at_ms: Date.now(), kind, endpoint, message: message.slice(0, 200) });
    if (this.tttErrors.length > 100) this.tttErrors.shift();
  }
}

export function num(s: string | number | undefined | null): number {
  if (s === undefined || s === null) return NaN;
  const n = typeof s === "number" ? s : Number(s);
  return n;
}

/** NaN -> null: a missing/unparseable constraint is NULL, never a fake number. */
function nn(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

function tfMinutesFor(tf: string): number {
  const m: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "45m": 2700, "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800, "1d": 86400 };
  return m[tf] ?? 3600;
}

export { MINUTE_MS };
export const sharedStore = new MarketStore();
