/**
 * Pipeline orchestrator (docs/architecture): opportunity lifecycle + signal
 * lifecycle + durability. Deterministic. Signals NEVER become orders.
 * Opportunities are stored with idempotent keys; refresh rules keep stale
 * anchors from being shown as live.
 */
import { createHash } from "node:crypto";
import { sharedStore } from "../market/store";
import { candleManager } from "../market/candles";
import { buildBundle } from "../analysis/bundle";
import { buildMtf } from "../analysis/mtf";
import { buildPsychology } from "../psychology/engine";
import { getRepo } from "../../db/sqlite";
import { promotedRuntimeStatus } from "../backtest/promotion";
import { getRuntimeStrategy, listRuntimeStrategies, evaluateRuntime, type StrategyRuntimeDefinition } from "../strategy/runtime";
import { evaluateRisk } from "../risk/engine";
import { evaluatePortfolio } from "../risk/portfolio";
import { evaluatePsychologyGate, defaultPsychologyState } from "../psychology/gate";
import { computeScore, admitOpportunity, SCORE_DISCLAIMER, type ScoreResult } from "../brain/score";
import { buildPsychologyPolicies } from "../brain/policies";
import { getProductionRiskPolicy } from "../risk/policy";
import { scoreFromEvaluation } from "./scoring";
import { buildChartEvidence, type ChartEvidence } from "../chart/evidence";
import { eventBus } from "../events";
import { getRiskPrefs } from "../prefs";
import { ASA_SCORE_THRESHOLD } from "../env";
import type { TimeframeId } from "../domain/timeframes";

export const OPPORTUNITY_STATES = ["SCANNING", "ANALYZING", "CANDIDATE", "RISK_CHECK", "READY", "REJECTED", "COOLDOWN", "EXPIRED"] as const;
export const SIGNAL_STATES = ["candidate", "qualified", "blocked_by_risk", "published", "expired", "invalidated", "closed", "archived"] as const;

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
  data_quality: { bars: number; stale: boolean; age_ms: number | null; state: string };
  psychology: { state: string; hard_blocks: string[]; soft_warnings: string[]; score_modifier: number } | null;
  portfolio: { verdict: string; reasons: string[]; unenforced: string[] } | null;
  setup_id: string | null;
  score_semantics: string;
  /** annotation lineage consumed by the chart route AND the Telegram image */
  chart_evidence: ChartEvidence | null;
  risk: { verdict: string; reasons: string[]; numbers?: Record<string, unknown> } | null;
  ai: { provider: string; label: string } | null;
  provenance: {
    generated_at_ms: number;
    data: {
      series_fetched_ms: number;
      stats_fetched_ms: number | null;
      native_1d: boolean;
      /** null = that series was NOT part of this decision (never a fake 0) */
      candles: { macro: number | null; context: number | null; trigger: number | null };
    };
  };
}

/** Freshness rule: anchor (15m trigger close) older than 4 bars -> EXPIRED. */
export function opportunityFreshness(anchor_close_ms: number | null, nowMs: number): { state: "READY" | "EXPIRED"; age_ms: number | null } {
  if (anchor_close_ms === null) return { state: "EXPIRED", age_ms: null };
  const age = nowMs - anchor_close_ms;
  return age <= 4 * 15 * 60_000 ? { state: "READY", age_ms: age } : { state: "EXPIRED", age_ms: age };
}

export function idFor(symbol: string, tf: string, direction: string, strategyId: string, anchorSec: number): string {
  return createHash("sha1").update(`${symbol}|${tf}|${direction}|${strategyId}|${anchorSec}`).digest("hex").slice(0, 16);
}

