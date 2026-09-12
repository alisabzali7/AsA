/**
 * GET /api/brain/rules — the executable rule registry.
 *
 * Shows every rule bound to a compiled strategy with its verbatim source text,
 * predicates, feature dependencies and semantic status. Rules that could not be
 * formalized appear with their exact `unresolved` reason.
 */
import { NextResponse } from "next/server";
import { listRuntimeStrategies } from "@/lib/strategy/runtime";
import { getBrain } from "@/lib/brain/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const wantPredicates = url.searchParams.get("predicates") === "1";

  const executable = listRuntimeStrategies().flatMap((s) => {
    if (!s.impl) return [];
    return s.impl.setup().rules.map((r) => ({
      rule_id: r.id,
      strategy_id: s.strategy_id,
      setup_id: s.setup_id,
      kind: r.kind,
      description: r.description,
      source_text: r.source_text,
      source_refs: r.source_refs,
      source_status: r.source_status,
      empirical_status: r.empirical_status,
      feature_dependencies: r.feature_dependencies,
      predicates: r.predicates.map((p) => ({ expr: p.expr, requires: p.requires })),
      operator: r.operator,
      timeframe: r.timeframe,
      direction: r.direction,
      unresolved: r.unresolved,
      executable: r.unresolved.length === 0,
      version: r.version,
    }));
  });

  // Governance breakdown of the STORED source-text rules (remediation P1).
  let stored = 0;
  let storedBreakdown: Record<string, number> = {};
  let storedByStatus: Record<string, number> = {};
  try {
    const b = getBrain();
    stored = b.stats().rules;
    storedBreakdown = b.ruleClassCounts();
    storedByStatus = b.ruleSourceStatusCounts();
  } catch {
    stored = 0;
  }

  return NextResponse.json({
    ok: true,
    executable_rules: executable.length,
    stored_source_rules: stored,
    stored_by_rule_class: storedBreakdown,
    stored_by_source_status: storedByStatus,
    governance: {
      machine_executable: executable.length,
      unformalized: stored,
      runtime_candidates_among_stored: 0,
      note:
        "the ONLY machine-executable rules are the compiled ones listed here. Every stored source-text rule is DISABLED with an explicit non_executable_reason; none is a runtime candidate.",
    },
    note:
      "executable rules carry machine predicates; the remaining stored rules are source text with provenance and are deliberately NOT executable",
    rules: wantPredicates
      ? executable
      : executable.map(({ predicates, ...rest }) => ({ ...rest, predicate_count: predicates.length })),
    ts: Date.now(),
  });
}
