/**
 * Brain opportunity scanner (Phase 2 §11, §12, §23).
 *
 * Runs the compiled strategies over the DYNAMIC operational universe and applies every
 * gate in order, producing an explainable admission decision for each
 * candidate — including the ones that are rejected.
 *
 * PERFORMANCE (§23): cheap deterministic filters run first. A symbol whose
 * candles are missing/stale is dropped before any detector runs, and the AI
 * layer is never invoked here — AI only ever sees already-admitted candidates.
 */
import type { Candle } from "../domain/types";
import { isOperationalSymbol } from "../market/operational-universe";
import { COMPILED_STRATEGIES, evaluateCompiled, type CompiledEvaluation } from "../strategy/compiled";
import { evaluateRisk } from "../risk/engine";
import { evaluatePortfolio, type OpenRisk } from "../risk/portfolio";
import { evaluatePsychologyGate, defaultPsychologyState, type PsychologyState } from "../psychology/gate";
import { admitOpportunity, SCORE_DISCLAIMER, type ScoreResult } from "../brain/score";
import { scoreFromEvaluation } from "./scoring";
import type { PsychologyPolicy, RiskPolicy, SourceRef } from "../brain/types";
import type { EmpiricalStatus } from "../brain/types";

export interface ScanCandidate {
  symbol: string;
  strategy_id: string;
  setup_id: string;
  timeframe: string;
  direction: "long" | "short";
  admitted: boolean;
  admission_reasons: string[];
  setup_outcome: string;
  setup_explanation: string;
  score: ScoreResult | null;
  entry: number | null;
  stop: number | null;
  targets: number[];
  rr: number | null;
  invalidation: number | null;
  level_assumptions: string[];
  risk: { verdict: string; reasons: string[]; numbers: Record<string, unknown> } | null;
  portfolio: { verdict: string; reasons: string[] } | null;
  psychology: { verdict: string; blocks: string[]; penalty: number } | null;
  data_quality: { bars: number; stale: boolean; age_ms: number | null };
  empirical_status: EmpiricalStatus;
  runtime_status: string;
  source_refs: SourceRef[];
  bar_time: number | null;
}

export interface ScanInput {
  /** symbol -> timeframe -> closed candles ending at the decision bar */
  series: Map<string, Map<string, Candle[]>>;
  equity: number;
  riskPolicy: RiskPolicy;
  psychologyPolicies: PsychologyPolicy[];
  psychologyState?: PsychologyState;
  openRisks?: OpenRisk[];
  dailyRealizedLoss?: number;
  periodRealizedLoss?: number;
  /** empirical status per strategy, resolved from persisted experiments */
  empiricalStatus: Record<string, EmpiricalStatus>;
  /** runtime status per strategy, resolved from the brain gate */
  runtimeStatus: Record<string, string>;
  scoreThreshold: number;
  maxStalenessMs: number;
  now?: number;
}

export interface ScanResult {
  scanned_symbols: number;
  evaluated_candidates: number;
  admitted: ScanCandidate[];
  rejected: ScanCandidate[];
  skipped: { symbol: string; reason: string }[];
  score_semantics: string;
  duration_ms: number;
}

/**
 * Build the score from deterministic evidence only.
 *
 * AUDIT FIX (§J): this used to DUPLICATE scoreFromEvaluation minus the
 * unknown-rule (−3 each) and contradiction (−10 each) penalties, so the
 * scanner systematically over-scored candidates relative to the advisory
 * pipeline. It now DELEGATES to the single shared implementation (closure §J:
 * "ONE function ... so the scanner cannot drift apart").
 */
function scoreCandidate(
  ev: CompiledEvaluation,
  riskPass: boolean,
  psychPenalty: number,
  psychReady: boolean,
  barsAvailable: number,
  stale: boolean,
): ScoreResult {
  // Contradiction derivation mirrors the orchestrator exactly: contradictions
  // come from the rule layer, never hard-coded.
  const contradictions = ev.setup.blocked_rules.map((id) => `rule ${id} is BLOCKED (non-computable or invalidation fired)`);
  return scoreFromEvaluation(ev, {
    riskPass,
    psychReady,
    psychPenalty,
    bars: barsAvailable,
    stale,
    contradictions,
  });
}

