/**
 * Pipeline orchestrator (docs/architecture): opportunity lifecycle + signal
 * lifecycle + durability. Deterministic. Signals NEVER become orders.
 * Opportunities are stored with idempotent keys; refresh rules keep stale
 * anchors from being shown as live.
 */
import { createHash } from "node:crypto";
import { sharedStore } from "../market/store";
import { candleManager } from "../market/candles";
import { prepareAnalysisInput } from "../analysis/input";
import { getRepo } from "../../db/sqlite";
import { promotedRuntimeStatus } from "../backtest/promotion";
import { getRuntimeStrategy, listRuntimeStrategies, evaluateRuntime, type StrategyRuntimeDefinition } from "../strategy/runtime";
import { evaluateLiveRisk } from "../risk/live";
import { isDeepStrictEqual } from "node:util";
import { evaluatePortfolio } from "../risk/portfolio";
import { evaluatePsychologyGate } from "../psychology/gate";
import { admitOpportunity, SCORE_DISCLAIMER, type ScoreResult } from "../brain/score";
import { buildPsychologyPolicies } from "../brain/policies";
import { getProductionRiskPolicy } from "../risk/policy";
import { scoreFromEvaluation } from "./scoring";
import { buildChartEvidence, chartEvidenceMatches, decisionSnapshot, type ChartEvidence, type DecisionSnapshot } from "../chart/evidence";
import { chartSource, validChartSource, type ChartSource } from "../chart/source";
import { DETECTOR_VERSION } from "../features/detectors";
import { eventBus } from "../events";
import { getRiskPrefs } from "../prefs";
import { ASA_SCORE_THRESHOLD } from "../env";
import type { TimeframeId } from "../domain/timeframes";
import { loadLiveGateContext, liveMeasurementBlocks } from "./live-gates";
import { opportunityFreshness, tfStalenessMs } from "./freshness";

export { opportunityFreshness, tfBarMs, tfStalenessMs } from "./freshness";

export const OPPORTUNITY_STATES = ["SCANNING", "ANALYZING", "CANDIDATE", "RISK_CHECK", "READY", "REJECTED", "COOLDOWN", "EXPIRED"] as const;
export { SIGNAL_STATES } from "./signal-lifecycle";
import { signalHasExpired, refreshSignalExpiry } from "./signal-lifecycle";

export interface OpportunityPayload {
  id: string;
  symbol: string;
  timeframe: string;
  direction: "long" | "short";
  score: number;
  setup: string;
  thesis: string;
  entry_zone: { top: number; bottom: number } | null;
  invalidation: number | null;
  stop: number | null;
  targets: number[];
  rr: number | null;
  strategy_id: string;
  mode: "research" | "live";
  state: string;
  anchor_ts_ms: number;
  anchor_close_ms: number | null;
  freshness_ms: number;
  evidence: string[];
  contradictions: string[];
  /** full explainable score decomposition (never a probability) */
  score_breakdown: ScoreResult | null;
  positive_factors: string[];
  negative_factors: string[];
  blocked_factors: string[];
  unknown_factors: string[];
  source_refs: { file: string; start_line: number; end_line: number }[];
  data_quality: {
    bars: number;
    stale: boolean;
    age_ms: number | null;
    state: string;
    source_ts_ms?: number | null;
    native?: boolean;
    forming_bar_excluded?: boolean;
  };
  psychology: {
    state: string;
    hard_blocks: string[];
    soft_warnings: string[];
    score_modifier: number;
    not_evaluated?: string[];
  } | null;
  portfolio: { verdict: string; reasons: string[]; unenforced: string[] } | null;
  setup_id: string | null;
  score_semantics: string;
  /** annotation lineage consumed by the chart route AND the Telegram image */
  chart_evidence: ChartEvidence | null;
  /** Exact decision dataset reference; absent on legacy opportunities only. */
  chart_source?: ChartSource;
  risk: { verdict: string; reasons: string[]; unenforced?: string[]; numbers?: Record<string, unknown> } | null;
  ai: { provider: string; label: string } | null;
  provenance: {
    generated_at_ms: number;
    data: {
      series_fetched_ms: number;
      stats_fetched_ms: number | null;
      native_1d: boolean;
      /** null = that series was NOT part of this decision (never a fake 0) */
      candles: { macro: number | null; context: number | null; trigger: number | null };
      /**
       * Task 10: identity of the exact closed-bar window evaluated
       * (bundleInputFingerprint over symbol|tf|engines + candles). Same object
       * as chart_evidence.snapshot. null only when it could not be formed;
       * absent on rows persisted before Task 10.
       */
      snapshot?: DecisionSnapshot | null;
    };
  };
}

