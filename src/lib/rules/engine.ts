/**
 * Rule evaluator (Phase 2 §3).
 *
 * A RuleDefinition binds natural-language source text to a deterministic
 * predicate over FeatureValues. The evaluator returns a four-state result —
 * PASS / FAIL / BLOCKED / UNKNOWN — and NEVER a bare boolean: every outcome
 * carries an explanation and the features it consulted.
 *
 * UNKNOWN PROPAGATION is the core safety property. If a required feature is
 * invalid (insufficient bars, stale, unavailable), the rule is UNKNOWN, not
 * FAIL. A setup containing any UNKNOWN required rule is itself UNKNOWN, so
 * missing data can never masquerade as a satisfied or rejected condition.
 */
import type { SourceRef, SourceStatus, EmpiricalStatus } from "../brain/types";
import type { FeatureValue } from "../features/types";

export type RuleOutcome = "PASS" | "FAIL" | "BLOCKED" | "UNKNOWN";

export interface FeatureBag {
  /** feature_id -> value; detectors are run by the setup engine */
  get(id: string): FeatureValue<unknown> | undefined;
}

export interface RulePredicate {
  /** short machine-readable expression, e.g. "FTR-LEVEL-TOUCH.value != null" */
  expr: string;
  /** the actual test; receives the feature bag */
  test(bag: FeatureBag): { ok: boolean; detail: string };
  /**
   * Features THIS predicate reads. Enforced by `evaluateRule`: a predicate whose
   * required feature is missing / invalid is UNDECIDABLE (null), never false, so
   * an unavailable measurement cannot be reported as a measured FAIL.
   *
   * `RuleDefinition.feature_dependencies` is the rule-level dependency list (a
   * rule cannot run at all without them → the whole rule is UNKNOWN). `requires`
   * is per-predicate and matters when a rule combines predicates with OR/AND:
   * one unreadable branch must not erase a branch that WAS measured.
   */
  requires: string[];
  /**
   * Set when the predicate does NOT measure the quantity the source names but
   * a stand-in for it (e.g. the source says "CD slope" but CD has not formed
   * at evaluation time). A proxy is never SOURCE_DERIVED: its classification
   * says who defined it. Metadata only — it never changes the test result.
   */
  proxy?: { measured: string; stands_for: string; classification: "ENGINEERING_DEFINED" | "LEGACY_BEHAVIOR"; reason: string };
}

export interface RuleDefinition {
  id: string;
  description: string;
  /** verbatim source sentence this rule encodes */
  source_text: string;
  source_refs: SourceRef[];
  source_status: SourceStatus;
  empirical_status: EmpiricalStatus;
  feature_dependencies: string[];
  predicates: RulePredicate[];
  /** how predicates combine */
  operator: "AND" | "OR";
  timeframe: string;
  direction: "long" | "short" | "both" | "none";
  kind: "context" | "location" | "structure" | "trigger" | "confirmation" | "invalidation" | "filter";
  /** set when the source text could not be fully formalized */
  unresolved: string[];
  version: string;
}

export interface RuleEvaluation {
  rule_id: string;
  outcome: RuleOutcome;
  explanation: string;
  predicate_results: { expr: string; ok: boolean | null; detail: string }[];
  missing_features: string[];
  features_used: string[];
  source_refs: SourceRef[];
  timeframe: string;
  evaluated_at_ms: number;
}

/**
 * Evaluate one rule.
 *
 * Order of checks matters:
 *  1. a rule with unresolved source semantics is BLOCKED (never guessed)
 *  2. a rule missing required feature data is UNKNOWN
 *  3. a predicate missing one of its own `requires` features is UNDECIDABLE —
 *     it does not silently evaluate to false
 *  4. only predicates that CAN be evaluated are actually run
 *
 * Combination is three-valued (Kleene): inside AND a measured false decides,
 * inside OR a measured true decides; a rule becomes UNKNOWN only when no
 * predicate could decide it. A rule that cannot be decided is never reported
 * as FAIL, so "the condition is not met" and "the condition could not be
 * measured" stay distinguishable for every consumer.
 */
