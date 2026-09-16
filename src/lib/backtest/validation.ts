/**
 * Empirical validation + promotion gates (Phase 2 §14, §16).
 *
 * Promotion ladder, each step requiring EVIDENCE (never a manual override):
 *   UNTESTED -> BACKTESTED -> OOS_TESTED -> WALK_FORWARD -> ROBUST -> LIVE
 *
 * THRESHOLD HONESTY: the corpus defines no statistical thresholds, so every
 * number below is an explicit ENGINEERING CRITERION, declared in
 * `PROMOTION_CRITERIA` and echoed in each verdict. They are deliberately
 * conservative and are never presented as the instructor's rules.
 *
 * VERDICT HONESTY (strategy-promotion phase):
 * This function previously returned `promoted: true` on every early-return
 * path — including the paths where a quality gate had just FAILED — so the
 * persisted verdict asserted promotion for strategies that were not promoted.
 * It now reports:
 *   - `stage`             the highest ladder step the EVIDENCE supports
 *   - `promoted`          true ONLY when out-of-sample evidence carried the
 *                         strategy past BACKTESTED (the governance-meaningful
 *                         notion of promotion; in-sample alone is never it)
 *   - `checks[]`          every criterion with PASS / FAIL / UNKNOWN
 *   - `failure_reasons[]` measured-and-insufficient (deterministic negative)
 *   - `unknown_reasons[]` not computable / not stored (NEVER treated as PASS)
 *
 * There is still exactly ONE definition of "what the evidence supports"; the
 * promotion gate in `backtest/promotion.ts` consumes this verdict, re-derives
 * it from the stored metrics and refuses to promote on anything else.
 */
import type { EmpiricalStatus } from "../brain/types";
import type { BacktestMetrics, BacktestResult, RunOptions } from "./strategy-runner";
import { computeMetrics, runStrategyBacktest } from "./strategy-runner";
import type { CompiledStrategy } from "../strategy/compiled";
import type { Candle } from "../domain/types";

/**
 * ENGINEERING CRITERIA — not from the corpus.
 * Chosen conservatively so a strategy cannot be promoted on noise.
 */
export const PROMOTION_CRITERIA = {
  min_trades_backtest: 30,
  min_trades_oos: 15,
  min_profit_factor: 1.2,
  min_expectancy_r: 0.05,
  max_drawdown_r: 15,
  /** OOS expectancy must retain this fraction of in-sample expectancy */
  oos_retention: 0.5,
  /** walk-forward: this share of windows must be profitable */
  min_profitable_windows: 0.6,
  min_windows: 3,
  source: "ENGINEERING CRITERIA — the corpus states no statistical thresholds",
} as const;

/**
 * Identifies HOW a verdict was produced. Recorded on every experiment so a
 * result can never be re-read under a methodology it was not produced under.
 */
export const VALIDATION_METHODOLOGY = "chronological-holdout-0.7+rolling-walk-forward-4";

/**
 * The ladder positions that can only be reached with OUT-OF-SAMPLE evidence.
 * Reaching any of them is a promotion; BACKTESTED is the in-sample starting
 * point and is NOT a promotion.
 */
export const PROMOTED_STATUSES: EmpiricalStatus[] = ["OOS_TESTED", "WALK_FORWARD", "ROBUST"];

/** Ladder order, weakest first. REJECTED is a terminal verdict, kept out. */
export const EMPIRICAL_ORDER: EmpiricalStatus[] = [
  "REJECTED", "UNTESTED", "BACKTESTED", "OOS_TESTED", "WALK_FORWARD", "ROBUST",
];

/** Weakest of two statuses (the governance-safe choice when combining evidence). */
export function weakestStatus(a: EmpiricalStatus, b: EmpiricalStatus): EmpiricalStatus {
  return EMPIRICAL_ORDER.indexOf(a) <= EMPIRICAL_ORDER.indexOf(b) ? a : b;
}

/** True when the status requires out-of-sample evidence (i.e. is a promotion). */
export function isPromotedStatus(s: EmpiricalStatus): boolean {
  return PROMOTED_STATUSES.includes(s);
}

export interface SplitResult {
  in_sample: BacktestResult;
  out_of_sample: BacktestResult;
  split_index: number;
  split_ratio: number;
}

/** Chronological split: train on the earlier portion, test on the later. */
export function runOOS(
  strat: CompiledStrategy,
  symbol: string,
  candles: Candle[],
  opts: RunOptions,
  ratio = 0.7,
): SplitResult {
  const splitIndex = Math.floor(candles.length * ratio);
  const inSample = runStrategyBacktest(strat, symbol, candles, {
    ...opts, start_index: strat.min_bars, end_index: splitIndex - 2,
  });
  // OOS still needs history for detectors, so it sees all candles but only
  // makes DECISIONS at/after the split point.
  const outSample = runStrategyBacktest(strat, symbol, candles, {
    ...opts, start_index: Math.max(splitIndex, strat.min_bars), end_index: candles.length - 2,
  });
  return { in_sample: inSample, out_of_sample: outSample, split_index: splitIndex, split_ratio: ratio };
}

