/**
 * Strategy Validation Pipeline Engine (MASTER PROMPT 2 — Phase 2).
 *
 * Provides a first-class, typed TypeScript orchestration engine for executing
 * end-to-end validation experiments over compiled runtime strategies using
 * real market data (TTT replay fixtures or persistent TTT history store).
 *
 * Flow per (strategy, symbol):
 *   Strategy Registry
 *     ↓
 *   Machine Executable Strategy (Compiled)
 *     ↓
 *   Market Data Load (TTT Replay / TTT Live Store) + Provenance Packaging
 *     ↓
 *   Market Regime Classification (Volatility Regime + Structure Bias)
 *     ↓
 *   In-Sample Backtest (70% chronological slice)
 *     ↓
 *   Out-of-Sample Backtest (30% holdout slice)
 *     ↓
 *   Walk-Forward Analysis (4 rolling test windows, or NOT_AVAILABLE if bars < 50/window)
 *     ↓
 *   Promotion Verdict Evaluation (Quality Ladder + Retention + Stability)
 *     ↓
 *   Immutable Experiment Record Persistence (experiments table in brain.db)
 *     ↓
 *   Deterministic Promotion Decision & Governance Audit (promotion.ts)
 *
 * HONESTY GUARANTEES:
 * - NO fabricated metrics or data.
 * - TTT only is the source of truth for market data.
 * - Limitation states (e.g. unmodelled funding) are explicitly declared.
 * - Insufficient history for Walk-Forward is recorded as NOT_AVAILABLE / 0 windows,
 *   never filled with synthetic numbers.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { COMPILED_STRATEGIES, type CompiledStrategy } from "../strategy/compiled";
import { getRuntimeVariants, listRuntimeStrategies } from "../strategy/runtime";
import { sourceContractBlockersFor, sourceContractDocumentIdentity, sourceContractStatusFor } from "../strategy/compiled/source-contract";
import {
  type BacktestCosts, type SameBarPolicy,
  type BacktestMetrics,
} from "./strategy-runner";
import {
  runOOS, runWalkForward, decidePromotion, PROMOTION_CRITERIA, VALIDATION_METHODOLOGY,
  type PromotionVerdict, type WalkForwardResult,
} from "./validation";
import {
  ExperimentStore, getExperiments, datasetFingerprint, artifactSha256,
  type DatasetIdentity, type DatasetSourceKind, type ExperimentRecord, type ExperimentSplit,
} from "./experiments";
import {
  buildPromotionDecision, resolvePromotionInput, promotionReport, promotionReports,
  buildProvenanceChain, type PromotionDecision, type StrategyValidationRecord,
  type PromotionStatus, type ValidationStage, type ValidationStatusLabel, type ProvenanceChain,
} from "./promotion";
import { buildPsychologyPolicies } from "../brain/policies";
import { getProductionRiskPolicy } from "../risk/policy";
import { getRiskPrefs } from "../prefs";
import { parseUdfHistory } from "../ttt/udf";
import { DETECTOR_VERSION, detectVolatilityRegime, detectStructureBias } from "../features/detectors";
import { buildReleaseIdentity } from "../release";
import { getHistoryStore } from "../market/history-store";
import type { TimeframeId } from "../domain/timeframes";
import type { Candle } from "../domain/types";
import type { EmpiricalStatus } from "../brain/types";

export type ValidationRunStatus = "NOT_RUN" | "RUNNING" | "COMPLETED" | "FAILED" | "INVALID" | "UNKNOWN";

export interface StrategyValidationExperimentOutput {
  experiment_id: string;
  strategy_id: string;
  setup_id: string;
  symbol: string;
  timeframe: string;
  bars: number;
  regime: { volatility: string; structure: string };
  in_sample: {
    trade_count: number;
    expectancy_r: number | null;
    profit_factor: number | null;
    win_rate: number | null;
    max_drawdown_r: number;
    total_r: number;
  };
  oos: {
    trade_count: number;
    expectancy_r: number | null;
    profit_factor: number | null;
    win_rate: number | null;
    max_drawdown_r: number;
    total_r: number;
  } | null;
  walk_forward: {
    total_windows: number;
    profitable_windows: number;
    stability: number | null;
    status: "COMPLETED" | "NOT_AVAILABLE";
    note: string;
  } | null;
  verdict: PromotionVerdict;
  dataset_identity: DatasetIdentity;
  split: ExperimentSplit;
  compiled_binding: {
    setup_id: string;
    direction: "long" | "short";
    timeframe: string;
    strategy_version: string;
    rule_bindings: { rule_id: string; rule_version: string }[];
    source_contract_sha256: string;
    source_contract_status: string;
    source_contract_blockers: string[];
  };
  persisted: boolean;
  status: ValidationRunStatus;
}

export interface ValidationPipelineOptions {
  /** Filter to a single strategy id or setup id */
  strategyId?: string;
  /** Must be explicit: replay fixture or stored TTT synchronization. */
  sourceKind?: DatasetSourceKind;
  /** Directory containing replay fixtures (path only; no data mode default). */
  replayDir?: string;
  /** Whether to persist experiment rows to ExperimentStore (default true). */
  persist?: boolean;
  /** Filter to specific symbols */
  symbols?: string[];
  /** Explicit operator inputs; missing values block the pipeline. */
  equity?: number;
  riskPerTradePct?: number;
  maxLeverage?: number;
  costs?: BacktestCosts;
  sameBarPolicy?: SameBarPolicy;
  maxHoldBars?: number;
}

