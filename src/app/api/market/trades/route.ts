/** GET /api/market/trades?symbol= — focus tape (side semantics UNVERIFIED). */
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
  const tape = sharedStore.tape.filter((t) => t.symbol === symbol).slice(-50);
  const isFocus = symbol === sharedStore.focusSymbol;
  const measured = isFocus && sharedStore.tapeFetchedAtMs !== null;
  const age = measured ? Date.now() - (sharedStore.tapeFetchedAtMs as number) : null;
  return NextResponse.json({
    ok: true,
    symbol,
    available: measured,
    state: age === null ? "UNAVAILABLE" : age < 60_000 ? "LIVE" : age < 300_000 ? "STALE" : "DEGRADED",
    reason: measured ? undefined : isFocus ? "trade tape has not been measured yet" : "trade tape is a focus-symbol lane",
    source: "ttt",
    endpoint: "/futures/markets/trades",
    side_semantics: "UNVERIFIED",
    note: "trade prints carry side=ASK/BID but taker-aggressor semantics are not documented — no CVD/flow inference is made",
    fetched_at_ms: measured ? sharedStore.tapeFetchedAtMs : null,
    age_ms: age,
    trades: measured ? tape : [],
    ts: Date.now(),
  });
}
