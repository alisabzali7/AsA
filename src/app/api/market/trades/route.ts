/** GET /api/market/trades?symbol= — focus tape (side semantics UNVERIFIED). */
import { NextResponse } from "next/server";
import { sharedStore } from "@/lib/market/store";
import { sym } from "@/lib/api-common";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const { symbol, error } = sym(url.searchParams, "symbol", sharedStore.focusSymbol);
  if (error) return error;
  const tape = sharedStore.tape.filter((t) => t.symbol === symbol).slice(-50);
  return NextResponse.json({
    ok: true,
    symbol,
    source: "ttt",
    endpoint: "/futures/markets/trades",
    side_semantics: "UNVERIFIED",
    note: "trade prints carry side=ASK/BID but taker-aggressor semantics are not documented — no CVD/flow inference is made",
    fetched_at_ms: sharedStore.tapeFetchedAtMs,
    trades: tape,
    ts: Date.now(),
  });
}