export interface ValidationPipelineSummary {
  ok: boolean;
  status: "COMPLETED" | "BLOCKED" | "FAILED";
  blockers: string[];
  timestamp: number;
  methodology: string;
  criteria: typeof PROMOTION_CRITERIA;
  source_kind: DatasetSourceKind | "UNKNOWN";
  total_strategies_tested: number;
  total_experiments_generated: number;
  total_experiments_persisted: number;
  skipped_series: number;
  results: StrategyValidationExperimentOutput[];
  by_strategy: Record<string, {
    strategy_id: string;
    empirical_status: EmpiricalStatus;
    validation_status: ValidationStatusLabel;
    stage: ValidationStage;
    promotion_decision: "ELIGIBLE" | "NOT_ELIGIBLE";
    promotion_status: PromotionStatus;
    experiments: number;
    symbols: string[];
    blocking: string[];
  }>;
  counts: {
    strategies: number;
    executable: number;
    with_validation_evidence: number;
    with_oos_evidence: number;
    promotion_eligible: number;
    live_eligible: number;
  };
}

interface ReplayManifest {
  base: string;
  endpoint: string;
  captured_at_utc: string;
  series: { symbol: string; resolution: string; bars: number; file: string }[];
}

/** Classify the market regime of candles so coverage is observable. */
export function classifySeriesRegime(candles: Candle[], tf: string): { volatility: string; structure: string } {
  try {
    const vol = detectVolatilityRegime(candles, tf);
    const bias = detectStructureBias(candles, tf);
    return {
      volatility: vol.valid && vol.value ? vol.value.state : "UNKNOWN",
      structure: bias.valid && bias.value ? bias.value.bias : "UNKNOWN",
    };
  } catch {
    return { volatility: "UNKNOWN", structure: "UNKNOWN" };
  }
}

/**
 * Execute validation only after every required research input is explicit.
 * Missing settings return BLOCKED rather than manufacturing a successful empty run.
 */