export interface WalkForwardWindow {
  window: number;
  train_from: number;
  test_from: number;
  test_to: number;
  metrics: BacktestMetrics;
  trades: number;
}

export interface WalkForwardResult {
  windows: WalkForwardWindow[];
  profitable_windows: number;
  total_windows: number;
  aggregate: BacktestMetrics;
  stability: number | null;
  note: string;
}

/**
 * Rolling walk-forward: consecutive out-of-sample test windows.
 * Each window only makes decisions inside its own slice, but detectors may use
 * prior history (that is not lookahead — it is the past).
 */
export function runWalkForward(
  strat: CompiledStrategy,
  symbol: string,
  candles: Candle[],
  opts: RunOptions,
  windows = 4,
): WalkForwardResult {
  const usable = candles.length - strat.min_bars;
  const per = Math.floor(usable / windows);
  const out: WalkForwardWindow[] = [];
  const allTrades = [];

  if (per < 50) {
    return {
      windows: [], profitable_windows: 0, total_windows: 0,
      aggregate: computeMetrics([], opts.equity), stability: null,
      note: `insufficient history for ${windows} windows (${per} bars each) — walk-forward not run`,
    };
  }

  for (let w = 0; w < windows; w++) {
    const from = strat.min_bars + w * per;
    const to = Math.min(candles.length - 2, from + per - 1);
    const r = runStrategyBacktest(strat, symbol, candles, { ...opts, start_index: from, end_index: to });
    out.push({
      window: w + 1,
      train_from: candles[0].t,
      test_from: candles[from]?.t ?? 0,
      test_to: candles[to]?.t ?? 0,
      metrics: r.metrics,
      trades: r.trades.length,
    });
    allTrades.push(...r.trades);
  }

  const profitable = out.filter((w) => (w.metrics.total_r ?? 0) > 0).length;
  const expectancies = out.map((w) => w.metrics.expectancy_r).filter((x): x is number => x !== null);
  const mean = expectancies.length ? expectancies.reduce((a, b) => a + b, 0) / expectancies.length : null;
  const sd = mean !== null && expectancies.length > 1
    ? Math.sqrt(expectancies.reduce((a, b) => a + (b - mean) ** 2, 0) / (expectancies.length - 1))
    : null;
  // stability = mean/sd of per-window expectancy; higher is steadier
  const stability = mean !== null && sd !== null && sd > 0 ? Math.round((mean / sd) * 1000) / 1000 : null;

  return {
    windows: out,
    profitable_windows: profitable,
    total_windows: out.length,
    aggregate: computeMetrics(allTrades, opts.equity),
    stability,
    note: `${out.length} rolling out-of-sample windows of ~${per} bars`,
  };
}

/** One ladder criterion, evaluated explicitly. */
export interface CriterionCheck {
  id: string;
  label: string;
  /** PASS = met; FAIL = measured and insufficient; UNKNOWN = not computable */
  verdict: "PASS" | "FAIL" | "UNKNOWN";
  detail: string;
}

export interface PromotionVerdict {
  /** the ladder always starts from the base state (fresh verdict from metrics) */
  from: EmpiricalStatus;
  /** highest ladder step the supplied EVIDENCE supports */
  to: EmpiricalStatus;
  /** true only when `to` required out-of-sample evidence */
  promoted: boolean;
  reasons: string[];
  /** measured-and-insufficient, one entry per failing criterion */
  failure_reasons: string[];
  /** not computable / not present — a blocking UNKNOWN, never a PASS */
  unknown_reasons: string[];
  checks: CriterionCheck[];
  criteria_used: typeof PROMOTION_CRITERIA;
  criteria_source: typeof PROMOTION_CRITERIA.source;
}

function unknown(id: string, label: string, detail: string, checks: CriterionCheck[], reasons: string[]): void {
  checks.push({ id, label, verdict: "UNKNOWN", detail });
  reasons.push(`${label} UNKNOWN: ${detail}`);
}
function fail(id: string, label: string, detail: string, checks: CriterionCheck[], reasons: string[]): void {
  checks.push({ id, label, verdict: "FAIL", detail });
  reasons.push(`${label} FAILED: ${detail}`);
}
function pass(id: string, label: string, detail: string, checks: CriterionCheck[]): void {
  checks.push({ id, label, verdict: "PASS", detail });
}

