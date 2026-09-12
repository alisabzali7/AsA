/**
 * GET /api/brain/unknowns — everything the corpus left unspecified.
 *
 * This endpoint exists so UNKNOWN is a first-class, browsable fact rather than
 * something buried in a status field. It lists UNKNOWN-marked source lines and
 * the strategies blocked by missing critical fields.
 */
import { NextResponse } from "next/server";
import { getBrain } from "@/lib/brain/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try {
    const url = new URL(req.url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
    const brain = getBrain();
    const stats = brain.stats();

    // strategies blocked by a missing critical field
    const blocked = brain.strategies()
      .filter((s) => s.unknown_critical.length > 0)
      .map((s) => ({
        strategy_id: s.strategy_id,
        canonical_name: s.canonical_name,
        family: s.family,
        unknown_critical: s.unknown_critical,
        runtime_status: s.runtime_status,
        disabled_reason: s.disabled_reason,
        source_refs: s.source_refs.slice(0, 3),
      }));

    // UNKNOWN-marked source lines, with provenance
    const lines = brain.searchFragments("UNKNOWN", limit)
      .filter((f) => f.fragment_class === "UNKNOWN_MARKER")
      .map((f) => ({ file: f.file_id, line: f.start_line, text: f.raw_text.slice(0, 400), tags: f.topic_tags }));

    const byField: Record<string, number> = {};
    for (const s of blocked) for (const f of s.unknown_critical) byField[f] = (byField[f] ?? 0) + 1;

    return NextResponse.json({
      ok: true,
      total_unknown_lines: stats.unknowns,
      strategies_blocked_by_unknown: blocked.length,
      unknown_by_critical_field: byField,
      strategies: blocked,
      source_lines: lines,
      note: "UNKNOWN is preserved exactly as the corpus left it — AsA never fills a missing entry/stop/target/timeframe/invalidation",
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), hint: "run `npm run brain:ingest`" },
      { status: 503 },
    );
  }
}
