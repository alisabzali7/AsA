/** GET /api/market/orderbook?symbol=&refresh=1 — focus book lane. */
import { NextResponse } from "next/server";
import { sharedStore } from "@/lib/market/store";
import { sym } from "@/lib/api-common";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const { symbol, error } = sym(url.searchParams, "symbol", sharedStore.focusSymbol);
  if (error) return error;
  const book = sharedStore.orderBook && sharedStore.orderBook.symbol === symbol ? sharedStore.orderBook : null;
  if (!book) return NextResponse.json({ ok: true, symbol, available: false, reason: "orderbook is a focus-symbol lane; it will appear after the next sweep" });
  return NextResponse.json({
    ok: true,
    symbol,
    available: true,
    depthDecimal: book.depthDecimal,
    spread_abs: book.spreadAbs,
    spread_pct: book.spreadPct,
    bids: book.bids,
    asks: book.asks,
    provenance: book.provenance,
    age_ms: Date.now() - (sharedStore.orderBookFetchedAtMs ?? 0),
  });
}