export function scanForOpportunities(input: ScanInput): ScanResult {
  const started = Date.now();
  const now = input.now ?? started;
  const admitted: ScanCandidate[] = [];
  const rejected: ScanCandidate[] = [];
  const skipped: { symbol: string; reason: string }[] = [];
  let evaluated = 0;

  for (const [symbol, byTf] of input.series) {
    // CHEAP FILTER 1: universe membership (TONUSDT can never pass)
    if (!isOperationalSymbol(symbol)) {
      skipped.push({ symbol, reason: "not in the operational TTT universe (dynamically discovered)" });
      continue;
    }

    for (const strat of COMPILED_STRATEGIES) {
      const candles = byTf.get(strat.timeframe);

      // CHEAP FILTER 2: data presence and depth, before any detector runs
      if (!candles || candles.length < strat.min_bars) {
        skipped.push({ symbol, reason: `${strat.setup_id}: needs ${strat.min_bars} ${strat.timeframe} bars, has ${candles?.length ?? 0}` });
        continue;
      }
      const lastBar = candles[candles.length - 1];
      const ageMs = now - lastBar.t * 1000;
      const stale = ageMs > input.maxStalenessMs;

      evaluated++;
      const ev = evaluateCompiled(strat, symbol, candles, now);

      // risk sizing (only meaningful with complete levels)
      let riskOut: ScanCandidate["risk"] = null;
      let riskPass = false;
      let riskAmount = 0;
      if (ev.levels.entry !== null && ev.levels.stop !== null) {
        const r = evaluateRisk({
          symbol, direction: ev.direction, entry: ev.levels.entry, stop: ev.levels.stop,
          equity: input.equity, riskPerTradePct: input.riskPolicy.risk_per_trade_pct ?? 1,
          maxLeverage: input.riskPolicy.max_leverage ?? 5,
          venueMaxLeverage: null, maintenanceMarginRate: null, takerFeeCoefficient: null,
        });
        riskPass = r.verdict === "pass";
        riskAmount = r.numbers.risk_notional ?? 0;
        riskOut = { verdict: r.verdict, reasons: r.reasons, numbers: r.numbers as unknown as Record<string, unknown> };
      }

      // portfolio gate
      const portfolio = evaluatePortfolio({
        equity: input.equity, policy: input.riskPolicy,
        open_risks: input.openRisks ?? [],
        daily_realized_loss: input.dailyRealizedLoss ?? 0,
        period_realized_loss: input.periodRealizedLoss ?? 0,
        candidate: { symbol, risk_amount: riskAmount, direction: ev.direction },
      });

      // psychology gate
      const pstate: PsychologyState = {
        ...defaultPsychologyState(),
        ...(input.psychologyState ?? {}),
        daily_loss_limit_pct: input.riskPolicy.daily_loss_limit_pct,
      };
      const psych = evaluatePsychologyGate(input.psychologyPolicies, pstate);

      const score = scoreCandidate(ev, riskPass, psych.score_penalty, psych.verdict !== "block", candles.length, stale);

      const runtimeStatus = input.runtimeStatus[strat.strategy_id] ?? "DISABLED";
      const empirical = input.empiricalStatus[strat.strategy_id] ?? "UNTESTED";

      const unknownFields: string[] = [];
      if (ev.levels.entry === null) unknownFields.push("entry");
      if (ev.levels.stop === null) unknownFields.push("stop");
      if (ev.levels.targets.length === 0) unknownFields.push("target");

      const admission = admitOpportunity({
        score: score.score,
        threshold: input.scoreThreshold,
        data_quality_ok: candles.length >= strat.min_bars && !stale,
        stale,
        risk_verdict: riskPass ? "pass" : "block",
        portfolio_verdict: portfolio.verdict,
        psychology_verdict: psych.verdict,
        strategy_runtime_status: runtimeStatus,
        unresolved_contradiction: ev.setup.blocked_rules.length > 0,
        unknown_required_fields: unknownFields,
      });

      const candidate: ScanCandidate = {
        symbol, strategy_id: strat.strategy_id, setup_id: strat.setup_id,
        timeframe: strat.timeframe, direction: ev.direction,
        admitted: admission.admitted, admission_reasons: admission.reasons,
        setup_outcome: ev.setup.outcome, setup_explanation: ev.setup.explanation,
        score,
        entry: ev.levels.entry, stop: ev.levels.stop, targets: ev.levels.targets,
        rr: ev.rr, invalidation: ev.levels.invalidation,
        level_assumptions: ev.levels.level_assumptions,
        risk: riskOut,
        portfolio: { verdict: portfolio.verdict, reasons: portfolio.reasons },
        psychology: { verdict: psych.verdict, blocks: psych.blocks.map((b) => b.reason), penalty: psych.score_penalty },
        data_quality: { bars: candles.length, stale, age_ms: ageMs },
        empirical_status: empirical,
        runtime_status: runtimeStatus,
        source_refs: score.source_refs as SourceRef[],
        bar_time: ev.bar_time,
      };

      if (admission.admitted) admitted.push(candidate);
      else rejected.push(candidate);
    }
  }

  admitted.sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0));
  rejected.sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0));

  return {
    scanned_symbols: input.series.size,
    evaluated_candidates: evaluated,
    admitted,
    rejected,
    skipped,
    score_semantics: SCORE_DISCLAIMER,
    duration_ms: Date.now() - started,
  };
}
