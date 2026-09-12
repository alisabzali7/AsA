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

export interface PromotionVerdict {
  from: EmpiricalStatus;
  to: EmpiricalStatus;
  promoted: boolean;
  reasons: string[];
  criteria_used: typeof PROMOTION_CRITERIA;
}

/** Decide the highest empirical status the EVIDENCE supports. */
export function decidePromotion(
  backtest: BacktestMetrics,
  oos: BacktestMetrics | null,
  wf: WalkForwardResult | null,
): PromotionVerdict {
  const reasons: string[] = [];
  let status: EmpiricalStatus = "UNTESTED";

  // ---- BACKTESTED
  if (backtest.trade_count === 0) {
    reasons.push("no trades produced — nothing to evaluate");
    return { from: "UNTESTED", to: "UNTESTED", promoted: false, reasons, criteria_used: PROMOTION_CRITERIA };
  }
  status = "BACKTESTED";
  reasons.push(`BACKTESTED: ${backtest.trade_count} trades, expectancy ${backtest.expectancy_r}R, PF ${backtest.profit_factor}`);

  const meetsQuality = (m: BacktestMetrics, label: string, minTrades: number): boolean => {
    const fails: string[] = [];
    if (m.trade_count < minTrades) fails.push(`only ${m.trade_count} trades (need ${minTrades})`);
    if (m.profit_factor === null || m.profit_factor < PROMOTION_CRITERIA.min_profit_factor) {
      fails.push(`profit factor ${m.profit_factor ?? "n/a"} < ${PROMOTION_CRITERIA.min_profit_factor}`);
    }
    if (m.expectancy_r === null || m.expectancy_r < PROMOTION_CRITERIA.min_expectancy_r) {
      fails.push(`expectancy ${m.expectancy_r ?? "n/a"}R < ${PROMOTION_CRITERIA.min_expectancy_r}R`);
    }
    if (m.max_drawdown_r > PROMOTION_CRITERIA.max_drawdown_r) {
      fails.push(`max drawdown ${m.max_drawdown_r}R > ${PROMOTION_CRITERIA.max_drawdown_r}R`);
    }
    if (fails.length) { reasons.push(`${label} quality gate FAILED: ${fails.join("; ")}`); return false; }
    reasons.push(`${label} quality gate passed`);
    return true;
  };

  if (!meetsQuality(backtest, "in-sample", PROMOTION_CRITERIA.min_trades_backtest)) {
    return { from: "UNTESTED", to: status, promoted: true, reasons, criteria_used: PROMOTION_CRITERIA };
  }

  // ---- OOS_TESTED
  if (!oos) {
    reasons.push("no out-of-sample run — cannot exceed BACKTESTED");
    return { from: "UNTESTED", to: status, promoted: true, reasons, criteria_used: PROMOTION_CRITERIA };
  }
  if (!meetsQuality(oos, "out-of-sample", PROMOTION_CRITERIA.min_trades_oos)) {
    return { from: "UNTESTED", to: status, promoted: true, reasons, criteria_used: PROMOTION_CRITERIA };
  }
  const isExp = backtest.expectancy_r ?? 0;
  const oosExp = oos.expectancy_r ?? 0;
  if (isExp > 0 && oosExp < isExp * PROMOTION_CRITERIA.oos_retention) {
    reasons.push(`OOS expectancy ${oosExp}R retained less than ${PROMOTION_CRITERIA.oos_retention * 100}% of in-sample ${isExp}R — unstable`);
    return { from: "UNTESTED", to: status, promoted: true, reasons, criteria_used: PROMOTION_CRITERIA };
  }
  status = "OOS_TESTED";
  reasons.push(`OOS_TESTED: out-of-sample expectancy ${oosExp}R held up`);

  // ---- WALK_FORWARD
  if (!wf || wf.total_windows < PROMOTION_CRITERIA.min_windows) {
    reasons.push(`walk-forward needs >= ${PROMOTION_CRITERIA.min_windows} windows (got ${wf?.total_windows ?? 0})`);
    return { from: "UNTESTED", to: status, promoted: true, reasons, criteria_used: PROMOTION_CRITERIA };
  }
  const share = wf.profitable_windows / wf.total_windows;
  if (share < PROMOTION_CRITERIA.min_profitable_windows) {
    reasons.push(`only ${wf.profitable_windows}/${wf.total_windows} walk-forward windows profitable (need ${PROMOTION_CRITERIA.min_profitable_windows * 100}%)`);
    return { from: "UNTESTED", to: status, promoted: true, reasons, criteria_used: PROMOTION_CRITERIA };
  }
  status = "WALK_FORWARD";
  reasons.push(`WALK_FORWARD: ${wf.profitable_windows}/${wf.total_windows} windows profitable`);

  // ---- ROBUST
  if (wf.stability !== null && wf.stability >= 1 && (wf.aggregate.profit_factor ?? 0) >= PROMOTION_CRITERIA.min_profit_factor) {
    status = "ROBUST";
    reasons.push(`ROBUST: expectancy stability ${wf.stability} across windows`);
  } else {
    reasons.push(`not ROBUST: stability ${wf.stability ?? "n/a"} (need >= 1)`);
  }

  return { from: "UNTESTED", to: status, promoted: true, reasons, criteria_used: PROMOTION_CRITERIA };
}