export function idFor(symbol: string, tf: string, direction: string, strategyId: string, anchorSec: number): string {
  return createHash("sha1").update(`${symbol}|${tf}|${direction}|${strategyId}|${anchorSec}`).digest("hex").slice(0, 16);
}

export interface ScanOutcome {
  opportunity: OpportunityPayload | null;
  evaluated: boolean;
  reason?: string;
  /**
   * Publication result when this scan reached the publication boundary (live
   * mode, READY decision). Absent = the boundary was never reached (no
   * opportunity, not READY, or research mode) — NOT a refusal.
   */
  publish?: PublishSignalResult;
}

/**
 * Full deterministic scan for one symbol using the BRAIN-BACKED runtime.
 *
 * Gate order (closure §K): data freshness -> strategy prerequisites -> features
 * -> rules -> setup -> psychology -> risk -> portfolio -> score -> admission.
 * Every gate contributes an explicit reason; nothing is hard-coded.
 */
export async function scanSymbol(
  symbol: string,
  strategy: StrategyRuntimeDefinition,
  mode: "research" | "live",
  opts: {
    /**
     * true (default, existing behaviour) = force a fresh candle fetch. The
     * live scanner passes false when reacting to `candle.closed`: that event
     * is emitted AFTER the fresh series was stored, so re-fetching would only
     * double the venue call. `ensureSeries` still refetches a cache older
     * than its own freshness window — stale data is never used silently.
     */
    forceRefresh?: boolean;
  } = {},
): Promise<ScanOutcome> {
  if (strategy.availability !== "EXECUTABLE" || !strategy.impl) {
    return { opportunity: null, evaluated: false, reason: `strategy ${strategy.setup_id} is ${strategy.availability}: ${strategy.blocked_reason ?? "not executable"}` };
  }
  // Each strategy declares its OWN timeframe — never hard-coded to 15m.
  const tf = strategy.timeframe as TimeframeId;

  const seriesTrg = await candleManager.ensureSeries(symbol, tf, opts.forceRefresh ?? true);
  const nowMs = Date.now();
  // ANALYSIS INPUT CONTRACT (Task 03): the venue series ends with the bar that
  // is still FORMING. Strategy rules are closed-bar logic, so that bar is
  // removed here (and the identity of the series is verified) before any
  // evaluation, sufficiency check or anchor/staleness computation.
  const input = prepareAnalysisInput(symbol, tf, seriesTrg ?? null, nowMs);
  if (!seriesTrg || input.closed_bars < strategy.min_bars) {
    return { opportunity: null, evaluated: false, reason: `insufficient closed ${tf} history: need ${strategy.min_bars}, have ${input.closed_bars}${input.reason ? ` (${input.reason})` : ""}` };
  }

  const candles = input.candles;
  const anchorSec = candles[candles.length - 1].t;
  // SOURCE age = time since the last CLOSED bar actually closed (open + period).
  const anchorCloseMs = input.source_ts_ms as number;
  const ageMs = input.data_age_ms ?? (nowMs - anchorCloseMs);
  const stale = input.freshness !== "FRESH";
  const snapshot = decisionSnapshot(symbol, tf, candles, anchorCloseMs, `strategy:${strategy.strategy_id}@${strategy.version}|detectors:${DETECTOR_VERSION}`);

  // ---- deterministic strategy evaluation (same call the backtester makes)
  const evOrBlocked = evaluateRuntime(strategy, symbol, candles, nowMs);
  if ("blocked" in evOrBlocked) {
    return { opportunity: null, evaluated: false, reason: evOrBlocked.reason };
  }
  const ev = evOrBlocked;
  const id = idFor(symbol, tf, ev.direction, strategy.setup_id, anchorSec);

  // ---- risk (direction-safe, target-aware)
  const policy = getProductionRiskPolicy();
  const rp = getRiskPrefs();
  const risk = ev.levels.entry !== null && ev.levels.stop !== null
    ? evaluateLiveRisk(symbol, ev.direction, ev.levels.entry, ev.levels.stop, ev.levels.targets[0] ?? null)
    : null;
  const riskPass = risk?.verdict === "pass";
  const riskVerdict: "pass" | "block" | "unavailable" = risk == null ? "unavailable" : risk.verdict === "pass" ? "pass" : "block";

  // ---- psychology + portfolio from MEASURED sources (journal / advisory book).
  // Never default consecutive losses, daily PnL or open exposure to zero.
  const repoForGates = getRepo();
  const gates = loadLiveGateContext(repoForGates, nowMs, {
    daily_loss_limit_pct: policy.daily_loss_limit_pct,
    excludeOppId: id,
  });
  const psych = evaluatePsychologyGate(buildPsychologyPolicies(), gates.psychology);

  const riskAmount = typeof risk?.numbers.risk_notional === "number" ? risk.numbers.risk_notional : null;
  const portfolio = evaluatePortfolio({
    equity: rp.equity,
    policy,
    open_risks: gates.open_risks,
    daily_realized_loss: gates.daily_realized_loss,
    period_realized_loss: gates.period_realized_loss,
    candidate: { symbol, risk_amount: riskAmount, direction: ev.direction },
  });

  if (mode === "live") {
    const unavailable = liveMeasurementBlocks(gates, policy);
    if (unavailable.length) {
      portfolio.verdict = "block";
      portfolio.reasons.push(...unavailable);
      portfolio.blocked_by.push(...unavailable);
    }
  }

  // ---- contradictions come from the rule layer, never hard-coded
  const contradictions = ev.setup.blocked_rules.map((id) => `rule ${id} is BLOCKED (non-computable or invalidation fired)`);

  // ---- explainable score (no constants)
  const score = scoreFromEvaluation(ev, {
    riskPass,
    riskEvaluated: risk != null,
    psychReady: psych.verdict !== "block",
    psychPenalty: psych.score_penalty,
    bars: candles.length,
    stale,
    contradictions,
  });

  const unknownFields: string[] = [];
  if (ev.levels.entry === null) unknownFields.push("entry");
  if (ev.levels.stop === null) unknownFields.push("stop");
  if (ev.levels.targets.length === 0) unknownFields.push("target");

  const admission = admitOpportunity({
    // HARD GATE: shared contract requires setup PASS (kept in lockstep with
    // the explicit `ev.setup.outcome !== "PASS"` early return below).
    setup_verdict: ev.setup.outcome,
    score: score.score,
    threshold: getScoreThreshold(),
    data_quality_ok: !stale && candles.length >= strategy.min_bars && (mode !== "live" || seriesTrg.native),
    stale,
    risk_verdict: riskVerdict,
    portfolio_verdict: portfolio.verdict,
    psychology_verdict: psych.verdict,
    strategy_runtime_status: mode === "live" ? runtimeStatusFor(strategy.strategy_id) : "CANDIDATE",
    unresolved_contradiction: contradictions.length > 0,
    unknown_required_fields: unknownFields,
    derived_market_truth: mode === "live" && seriesTrg.native === false,
    // Live output additionally requires the FULL promotion gate: a strategy
    // that is merely executable, or in-sample BACKTESTED, must never publish a
    // live advisory signal.
    requires_live_eligibility: mode === "live",
  });

  if (ev.setup.outcome !== "PASS") {
    return { opportunity: null, evaluated: true, reason: `setup ${ev.setup.outcome}: ${ev.setup.explanation}` };
  }

  const oppState = admission.admitted ? "READY" : "REJECTED";

  const payload: OpportunityPayload = {
    id,
    symbol,
    timeframe: tf,
    direction: ev.direction,
    score: score.score,
    setup: `${strategy.name} (${strategy.setup_id})`,
    thesis: ev.setup.explanation,
    entry_zone: ev.levels.entry !== null ? { top: ev.levels.entry, bottom: ev.levels.entry } : null,
    invalidation: ev.levels.invalidation,
    stop: ev.levels.stop,
    targets: ev.levels.targets,
    rr: ev.rr,
    strategy_id: strategy.strategy_id,
    setup_id: strategy.setup_id,
    mode,
    state: oppState,
    anchor_ts_ms: anchorSec * 1000,
    anchor_close_ms: anchorCloseMs,
    freshness_ms: ageMs,
    evidence: score.positive_factors,
    contradictions,
    score_breakdown: score,
    positive_factors: score.positive_factors,
    negative_factors: score.negative_factors,
    blocked_factors: [...admission.reasons, ...portfolio.blocked_by],
    unknown_factors: score.unknown_factors,
    source_refs: score.source_refs,
    data_quality: { bars: candles.length, stale, age_ms: ageMs, state: stale ? "STALE" : "FRESH" },
    psychology: {
      state: psych.verdict === "block" ? "BLOCKED" : psych.verdict === "flag" ? "CAUTION" : "READY",
      hard_blocks: psych.blocks.map((b) => b.reason),
      soft_warnings: psych.flags.map((f) => f.reason),
      score_modifier: -psych.score_penalty,
      not_evaluated: psych.not_evaluated.map((p) => `${p.policy_id}: ${p.reason}`),
    },
    portfolio: { verdict: portfolio.verdict, reasons: portfolio.reasons, unenforced: portfolio.unenforced },
    score_semantics: SCORE_DISCLAIMER,
    chart_evidence: buildChartEvidence(ev, score.score, snapshot),
    chart_source: chartSource(candles),
    risk: risk ? { verdict: risk.verdict, reasons: risk.reasons, unenforced: risk.unenforced, numbers: risk.numbers as unknown as Record<string, unknown> } : null,
    ai: null,
    provenance: {
      generated_at_ms: nowMs,
      data: {
        series_fetched_ms: seriesTrg.fetched_at_ms,
        stats_fetched_ms: sharedStore.getStats(symbol)?.provenance.fetched_at_ms ?? null,
        native_1d: seriesTrg.native,
        // AUDIT FIX (P2): macro/context counts were hard-coded 0, which
        // reads as "measured zero bars". The advisory decision uses ONLY the
        // strategy's own trigger series; the MTF macro/context bundles belong
        // to the /api/analysis path. Honest value: null = not part of this
        // decision.
        candles: { macro: null, context: null, trigger: candles.length },
        snapshot,
      },
    },
  };

  if (payload.state === "READY" && stale) payload.state = "EXPIRED";

  const repo = getRepo();
  const row = repo.opportunityGet(payload.id);
  const createdMs = row?.created_ms ?? nowMs;
  repo.opportunityUpsert({
    id: payload.id,
    symbol,
    timeframe: tf,
    direction: ev.direction,
    score: score.score,
    state: payload.state,
    mode,
    strategy_id: strategy.strategy_id,
    payload_json: JSON.stringify(payload),
    created_ms: createdMs,
    updated_ms: nowMs,
  });
  if (!row) eventBus.emit("opportunity.created", { id: payload.id, symbol });
  else eventBus.emit("opportunity.updated", { id: payload.id, state: payload.state });

  if (mode === "live" && payload.state === "READY") {
    // T05 T4: the publish result is part of the scan outcome (observable),
    // never silently discarded. publishSignal is the ONE publication path.
    const publish = publishSignal(payload);
    if (!publish.published) {
      // A mutable gate may change between scan and the publication lock.
      // Persist refusal so API/UI cannot advertise READY without authorization.
      payload.state = "REJECTED";
      payload.blocked_factors = [...payload.blocked_factors, publish.reason];
      repo.opportunityUpsert({ id:payload.id,symbol,timeframe:tf,direction:payload.direction,score:payload.score,
        state:payload.state,mode,strategy_id:payload.strategy_id,payload_json:JSON.stringify(payload),created_ms:createdMs,updated_ms:Date.now() });
    }
    return { opportunity: payload, evaluated: true, publish };
  }
  return { opportunity: payload, evaluated: true };
}

