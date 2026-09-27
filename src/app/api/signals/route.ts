/** GET /api/signals — advisory signals w/ explicit lifecycle states. */
import { NextResponse } from "next/server";
import { getRepo } from "@/db/sqlite";
import { SIGNAL_STATES, refreshSignalExpiry } from "@/lib/pipeline/signal-lifecycle";
import { signalDelivery, parseStoredPayload } from "@/lib/pipeline/provenance";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const repo = getRepo();
  const rows = repo.signalList(limit);
  const now = Date.now();
  const items = rows.map((stored) => {
    const r = refreshSignalExpiry(repo, stored, now);
    const { payload, status: payload_status } = parseStoredPayload(r.payload_json);
    // T05 T4: signal -> outbox -> live delivery state (read from the outbox row, never copied)
    const delivery = signalDelivery(repo, r, now);
    return { id: r.id, state: r.state, symbol: r.symbol, timeframe: r.timeframe, direction: r.direction, score: r.score, strategy_id: r.strategy_id, opp_id: r.opp_id, outbox_id: delivery.outbox_id, created_ms: r.created_ms, updated_ms: r.updated_ms, delivery, payload, payload_status };
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