/** Quality gate over one metric set. Returns false if the step is not reached. */
function qualityGate(
  m: BacktestMetrics,
  label: string,
  minTrades: number,
  reasons: string[],
  unknownReasons: string[],
  failureReasons: string[],
  checks: CriterionCheck[],
): boolean {
  const fails: string[] = [];
  if (m.trade_count < minTrades) fails.push(`only ${m.trade_count} trades (need ${minTrades})`);
  if (m.profit_factor === null) {
    unknownReasons.push(`${label} profit factor is not computed (null) — treating as UNKNOWN, not as a pass`);
    checks.push({ id: `${label}_profit_factor`, label: `${label} profit factor`, verdict: "UNKNOWN", detail: "metric not computed" });
  } else if (m.profit_factor < PROMOTION_CRITERIA.min_profit_factor) {
    fails.push(`profit factor ${m.profit_factor} < ${PROMOTION_CRITERIA.min_profit_factor}`);
  } else {
    pass(`${label}_profit_factor`, `${label} profit factor`, `${m.profit_factor} >= ${PROMOTION_CRITERIA.min_profit_factor}`, checks);
  }
  if (m.expectancy_r === null) {
    unknownReasons.push(`${label} expectancy is not computed (null) — treating as UNKNOWN, not as a pass`);
    checks.push({ id: `${label}_expectancy`, label: `${label} expectancy`, verdict: "UNKNOWN", detail: "metric not computed" });
  } else if (m.expectancy_r < PROMOTION_CRITERIA.min_expectancy_r) {
    fails.push(`expectancy ${m.expectancy_r}R < ${PROMOTION_CRITERIA.min_expectancy_r}R`);
  } else {
    pass(`${label}_expectancy`, `${label} expectancy`, `${m.expectancy_r}R >= ${PROMOTION_CRITERIA.min_expectancy_r}R`, checks);
  }
  if (m.max_drawdown_r > PROMOTION_CRITERIA.max_drawdown_r) {
    fails.push(`max drawdown ${m.max_drawdown_r}R > ${PROMOTION_CRITERIA.max_drawdown_r}R`);
  } else {
    pass(`${label}_drawdown`, `${label} max drawdown`, `${m.max_drawdown_r}R <= ${PROMOTION_CRITERIA.max_drawdown_r}R`, checks);
  }
  if (fails.length) {
    failureReasons.push(`${label} quality gate failed: ${fails.join("; ")}`);
    reasons.push(`${label} quality gate FAILED: ${fails.join("; ")}`);
    return false;
  }
  reasons.push(`${label} quality gate passed`);
  return true;
}

/**
 * Decide the highest empirical status the EVIDENCE supports.
 *
 * Every early return carries an honest `promoted` flag: a strategy that merely
 * survived the in-sample step is BACKTESTED, which is NOT a promotion.
 */
