/** GET /api/opportunities — stored opportunities, freshness recomputed. */
import { NextResponse } from "next/server";
import { getRepo } from "@/db/sqlite";
import { opportunityFreshness } from "@/lib/pipeline/orchestrator";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const now = Date.now();
  const rows = getRepo().opportunityList(limit);
  const items = rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(r.payload_json) as Record<string, unknown>; } catch { /* ignore */ }
    const fresh = opportunityFreshness((payload.anchor_close_ms as number | null) ?? null, now);
    return {
      ...payload,
      id: r.id,
      symbol: r.symbol,
      timeframe: r.timeframe,
      direction: r.direction,
      score: r.score,
      mode: r.mode,
      strategy_id: r.strategy_id,
      created_ms: r.created_ms,
      updated_ms: r.updated_ms,
      fresh: fresh.state,
      age_ms: fresh.age_ms,
      note: "85 is a deterministic score — never a calibrated probability",
    };
  });
  return NextResponse.json({ ok: true, count: items.length, items, ts: now });
}
