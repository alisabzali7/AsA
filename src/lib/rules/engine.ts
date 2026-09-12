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
  /** features that MUST be valid for this predicate to be meaningful */
  requires: string[];
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
 *  3. only then are predicates actually run
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

  const results: RuleEvaluation["predicate_results"] = [];
  for (const p of rule.predicates) {
    try {
      const r = p.test(bag);
      results.push({ expr: p.expr, ok: r.ok, detail: r.detail });
    } catch (err) {
      results.push({ expr: p.expr, ok: null, detail: `predicate threw: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const threw = results.some((r) => r.ok === null);
  if (threw) {
    return {
      ...base,
      outcome: "UNKNOWN",
      explanation: "a predicate could not be evaluated",
      predicate_results: results,
      missing_features: [],
    };
  }

  const pass = rule.operator === "AND" ? results.every((r) => r.ok === true) : results.some((r) => r.ok === true);
  const detail = results.map((r) => `${r.ok ? "✓" : "✗"} ${r.detail}`).join(" | ");
  return {
    ...base,
    outcome: pass ? "PASS" : "FAIL",
    explanation: detail || "no predicates",
    predicate_results: results,
    missing_features: [],
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
