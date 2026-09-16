/**
 * Research registry — documented hypotheses + strategy list (structural
 * truth, not invented backtests). Research claims carry statuses.
 */
import { NextResponse } from "next/server";
import { listRuntimeStrategies } from "@/lib/strategy/runtime";
import { runtimeStatusFor } from "@/lib/pipeline/orchestrator";
import { promotionReport } from "@/lib/backtest/promotion";
import { EXIT_POLICY } from "@/lib/strategy/index";
import { verifyCompiledLineage, type LineageReport } from "@/lib/strategy/lineage";
import { getBrain } from "@/lib/brain/store";

export const dynamic = "force-dynamic";

const HYPOTHESES = [
  { id: "h-funding-extreme-meanrev", title: "Funding extremes precede moderation", status: "UNTESTED", evidence: "requires verified funding history + backtest w/ funding modelled", tested: false },
  { id: "h-mtf-alignment", title: "4H/1H/15M alignment improves R:R outcomes vs single-TF entries", status: "RESEARCH_CANDIDATE", evidence: "structural hypothesis only; no validated result exists", tested: false },
  { id: "h-oiv-velocity", title: "OI velocity regime filters range entries", status: "DATA_LIMITED", evidence: "OI snapshots derived from stats ring only since this build; needs weeks of data", tested: false },
] as const;

export async function GET(): Promise<NextResponse> {
  // AUDIT FIX (mandate B8): surface the Brain-lineage governance of
  // COMPILED_STRATEGIES explicitly. If the brain store is unavailable the
  // lineage is reported UNKNOWN — never silently "ok".
  let lineage: LineageReport | { unavailable: string };
  try {
    lineage = verifyCompiledLineage(getBrain().strategies());
  } catch (err) {
    lineage = { unavailable: `brain store not accessible: ${err instanceof Error ? err.message : String(err)}` };
  }
  return NextResponse.json({
    ok: true,
    hypotheses: HYPOTHESES,
    // Brain-backed registry: the same definitions live advisory and backtest use.
    brain_lineage: lineage,
    strategies: listRuntimeStrategies().map((s) => {
      // Promotion phase: the executable/validated/promotable/live states come
      // from the ONE deterministic gate, so this endpoint and
      // /api/brain/validation can never disagree about live eligibility.
      const promotion = promotionReport(s.strategy_id);
      return {
      id: s.setup_id,
      strategy_id: s.strategy_id,
      name: s.name,
      family: s.family,
      status: s.availability,
      version: s.version,
      // AUDIT FIX (P1-9): executability is NOT live eligibility. The old
      // `liveEligible: EXECUTABLE` field could expose executable-but-
      // unvalidated strategies as live to any API consumer.
      executable: s.availability === "EXECUTABLE",
      live_eligible: s.availability === "EXECUTABLE" && runtimeStatusFor(s.strategy_id) === "LIVE_ADVISORY_ONLY",
      promotion_decision: promotion.promotion.decision,
      promotion_stage: promotion.strategy_state.stage,
      validation_status: promotion.validation_status,
      blocking: promotion.blocking,
      timeframe: s.timeframe,
      direction: s.direction,
      rules: s.rule_ids,
      blocked_reason: s.blocked_reason,
      source_refs: s.source_refs,
    };
    }),
    exit_policy: EXIT_POLICY,
    note: "no hypothesis here claims validation; every row states its evidence state. executable ≠ live_eligible: live requires empirical OOS/walk-forward proof via the Brain gate",
    ts: Date.now(),
  });
}