/** Admission threshold. Decision score, NOT a probability. */
export function getScoreThreshold(): number {
  // AUDIT FIX (P2): single registered source (clamped 0..100 in env.ts),
  // previously an undocumented direct process.env read.
  return ASA_SCORE_THRESHOLD;
}

/**
 * Runtime status for live gating.
 *
 * PROMOTION PHASE: this is now a thin read of the ONE deterministic promotion
 * gate (`backtest/promotion`) instead of a hand-rolled status→status mapping.
 * The old mapping consulted persisted empirical status only, so it could not
 * see governance (critical UNKNOWNs, unresolved conflicts, a missing
 * implementation binding) and could not tell whether the evidence still
 * described the current build. `LIVE_ADVISORY_ONLY` is now reachable ONLY
 * through a fully satisfied promotion gate; every other case is the
 * evidence-derived status CLAMPED by the governance ceiling, and any error
 * fails CLOSED.
 *
 * AUDIT FIX (P1): the old implementation used `require()` (which silently
 * fails under ESM test runners — always yielding DISABLED) and opened a NEW
 * SQLite connection on every call. It now uses the shared stores via static
 * imports and still fails CLOSED on any error.
 */
export function runtimeStatusFor(strategyId: string): string {
  return promotedRuntimeStatus(strategyId);
}

