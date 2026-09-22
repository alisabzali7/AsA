/**
 * Typed TTT client — the ONLY path to the venue (matches docs/architecture).
 * Each method validates shapes against live-verified contracts and attaches
 * provenance. Every request crosses the source guard (guard.ts) and the
 * safe-methods-only transport (http.ts).
 */
import { tttRequest, TttHttpError, type TttRequestResult } from "./http";
import { PRIORITY } from "./scheduler";
import { TTT_HAS_KEY } from "../env";
import { parseUdfHistory, derive1DFrom8h } from "./udf";
import { sourceName } from "./guard";
import {
  type TttMarketRaw,
  type TttStatsRaw,
  type TttTradeRaw,
  type TttOrderBookRaw,
  type TttFundingPageRaw,
  type TttQuoteRateRaw,
  type TttUdfRaw,
} from "./types";
import type { CandleSeries, Provenance, Candle } from "../domain/types";

export const SOURCE = sourceName();
/**
 * MARKET DATA IS ALWAYS UNSIGNED.
 * Measured 2026-09-06 against apiv2.thetruetrade.io: any request carrying an
 * `X-API-Key` header is rejected by the venue edge with HTTP 403 (nginx),
 * including the *public* `/futures/markets/stats` route that returns 200
 * without the header. Sending credentials therefore breaks market data
 * outright. Combined with the standing policy that TTT exposes no read-only
 * futures scope, the client never signs a market-data request: `AUTH` stays
 * undefined even when TTT_API_KEY/TTT_API_SECRET are configured.
 * Key presence is reported (masked) by the capability probe, never used here.
 */
const AUTH: { apiKey: string; apiSecret: string } | undefined = undefined;
/** True when credentials exist in env but are deliberately unused for market data. */
export const TTT_KEYS_PRESENT_BUT_UNUSED = TTT_HAS_KEY;

