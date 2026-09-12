/**
 * Research registry — documented hypotheses + strategy list (structural
 * truth, not invented backtests). Research claims carry statuses.
 */
import { NextResponse } from "next/server";
import { listRuntimeStrategies } from "@/lib/strategy/runtime";
import { EXIT_POLICY } from "@/lib/strategy/index";

export const dynamic = "force-dynamic";

const HYPOTHESES = [
  { id: "h-funding-extreme-meanrev", title: "Funding extremes precede moderation", status: "UNTESTED", evidence: "requires verified funding history + backtest w/ funding modelled", tested: false },
  { id: "h-mtf-alignment", title: "4H/1H/15M alignment improves R:R outcomes vs single-TF entries", status: "RESEARCH_CANDIDATE", evidence: "structural hypothesis only; no validated result exists", tested: false },
  { id: "h-oiv-velocity", title: "OI velocity regime filters range entries", status: "DATA_LIMITED", evidence: "OI snapshots derived from stats ring only since this build; needs weeks of data", tested: false },
] as const;

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    ok: true,
    hypotheses: HYPOTHESES,
    // Brain-backed registry: the same definitions live advisory and backtest use.
    strategies: listRuntimeStrategies().map((s) => ({
      id: s.setup_id,
      strategy_id: s.strategy_id,
      name: s.name,
      family: s.family,
      status: s.availability,
      version: s.version,
      liveEligible: s.availability === "EXECUTABLE",
      timeframe: s.timeframe,
      direction: s.direction,
      rules: s.rule_ids,
      blocked_reason: s.blocked_reason,
      source_refs: s.source_refs,
    })),
    exit_policy: EXIT_POLICY,
    note: "no hypothesis here claims validation; every row states its evidence state",
    ts: Date.now(),
  });
}
