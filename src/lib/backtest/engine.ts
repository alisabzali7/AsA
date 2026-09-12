/**
 * Backtest engine — DELEGATES to the shared strategy runner (closure §L).
 *
 * This module used to contain a SECOND strategy implementation with its own
 * bar loop, its own exit logic, a hard-coded `tf = "15m"` for every strategy,
 * and slice-relative `exit_index` values that were later read against the full
 * series. All of that is gone: the file is now a thin adapter over
 * `runStrategyBacktest`, which is the same code path the advisory scanner uses.
 *
 * Guarantees inherited from the shared runner:
 *  - each strategy uses its OWN declared timeframe;
 *  - decisions see only closed bars up to the signal index;
 *  - entry fills at the next bar's open;
 *  - same-bar stop/target ambiguity resolved by an EXPLICIT policy;
 *  - exits are recorded as absolute timestamps, never slice-relative indexes;
 *  - a partial-exit ladder is ONE position with several fills.
 */
import { randomUUID } from "node:crypto";
import { getRuntimeStrategy } from "../strategy/runtime";
import { getProductionRiskPolicy } from "../risk/policy";
import { buildReleaseIdentity } from "../release";
import type { Candle } from "../domain/types";
import {
  runStrategyBacktest, DEFAULT_COSTS, type BacktestCosts, type SameBarPolicy,
  type PositionRecord, type BacktestMetrics,
} from "./strategy-runner";
import { datasetFingerprint } from "./experiments";

export type { SameBarPolicy };

export interface BacktestInput {
  /** setup_id or Brain strategy_id */
  strategyId: string;
  symbol: string;
  /** closed candles of the STRATEGY'S OWN timeframe, ascending */
  candles: Candle[];
  feeRoundTripPct?: number;
  slippagePct?: number;
  sameBarPolicy?: SameBarPolicy;
  dataMode?: "fixture" | "ttt";
  startTsSec?: number;
  endTsSec?: number;
  accountEquity?: number;
  warningsSeed?: string[];
}

export interface BacktestOutput {
  ok: boolean;
  error?: string;
  run_id: string;
  strategy_id: string;
  setup_id: string;
  symbol: string;
  timeframe: string;
  positions: PositionRecord[];
  metrics: BacktestMetrics;
  rejections: Record<string, number>;
  costs: BacktestCosts;
  same_bar_policy: SameBarPolicy;
  assumptions: string[];
  warnings: string[];
  lineage: Record<string, unknown>;
}

function fail(run_id: string, error: string): BacktestOutput {
  return {
    ok: false, error, run_id, strategy_id: "", setup_id: "", symbol: "", timeframe: "",
    positions: [], metrics: emptyMetrics(), rejections: {}, costs: DEFAULT_COSTS,
    same_bar_policy: "stop_first", assumptions: [], warnings: [error], lineage: {},
  };
}

function emptyMetrics(): BacktestMetrics {
  return {
    trade_count: 0, wins: 0, losses: 0, win_rate: null, average_r: null, expectancy_r: null,
    profit_factor: null, max_drawdown_r: 0, max_drawdown_pct: null, longest_loss_streak: 0,
    average_hold_bars: null, total_r: 0, gross_total_r: 0, return_pct: null,
    fee_impact_r: 0, slippage_impact_r: 0, funding_impact: null, sufficient_sample: false,
  };
}

/** Run a backtest through the single shared engine. */
export function runBacktest(input: BacktestInput): BacktestOutput {
  const run_id = randomUUID();
  const strat = getRuntimeStrategy(input.strategyId);
  if (!strat) return fail(run_id, `unknown strategy ${input.strategyId}`);
  if (!strat.impl) return fail(run_id, `strategy ${input.strategyId} is ${strat.availability}: ${strat.blocked_reason}`);

  let candles = input.candles;
  if (input.startTsSec !== undefined) candles = candles.filter((c) => c.t >= input.startTsSec!);
  if (input.endTsSec !== undefined) candles = candles.filter((c) => c.t <= input.endTsSec!);
  if (candles.length < strat.min_bars + 20) {
    return fail(run_id, `insufficient candles: need ${strat.min_bars + 20}, got ${candles.length}`);
  }

  const costs: BacktestCosts = {
    // feeRoundTripPct is a ROUND TRIP percentage; the runner charges per side.
    fee_rate: input.feeRoundTripPct !== undefined ? input.feeRoundTripPct / 100 / 2 : DEFAULT_COSTS.fee_rate,
    slippage_rate: input.slippagePct !== undefined ? input.slippagePct / 100 : DEFAULT_COSTS.slippage_rate,
  };
  const policy = getProductionRiskPolicy();
  const equity = input.accountEquity ?? 10_000;

  const result = runStrategyBacktest(strat.impl, input.symbol, candles, {
    equity,
    policy,
    costs,
    sameBarPolicy: input.sameBarPolicy ?? "stop_first",
  });

  const release = buildReleaseIdentity();
  return {
    ok: true,
    run_id,
    strategy_id: strat.strategy_id,
    setup_id: strat.setup_id,
    symbol: input.symbol,
    timeframe: strat.timeframe,
    positions: result.positions,
    metrics: result.metrics,
    rejections: result.rejections,
    costs: result.costs,
    same_bar_policy: result.same_bar_policy,
    assumptions: result.assumptions,
    warnings: [
      ...(input.warningsSeed ?? []),
      "funding is NOT modelled — TTT historical funding is not integrated into replay (declared, not silently ignored)",
      `data mode: ${input.dataMode ?? "fixture"}`,
    ],
    lineage: {
      run_id,
      dataset_fingerprint: datasetFingerprint(candles),
      ttt_source: input.dataMode === "ttt" ? "ttt:/futures/udf/history" : "fixture",
      symbol: input.symbol,
      timeframe: strat.timeframe,
      date_range: { from_ts: candles[0].t, to_ts: candles[candles.length - 1].t, bars: candles.length },
      strategy_version: strat.version,
      rule_ids: strat.rule_ids,
      risk_policy_id: policy.policy_id,
      risk_policy_version: policy.policy_version,
      app_version: release.app_version,
      git_commit: release.git_commit,
      build_id: release.build_id,
      costs,
      same_bar_policy: result.same_bar_policy,
    },
  };
}
