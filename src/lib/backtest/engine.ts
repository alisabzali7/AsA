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
import { getRiskPrefs } from "../prefs";
import { buildReleaseIdentity } from "../release";
import type { Candle } from "../domain/types";
import {
  runStrategyBacktest, type BacktestCosts, type SameBarPolicy,
  type PositionRecord, type BacktestMetrics,
} from "./strategy-runner";
import { datasetFingerprint } from "./experiments";
import type { DataFreshness } from "./data-freshness";

export type { SameBarPolicy };

export interface BacktestInput {
  /** setup_id or Brain strategy_id */
  strategyId: string;
  symbol: string;
  /** closed candles of the STRATEGY'S OWN timeframe, ascending */
  candles: Candle[];
  feeRoundTripPct: number;
  slippagePct: number;
  sameBarPolicy: SameBarPolicy;
  dataMode: "fixture" | "ttt";
  maxHoldBars: number;
  startTsSec?: number;
  endTsSec?: number;
  accountEquity?: number;
  riskPerTradePct?: number;
  maxLeverage?: number;
  warningsSeed?: string[];
  /**
   * AUDIT FIX (P0-7): explicit statement of whether the underlying history was
   * freshly synchronized from TTT, or the run used previously stored data
   * after a failed fresh sync. Surfaced in BOTH warnings and lineage so a
   * stale-data run can never be presented as freshly synchronized.
   */
  dataFreshness?: DataFreshness;
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
  costs: BacktestCosts | null;
  same_bar_policy: SameBarPolicy | null;
  portfolio_verdicts: { pass: number; block: number; unknown: number };
  psychology_context: { status: "NOT_RECONSTRUCTED"; mode: "RESEARCH_ONLY"; note: string } | null;
  assumptions: string[];
  warnings: string[];
  lineage: Record<string, unknown>;
}

