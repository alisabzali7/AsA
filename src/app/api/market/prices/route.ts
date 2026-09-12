/** GET /api/market/prices — 48-row live board, one bounded aggregation pass. */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { sharedStore } from "@/lib/market/store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    await ensureEngineBooted();
  } catch {
    /* report partial board even when boot is degraded */
  }
  const rows = sharedStore.liveRows();
  const sweepAge = sharedStore.lastStatsSweepAtMs === null ? null : Date.now() - sharedStore.lastStatsSweepAtMs;
  return NextResponse.json({
    ok: true,
    source: "ttt",
    endpoint: "/futures/markets/stats",
    stats_age_ms: sweepAge,
    rows,
    totals: { total: rows.length, live: rows.filter((r) => r.state === "LIVE" && r.price !== null).length },
    ts: Date.now(),
  });
}
