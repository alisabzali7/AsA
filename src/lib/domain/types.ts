/**
 * Canonical market-domain types. Business logic consumes these; provider
 * adapters translate upstream JSON -> canonical (ttt/).
 * Provenance rules: a value that travels without provenance does not exist.
 */

/** The only production market-data source. Guarded centrally (ttt/guard.ts). */
export const MARKET_SOURCE = "ttt" as const;
export type MarketSourceName = typeof MARKET_SOURCE;

export interface Provenance {
  source_name: MarketSourceName;
  endpoint: string;
  fetched_at_ms: number; // received by AsA
  source_ts_ms?: number; // upstream timestamp when one exists
  latency_ms?: number; // measured request duration
  auth: "public" | "private";
  note?: string;
}

/** Truth taxonomy used across the whole app (§78 semantics). */
export type AppState =
  | "CONNECTING"
  | "CONNECTED"
  | "LIVE"
  | "DEGRADED"
  | "STALE"
  | "UNAVAILABLE"
  | "NOT_CONFIGURED"
  | "INSUFFICIENT_DATA"
  | "ERROR"
  | "READY"
  | "REJECTED"
  | "COOLDOWN"
  | "IDLE";

/** CAPABILITY vs AVAILABILITY vs MEASUREMENT (master §48) — three axes. */
export type VerdictKind = "MEASURED" | "DERIVED" | "PROXY" | "UNVERIFIED" | "UNAVAILABLE";

export interface MetricTruth {
  /** this system knows how to request/compute the field */
  capability: boolean;
  /** upstream can currently supply the field */
  availability: "available" | "unavailable" | "unknown";
  /** a valid value was observed now */
  currently_measured: boolean;
  verdict: VerdictKind;
  source?: MarketSourceName;
  endpoint?: string;
  /** UNAVAILABLE/UNKNOWN/UNVERIFIED must carry a human reason */
  reason?: string;
  /** non-empty only when currently_measured */
  measured_at_ms?: number;
  derived?: boolean;
  /** e.g. "1D" -> derivation source timeframe */
  derivation_source?: string;
}

export interface Candle {
  /** epoch seconds, aligned to timeframe open */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type CandleProvenance = "NATIVE" | "DERIVED";

export interface CandleSeries {
  symbol: string;
  timeframe: string; // TimeframeId
  candles: Candle[];
  native: boolean; // NATIVE TTT data
  /** when native=false: which TTF timeframe the series was derived from */
  derived_source_tf?: string;
  source: MarketSourceName;
  fetched_at_ms: number;
  // integrity accounting (computed on normalize)
  closed_count?: number;
}

export interface SymbolStats {
  symbol: string;
  lastPrice: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  fundingRate: number | null;
  nextFundingTimeMs: number | null;
  fundingIntervalHours: number | null;
  change24hPct: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24hQuote: number | null;
  openInterest: number | null; // base units (semantics: upstream 'openInterest')
  openValue: number | null; // quote units
  provenance: Provenance;
}

export interface MarketStatusRow {
  symbol: string;
  price: number | null;
  state: AppState;
  age_ms: number | null; // age of the freshest price source
  source: MarketSourceName | null;
  endpoint: string | null;
  received_ts_ms: number | null;
  price_source_ts_ms: number | null;
  reason?: string;
}

export interface TradePrint {
  symbol: string;
  price: number;
  size: number;
  side: "ASK" | "BID" | "UNKNOWN";
  ts_ms: number;
  /** taker-side semantics are NOT verified on TTT (docs §side unverified) */
  side_semantics: "UNVERIFIED";
  provenance: Provenance;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  depthDecimal: number | null;
  spreadAbs: number | null;
  spreadPct: number | null;
  provenance: Provenance;
}

export interface FundingObservation {
  symbol: string;
  calc_time_ms: number;
  last_funding_rate: number;
  mark_price: number | null;
  provenance: Provenance;
}

/** Coverage object per symbol/timeframe (master §54). */
export interface SeriesCoverage {
  symbol: string;
  timeframe: string;
  first_ts_ms: number | null;
  last_ts_ms: number | null;
  bar_count: number;
  gap_count: number;
  duplicates: number;
  native_or_derived: "NATIVE" | "DERIVED";
  derivation_source_tf?: string;
  source: MarketSourceName;
  last_fetch_ms: number | null;
  status: "OK" | "PARTIAL" | "INSUFFICIENT" | "ERROR" | "PENDING" | "UNAVAILABLE";
  reason?: string;
  target_bars: number;
}
