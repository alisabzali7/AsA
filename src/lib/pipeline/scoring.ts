/**
 * Shared score construction (closure §J).
 *
 * ONE function turns a deterministic strategy evaluation into a score, so the
 * advisory pipeline, the backtester and the scanner cannot drift apart and no
 * caller can hard-code a constant like `strength = 55` again.
 *
 * Components are only credited when the underlying evidence actually exists.
 * Missing evidence yields `achieved: null` (reported as an unknown factor),
 * never a silent full-marks default.
 */
import { computeScore, type ScoreResult } from "../brain/score";
import type { CompiledEvaluation } from "../strategy/compiled";

export interface ScoreContext {
  riskPass: boolean;
  psychReady: boolean;
  psychPenalty: number;
  bars: number;
  stale: boolean;
  /** unresolved contradictions surfaced by the setup/rule layer */
  contradictions: string[];
}

export function scoreFromEvaluation(ev: CompiledEvaluation, ctx: ScoreContext): ScoreResult {
  const stages = new Map(ev.setup.stages.map((s) => [String(s.stage), s]));

  const stage = (name: string): { achieved: number | null; reason: string; kind: "MEASURED" | "SOURCE" | "UNKNOWN" } => {
    const s = stages.get(name);
    if (!s || s.outcome === "SKIPPED") return { achieved: null, reason: `${name}: no rule defined in source`, kind: "UNKNOWN" };
    if (s.outcome === "UNKNOWN") return { achieved: null, reason: `${name}: required data unavailable`, kind: "UNKNOWN" };
    if (s.outcome === "BLOCKED") return { achieved: 0, reason: `${name}: blocked`, kind: "SOURCE" };
    return { achieved: s.outcome === "PASS" ? 1 : 0, reason: `${name}: ${s.outcome}`, kind: "MEASURED" };
  };

  const ctxS = stage("context");
  const loc = stage("location");
  const str = stage("structure");
  const conf = stage("confirmation");

  const passed = ev.setup.passed_rules.length;
  const total = passed + ev.setup.failed_rules.length + ev.setup.unknown_rules.length + ev.setup.blocked_rules.length;

  // Unknown/contradiction penalties are explicit score components, not silent.
  const unknownPenalty = ev.setup.unknown_rules.length * 3;
  const contradictionPenalty = ctx.contradictions.length * 10;

  const penalties: { reason: string; points: number }[] = [];
  if (ctx.psychPenalty > 0) penalties.push({ reason: "psychology soft warnings", points: ctx.psychPenalty });
  if (unknownPenalty > 0) penalties.push({ reason: `${ev.setup.unknown_rules.length} rule(s) UNKNOWN`, points: unknownPenalty });
  if (contradictionPenalty > 0) penalties.push({ reason: `${ctx.contradictions.length} unresolved contradiction(s)`, points: contradictionPenalty });

  return computeScore({
    components: {
      strategy_compliance: total > 0
        ? { achieved: passed / total, reason: `${passed}/${total} rules passed`, evidence_kind: "MEASURED" }
        : { achieved: null, reason: "no rules evaluated", evidence_kind: "UNKNOWN" },
      structure_alignment: { achieved: str.achieved, reason: str.reason, evidence_kind: str.kind },
      technical_confluence: { achieved: loc.achieved, reason: loc.reason, evidence_kind: loc.kind },
      confirmation_quality: { achieved: conf.achieved, reason: conf.reason, evidence_kind: conf.kind },
      market_regime: { achieved: ctxS.achieved, reason: ctxS.reason, evidence_kind: ctxS.kind },
      reward_risk_quality: ev.rr !== null
        ? { achieved: Math.min(1, ev.rr / 3), reason: `R:R ${ev.rr} (full marks at 3R)`, evidence_kind: "MEASURED" }
        : { achieved: null, reason: "R:R not computable — target or stop missing", evidence_kind: "UNKNOWN" },
      risk_quality: { achieved: ctx.riskPass ? 1 : 0, reason: ctx.riskPass ? "risk engine passed" : "risk engine blocked", evidence_kind: "MEASURED" },
      data_quality: {
        achieved: ctx.stale ? 0 : Math.min(1, ctx.bars / 200),
        reason: ctx.stale ? "market data is stale" : `${ctx.bars} closed bars available`,
        evidence_kind: "MEASURED",
      },
      psychology_gate: { achieved: ctx.psychReady ? 1 : 0, reason: ctx.psychReady ? "psychology ready" : "psychology blocked", evidence_kind: "MEASURED" },
    },
    penalties,
    contradictions: ctx.contradictions,
    source_refs: ev.setup.stages.flatMap((s) => s.rules.flatMap((r) => r.source_refs)).slice(0, 8),
  });
}

export { admitOpportunity } from "../brain/score";
export type { ScoreResult };