function prov(endpoint: string, res: TttRequestResult<unknown>, sourceTsMs?: number): Provenance {
  return {
    source_name: "ttt",
    endpoint,
    fetched_at_ms: res.fetched_at_ms,
    source_ts_ms: sourceTsMs,
    latency_ms: res.latency_ms,
    auth: AUTH ? "private" : "public",
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Does this error mean "TTT does not support this resolution"?
 *
 * ONLY an explicit unsupported-resolution signal qualifies. Timeouts, 5xx,
 * auth failures, rate limiting and transport errors are infrastructure
 * problems and must never authorise a derived-candle fallback.
 */
export function isUnsupportedResolution(err: unknown): boolean {
  if (!(err instanceof TttHttpError)) return false;
  // transport/availability failures are never "unsupported"
  if (err.kind === "timeout" || err.kind === "network" || err.kind === "server" ||
      err.kind === "rate_limited" || err.kind === "auth") return false;
  const msg = `${err.message} ${typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? "")}`.toLowerCase();
  return /unsupported[_ ]?resolution|invalid[_ ]?resolution|resolution not supported/.test(msg);
}

/**
 * LANE INTENT (Task 1).
 *
 * Every method below accepts an optional `priority`. It is INTENT ONLY: the
 * shared transport (http.ts) performs the single scheduler admission, once per
 * network attempt. The client never consumes budget itself, and a caller that
 * omits the lane simply gets the default background lane.
 */
export type LaneIntent = number | undefined;

export class TttClient {
  async getMarkets(priority: LaneIntent = PRIORITY.SWEEP): Promise<TttMarketRaw[]> {
    const res = await tttRequest<TttMarketRaw[]>("/futures/markets", { apiKey: AUTH?.apiKey, apiSecret: AUTH?.apiSecret, priority });
    if (!Array.isArray(res.data)) throw new Error("TTT /markets: expected array");
    return res.data.filter((m) => isObject(m) && typeof m.symbol === "string");
  }

  async getStats(priority: LaneIntent = PRIORITY.SWEEP): Promise<{ rows: TttStatsRaw[]; provenance: Provenance }> {
    const res = await tttRequest<TttStatsRaw[]>("/futures/markets/stats", { apiKey: AUTH?.apiKey, apiSecret: AUTH?.apiSecret, priority });
    if (!Array.isArray(res.data)) throw new Error("TTT /markets/stats: expected array");
    const rows = res.data.filter((r) => isObject(r) && typeof r.symbol === "string");
    const srcTs = parseIsoMs(rows[0]?.timestamp);
    return { rows, provenance: prov("/futures/markets/stats", res as TttRequestResult<unknown>, srcTs) };
  }

  async getTrades(symbol: string, priority: LaneIntent = PRIORITY.REFRESH): Promise<{ book: TttTradeRaw; provenance: Provenance }> {
    const res = await tttRequest<TttTradeRaw>(`/futures/markets/trades?symbol=${encodeURIComponent(symbol)}`, { apiKey: AUTH?.apiKey, apiSecret: AUTH?.apiSecret, retries: 1, priority });
    if (!isObject(res.data) || !Array.isArray((res.data as TttTradeRaw).trades)) throw new Error("TTT trades: unexpected shape");
    return { book: res.data, provenance: prov("/futures/markets/trades", res as TttRequestResult<unknown>) };
  }

  async getOrderBook(symbol: string, precision?: number, priority: LaneIntent = PRIORITY.REFRESH): Promise<{ book: TttOrderBookRaw; provenance: Provenance }> {
    let uri = `/futures/markets/orderbook?symbol=${encodeURIComponent(symbol)}`;
    if (precision !== undefined && Number.isInteger(precision)) uri += `&precision=${precision}`;
    const res = await tttRequest<TttOrderBookRaw>(uri, { apiKey: AUTH?.apiKey, apiSecret: AUTH?.apiSecret, retries: 1, priority });
    if (!isObject(res.data) || !Array.isArray((res.data as TttOrderBookRaw).asks) || !Array.isArray((res.data as TttOrderBookRaw).bids)) {
      throw new Error("TTT orderbook: unexpected shape");
    }
    return { book: res.data, provenance: prov(uri, res as TttRequestResult<unknown>) };
  }

  async getFundingHistory(symbol: string, page = 1, priority: LaneIntent = PRIORITY.SWEEP): Promise<{ page: TttFundingPageRaw; provenance: Provenance }> {
    const uri = `/futures/markets/funding-history?symbol=${encodeURIComponent(symbol)}&page=${page}`;
    const res = await tttRequest<TttFundingPageRaw>(uri, { apiKey: AUTH?.apiKey, apiSecret: AUTH?.apiSecret, retries: 1, priority });
    if (!isObject(res.data) || !Array.isArray((res.data as TttFundingPageRaw).items)) throw new Error("TTT funding-history: unexpected shape");
    return { page: res.data, provenance: prov(uri, res as TttRequestResult<unknown>) };
  }

  async getQuoteRates(priority: LaneIntent = PRIORITY.SWEEP): Promise<{ rates: TttQuoteRateRaw[]; provenance: Provenance }> {
    const res = await tttRequest<TttQuoteRateRaw[]>("/futures/quote-rates", { apiKey: AUTH?.apiKey, apiSecret: AUTH?.apiSecret, retries: 1, priority });
    if (!Array.isArray(res.data)) throw new Error("TTT quote-rates: expected array");
    return { rates: res.data, provenance: prov("/futures/quote-rates", res as TttRequestResult<unknown>) };
  }

  /**
   * Native candle history request. Returns NORMALIZED candles + integrity
   * meta + provenance. `resolution` is a TTT UDF resolution ('1','5',...,'1D').
   */
  async getUdfHistory(opts: {
    symbol: string;
    resolution: string;
    fromSec: number;
    toSec: number;
    countback?: number;
    tfMinutes: number;
    /** lane intent only — the transport charges the admission per attempt */
    priority?: number;
  }): Promise<{ series: CandleSeries; fetched_at_ms: number; no_data: boolean }> {
    const { symbol, resolution, fromSec, toSec, countback, tfMinutes, priority = PRIORITY.SWEEP } = opts;
    const q = [
      `symbol=${encodeURIComponent(symbol)}`,
      `resolution=${encodeURIComponent(resolution)}`,
      `from=${Math.floor(fromSec)}`,
      `to=${Math.floor(toSec)}`,
      countback ? `countback=${Math.max(1, Math.floor(countback))}` : null,
    ].filter(Boolean).join("&");
    const uri = `/futures/udf/history?${q}`;
    const res = await tttRequest<TttUdfRaw | { s: "no_data" }>(uri, { apiKey: AUTH?.apiKey, apiSecret: AUTH?.apiSecret, timeoutMs: 20_000, retries: 2, priority });
    const parsed = parseUdfHistory(res.data, tfMinutes);
    if (!parsed.meta.ok) {
      throw new Error(`TTT UDF ${symbol}@${resolution}: ${parsed.meta.reason ?? "invalid payload"}`);
    }
    return {
      series: {
        symbol,
        timeframe: String(resolution),
        candles: parsed.candles,
        native: true,
        source: "ttt",
        fetched_at_ms: res.fetched_at_ms,
        closed_count: parsed.candles.length,
      },
      fetched_at_ms: res.fetched_at_ms,
      // AUDIT FIX (mandate bug 5): expose the EXPLICIT no-data signal so
      // callers can distinguish "venue says no_data" (authoritative boundary)
      // from "s:ok with zero bars" (ambiguous empty-success — NOT a boundary
      // proof and NOT a license to derive).
      no_data: parsed.meta.no_data === true,
    };
  }

  /**
   * 1D resolver: NATIVE first (documented TTT resolution '1D', live-verified),
   * labeled 8H-derivation only if the native request returns nothing.
   */
  async getDailyCandles(symbol: string, targetBars: number, priority: LaneIntent = PRIORITY.SWEEP): Promise<CandleSeries> {
    const toSec = Math.floor(Date.now() / 1000);
    const spanSec = targetBars * 86400 + 86400;
    // FALLBACK POLICY (remediation P0-4).
    //
    // A bare catch previously converted ANY failure — timeout, HTTP 500, 403,
    // network error, malformed payload — into a synthetic 1D series derived
    // from 8h. That masked infrastructure outages as valid market data.
    //
    // Derivation is now permitted ONLY for the two semantics that genuinely
    // mean "the venue has no native 1D here":
    //   * an explicit no-data response (zero candles, s="no_data")
    //   * an explicit unsupported-resolution rejection
    // Every other error is PROPAGATED so callers see an outage as an outage.
    try {
      const native = await this.getUdfHistory({ symbol, resolution: "1D", fromSec: toSec - spanSec, toSec, countback: targetBars + 5, tfMinutes: 1440, priority });
      if (native.series.candles.length > 0) return native.series;
      if (native.no_data) {
        // explicit no-data -> labeled derivation is allowed
        return await this.derive1DFallback(symbol, targetBars, toSec, priority);
      }
      // AUDIT FIX (mandate bug 5): HTTP 200 s:"ok" with ZERO bars is an
      // ambiguous empty-success. It is NOT proof that the venue lacks native
      // 1D, so deriving a synthetic series here would mask a venue anomaly as
      // market data. Surface it instead.
      throw new Error(`TTT 1D ${symbol}: venue returned s:ok with zero candles (ambiguous empty-success; refusing to derive)`);
    } catch (err) {
      if (isUnsupportedResolution(err)) {
        // explicit unsupported-resolution -> labeled derivation is allowed
        return await this.derive1DFallback(symbol, targetBars, toSec, priority);
      }
      // timeout / 5xx / auth / rate limit / transport / malformed payload:
      // NEVER silently synthesise candles from an outage.
      throw err;
    }
  }

  private async derive1DFallback(symbol: string, targetBars: number, toSec: number, priority: LaneIntent = PRIORITY.SWEEP): Promise<CandleSeries> {
    const spanSec = targetBars * 3 * 28800 + 2 * 28800;
    const res = await this.getUdfHistory({ symbol, resolution: "480", fromSec: toSec - spanSec, toSec, countback: targetBars * 3 + 6, tfMinutes: 480, priority });
    const { candles } = derive1DFrom8h(res.series.candles);
    return {
      symbol,
      timeframe: "1d",
      candles: candles.slice(-targetBars),
      native: false,
      derived_source_tf: "8h",
      source: "ttt",
      fetched_at_ms: res.fetched_at_ms,
      closed_count: candles.length,
    };
  }
}

function parseIsoMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : undefined;
}

export type { Candle };
export const tttClient = new TttClient();
