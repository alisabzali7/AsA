/** GET /api/market/prices — live board over the dynamic universe, one bounded aggregation pass. */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { sharedStore } from "@/lib/market/store";
import { universeMeta } from "@/lib/market/operational-universe";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    await ensureEngineBooted();
  } catch {
    /* report partial board even when boot is degraded */
  }
  const meta = universeMeta();
  if (!meta.discovery_complete) {
    return NextResponse.json({
      ok: false,
      source: "ttt",
      endpoint: "/futures/markets/stats",
      state: meta.state,
      error: `TTT discovery is ${meta.state}; prices are not ready`,
      last_error: meta.last_error,
      rows: [],
      totals: { total: 0, live: 0 },
      universe: meta,
      ts: Date.now(),
    }, { status: 503 });
  }
  const rows = sharedStore.liveRows();
  const sweepAge = sharedStore.lastStatsSweepAtMs === null ? null : Date.now() - sharedStore.lastStatsSweepAtMs;
  return NextResponse.json({
    ok: true,
    source: "ttt",
    endpoint: "/futures/markets/stats",
    stats_age_ms: sweepAge,
    universe: meta,
    rows,
    totals: { total: rows.length, live: rows.filter((r) => r.state === "LIVE" && r.price !== null).length },
    ts: Date.now(),
  });
}