export function runValidationPipeline(options: ValidationPipelineOptions = {}): ValidationPipelineSummary {
  const sourceKind = options.sourceKind;
  const policy = getProductionRiskPolicy();
  const prefs = getRiskPrefs();
  const equity = options.equity ?? prefs.equity;
  const riskPerTradePct = policy.risk_per_trade_pct ?? options.riskPerTradePct ?? prefs.perTradePct;
  const maxLeverage = policy.max_leverage ?? options.maxLeverage ?? prefs.maxLeverage;
  const costs = options.costs;
  const sameBarPolicy = options.sameBarPolicy;
  const maxHoldBars = options.maxHoldBars;
  const blockers: string[] = [];
  if (sourceKind !== "TTT_UDF_REPLAY" && sourceKind !== "TTT_LIVE_SYNC") blockers.push("sourceKind must be explicitly TTT_UDF_REPLAY or TTT_LIVE_SYNC");
  if (policy.selection_status !== "SELECTED" || policy.source_status !== "SOURCE_VERIFIED" || policy.source_refs.length === 0 || policy.conflict_group_id !== null) blockers.push(`risk policy is not explicitly selected and source-verified: ${policy.selection_reason}`);
  if (equity === null || !Number.isFinite(equity) || equity <= 0) blockers.push("account equity is unconfigured; no default is substituted");
  if (riskPerTradePct === null || !Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0) blockers.push("per-trade risk sizing is unconfigured; no default is substituted");
  if (maxLeverage === null || !Number.isFinite(maxLeverage) || maxLeverage <= 0) blockers.push("maximum leverage is unconfigured; no default is substituted");
  if (!costs || !Number.isFinite(costs.fee_rate) || costs.fee_rate < 0 || !Number.isFinite(costs.slippage_rate) || costs.slippage_rate < 0) blockers.push("fee/slippage costs must be explicitly supplied as finite non-negative rates");
  if (sameBarPolicy !== "stop_first" && sameBarPolicy !== "target_first") blockers.push("same-bar ambiguity policy must be explicitly selected");
  if (!Number.isSafeInteger(maxHoldBars) || (maxHoldBars ?? 0) <= 0) blockers.push("maxHoldBars must be explicitly supplied as a positive integer");
  if (blockers.length > 0) {
    return {
      ok: false, status: "BLOCKED", blockers, timestamp: Date.now(), methodology: VALIDATION_METHODOLOGY,
      criteria: PROMOTION_CRITERIA, source_kind: sourceKind ?? "UNKNOWN", total_strategies_tested: 0,
      total_experiments_generated: 0, total_experiments_persisted: 0, skipped_series: 0, results: [], by_strategy: {},
      counts: { strategies: 0, executable: 0, with_validation_evidence: 0, with_oos_evidence: 0, promotion_eligible: 0, live_eligible: 0 },
    };
  }
  const resolvedSourceKind = sourceKind as DatasetSourceKind;
  const replayDir = options.replayDir ?? path.join(process.cwd(), "tests/fixtures/replay");
  const persist = options.persist !== false;
  const resolvedCosts = costs as BacktestCosts;
  const resolvedSameBarPolicy = sameBarPolicy as SameBarPolicy;
  const resolvedMaxHoldBars = maxHoldBars as number;
  const resolvedEquity = equity as number;
  const resolvedRiskPerTradePct = riskPerTradePct as number;
  const resolvedMaxLeverage = maxLeverage as number;
  const psychIds = "NOT_RECONSTRUCTED_HISTORICAL_RESEARCH";
  const release = buildReleaseIdentity();
  const codeVersion = release.git_commit;
  const sourceTreeSha256 = release.source_tree_sha256;
  const sourceTreeDigestStatus = release.source_tree_digest_status;
  const retrievedAt = new Date().toISOString();

  let manifest: ReplayManifest | null = null;
  if (resolvedSourceKind === "TTT_UDF_REPLAY") {
    const manifestPath = path.join(replayDir, "MANIFEST.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`replay manifest not found at ${manifestPath}`);
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ReplayManifest;
  }

  // Filter strategies
  let strategiesToTest: CompiledStrategy[] = COMPILED_STRATEGIES;
  if (options.strategyId) {
    const target = options.strategyId;
    strategiesToTest = COMPILED_STRATEGIES.filter(
      (s) => s.strategy_id === target || s.setup_id === target,
    );
    if (strategiesToTest.length === 0) {
      throw new Error(`no compiled executable strategy found matching '${target}'`);
    }
  }

  const store = getExperiments();
  const results: StrategyValidationExperimentOutput[] = [];
  let skipped = 0;
  let persistedCount = 0;

  const sourceContractIdentity = sourceContractDocumentIdentity();
  for (const strat of strategiesToTest) {
    const tfMin = strat.timeframe === "1d" ? 1440 : 60;
    const setup = strat.setup();
    const ruleBindings = setup.rules.map((rule) => ({ rule_id: rule.id, rule_version: rule.version })).sort((a, b) => a.rule_id.localeCompare(b.rule_id));
    const ruleVersions = [...new Set(ruleBindings.map((binding) => binding.rule_version))].sort();
    const contractStatus = sourceContractStatusFor(strat.strategy_id);
    const contractBlockers = sourceContractBlockersFor(strat.strategy_id);
    const compiledBinding = {
      setup_id: strat.setup_id,
      direction: strat.direction,
      timeframe: strat.timeframe,
      strategy_version: setup.version,
      rule_bindings: ruleBindings,
      source_contract_sha256: sourceContractIdentity.contract_sha256 ?? "",
      source_contract_status: contractStatus,
      source_contract_blockers: contractBlockers,
    };

    if (resolvedSourceKind === "TTT_UDF_REPLAY" && manifest) {
      const wanted = manifest.series.filter((s) => {
        const matchRes = strat.timeframe === "1d" ? s.resolution === "1D" : s.resolution === "60";
        const matchSym = options.symbols ? options.symbols.includes(s.symbol) : true;
        return matchRes && matchSym;
      });

      for (const ser of wanted) {
        const filePath = path.join(/*turbopackIgnore: true*/ replayDir, ser.file);
        if (!fs.existsSync(/*turbopackIgnore: true*/ filePath)) {
          skipped++;
          continue;
        }

        const fileContent = fs.readFileSync(/*turbopackIgnore: true*/ filePath, "utf8");
        const parsedRaw = JSON.parse(fileContent);
        const { candles } = parseUdfHistory(parsedRaw, tfMin);

        if (candles.length < strat.min_bars + 60) {
          skipped++;
          continue;
        }

        const artifactSha = artifactSha256(fileContent);
        const fingerprint = datasetFingerprint(candles);
        const regime = classifySeriesRegime(candles, strat.timeframe);

        const opts = { equity: resolvedEquity, policy, riskPerTradePct: resolvedRiskPerTradePct, maxLeverage: resolvedMaxLeverage, costs: resolvedCosts, sameBarPolicy: resolvedSameBarPolicy, max_hold_bars: resolvedMaxHoldBars };
        const split = runOOS(strat, ser.symbol, candles, opts, 0.7);
        const wf = runWalkForward(strat, ser.symbol, candles, opts, 4);
        const verdict = decidePromotion(split.in_sample.metrics, split.out_of_sample.metrics, wf);

        const splitIndex = split.split_index;
        const isPeriod = { from_ts: candles[0].t, to_ts: candles[splitIndex - 1].t, bars: splitIndex };
        const oosPeriod = { from_ts: candles[splitIndex].t, to_ts: candles[candles.length - 1].t, bars: candles.length - splitIndex };

        const datasetIdentity: DatasetIdentity = {
          source_kind: "TTT_UDF_REPLAY",
          source_ref: path.relative(process.cwd(), filePath),
          source_base: manifest.base,
          captured_at: manifest.captured_at_utc,
          retrieved_at: retrievedAt,
          fingerprint,
          fingerprint_recomputed: true,
          source_sha256: artifactSha,
          bars: candles.length,
          from_ts: candles[0].t,
          to_ts: candles[candles.length - 1].t,
          note: `TTT public UDF history captured verbatim (${manifest.endpoint}); deterministic replay — not a live sync`,
        };

        const splitRecord: ExperimentSplit = {
          split_ratio: 0.7,
          split_index: splitIndex,
          in_sample: isPeriod,
          out_of_sample: oosPeriod,
          walk_forward_windows: wf.windows.map((w) => ({
            window: w.window,
            test_from: w.test_from,
            test_to: w.test_to,
            trades: w.trades,
          })),
        };

        const expId = `${strat.setup_id}|${ser.symbol}|${Date.now()}|${randomUUID().slice(0, 8)}`;
        const experimentRecord: ExperimentRecord = {
          experiment_id: expId,
          created_ms: Date.now(),
          strategy_id: strat.strategy_id,
          setup_id: strat.setup_id,
          symbol: ser.symbol,
          timeframe: strat.timeframe,
          dataset_fingerprint: fingerprint,
          bars: candles.length,
          from_ts: candles[0].t,
          to_ts: candles[candles.length - 1].t,
          strategy_version: setup.version,
          detector_version: DETECTOR_VERSION,
          app_version: release.app_version,
          build_id: release.build_id,
          rule_version: ruleVersions.join("+"),
          risk_policy_id: policy.policy_id,
          psychology_policy_set: psychIds,
          costs: resolvedCosts,
          params: {
            split_ratio: 0.7,
            windows: 4,
            criteria: PROMOTION_CRITERIA,
            regime,
            methodology: VALIDATION_METHODOLOGY,
            walk_forward_note: wf.note,
            detectors_may_use_prior_history: true,
            compiled_binding: compiledBinding,
          },
          in_sample: split.in_sample.metrics,
          oos: split.out_of_sample.metrics,
          walk_forward: wf,
          promotion: verdict,
          empirical_status: verdict.to,
          code_version: codeVersion,
          source_tree_sha256: sourceTreeSha256,
          source_tree_digest_status: sourceTreeDigestStatus,
          dataset_identity: datasetIdentity,
          split: splitRecord,
        };

        if (persist) {
          store.insert(experimentRecord);
          persistedCount++;
        }

        const isMetrics = split.in_sample.metrics;
        const oosMetrics = split.out_of_sample.metrics;

        results.push({
          experiment_id: expId,
          strategy_id: strat.strategy_id,
          setup_id: strat.setup_id,
          symbol: ser.symbol,
          timeframe: strat.timeframe,
          bars: candles.length,
          regime,
          in_sample: {
            trade_count: isMetrics.trade_count,
            expectancy_r: isMetrics.expectancy_r,
            profit_factor: isMetrics.profit_factor,
            win_rate: isMetrics.win_rate,
            max_drawdown_r: isMetrics.max_drawdown_r,
            total_r: isMetrics.total_r,
          },
          oos: oosMetrics ? {
            trade_count: oosMetrics.trade_count,
            expectancy_r: oosMetrics.expectancy_r,
            profit_factor: oosMetrics.profit_factor,
            win_rate: oosMetrics.win_rate,
            max_drawdown_r: oosMetrics.max_drawdown_r,
            total_r: oosMetrics.total_r,
          } : null,
          walk_forward: {
            total_windows: wf.total_windows,
            profitable_windows: wf.profitable_windows,
            stability: wf.stability,
            status: wf.total_windows >= PROMOTION_CRITERIA.min_windows ? "COMPLETED" : "NOT_AVAILABLE",
            note: wf.note,
          },
          verdict,
          dataset_identity: datasetIdentity,
          split: splitRecord,
          compiled_binding: compiledBinding,
          persisted: persist,
          status: "COMPLETED",
        });
      }
    } else if (resolvedSourceKind === "TTT_LIVE_SYNC") {
      const historyStore = getHistoryStore();
      const operationalSymbols = options.symbols ?? ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "BNBUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT"];

      for (const symbol of operationalSymbols) {
        const tf = strat.timeframe as TimeframeId;
        const candles = historyStore.get(symbol, tf);
        const syncRow = historyStore.syncRow(symbol, tf);

        if (candles.length < strat.min_bars + 60) {
          skipped++;
          continue;
        }

        const fingerprint = datasetFingerprint(candles);
        const candleBytes = Buffer.from(JSON.stringify(candles), "utf8");
        const artifactSha = artifactSha256(candleBytes);
        const regime = classifySeriesRegime(candles, strat.timeframe);

        const opts = { equity: resolvedEquity, policy, riskPerTradePct: resolvedRiskPerTradePct, maxLeverage: resolvedMaxLeverage, costs: resolvedCosts, sameBarPolicy: resolvedSameBarPolicy, max_hold_bars: resolvedMaxHoldBars };
        const split = runOOS(strat, symbol, candles, opts, 0.7);
        const wf = runWalkForward(strat, symbol, candles, opts, 4);
        const verdict = decidePromotion(split.in_sample.metrics, split.out_of_sample.metrics, wf);

        const splitIndex = split.split_index;
        const isPeriod = { from_ts: candles[0].t, to_ts: candles[splitIndex - 1].t, bars: splitIndex };
        const oosPeriod = { from_ts: candles[splitIndex].t, to_ts: candles[candles.length - 1].t, bars: candles.length - splitIndex };

        const datasetIdentity: DatasetIdentity = {
          source_kind: "TTT_LIVE_SYNC",
          source_ref: `ttt:/futures/udf/history?symbol=${symbol}&resolution=${strat.timeframe}`,
          source_base: "https://apiv2.thetruetrade.io",
          captured_at: syncRow?.last_successful_sync_ms ? new Date(syncRow.last_successful_sync_ms).toISOString() : retrievedAt,
          retrieved_at: retrievedAt,
          fingerprint,
          fingerprint_recomputed: true,
          source_sha256: artifactSha,
          bars: candles.length,
          from_ts: candles[0].t,
          to_ts: candles[candles.length - 1].t,
          note: "TTT history synchronized to persistent store (live synchronization)",
        };

        const splitRecord: ExperimentSplit = {
          split_ratio: 0.7,
          split_index: splitIndex,
          in_sample: isPeriod,
          out_of_sample: oosPeriod,
          walk_forward_windows: wf.windows.map((w) => ({
            window: w.window,
            test_from: w.test_from,
            test_to: w.test_to,
            trades: w.trades,
          })),
        };

        const expId = `${strat.setup_id}|${symbol}|${Date.now()}|${randomUUID().slice(0, 8)}`;
        const experimentRecord: ExperimentRecord = {
          experiment_id: expId,
          created_ms: Date.now(),
          strategy_id: strat.strategy_id,
          setup_id: strat.setup_id,
          symbol,
          timeframe: strat.timeframe,
          dataset_fingerprint: fingerprint,
          bars: candles.length,
          from_ts: candles[0].t,
          to_ts: candles[candles.length - 1].t,
          strategy_version: setup.version,
          detector_version: DETECTOR_VERSION,
          app_version: release.app_version,
          build_id: release.build_id,
          rule_version: ruleVersions.join("+"),
          risk_policy_id: policy.policy_id,
          psychology_policy_set: psychIds,
          costs: resolvedCosts,
          params: {
            split_ratio: 0.7,
            windows: 4,
            criteria: PROMOTION_CRITERIA,
            regime,
            methodology: VALIDATION_METHODOLOGY,
            walk_forward_note: wf.note,
            detectors_may_use_prior_history: true,
            compiled_binding: compiledBinding,
          },
          in_sample: split.in_sample.metrics,
          oos: split.out_of_sample.metrics,
          walk_forward: wf,
          promotion: verdict,
          empirical_status: verdict.to,
          code_version: codeVersion,
          source_tree_sha256: sourceTreeSha256,
          source_tree_digest_status: sourceTreeDigestStatus,
          dataset_identity: datasetIdentity,
          split: splitRecord,
        };

        if (persist) {
          store.insert(experimentRecord);
          persistedCount++;
        }

        const isMetrics = split.in_sample.metrics;
        const oosMetrics = split.out_of_sample.metrics;

        results.push({
          experiment_id: expId,
          strategy_id: strat.strategy_id,
          setup_id: strat.setup_id,
          symbol,
          timeframe: strat.timeframe,
          bars: candles.length,
          regime,
          in_sample: {
            trade_count: isMetrics.trade_count,
            expectancy_r: isMetrics.expectancy_r,
            profit_factor: isMetrics.profit_factor,
            win_rate: isMetrics.win_rate,
            max_drawdown_r: isMetrics.max_drawdown_r,
            total_r: isMetrics.total_r,
          },
          oos: oosMetrics ? {
            trade_count: oosMetrics.trade_count,
            expectancy_r: oosMetrics.expectancy_r,
            profit_factor: oosMetrics.profit_factor,
            win_rate: oosMetrics.win_rate,
            max_drawdown_r: oosMetrics.max_drawdown_r,
            total_r: oosMetrics.total_r,
          } : null,
          walk_forward: {
            total_windows: wf.total_windows,
            profitable_windows: wf.profitable_windows,
            stability: wf.stability,
            status: wf.total_windows >= PROMOTION_CRITERIA.min_windows ? "COMPLETED" : "NOT_AVAILABLE",
            note: wf.note,
          },
          verdict,
          dataset_identity: datasetIdentity,
          split: splitRecord,
          compiled_binding: compiledBinding,
          persisted: persist,
          status: "COMPLETED",
        });
      }
    }
  }

  // Generate updated promotion reports across compiled strategies
  const reports = promotionReports();
  const byStrategy: ValidationPipelineSummary["by_strategy"] = {};

  for (const rep of reports) {
    byStrategy[rep.strategy_id] = {
      strategy_id: rep.strategy_id,
      empirical_status: rep.promotion.evidenced_status,
      validation_status: rep.validation_status,
      stage: rep.strategy_state.stage,
      promotion_decision: rep.promotion.decision,
      promotion_status: rep.promotion.promotion_status,
      experiments: results.filter((r) => r.strategy_id === rep.strategy_id).length,
      symbols: [...new Set(results.filter((r) => r.strategy_id === rep.strategy_id).map((r) => r.symbol))],
      blocking: rep.blocking,
    };
  }

  return {
    ok: true,
    status: "COMPLETED",
    blockers: [],
    timestamp: Date.now(),
    methodology: VALIDATION_METHODOLOGY,
    criteria: PROMOTION_CRITERIA,
    source_kind: resolvedSourceKind,
    total_strategies_tested: strategiesToTest.length,
    total_experiments_generated: results.length,
    total_experiments_persisted: persistedCount,
    skipped_series: skipped,
    results,
    by_strategy: byStrategy,
    counts: {
      strategies: reports.length,
      executable: reports.filter((r) => r.strategy_state.executable).length,
      with_validation_evidence: reports.filter((r) => r.strategy_state.has_validation_evidence).length,
      with_oos_evidence: reports.filter((r) => r.strategy_state.has_oos_evidence).length,
      promotion_eligible: reports.filter((r) => r.strategy_state.promotion_eligible).length,
      live_eligible: reports.filter((r) => r.strategy_state.live_eligible).length,
    },
  };
}
