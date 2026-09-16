/**
 * GET /api/brain/strategies — the canonical strategy registry.
 *
 * Query: ?family=…&runtime=…&q=…&limit=…
 *
 * Every row carries provenance and an explicit reason for its runtime status,
 * so "why is this disabled?" is always answerable from the API alone.
 */
import { NextResponse } from "next/server";
import { getBrain } from "@/lib/brain/store";
import { gateStrategy } from "@/lib/brain/gate";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try {
    const url = new URL(req.url);
    const family = url.searchParams.get("family");
    const runtime = url.searchParams.get("runtime");
    const q = url.searchParams.get("q")?.toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));

    const brain = getBrain();
    let rows = brain.strategies();
    if (family) rows = rows.filter((s) => s.family === family);
    if (runtime) rows = rows.filter((s) => s.runtime_status === runtime);
    if (q) {
      rows = rows.filter(
        (s) => s.canonical_name.toLowerCase().includes(q) || s.aliases.some((a) => a.toLowerCase().includes(q)),
      );
    }

    const out = rows.slice(0, limit).map((s) => {
      const verdict = gateStrategy(s);
      return {
        strategy_id: s.strategy_id,
        canonical_name: s.canonical_name,
        family: s.family,
        aliases: s.aliases,
        type: s.type,
        description: s.description,
        source_status: s.source_status,
        empirical_status: s.empirical_status,
        runtime_status: s.runtime_status,
        runtime_ceiling: verdict.ceiling,
        why: verdict.reasons,
        unknown_critical: s.unknown_critical,
        has_executable_spec: s.implementation !== null,
        setup_ids: s.setup_ids,
        source_refs: s.source_refs.slice(0, 8),
        version: s.version,
      };
    });

    return NextResponse.json({
      ok: true,
      total: rows.length,
      returned: out.length,
      strategies: out,
      note:
        "empirical_status is NEVER inferred from source_status; UNTESTED strategies cannot go live. " +
        "`runtime_ceiling` here is the ceiling of the CORPUS record; the evidence-backed ceiling and the " +
        "promotion decision live in GET /api/brain/validation (the same deterministic gate runtime uses).",
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), hint: "run `npm run brain:ingest`" },
      { status: 503 },
    );
  }
}
