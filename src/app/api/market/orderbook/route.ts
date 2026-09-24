/** GET /api/market/orderbook?symbol=&refresh=1 — focus book lane. */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { sharedStore } from "@/lib/market/store";
import { sym } from "@/lib/api-common";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try { await ensureEngineBooted(); } catch { /* sym() reports NOT_READY when discovery is unavailable */ }
  const url = new URL(req.url);
  const { symbol, error } = sym(url.searchParams, "symbol", sharedStore.focusSymbol);
  if (error) return error;
  const book = sharedStore.orderBook && sharedStore.orderBook.symbol === symbol ? sharedStore.orderBook : null;
  if (!book || sharedStore.orderBookFetchedAtMs === null) return NextResponse.json({ ok: true, symbol, available: false, state: "UNAVAILABLE", age_ms: null, reason: "orderbook is a focus-symbol lane; it will appear after the next sweep" });
  const age = Date.now() - sharedStore.orderBookFetchedAtMs;
  return NextResponse.json({
    ok: true,
    symbol,
    available: true,
    state: age < 60_000 ? "LIVE" : age < 300_000 ? "STALE" : "DEGRADED",
    depthDecimal: book.depthDecimal,
    spread_abs: book.spreadAbs,
    spread_pct: book.spreadPct,
    bids: book.bids,
    asks: book.asks,
    provenance: book.provenance,
    age_ms: age,
  });
}