export function evaluateRule(rule: RuleDefinition, bag: FeatureBag, now = Date.now()): RuleEvaluation {
  const base = {
    rule_id: rule.id,
    source_refs: rule.source_refs,
    timeframe: rule.timeframe,
    evaluated_at_ms: now,
    features_used: rule.feature_dependencies,
  };

  if (rule.unresolved.length > 0) {
    return {
      ...base,
      outcome: "BLOCKED",
      explanation: `rule is not formalizable from source: ${rule.unresolved.join("; ")}`,
      predicate_results: [],
      missing_features: [],
    };
  }

  const missing: string[] = [];
  for (const fid of rule.feature_dependencies) {
    const f = bag.get(fid);
    if (!f) missing.push(`${fid} (not computed)`);
    else if (!f.valid) missing.push(`${fid} (${f.data_quality}: ${f.reason})`);
  }
  if (missing.length > 0) {
    return {
      ...base,
      outcome: "UNKNOWN",
      explanation: `required features unavailable: ${missing.join(", ")}`,
      predicate_results: [],
      missing_features: missing,
    };
  }

  // PER-PREDICATE AVAILABILITY GATE (UNKNOWN propagation). A predicate that
  // cannot read one of its `requires` features is UNDECIDABLE (ok: null), not
  // false: "the pattern is absent" and "the pattern could not be measured" are
  // different facts, and rule outcomes must keep them apart. This is enforced
  // here because `requires` is the only place a branch-level dependency is
  // declared (e.g. the OR branch of a confirmation rule that reads FTR-PINBAR
  // while the rule's own `feature_dependencies` lists FTR-REJECTION).
  const results: RuleEvaluation["predicate_results"] = [];
  const unavailable: string[] = [];
  let threw = false;
  for (const p of rule.predicates) {
    const missingRequired = p.requires.filter((fid) => {
      const f = bag.get(fid);
      return !f || !f.valid;
    });
    if (missingRequired.length > 0) {
      unavailable.push(...missingRequired.map((fid) => `${fid} (${p.expr})`));
      results.push({ expr: p.expr, ok: null, detail: `required feature(s) unavailable: ${missingRequired.join(", ")}` });
      continue;
    }
    try {
      const r = p.test(bag);
      results.push({ expr: p.expr, ok: r.ok, detail: r.detail });
    } catch (err) {
      threw = true;
      results.push({ expr: p.expr, ok: null, detail: `predicate threw: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // A predicate that THREW is a code defect, not a data state: the rule stays
  // undecidable regardless of the operator (unchanged behaviour).
  if (threw) {
    return {
      ...base,
      outcome: "UNKNOWN",
      explanation: "a predicate could not be evaluated",
      predicate_results: results,
      missing_features: [],
    };
  }

  // Kleene three-valued combination: a decided branch wins over an undecided
  // one inside its operator (AND: a measured false decides; OR: a measured true
  // decides); only when nothing decides does the rule become UNKNOWN.
  const anyTrue = results.some((r) => r.ok === true);
  const anyFalse = results.some((r) => r.ok === false);
  const anyNull = results.some((r) => r.ok === null);
  const outcome: RuleOutcome = rule.operator === "AND"
    ? anyFalse ? "FAIL" : anyNull ? "UNKNOWN" : "PASS"
    : anyTrue ? "PASS" : anyNull ? "UNKNOWN" : "FAIL";
  // an empty predicate list is a PASS (unchanged: `[].every` is true)
  const decided: RuleOutcome = results.length === 0 ? "PASS" : outcome;
  const detail = results.map((r) => `${r.ok === true ? "✓" : r.ok === false ? "✗" : "?"} ${r.detail}`).join(" | ");
  return {
    ...base,
    outcome: decided,
    explanation: decided === "UNKNOWN"
      ? `not decidable: ${unavailable.length ? unavailable.join(", ") : "no predicate could decide"}`
      : detail || "no predicates",
    predicate_results: results,
    missing_features: unavailable,
  };
}

/** Simple map-backed feature bag. */
export class MapFeatureBag implements FeatureBag {
  constructor(private readonly m: Map<string, FeatureValue<unknown>>) {}
  get(id: string): FeatureValue<unknown> | undefined {
    return this.m.get(id);
  }
  set(id: string, v: FeatureValue<unknown>): void {
    this.m.set(id, v);
  }
  static from(entries: [string, FeatureValue<unknown>][]): MapFeatureBag {
    return new MapFeatureBag(new Map(entries));
  }
  ids(): string[] {
    return [...this.m.keys()];
  }
}

/** Typed accessor helper for predicates. */
export function val<T>(bag: FeatureBag, id: string): T | null {
  const f = bag.get(id);
  return f && f.valid ? (f.value as T) : null;
}