function fail(run_id: string, error: string): BacktestOutput {
  return {
    ok: false, error, run_id, strategy_id: "", setup_id: "", symbol: "", timeframe: "",
    positions: [], metrics: emptyMetrics(), rejections: {}, costs: null,
    same_bar_policy: null, portfolio_verdicts: { pass: 0, block: 0, unknown: 0 },
    psychology_context: null, assumptions: [], warnings: [error], lineage: {},
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
  if (!strat.impl || (strat.availability !== "EXECUTABLE" && strat.availability !== "RESEARCH_ONLY")) {
    return fail(run_id, `strategy ${input.strategyId} is ${strat.availability}: ${strat.blocked_reason}`);
  }
  if (input.dataMode !== "fixture" && input.dataMode !== "ttt") return fail(run_id, "data source mode must be explicitly fixture or ttt");
  if (!Number.isFinite(input.feeRoundTripPct) || input.feeRoundTripPct < 0 || !Number.isFinite(input.slippagePct) || input.slippagePct < 0) {
    return fail(run_id, "fee and slippage inputs must be explicitly supplied as finite non-negative percentages");
  }
  if (input.sameBarPolicy !== "stop_first" && input.sameBarPolicy !== "target_first") return fail(run_id, "same-bar ambiguity policy must be explicitly selected");
  if (!Number.isSafeInteger(input.maxHoldBars) || input.maxHoldBars <= 0) return fail(run_id, "maxHoldBars must be explicitly configured as a positive integer");

  const policy = getProductionRiskPolicy();
  if (policy.selection_status !== "SELECTED" || policy.source_status !== "SOURCE_VERIFIED" || policy.source_refs.length === 0 || policy.conflict_group_id !== null) {
    return fail(run_id, `risk policy is not production-usable: ${policy.selection_reason}`);
  }
  const prefs = getRiskPrefs();
  const equity = input.accountEquity ?? prefs.equity;
  const riskPerTradePct = policy.risk_per_trade_pct ?? input.riskPerTradePct ?? prefs.perTradePct;
  const maxLeverage = policy.max_leverage ?? input.maxLeverage ?? prefs.maxLeverage;
  if (equity === null || !Number.isFinite(equity) || equity <= 0) return fail(run_id, "account equity is unconfigured; no numeric default is substituted");
  if (riskPerTradePct === null || !Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0) return fail(run_id, "per-trade sizing input is unconfigured; no numeric default is substituted");
  if (maxLeverage === null || !Number.isFinite(maxLeverage) || maxLeverage <= 0) return fail(run_id, "maximum leverage is unconfigured; no numeric default is substituted");

  let candles = input.candles;
  if (input.startTsSec !== undefined) candles = candles.filter((c) => c.t >= input.startTsSec!);
  if (input.endTsSec !== undefined) candles = candles.filter((c) => c.t <= input.endTsSec!);
  if (candles.length < strat.min_bars + 20) {
    return fail(run_id, `insufficient candles: need ${strat.min_bars + 20}, got ${candles.length}`);
  }

  const costs: BacktestCosts = {
    // feeRoundTripPct is a caller-supplied ROUND TRIP percentage; the runner charges per side.
    fee_rate: input.feeRoundTripPct / 100 / 2,
    slippage_rate: input.slippagePct / 100,
  };
  const result = runStrategyBacktest(strat.impl, input.symbol, candles, {
    equity,
    policy,
    riskPerTradePct,
    maxLeverage,
    costs,
    sameBarPolicy: input.sameBarPolicy,
    max_hold_bars: input.maxHoldBars,
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
    portfolio_verdicts: result.portfolio_verdicts,
    psychology_context: result.psychology_context,
    assumptions: result.assumptions,
    warnings: [
      ...(input.warningsSeed ?? []),
      ...(input.dataFreshness?.warning ? [input.dataFreshness.warning] : []),
      ...(result.portfolio_verdicts.unknown > 0 ? [`portfolio checks were UNKNOWN for ${result.portfolio_verdicts.unknown} candidate(s); those candidates were not admitted`] : []),
      "user psychology was not reconstructed for historical research; no claim is made about psychology-gated performance",
      "funding is NOT modelled — TTT historical funding is not integrated into replay (declared, not silently ignored)",
      `data mode: ${input.dataMode}`,
    ],
    lineage: {
      run_id,
      dataset_fingerprint: datasetFingerprint(candles),
      ttt_source: input.dataMode === "ttt" ? "ttt:/futures/udf/history" : "fixture",
      data_freshness: input.dataFreshness
        ? {
            fresh_sync_status: input.dataFreshness.fresh_sync_status,
            fresh_sync_error: input.dataFreshness.fresh_sync_error,
            last_successful_sync_ms: input.dataFreshness.last_successful_sync_ms,
            used_stored_data_after_failed_sync: input.dataFreshness.used_stored_data_after_failed_sync,
          }
        : null,
      symbol: input.symbol,
      timeframe: strat.timeframe,
      date_range: { from_ts: candles[0].t, to_ts: candles[candles.length - 1].t, bars: candles.length },
      strategy_version: strat.strategy_version,
      rule_ids: strat.rule_ids,
      rule_versions: strat.rule_versions,
      runtime_availability: strat.availability,
      source_contract_status: strat.source_contract_status,
      source_contract_blockers: strat.source_contract_blockers,
      risk_policy_id: policy.policy_id,
      risk_policy_version: policy.policy_version,
      risk_policy_selection_status: policy.selection_status,
      risk_policy_selection_source: policy.selected_by,
      risk_policy_source_refs: policy.source_refs,
      risk_sizing_inputs: {
        equity,
        risk_per_trade_pct: riskPerTradePct,
        max_leverage: maxLeverage,
        prefs_source: prefs.source,
        configured: prefs.configured,
      },
      portfolio_verdicts: result.portfolio_verdicts,
      psychology_context: result.psychology_context,
      account_equity: equity,
      max_hold_bars: input.maxHoldBars,
      app_version: release.app_version,
      git_commit: release.git_commit,
      build_id: release.build_id,
      release_identity_status: release.source_tree_digest_status,
      source_tree_digest_status: release.source_tree_digest_status,
      worktree_status: release.worktree_status,
      source_tree_sha256: release.source_tree_sha256,
      source_tree_file_count: release.source_tree_file_count,
      source_tree_bytes: release.source_tree_bytes,
      source_tree_missing_inputs: release.source_tree_missing_inputs,
      source_tree_errors: release.source_tree_errors,
      costs,
      same_bar_policy: result.same_bar_policy,
    },
  };
}
