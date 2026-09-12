/**
 * Raw upstream response types for the documented TTT v2 endpoints.
 * Shapes captured from LIVE probes on 2026-09-05 (see tests/fixtures/live/
 * and docs/ttt-integration.md). No undocumented fields are invented.
 * All numeric-looking JSON values arrive as strings unless noted.
 */

export interface TttErrorBody {
  errors: { message: string; field?: string }[];
}

/* GET /futures/markets — full instrument catalog */
export interface TttLeverageTier {
  minNotional: string;
  maxNotional: string;
  maxLeverage: number;
  maintenanceMarginRate: string;
}
export interface TttMarketRaw {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  category: string;
  name: string;
  tickSize: string;
  stepSize: string;
  minLeverage: number;
  maxLeverage: number;
  defaultLeverage: number;
  maintenanceMarginRate: string;
  maxPriceImpact: string;
  leverageTiers: TttLeverageTier[];
  precisions: string[];
  isActive: boolean;
  makerFeeCoefficient: string;
  takerFeeCoefficient: string;
}

/* GET /futures/markets/stats — full-universe snapshot */
export interface TttStatsRaw {
  symbol: string;
  lastPrice: string;
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  nextFundingTime: string; // ISO 8601 UTC
  minFundingRate: string;
  maxFundingRate: string;
  interestRate: string;
  fundingIntervalHours: number;
  change24h: string;
  change24hPct: string;
  high24h: string;
  low24h: string;
  volume24hBase: string;
  volume24hQuote: string;
  openInterest: string; // base units (per upstream naming)
  openValue: string; // quote units
  turnover24hQuote: string;
  timestamp: string; // ISO 8601 UTC — server generation time
}

/* GET /futures/markets/trades?symbol= */
export interface TttTradeRaw {
  symbol: string;
  trades: {
    price: string;
    size: string;
    side: "ASK" | "BID"; // semantics NOT documented as taker-aggressor — UNVERIFIED
    timestamp: number; // epoch ms
  }[];
}

/* GET /futures/markets/orderbook?symbol= [&precision=] */
export interface TttBookLevelRaw {
  price: string;
  size: string;
  total: string;
  count: number;
}
export interface TttOrderBookRaw {
  symbol: string;
  depthDecimal: number;
  asks: TttBookLevelRaw[];
  bids: TttBookLevelRaw[];
}

/* GET /futures/markets/funding-history?symbol=&page= */
export interface TttFundingPageRaw {
  meta: {
    totalItems: number;
    itemCount: number;
    itemsPerPage: number;
    totalPages: number;
    currentPage: number;
  };
  items: {
    calcTime: string; // ISO UTC
    symbol: string;
    lastFundingRate: string;
    markPrice: string;
    minFundingRate: string;
    maxFundingRate: string;
    interestRate: string;
    fundingIntervalHours: number;
  }[];
}

/* GET /futures/udf/history — TradingView-compatible UDF */
export interface TttUdfRaw {
  s: "ok";
  t: number[]; // epoch SECONDS
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}
export interface TttUdfNoData {
  s: "no_data";
}

/* GET /futures/quote-rates */
export interface TttQuoteRateRaw {
  quoteAsset: string;
  rate: string;
  timestamp: string; // ISO UTC
}
