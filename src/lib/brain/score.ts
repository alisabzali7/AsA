/**
 * Explainable scoring.
 *
 * A SCORE IS NOT A PROBABILITY. An 87 does not mean "87% likely to win"; it
 * means the deterministic evidence checklist summed to 87 of a possible 100.
 * Every consumer (API, UI, Telegram, AI prompt) must repeat that framing, and
 * `SCORE_DISCLAIMER` is the single canonical wording used everywhere.
 *
 * Every component is itemized so a user can see exactly which evidence earned
 * or lost points, including which factors could not be evaluated at all.
 */
import type { RuleOutcome } from "../rules/engine";

export const SCORE_DISCLAIMER =
  "Score is a deterministic evidence sum (0-100), NOT a probability or win rate.";

export interface ScoreComponent {
  key: string;
  label: string;
  weight: number;
  /** 0..1 achievement of this component, or null when not evaluable */
  achieved: number | null;
  points: number;
  reason: string;
  evidence_kind: "MEASURED" | "SOURCE" | "INFERRED" | "PROXY" | "UNKNOWN" | "UNAVAILABLE";
}

export interface ScoreResult {
  score: number;
  max_possible: number;
  /** score normalized over the components that COULD be evaluated */
  score_of_evaluable: number;
  disclaimer: string;
  breakdown: ScoreComponent[];
  positive_factors: string[];
  negative_factors: string[];
  blocked_factors: string[];
  unknown_factors: string[];
  contradictions: string[];
  source_refs: { file: string; start_line: number; end_line: number }[];
}

/** Canonical component weights (sum = 100). */
export const SCORE_WEIGHTS = {
  technical_confluence: 20,
  structure_alignment: 15,
  strategy_compliance: 15,
  reward_risk_quality: 12,
  confirmation_quality: 10,
  market_regime: 10,
  data_quality: 10,
  risk_quality: 5,
  psychology_gate: 3,
} as const;

export type ScoreKey = keyof typeof SCORE_WEIGHTS;

export interface ScoreInput {
  components: Partial<Record<ScoreKey, { achieved: number | null; reason: string; evidence_kind: ScoreComponent["evidence_kind"] }>>;
  contradictions?: string[];
  blocked?: string[];
  source_refs?: { file: string; start_line: number; end_line: number }[];
  /** subtracted after summation, e.g. psychology penalties */
  penalties?: { reason: string; points: number }[];
}

const LABELS: Record<ScoreKey, string> = {
  technical_confluence: "Technical confluence",
  structure_alignment: "Structure alignment (MTF)",
  strategy_compliance: "Strategy rule compliance",
  reward_risk_quality: "Reward/risk quality",
  confirmation_quality: "Confirmation quality",
  market_regime: "Market regime fit",
  data_quality: "Data quality/freshness",
  risk_quality: "Risk engine quality",
  psychology_gate: "Psychology gate",
};

export function computeScore(input: ScoreInput): ScoreResult {
  const breakdown: ScoreComponent[] = [];
  const positive: string[] = [];
  const negative: string[] = [];
  const unknown: string[] = [];

  let earned = 0;
  let evaluableWeight = 0;

  for (const key of Object.keys(SCORE_WEIGHTS) as ScoreKey[]) {
    const weight = SCORE_WEIGHTS[key];
    const c = input.components[key];
    if (!c || c.achieved === null) {
      breakdown.push({
        key,
        label: LABELS[key],
        weight,
        achieved: null,
        points: 0,
        reason: c?.reason ?? "not evaluated — required inputs unavailable",
        evidence_kind: c?.evidence_kind ?? "UNKNOWN",
      });
      unknown.push(`${LABELS[key]}: ${c?.reason ?? "not evaluable"}`);
      continue;
    }
    const achieved = Math.max(0, Math.min(1, c.achieved));
    const points = Math.round(weight * achieved * 100) / 100;
    earned += points;
    evaluableWeight += weight;
    breakdown.push({
      key, label: LABELS[key], weight, achieved, points, reason: c.reason, evidence_kind: c.evidence_kind,
    });
    if (achieved >= 0.6) positive.push(`${LABELS[key]}: ${c.reason}`);
    else negative.push(`${LABELS[key]}: ${c.reason}`);
  }

  let penaltyTotal = 0;
  for (const p of input.penalties ?? []) {
    penaltyTotal += p.points;
    negative.push(`penalty -${p.points}: ${p.reason}`);
  }

  const raw = Math.max(0, earned - penaltyTotal);
  const score = Math.round(raw * 100) / 100;
  const ofEvaluable = evaluableWeight > 0 ? Math.round((raw / evaluableWeight) * 10000) / 100 : 0;

  return {
    score,
    max_possible: 100,
    score_of_evaluable: ofEvaluable,
    disclaimer: SCORE_DISCLAIMER,
    breakdown,
    positive_factors: positive,
    negative_factors: negative,
    blocked_factors: input.blocked ?? [],
    unknown_factors: unknown,
    contradictions: input.contradictions ?? [],
    source_refs: input.source_refs ?? [],
  };
}