export function decidePromotion(
  backtest: BacktestMetrics,
  oos: BacktestMetrics | null,
  wf: WalkForwardResult | null,
): PromotionVerdict {
  const reasons: string[] = [];
  const failureReasons: string[] = [];
  const unknownReasons: string[] = [];
  const checks: CriterionCheck[] = [];
  const base = {
    from: "UNTESTED" as EmpiricalStatus,
    criteria_used: PROMOTION_CRITERIA,
    criteria_source: PROMOTION_CRITERIA.source,
  };
  const done = (to: EmpiricalStatus): PromotionVerdict => ({
    ...base,
    to,
    promoted: isPromotedStatus(to),
    reasons,
    failure_reasons: failureReasons,
    unknown_reasons: unknownReasons,
    checks,
  });

  // ---- BACKTESTED
  if (backtest.trade_count === 0) {
    failureReasons.push("no trades produced — nothing was measured");
    reasons.push("no trades produced — nothing to evaluate");
    fail("in_sample_trade_count", "in-sample trade count",
      "the backtest produced 0 trades, so no metric could be measured", checks, reasons);
    return done("UNTESTED");
  }
  pass("in_sample_trade_count", "in-sample trade count", `${backtest.trade_count} trades`, checks);
  reasons.push(`BACKTESTED: ${backtest.trade_count} trades, expectancy ${backtest.expectancy_r}R, PF ${backtest.profit_factor}`);

  if (!qualityGate(backtest, "in-sample", PROMOTION_CRITERIA.min_trades_backtest, reasons, unknownReasons, failureReasons, checks)) {
    return done("BACKTESTED");
  }

  // ---- OOS_TESTED
  if (!oos) {
    unknownReasons.push("no out-of-sample run — OOS evidence is UNKNOWN, so the strategy can never exceed BACKTESTED");
    reasons.push("no out-of-sample run — cannot exceed BACKTESTED");
    unknown("oos_present", "out-of-sample evidence",
      "no out-of-sample metrics are available for this run", checks, reasons);
    return done("BACKTESTED");
  }
  pass("oos_present", "out-of-sample evidence", `OOS run present with ${oos.trade_count} trades`, checks);
  if (!qualityGate(oos, "out-of-sample", PROMOTION_CRITERIA.min_trades_oos, reasons, unknownReasons, failureReasons, checks)) {
    return done("BACKTESTED");
  }
  const isExp = backtest.expectancy_r ?? 0;
  const oosExp = oos.expectancy_r ?? 0;
  if (backtest.expectancy_r === null || oos.expectancy_r === null) {
    unknownReasons.push("in-sample or out-of-sample expectancy is not computed — retention cannot be evaluated");
    unknown("oos_retention", "OOS expectancy retention", "expectancy is null on one side of the split", checks, reasons);
    return done("BACKTESTED");
  }
  if (isExp > 0 && oosExp < isExp * PROMOTION_CRITERIA.oos_retention) {
    failureReasons.push(`OOS expectancy ${oosExp}R retained less than ${PROMOTION_CRITERIA.oos_retention * 100}% of in-sample ${isExp}R`);
    fail("oos_retention", "OOS expectancy retention",
      `OOS ${oosExp}R < ${PROMOTION_CRITERIA.oos_retention * 100}% of in-sample ${isExp}R — unstable`, checks, reasons);
    reasons.push(`OOS expectancy ${oosExp}R retained less than ${PROMOTION_CRITERIA.oos_retention * 100}% of in-sample ${isExp}R — unstable`);
    return done("BACKTESTED");
  }
  pass("oos_retention", "OOS expectancy retention", `OOS ${oosExp}R vs in-sample ${isExp}R`, checks);
  reasons.push(`OOS_TESTED: out-of-sample expectancy ${oosExp}R held up`);

  // ---- WALK_FORWARD
  if (!wf || wf.total_windows < PROMOTION_CRITERIA.min_windows) {
    unknownReasons.push(`walk-forward needs >= ${PROMOTION_CRITERIA.min_windows} windows (got ${wf?.total_windows ?? 0}) — walk-forward evidence is UNKNOWN`);
    reasons.push(`walk-forward needs >= ${PROMOTION_CRITERIA.min_windows} windows (got ${wf?.total_windows ?? 0})`);
    unknown("walk_forward_windows", "walk-forward windows",
      `only ${wf?.total_windows ?? 0} usable window(s) recorded`, checks, reasons);
    return done("OOS_TESTED");
  }
  pass("walk_forward_windows", "walk-forward windows", `${wf.total_windows} windows`, checks);
  const share = wf.profitable_windows / wf.total_windows;
  if (share < PROMOTION_CRITERIA.min_profitable_windows) {
    failureReasons.push(`only ${wf.profitable_windows}/${wf.total_windows} walk-forward windows profitable`);
    fail("walk_forward_profitable", "walk-forward profitable share",
      `only ${wf.profitable_windows}/${wf.total_windows} windows profitable (need ${PROMOTION_CRITERIA.min_profitable_windows * 100}%)`, checks, reasons);
    reasons.push(`only ${wf.profitable_windows}/${wf.total_windows} walk-forward windows profitable (need ${PROMOTION_CRITERIA.min_profitable_windows * 100}%)`);
    return done("OOS_TESTED");
  }
  pass("walk_forward_profitable", "walk-forward profitable share",
    `${wf.profitable_windows}/${wf.total_windows} windows profitable`, checks);
  reasons.push(`WALK_FORWARD: ${wf.profitable_windows}/${wf.total_windows} windows profitable`);

  // ---- ROBUST
  if (wf.stability !== null && wf.stability >= 1 && (wf.aggregate.profit_factor ?? 0) >= PROMOTION_CRITERIA.min_profit_factor) {
    pass("robust_stability", "robustness", `expectancy stability ${wf.stability} across windows`, checks);
    reasons.push(`ROBUST: expectancy stability ${wf.stability} across windows`);
    return done("ROBUST");
  }
  const detail = wf.stability === null
    ? "expectancy stability could not be computed from the recorded windows"
    : `stability ${wf.stability} < 1 (or aggregate profit factor ${wf.aggregate.profit_factor ?? "n/a"} below ${PROMOTION_CRITERIA.min_profit_factor})`;
  fail("robust_stability", "robustness", detail, checks, reasons);
  failureReasons.push(`not ROBUST: ${detail}`);
  reasons.push(`not ROBUST: ${detail}`);
  return done("WALK_FORWARD");
}
