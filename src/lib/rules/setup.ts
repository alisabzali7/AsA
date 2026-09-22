/**
 * Setup engine (Phase 2 §4).
 *
 * A setup composes rules into the canonical pipeline:
 *   CONTEXT -> LOCATION -> STRUCTURE -> TRIGGER -> CONFIRMATION -> INVALIDATION
 *
 * Result semantics (no boolean without explanation):
 *   PASS    every required stage passed
 *   FAIL    a required stage evaluated FALSE on good data
 *   UNKNOWN a required stage lacked the data to decide  (never treated as FAIL)
 *   BLOCKED a required stage is not formalizable, or an invalidation fired
 *
 * The same engine runs in live advisory and in backtest — there is no second
 * implementation to drift.
 */
import type { SourceRef } from "../brain/types";
import { evaluateRule, type FeatureBag, type RuleDefinition, type RuleEvaluation, type RuleOutcome } from "./engine";

export type SetupStage = "context" | "location" | "structure" | "trigger" | "confirmation" | "invalidation" | "filter";

export interface SetupDefinition {
  setup_id: string;
  strategy_id: string;
  name: string;
  direction: "long" | "short";
  timeframe: string;
  /** rules grouped by stage; a stage with no rules is skipped and reported */
  rules: RuleDefinition[];
  source_refs: SourceRef[];
  version: string;
}

export interface SetupEvaluation {
  setup_id: string;
  strategy_id: string;
  direction: "long" | "short";
  outcome: RuleOutcome;
  explanation: string;
  stages: {
    stage: SetupStage;
    outcome: RuleOutcome | "SKIPPED";
    rules: RuleEvaluation[];
    note: string;
  }[];
  passed_rules: string[];
  failed_rules: string[];
  unknown_rules: string[];
  blocked_rules: string[];
  evaluated_at_ms: number;
}

const REQUIRED_ORDER: SetupStage[] = ["context", "location", "structure", "trigger", "confirmation"];

/** Combine rule outcomes within one stage (all rules in a stage are ANDed). */
function combine(outcomes: RuleOutcome[]): RuleOutcome {
  if (outcomes.length === 0) return "PASS";
  if (outcomes.includes("BLOCKED")) return "BLOCKED";
  if (outcomes.includes("UNKNOWN")) return "UNKNOWN";
  if (outcomes.includes("FAIL")) return "FAIL";
  return "PASS";
}

export function evaluateSetup(def: SetupDefinition, bag: FeatureBag, now = Date.now()): SetupEvaluation {
  const stages: SetupEvaluation["stages"] = [];
  const passed: string[] = [], failed: string[] = [], unknown: string[] = [], blocked: string[] = [];

  const byStage = new Map<SetupStage, RuleDefinition[]>();
  for (const r of def.rules) {
    const list = byStage.get(r.kind) ?? [];
    list.push(r);
    byStage.set(r.kind, list);
  }

  const evalStage = (stage: SetupStage) => {
    const rules = byStage.get(stage) ?? [];
    if (rules.length === 0) {
      stages.push({ stage, outcome: "SKIPPED", rules: [], note: "no rule defined for this stage in the source" });
      return "PASS" as RuleOutcome;
    }
    const evals = rules.map((r) => evaluateRule(r, bag, now));
    for (const e of evals) {
      if (e.outcome === "PASS") passed.push(e.rule_id);
      else if (e.outcome === "FAIL") failed.push(e.rule_id);
      else if (e.outcome === "UNKNOWN") unknown.push(e.rule_id);
      else blocked.push(e.rule_id);
    }
    const outcome = combine(evals.map((e) => e.outcome));
    stages.push({
      stage,
      outcome,
      rules: evals,
      note: evals.map((e) => `${e.rule_id}:${e.outcome}`).join(", "),
    });
    return outcome;
  };

  // Outcome precedence: BLOCKED > UNKNOWN > FAIL > PASS. Collected as a list
  // and folded once, so no branch can silently overwrite a stronger verdict.
  const outcomes: RuleOutcome[] = [];
  const reasons: string[] = [];

  // filters are exclusions: a FAILED filter means the source forbids this trade.
  // UNKNOWN must also fold — an unevaluated exclusion is never evidence of
  // "no exclusion matched" (rule-engine contract: UNKNOWN never becomes positive).
  const filterOutcome = evalStage("filter");
  if (filterOutcome === "FAIL") {
    outcomes.push("BLOCKED");
    reasons.push("an exclusion filter matched — the source forbids trading in this condition");
  } else if (filterOutcome === "UNKNOWN") {
    outcomes.push("UNKNOWN");
    reasons.push("filter stage lacks data to decide — the unevaluated exclusion is not treated as clear");
  }

  for (const stage of REQUIRED_ORDER) {
    const o = evalStage(stage);
    if (o === "BLOCKED") { outcomes.push("BLOCKED"); reasons.push(`${stage} stage is not formalizable from source`); }
    else if (o === "UNKNOWN") { outcomes.push("UNKNOWN"); reasons.push(`${stage} stage lacks data to decide`); }
    else if (o === "FAIL") { outcomes.push("FAIL"); reasons.push(`${stage} condition not met`); }
  }

  // invalidation evaluated last: if its condition is currently TRUE the setup is void.
  // UNKNOWN must also fold — an unevaluated void-guard is never evidence the
  // setup is still valid (same rule-engine contract as above).
  const invalidation = evalStage("invalidation");
  if (invalidation === "PASS" && (byStage.get("invalidation")?.length ?? 0) > 0) {
    outcomes.push("BLOCKED");
    reasons.push("invalidation condition is currently TRUE — the setup is void");
  } else if (invalidation === "UNKNOWN") {
    outcomes.push("UNKNOWN");
    reasons.push("invalidation stage lacks data to decide — the unevaluated void-guard is not treated as clear");
  }

  const final: RuleOutcome = outcomes.includes("BLOCKED") ? "BLOCKED"
    : outcomes.includes("UNKNOWN") ? "UNKNOWN"
      : outcomes.includes("FAIL") ? "FAIL" : "PASS";

  return {
    setup_id: def.setup_id,
    strategy_id: def.strategy_id,
    direction: def.direction,
    outcome: final,
    explanation: reasons.length ? reasons.join("; ") : "all required stages passed",
    stages,
    passed_rules: passed,
    failed_rules: failed,
    unknown_rules: unknown,
    blocked_rules: blocked,
    evaluated_at_ms: now,
  };
}
