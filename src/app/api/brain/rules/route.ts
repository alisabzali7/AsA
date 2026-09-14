/**
 * GET /api/brain/rules — the complete rule registry (rule-graph closure).
 *
 * Two governed populations, one endpoint:
 *  1. MACHINE rules — every runtime RuleDefinition, shown both as the live
 *     runtime representation AND as its Brain registry row
 *     (rule_class MACHINE_EXECUTABLE_RULE, registered by ingest). A
 *     bidirectional closure check proves the two agree.
 *  2. SOURCE-TEXT rules — stored corpus sentences with provenance, all
 *     DISABLED with an explicit non_executable_reason; never runtime
 *     candidates.
 *
 * ?predicates=1 also returns the structural predicate expressions.
 */
import { NextResponse } from "next/server";
import { listRuntimeStrategies } from "@/lib/strategy/runtime";
import { buildMachineRuleGraph, verifyRuleRegistryClosure, type RuleClosureReport } from "@/lib/strategy/rule-graph";
import { getBrain } from "@/lib/brain/store";
import type { RuleSpec } from "@/lib/brain/types";

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

  // Registry read-back + closure verification. If the brain store is
  // unavailable the closure is reported UNKNOWN — never silently "ok".
  let stored = 0;
  let storedMachine = 0;
  let storedText = 0;
  let storedBreakdown: Record<string, number> = {};
  let storedByStatus: Record<string, number> = {};
  let registryRows: RuleSpec[] = [];
  let closure: RuleClosureReport | { unavailable: string };
  try {
    const b = getBrain();
    registryRows = b.rules();
    stored = registryRows.length;
    storedMachine = registryRows.filter((r) => r.rule_class === "MACHINE_EXECUTABLE_RULE").length;
    storedText = stored - storedMachine;
    storedBreakdown = b.ruleClassCounts();
    storedByStatus = b.ruleSourceStatusCounts();
    closure = verifyRuleRegistryClosure({
      graph: buildMachineRuleGraph(),
      registryRules: registryRows,
      strategies: b.strategies(),
    });
  } catch (err) {
    closure = { unavailable: `brain store not accessible: ${err instanceof Error ? err.message : String(err)}` };
  }

  const machineRows = registryRows.filter((r) => r.rule_class === "MACHINE_EXECUTABLE_RULE");

  return NextResponse.json({
    ok: true,
    executable_rules: executable.length,
    stored_rules: stored,
    stored_machine_rules: storedMachine,
    stored_source_rules: storedText,
    stored_by_rule_class: storedBreakdown,
    stored_by_source_status: storedByStatus,
    governance: {
      machine_executable: executable.length,
      unformalized_source_text: storedText,
      runtime_candidates_among_source_text: 0,
      note:
        "machine-executable rules are registered in the Brain rule registry as MACHINE_EXECUTABLE_RULE rows with predicates, feature dependencies, provenance and an explicit runtime binding; every source-text rule stays DISABLED with an explicit non_executable_reason and is never a runtime candidate",
    },
    // Bidirectional registry↔runtime closure. `ok:false` (or unavailable)
    // means the registry and the runtime disagree — an auditable defect.
    closure,
    machine_registry_rows: machineRows.map((r) => ({
      rule_id: r.rule_id,
      rule_class: r.rule_class,
      predicates: wantPredicates ? r.predicates : undefined,
      predicate_count: r.predicates.length,
      required_features: r.required_features,
      direction: r.direction,
      timeframe: r.timeframe,
      source_refs: r.source_refs,
      source_status: r.source_status,
      runtime_status: r.runtime_status,
      binding: r.binding,
      non_executable_reason: r.non_executable_reason,
    })),
    rules: wantPredicates
      ? executable
      : executable.map(({ predicates, ...rest }) => ({ ...rest, predicate_count: predicates.length })),
    ts: Date.now(),
  });
}
