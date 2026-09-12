/** GET /api/signals — advisory signals w/ explicit lifecycle states. */
import { NextResponse } from "next/server";
import { getRepo } from "@/db/sqlite";
import { SIGNAL_STATES } from "@/lib/pipeline/orchestrator";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const rows = getRepo().signalList(limit);
  const items = rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(r.payload_json) as Record<string, unknown>; } catch { /* ignore */ }
    return { id: r.id, state: r.state, symbol: r.symbol, timeframe: r.timeframe, direction: r.direction, score: r.score, strategy_id: r.strategy_id, opp_id: r.opp_id, created_ms: r.created_ms, updated_ms: r.updated_ms, payload };
  });
  return NextResponse.json({
    ok: true,
    states: SIGNAL_STATES,
    note: "signal ≠ order. AsA never executes; states are explicit; stale signals are expired by the engine.",
    items,
    count: items.length,
    ts: Date.now(),
  });
}
