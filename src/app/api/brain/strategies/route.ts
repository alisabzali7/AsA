/**
 * GET /api/brain/strategies — the canonical strategy registry.
 *
 * Query: ?family=…&runtime=…&q=…&limit=…
 *
 * Every row carries provenance and an explicit reason for its runtime status,
 * so "why is this disabled?" is always answerable from the API alone.
 *
 * EXECUTABLE-STATUS SEMANTICS (aligned with GET /api/research/strategies):
 * `has_executable_spec` means ONLY "a compiled implementation binding exists in
 * the runtime registry" — it does NOT mean the strategy is executable or
 * live-eligible. The runtime registry's own verdict is exposed additively as
 * `runtime_availability` (null when the Brain record has no compiled runtime
 * definition at all), and `research_computable` carries exactly the same
 * meaning it has on the research endpoint. Live eligibility is NEVER derived
 * here; it lives in GET /api/brain/validation (the deterministic promotion
 * gate).
 */
import { NextResponse } from "next/server";
import { getBrain } from "@/lib/brain/store";
import { gateStrategy } from "@/lib/brain/gate";
import { listRuntimeStrategies } from "@/lib/strategy/runtime";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try {
    const url = new URL(req.url);
    const family = url.searchParams.get("family");
    const runtime = url.searchParams.get("runtime");
    const q = url.searchParams.get("q")?.toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));

    const brain = getBrain();
    // Runtime-registry view keyed by Brain strategy id. A strategy may compile
    // to several setups (long + short); the availability is per strategy id
    // (all setups of one strategy share it in the current registry), but the
    // projection is derived from the definitions themselves — never asserted.
    const runtimeByStrategy = new Map<string, { availability: string; research_computable: boolean }>();
    for (const def of listRuntimeStrategies()) {
      const researchComputable = def.impl !== null && (def.availability === "EXECUTABLE" || def.availability === "RESEARCH_ONLY");
      const existing = runtimeByStrategy.get(def.strategy_id);
      // If variants ever disagreed, report the weakest honest state rather
      // than a fabricated aggregate.
      if (!existing) {
        runtimeByStrategy.set(def.strategy_id, { availability: def.availability, research_computable: researchComputable });
      } else if (existing.availability !== def.availability || existing.research_computable !== researchComputable) {
        runtimeByStrategy.set(def.strategy_id, { availability: "MIXED", research_computable: existing.research_computable && researchComputable });
      }
    }

    let rows = brain.strategies();
    if (family) rows = rows.filter((s) => s.family === family);
    if (runtime) rows = rows.filter((s) => s.runtime_status === runtime);
    if (q) {
      rows = rows.filter(
        (s) => s.canonical_name.toLowerCase().includes(q) || s.aliases.some((a) => a.toLowerCase().includes(q)),
      );
    }

    // Canonical conflict input: the linked group's RESOLUTION decides, never the
    // mere presence of the link (see `brain/conflicts.ts`).
    const conflictGroups = brain.conflicts();
    const out = rows.slice(0, limit).map((s) => {
      const verdict = gateStrategy(s, conflictGroups);
      const runtimeView = runtimeByStrategy.get(s.strategy_id) ?? null;
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
        // runtime-registry view of the SAME strategy id; null = no compiled
        // runtime definition exists (text-only Brain record)
        runtime_availability: runtimeView?.availability ?? null,
        // identical semantics to GET /api/research/strategies `research_computable`
        research_computable: runtimeView?.research_computable ?? false,
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
        "`has_executable_spec` = a compiled implementation binding exists (research-computable code path); it does NOT mean executable or live-eligible — " +
        "the runtime registry's own verdict is `runtime_availability` (null = no compiled runtime definition), and `research_computable` matches GET /api/research/strategies. " +
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