/**
 * Publish action for an existing signal row, by its current lifecycle state.
 *
 * The signal lifecycle is one-way for a given opportunity (stable key =
 * `idFor`'s symbol|tf|direction|strategy|anchor): `candidate`/`qualified` may
 * become `published` exactly once; `published` is an idempotent no-op; every
 * other state (`expired`, `invalidated`, `closed`, `archived`,
 * `blocked_by_risk`) is TERMINAL and must never be resurrected or re-queued.
 * Unknown states are fail-safe terminal: a state this code does not understand
 * must never be silently overwritten into `published`.
 */
export function publishActionFor(existingState: string | null): "create" | "activate" | "already_published" | "terminal" {
  if (existingState === null) return "create";
  if (existingState === "published") return "already_published";
  if (existingState === "candidate" || existingState === "qualified") return "activate";
  return "terminal";
}

export interface PublishSignalResult {
  id: string;
  /** true only when the signal is in state `published` after this call */
  published: boolean;
  /** honest outcome: "published", "already published", or the exact refusal reason */
  reason: string;
}

/**
 * Publish advisory signal (live mode only). Signal ≠ order.
 *
 * FIX (T05): this is the FINAL boundary of the hard risk gate and the ONE
 * publication point for the Telegram outbox. It now enforces, on its own,
 * every invariant the delivery path promises:
 *
 *  1. FINAL RISK BOUNDARY (strict): a decision whose state is not `READY`, or
 *     whose risk result is not an EXPLICIT well-formed `verdict: "pass"` from
 *     the risk engine, is NEVER turned into a published signal or an outbox
 *     row — regardless of the caller. Missing / unavailable / unknown /
 *     malformed risk is refused as firmly as `block`; a blocked/denied risk
 *     result stays blocked here; no later layer can override it.
 *  2. EXACTLY ONCE (closure §V): one opportunity -> one signal row -> ONE
 *     outbox row. Re-publishing is an idempotent no-op. Previously only
 *     `state === "published"` short-circuited, so an `expired` signal (engine
 *     expires on age while >=1h-strategy anchors are still fresh) was
 *     resurrected to `published` AND re-queued — a duplicate Telegram advisory
 *     for one opportunity and a non-deterministic lifecycle.
 *  3. LIFECYCLE ONE-WAYNESS: terminal states are preserved verbatim;
 *     `candidate`/`qualified` transition exactly once (via UPDATE — created_ms
 *     and row identity preserved; the old `INSERT OR REPLACE` destroyed the
 *     row's history).
 *  4. ATOMICITY: the signal row and its outbox row are written in ONE
 *     transaction — a crash can no longer produce a "published" signal with no
 *     delivery record (or a delivery with no signal).
 */
