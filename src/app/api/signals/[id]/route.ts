/** GET /api/signals/[id] — one advisory signal with live delivery provenance. */
import { NextResponse } from "next/server";
import { getRepo } from "@/db/sqlite";
import { SIGNAL_STATES, refreshSignalExpiry } from "@/lib/pipeline/signal-lifecycle";
import { signalDelivery, parseStoredPayload } from "@/lib/pipeline/provenance";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: raw } = await ctx.params;
  const id = raw; // Next has already decoded route params; do not decode twice.
  const repo = getRepo();
  let row = repo.signalGet(id) ?? (id.startsWith("sig-") ? repo.signalByOpp(id.slice(4)) : repo.signalByOpp(id));
  if (!row) {
    return NextResponse.json({ ok: false, error: "signal not found", states: SIGNAL_STATES }, { status: 404 });
  }
  row = refreshSignalExpiry(repo, row, Date.now());
  const { payload, status: payload_status } = parseStoredPayload(row.payload_json);
  const now = Date.now();
  const delivery = signalDelivery(repo, row, now);
  return NextResponse.json({
    ok: true,
    note: "signal ≠ order. Delivery state is read live from the outbox row and is not copied onto the decision.",
    item: {
      id: row.id,
      state: row.state,
      symbol: row.symbol,
      timeframe: row.timeframe,
      direction: row.direction,
      score: row.score,
      strategy_id: row.strategy_id,
      opp_id: row.opp_id,
      outbox_id: delivery.outbox_id,
      created_ms: row.created_ms,
      updated_ms: row.updated_ms,
      delivery,
      payload,
      payload_status,
      lifecycle: { source: "recorded_transitions", history: repo.signalHistory(row.id), note: "Legacy history before audit capture is unknown." },
    },
    ts: now,
  });
}