/**
 * Opportunity admission. A candidate is only an opportunity when EVERY gate
 * passes — a high score alone is never sufficient.
 *
 * THE SETUP HARD GATE (Cognitive Core invariant): the deterministic setup
 * verdict is a REQUIRED input and `admitOpportunity` refuses anything other
 * than `PASS`. This makes the RULES → SETUP → ADMISSION boundary
 * machine-enforced at the ONE shared chokepoint, so no consumer (scanner,
 * orchestrator, backtester, future callers) can forget it: the type system
 * forces every admission path to state the setup verdict it admits under.
 * FAIL / UNKNOWN / BLOCKED each produce their own distinguishable rejection
 * reason — `UNKNOWN != FAIL != PASS` is preserved in the explanation.
 */
export interface AdmissionInput {
  /**
   * Deterministic outcome of the setup evaluation (`evaluateSetup`). ONLY
   * `PASS` may be admitted; `FAIL`, `UNKNOWN` and `BLOCKED` are hard
   * rejections regardless of score, risk, portfolio, psychology or runtime
   * status. Required by type — a caller cannot omit setup validity.
   */
  setup_verdict: RuleOutcome;
  score: number;
  threshold: number;
  data_quality_ok: boolean;
  stale: boolean;
  risk_verdict: "pass" | "block" | "unavailable";
  portfolio_verdict: "pass" | "block";
  psychology_verdict: "pass" | "block" | "flag";
  strategy_runtime_status: string;
  unresolved_contradiction: boolean;
  unknown_required_fields: string[];
  /** true when the series used for this decision is DERIVED rather than native TTT */
  derived_market_truth?: boolean;
  /**
   * LIVE MODE ONLY. Live advisory output requires the FULL promotion gate
   * (`strategy/promotion`), not merely "the strategy is not DISABLED".
   *
   * Without this flag a strategy holding CANDIDATE (in-sample BACKTESTED) or
   * PAPER (OOS only) would still be admitted and published as a live signal,
   * which would collapse `executable ≠ validated ≠ promotable ≠ live eligible`
   * into one boolean. Research/backtest callers leave it false because they are
   * not producing live advisory output.
   */
  requires_live_eligibility?: boolean;
}

export interface AdmissionResult {
  admitted: boolean;
  reasons: string[];
}

export function admitOpportunity(a: AdmissionInput): AdmissionResult {
  const reasons: string[] = [];
  // SETUP HARD GATE — first and unconditional. The setup verdict names itself
  // in the reason so UNKNOWN stays explainably distinct from FAIL and BLOCKED.
  if (a.setup_verdict !== "PASS") {
    reasons.push(`setup outcome ${a.setup_verdict} — only a PASS setup may be admitted`);
  }
  if (!a.data_quality_ok) reasons.push("data quality insufficient");
  if (a.stale) reasons.push("market data is stale");
  if (a.risk_verdict === "block") reasons.push("risk engine BLOCK");
  if (a.risk_verdict === "unavailable") reasons.push("risk result UNAVAILABLE — not treated as pass");
  if (a.derived_market_truth) reasons.push("derived series cannot be admitted as native market truth");
  if (a.portfolio_verdict === "block") reasons.push("portfolio risk BLOCK");
  if (a.psychology_verdict === "block") reasons.push("psychology hard block");
  if (a.unresolved_contradiction) reasons.push("unresolved contradiction in evidence");
  if (a.unknown_required_fields.length > 0) {
    reasons.push(`required fields UNKNOWN: ${a.unknown_required_fields.join(", ")}`);
  }
  if (a.strategy_runtime_status === "DISABLED") reasons.push("strategy is DISABLED by the runtime gate");
  if (a.requires_live_eligibility && a.strategy_runtime_status !== "LIVE_ADVISORY_ONLY") {
    reasons.push(
      `live advisory requires a promotion-eligible strategy — the promotion gate reports ${a.strategy_runtime_status}`,
    );
  }
  if (a.score < a.threshold) reasons.push(`score ${a.score} below threshold ${a.threshold}`);
  return { admitted: reasons.length === 0, reasons };
}
