/** GET /api/opportunities — stored opportunities, freshness recomputed. */
import { NextResponse } from "next/server";
import { getRepo } from "@/db/sqlite";
import { opportunityFreshness } from "@/lib/pipeline/orchestrator";

import { parseStoredPayload } from "@/lib/pipeline/provenance";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const now = Date.now();
  const repo = getRepo();
  const rows = repo.opportunityList(limit);
  const items = rows.map((r) => {
    const { payload, status: payload_status } = parseStoredPayload(r.payload_json);
    // INTERFACE (Task 3): freshness is timeframe-aware — pass the row's own
    // timeframe so the 4-bar window matches the strategy that produced it.
    const fresh = opportunityFreshness((payload.anchor_close_ms as number | null) ?? null, now, r.timeframe);
    const decisionState = r.state;
    const signal = repo.signalByOpp(r.id);
    const signalTerminal = signal !== null && !["candidate", "qualified", "published"].includes(signal.state);
    // Freshness is NOT the decision. READY freshness on a REJECTED row must
    // never present as an actionable opportunity.
    return {
      ...payload,
      payload_status,
      id: r.id,
      symbol: r.symbol,
      timeframe: r.timeframe,
      direction: r.direction,
      score: r.score,
      mode: r.mode,
      strategy_id: r.strategy_id,
      state: decisionState,
      created_ms: r.created_ms,
      updated_ms: r.updated_ms,
      fresh: fresh.state,
      age_ms: fresh.age_ms,
      freshness: {
        state: fresh.state === "EXPIRED" ? "EXPIRED" : "WITHIN_WINDOW",
        age_ms: fresh.age_ms,
        window_bars: 4,
        timeframe: r.timeframe,
      },
      signal_id: signal?.id ?? null,
      signal_state: signal?.state ?? null,
      actionable: decisionState === "READY" && fresh.state === "READY" && !signalTerminal,
      note: "Score is deterministic, never a calibrated probability. READY describes stored admission; actionable filters source freshness and linked lifecycle, not a fresh risk certificate. Publication revalidates current gates.",
    };
  });
  return NextResponse.json({ ok: true, count: items.length, items, ts: now });
}