export interface ScanOutcome {
  opportunity: OpportunityPayload | null;
  evaluated: boolean;
  reason?: string;
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
): Promise<ScanOutcome> {
  if (strategy.availability !== "EXECUTABLE" || !strategy.impl) {
    return { opportunity: null, evaluated: false, reason: `strategy ${strategy.setup_id} is ${strategy.availability}: ${strategy.blocked_reason ?? "not executable"}` };
  }
  // Each strategy declares its OWN timeframe — never hard-coded to 15m.
  const tf = strategy.timeframe as TimeframeId;

  const seriesTrg = await candleManager.ensureSeries(symbol, tf, true);
  if (!seriesTrg || seriesTrg.candles.length < strategy.min_bars) {
    return { opportunity: null, evaluated: false, reason: `insufficient ${tf} history: need ${strategy.min_bars}, have ${seriesTrg?.candles.length ?? 0}` };
  }

  const nowMs = Date.now();
  const candles = seriesTrg.candles;
  const anchorSec = candles[candles.length - 1].t;
  const ageMs = nowMs - anchorSec * 1000;
  const staleAfter = tfStalenessMs(tf);
  const stale = ageMs > staleAfter;

  // ---- deterministic strategy evaluation (same call the backtester makes)
  const evOrBlocked = evaluateRuntime(strategy, symbol, candles, nowMs);
  if ("blocked" in evOrBlocked) {
    return { opportunity: null, evaluated: false, reason: evOrBlocked.reason };
  }
  const ev = evOrBlocked;

  // ---- risk (direction-safe, target-aware)
  const meta = sharedStore.catalog.get(symbol);
  const policy = getProductionRiskPolicy();
  const rp = getRiskPrefs();
  let risk = null as ReturnType<typeof evaluateRisk> | null;
  if (ev.levels.entry !== null && ev.levels.stop !== null) {
    risk = evaluateRisk({
      symbol,
      direction: ev.direction,
      entry: ev.levels.entry,
      stop: ev.levels.stop,
      target: ev.levels.targets[0] ?? null,
      equity: rp.equity,
      riskPerTradePct: policy.risk_per_trade_pct ?? rp.perTradePct,
      maxLeverage: policy.max_leverage ?? rp.maxLeverage,
      venueMaxLeverage: meta?.maxLeverage ?? null,
      maintenanceMarginRate: meta?.maintenanceMarginRate ?? null,
      takerFeeCoefficient: meta?.takerFeeCoefficient ?? null,
      tickSize: meta?.tickSize ?? null,
      qtyStep: meta?.stepSize ?? null,
      // TTT does not expose minQty/minNotional on the verified public catalog;
      // null makes the engine report them UNAVAILABLE rather than invent them.
      minQty: null,
      minNotional: null,
    });
  }
  const riskPass = risk?.verdict === "pass";

  // ---- psychology (real gate, hard blocks cannot be overridden)
  const psych = evaluatePsychologyGate(buildPsychologyPolicies(), {
    ...defaultPsychologyState(),
    daily_loss_limit_pct: policy.daily_loss_limit_pct,
  });

  // ---- portfolio
  const portfolio = evaluatePortfolio({
    equity: rp.equity,
    policy,
    open_risks: [],
    daily_realized_loss: 0,
    period_realized_loss: 0,
    candidate: { symbol, risk_amount: risk?.numbers.risk_notional ?? 0, direction: ev.direction },
  });

  // ---- contradictions come from the rule layer, never hard-coded
  const contradictions = ev.setup.blocked_rules.map((id) => `rule ${id} is BLOCKED (non-computable or invalidation fired)`);

  // ---- explainable score (no constants)
  const score = scoreFromEvaluation(ev, {
    riskPass,
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
    data_quality_ok: !stale && candles.length >= strategy.min_bars,
    stale,
    risk_verdict: riskPass ? "pass" : "block",
    portfolio_verdict: portfolio.verdict,
    psychology_verdict: psych.verdict,
    strategy_runtime_status: mode === "live" ? runtimeStatusFor(strategy.strategy_id) : "CANDIDATE",
    unresolved_contradiction: contradictions.length > 0,
    unknown_required_fields: unknownFields,
    // Live output additionally requires the FULL promotion gate: a strategy
    // that is merely executable, or in-sample BACKTESTED, must never publish a
    // live advisory signal.
    requires_live_eligibility: mode === "live",
  });

  if (ev.setup.outcome !== "PASS") {
    return { opportunity: null, evaluated: true, reason: `setup ${ev.setup.outcome}: ${ev.setup.explanation}` };
  }

  const id = idFor(symbol, tf, ev.direction, strategy.setup_id, anchorSec);
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
    anchor_close_ms: anchorSec * 1000,
    freshness_ms: ageMs,
    evidence: score.positive_factors,
    contradictions,
    score_breakdown: score,
    positive_factors: score.positive_factors,
    negative_factors: score.negative_factors,
    blocked_factors: admission.reasons,
    unknown_factors: score.unknown_factors,
    source_refs: score.source_refs,
    data_quality: { bars: candles.length, stale, age_ms: ageMs, state: stale ? "STALE" : "FRESH" },
    psychology: {
      state: psych.verdict === "block" ? "BLOCKED" : psych.verdict === "flag" ? "CAUTION" : "READY",
      hard_blocks: psych.blocks.map((b) => b.reason),
      soft_warnings: psych.flags.map((f) => f.reason),
      score_modifier: -psych.score_penalty,
    },
    portfolio: { verdict: portfolio.verdict, reasons: portfolio.reasons, unenforced: portfolio.unenforced },
    score_semantics: SCORE_DISCLAIMER,
    chart_evidence: buildChartEvidence(ev, score.score),
    risk: risk ? { verdict: risk.verdict, reasons: risk.reasons, numbers: risk.numbers as unknown as Record<string, unknown> } : null,
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

  if (mode === "live" && payload.state === "READY") publishSignal(payload);
  return { opportunity: payload, evaluated: true };
}

