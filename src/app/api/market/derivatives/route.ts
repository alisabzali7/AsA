/**
 * GET /api/market/derivatives?symbol= — per-metric capability/availability/
 * measurement matrix (master §48). UNAVAILABLE stays UNAVAILABLE with the
 * reason; nothing is invented and nothing missing is shown as zero.
 */
import { NextResponse } from "next/server";
import { sharedStore } from "@/lib/market/store";
import { sym } from "@/lib/api-common";

export const dynamic = "force-dynamic";

const METRICS = [
  "last_price", "stats_24h", "ohlcv", "trades", "orderbook", "funding",
  "funding_history", "open_interest", "mark_price", "index_price", "basis",
  "liquidations", "long_short_ratio", "taker_volume", "cvd", "oi_snapshots", "leverage_tiers",
] as const;

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const { symbol, error } = sym(url.searchParams, "symbol", sharedStore.focusSymbol);
  if (error) return error;
  const metrics = METRICS.map((m) => ({ metric: m, ...sharedStore.metricTruth(symbol as string, m) }));
  return NextResponse.json({
    ok: true,
    symbol,
    note: "capability ≠ availability ≠ measurement; missing metrics are UNAVAILABLE with reason",
    metrics,
    ts: Date.now(),
  });
}