export function publishSignal(opp: OpportunityPayload): PublishSignalResult {
  const repo = getRepo();
  try {
    // BEGIN IMMEDIATE precedes lifecycle reads as well as writes: concurrent
    // activation of an existing candidate cannot enqueue a second delivery.
    const result = repo.withTransaction(() => publishInTransaction(opp, repo));
    if (result.published && !result.reason.startsWith("already published")) {
      eventBus.emit("signal.created", { id: result.id, symbol: opp.symbol, state: "published" });
      eventBus.emit("system", { message: `signal ${result.id}: ${result.reason}`, level: "info" });
    } else if (!result.published) {
      eventBus.emit("signal.publish.refused", { id: result.id, symbol: opp.symbol, opportunity_id: opp.id, reason: result.reason });
    }
    return result;
  } catch (err) {
    return { id: `sig-${opp.id}`, published: false, reason: `publication unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function publishInTransaction(opp: OpportunityPayload, repo: ReturnType<typeof getRepo>): PublishSignalResult {
  const id = `sig-${opp.id}`;

  // ---- 1. final hard risk boundary (defense in depth at the publish step).
  // FIX (T05 T2, STRICT): ONLY an explicit, well-formed PASS from the
  // authoritative risk engine may publish. Missing / unavailable / unknown /
  // malformed risk is NEVER approval — there is no substitute metric and no
  // default. The contract vocabulary stays the risk engine's own: a result is
  // publishable exactly when `verdict === "pass"` on a well-formed result
  // ({verdict: string, reasons: []}); it must ALSO match a fresh authoritative
  // evaluation below. Shape alone is not authentication of a PASS. `block`
  // and every other value are refused before re-evaluation.
  if (opp.state !== "READY") {
    return { id, published: false, reason: `opportunity state ${opp.state} is not publishable — only READY opportunities become signals` };
  }
  const riskUnknown: unknown = opp.risk;
  if (riskUnknown == null) {
    return { id, published: false, reason: "risk result missing/unavailable — publication requires an explicit risk-gate PASS" };
  }
  const riskVerdict = (riskUnknown as { verdict?: unknown }).verdict;
  const riskReasons = (riskUnknown as { reasons?: unknown }).reasons;
  if (typeof riskVerdict !== "string" || !Array.isArray(riskReasons) || !riskReasons.every((r) => typeof r === "string")) {
    return { id, published: false, reason: "risk result malformed (expected {verdict: string, reasons: []}) — publication requires an explicit risk-gate PASS" };
  }
  if (riskVerdict !== "pass") {
    return { id, published: false, reason: `risk gate verdict "${riskVerdict}" — only an explicit PASS may be published` };
  }

  const now = Date.now();
  const fresh = opportunityFreshness(opp.anchor_close_ms, now, opp.timeframe);
  if (opp.mode !== "live" || fresh.state !== "READY" || (fresh.age_ms ?? Infinity) > tfStalenessMs(opp.timeframe) || opp.data_quality?.stale !== false) {
    return { id, published: false, reason: "publication requires a live, fresh opportunity with valid source time and timeframe" };
  }
  if (!opp.entry_zone || !Number.isFinite(opp.entry_zone.top) || !Number.isFinite(opp.entry_zone.bottom)
      || opp.entry_zone.bottom > opp.entry_zone.top || typeof opp.stop !== "number"
      || !Array.isArray(opp.targets) || opp.targets.length === 0 || !opp.targets.every((t) => Number.isFinite(t) && t > 0)) {
    return { id, published: false, reason: "risk inputs missing/malformed — entry, stop and targets required" };
  }
  const checked = evaluateLiveRisk(opp.symbol, opp.direction, (opp.entry_zone.top + opp.entry_zone.bottom) / 2, opp.stop, opp.targets[0]);
  if (checked.verdict !== "pass" || !isDeepStrictEqual(checked.numbers, opp.risk?.numbers)
      || !isDeepStrictEqual(checked.reasons, riskReasons) || !isDeepStrictEqual(checked.unenforced, opp.risk?.unenforced)) {
    return { id, published: false, reason: "risk PASS is forged, inconsistent or stale against current authoritative evaluation" };
  }
  if (opp.psychology?.hard_blocks?.length || opp.psychology?.state === "BLOCKED"
      || opp.portfolio?.verdict === "block" || opp.blocked_factors?.length || opp.contradictions?.length) {
    return { id, published: false, reason: "contradictory admission evidence — READY cannot override a hard block" };
  }

  if (!opp.setup_id || !Number.isFinite(opp.anchor_ts_ms)
      || opp.anchor_close_ms !== opp.anchor_ts_ms + tfStalenessMs(opp.timeframe) / 2
      || opp.id !== idFor(opp.symbol, opp.timeframe, opp.direction, opp.setup_id, opp.anchor_ts_ms / 1000)) {
    return { id, published: false, reason: "noncanonical opportunity identity or cross-timeframe anchor — publication refused" };
  }
  const chart = opp.chart_evidence;
  if (!chart || !chartEvidenceMatches(chart, opp) || chart.strategy_id !== opp.strategy_id
      || chart.setup_id !== opp.setup_id || chart.bar_time !== opp.anchor_ts_ms / 1000
      || !Array.isArray(chart.annotations) || !Array.isArray(chart.rules)
      || !validChartSource(opp.chart_source, opp.anchor_ts_ms / 1000)) {
    return { id, published: false, reason: "decision chart evidence missing or mismatched — incomplete qualification" };
  }

  // READY is not an authorization token. Read the scanner-owned persisted
  // decision, then recheck mutable gates while holding the same IMMEDIATE
  // transaction that inserts the signal and outbox. Two different candidates
  // cannot both spend a portfolio slot based on the same old book.
  const stored = repo.opportunityGet(opp.id);
  if (!stored || stored.state !== "READY" || stored.mode !== "live"
      || stored.symbol !== opp.symbol || stored.timeframe !== opp.timeframe
      || stored.direction !== opp.direction || stored.strategy_id !== opp.strategy_id
      || !isDeepStrictEqual(JSON.parse(stored.payload_json), JSON.parse(JSON.stringify(opp)))) {
    return { id, published: false, reason: "stored opportunity missing, contradictory or changed since qualification" };
  }
  if (runtimeStatusFor(opp.strategy_id) !== "LIVE_ADVISORY_ONLY") {
    return { id, published: false, reason: "current promotion gate does not authorize live advisory publication" };
  }
  const policy = getProductionRiskPolicy();
  const gates = loadLiveGateContext(repo, now, { daily_loss_limit_pct: policy.daily_loss_limit_pct, excludeOppId: opp.id });
  const measurementBlocks = liveMeasurementBlocks(gates, policy);
  const psych = evaluatePsychologyGate(buildPsychologyPolicies(), gates.psychology);
  const portfolio = evaluatePortfolio({ equity: getRiskPrefs().equity, policy, open_risks: gates.open_risks,
    daily_realized_loss: gates.daily_realized_loss, period_realized_loss: gates.period_realized_loss,
    candidate: { symbol: opp.symbol, direction: opp.direction, risk_amount: checked.numbers.risk_notional } });
  if (measurementBlocks.length || psych.verdict === "block" || portfolio.verdict !== "pass") {
    return { id, published: false, reason: `current admission gate BLOCK: ${[...measurementBlocks, ...psych.blocks.map((b) => b.reason), ...portfolio.blocked_by].join("; ")}` };
  }
  if (opp.portfolio?.verdict !== "pass" || !["READY", "CAUTION"].includes(opp.psychology?.state ?? "")
      || !Number.isFinite(opp.score) || opp.score < getScoreThreshold() || opp.provenance?.data?.native_1d !== true) {
    return { id, published: false, reason: "admission evidence missing/unknown, score below threshold or derived market source" };
  }

  // ---- 2/3. lifecycle-aware idempotency on the stable natural key (closure §V)
  const existing = repo.signalByOpp(opp.id);
  const action = publishActionFor(existing?.state ?? null);
  if (action === "already_published") {
    return { id: existing!.id, published: true, reason: "already published (idempotent no-op)" };
  }
  if (action === "terminal") {
    return { id: existing!.id, published: false, reason: `existing signal is ${existing!.state} (terminal) — never resurrected or re-queued` };
  }

  const payloadJson = JSON.stringify({ ...opp, published_at_ms: now });
  // Advisory payload (closure §V): complete decision context, no execution language.
  const entryPx = opp.entry_zone ? (opp.entry_zone.top + opp.entry_zone.bottom) / 2 : null;
  const outboxPayload = {
    kind: "signal",
    signal_id: existing?.id ?? id,
    delivery_progress: { photo_required: true, photo_sent: false, text_sent: false },
    advisory_only: true,
    symbol: opp.symbol,
    timeframe: opp.timeframe,
    direction: opp.direction,
    strategy: opp.setup ?? opp.strategy_id,
    strategy_id: opp.strategy_id,
    setup_id: opp.setup_id,
    score: opp.score,
    score_semantics: opp.score_semantics,
    entry: entryPx,
    stop: opp.stop,
    targets: opp.targets,
    rr: opp.rr,
    risk: opp.risk,
    psychology: opp.psychology,
    reason: opp.thesis,
    invalidation: opp.invalidation,
    data_quality: opp.data_quality,
    source_refs: opp.source_refs,
    opportunity_id: opp.id,
    chart_json_url: `/api/charts/${existing?.id ?? id}.json`,
    chart_png_url: `/api/charts/${existing?.id ?? id}.png`,
    generated_at_ms: now,
    timestamp: now,
  };

  // ---- 4. signal row + outbox row are ONE publication act (all-or-nothing).
  // T05 T4: the outbox row id is recorded ON the signal row (`outbox_id`) in
  // the same transaction — the stable signal -> outbox provenance link. The
  // outbox row stays the single source of truth for delivery state.
  let outboxId: number;
  try {
    outboxId = repo.withTransaction(() => {
      const enqueued = repo.outboxEnqueue("signal", outboxPayload);
      if (action === "create") {
        repo.signalInsert({
          id,
          state: "published",
          symbol: opp.symbol,
          timeframe: opp.timeframe,
          direction: opp.direction,
          score: opp.score,
          strategy_id: opp.strategy_id,
          opp_id: opp.id,
          payload_json: payloadJson,
          created_ms: now,
          updated_ms: now,
          outbox_id: enqueued,
        });
      } else {
        // activate: candidate/qualified -> published, exactly once. UPDATE
        // (not REPLACE) preserves id, opp_id and created_ms.
        repo.signalUpdate({
          id: existing!.id,
          state: "published",
          symbol: opp.symbol,
          timeframe: opp.timeframe,
          direction: opp.direction,
          score: opp.score,
          strategy_id: opp.strategy_id,
          opp_id: opp.id,
          payload_json: payloadJson,
          outbox_id: enqueued,
        });
      }
      return enqueued;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A concurrent publisher may have won the UNIQUE(opp_id)/PK race — the
    // row that exists is authoritative; never queue a second delivery for it.
    const again = repo.signalByOpp(opp.id);
    if (again && publishActionFor(again.state) === "already_published") {
      return { id: again.id, published: true, reason: "already published (existing row found after publish conflict)" };
    }
    return { id, published: false, reason: `publish aborted atomically: ${msg}` };
  }

  return {
    id: existing?.id ?? id,
    published: true,
    reason: action === "create" ? `published; outbox row ${outboxId} queued` : `activated from ${existing!.state}; outbox row ${outboxId} queued`,
  };
}

/**
 * Mark stale published signals EXPIRED (freshness correctness).
 *
 * AUDIT FIX (P1): pagination happens over `updated_ms DESC` and expiring a row
 * MUTATES `updated_ms`, which used to reshuffle rows mid-walk and could skip a
 * band of rows for a cycle. The walk is now two-phase: collect every stale id
 * first (no mutation during pagination), then expire them.
 */
export function expireStaleSignals(maxAgeMs?: number, repo: ReturnType<typeof getRepo> = getRepo()): number {
  const now = Date.now();
  // Phase 1: collect. No writes happen while the pages are being read, so the
  // ordering cannot shift underneath the cursor.
  const staleIds: string[] = [];
  const PAGE = 500;
  let offset = 0;
  for (;;) {
    const page = repo.signalPage(PAGE, offset);
    if (page.length === 0) break;
    for (const s of page) {
      if (signalHasExpired(s, now, maxAgeMs)) staleIds.push(s.id);
    }
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  // Phase 2: expire.
  let expired = 0;
  for (const id of staleIds) {
    const row = repo.signalGet(id);
    if (row && signalHasExpired(row, now, maxAgeMs) && refreshSignalExpiry(repo, row, now, maxAgeMs).state === "expired") expired++;
  }
  return expired;
}

export function listStrategiesSummary() {
  return listRuntimeStrategies().map((s) => ({
    id: s.setup_id,
    strategy_id: s.strategy_id,
    name: s.name,
    family: s.family,
    status: s.availability,
    version: s.version,
    // AUDIT FIX (P1-9): executability is NOT live eligibility. `executable`
    // means the rules are deterministic; `live_eligible` additionally requires
    // the Brain runtime gate (empirical OOS/walk-forward evidence), which no
    // compiled strategy currently holds.
    executable: s.availability === "EXECUTABLE",
    live_eligible: s.availability === "EXECUTABLE" && runtimeStatusFor(s.strategy_id) === "LIVE_ADVISORY_ONLY",
    live_eligibility_note:
      "live_eligible requires LIVE_ADVISORY_ONLY from the deterministic promotion gate (`backtest/promotion`: evidence provenance + current versions + computed metrics + OOS + governance); executable alone is never live",
    timeframe: s.timeframe,
    direction: s.direction,
    blocked_reason: s.blocked_reason,
    rule_ids: s.rule_ids,
  }));
}

export function getStrategyOrThrow(id: string): StrategyRuntimeDefinition {
  const s = getRuntimeStrategy(id);
  if (!s) throw new Error(`unknown strategy ${id}`);
  return s;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