/** Staleness budget = 2 closed bars of the strategy's own timeframe. */
export function tfStalenessMs(tf: string): number {
  const map: Record<string, number> = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "45m": 2_700_000,
    "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000, "1d": 86_400_000,
  };
  return (map[tf] ?? 900_000) * 2;
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

/** Publish advisory signal (live mode only). Signal ≠ order. */
export function publishSignal(opp: OpportunityPayload): { id: string } {
  const repo = getRepo();
  const id = `sig-${opp.id}`;
  const now = Date.now();
  // Idempotency (closure §V): the DB enforces UNIQUE(opp_id). We look the
  // signal up by that natural key instead of scanning the newest N rows.
  const existing = repo.signalByOpp(opp.id);
  if (existing && existing.state === "published") return { id: existing.id };
  repo.signalInsert({
    id,
    state: "published",
    symbol: opp.symbol,
    timeframe: opp.timeframe,
    direction: opp.direction,
    score: opp.score,
    strategy_id: opp.strategy_id,
    opp_id: opp.id,
    payload_json: JSON.stringify({ ...opp, published_at_ms: now }),
    created_ms: existing?.created_ms ?? now,
    updated_ms: now,
  });
  // Advisory payload (closure §V): complete decision context, no execution language.
  const entryPx = opp.entry_zone ? (opp.entry_zone.top + opp.entry_zone.bottom) / 2 : null;
  const outboxId = repo.outboxEnqueue("signal", {
    kind: "signal",
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
    chart_json_url: `/api/charts/${opp.id}.json`,
    chart_png_url: `/api/charts/${opp.id}.png`,
    generated_at_ms: now,
    timestamp: now,
  });
  eventBus.emit("signal.created", { id, symbol: opp.symbol, state: "published" });
  eventBus.emit("system", { message: `signal ${id} published; outbox row ${outboxId} queued`, level: "info" });
  return { id };
}

/**
 * Mark stale published signals EXPIRED (freshness correctness).
 *
 * AUDIT FIX (P1): pagination happens over `updated_ms DESC` and expiring a row
 * MUTATES `updated_ms`, which used to reshuffle rows mid-walk and could skip a
 * band of rows for a cycle. The walk is now two-phase: collect every stale id
 * first (no mutation during pagination), then expire them.
 */
export function expireStaleSignals(maxAgeMs = 60 * 60_000, repo: ReturnType<typeof getRepo> = getRepo()): number {
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
      if ((s.state === "published" || s.state === "qualified") && now - s.updated_ms > maxAgeMs) {
        staleIds.push(s.id);
      }
    }
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  // Phase 2: expire.
  for (const id of staleIds) repo.signalUpdate({ id, state: "expired" });
  return staleIds.length;
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
