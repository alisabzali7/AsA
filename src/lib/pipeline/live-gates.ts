/**
 * Live-scan gate inputs (journal + persisted advisory book).
 *
 * The orchestrator used to feed the psychology and portfolio engines
 * `defaultPsychologyState()` and `open_risks: []` / `daily_realized_loss: 0`.
 * That coerced UNAVAILABLE measurements into permissive zeros — a daily-loss
 * budget looked unused, consecutive journaled losses never reached PSY-REVENGE,
 * and concurrent published advisories never counted toward heat/concurrency.
 *
 * This module is the single reader of those sources. It never invents a
 * currency PnL from an R-multiple, and it never treats a missing open book
 * as an empty book.
 */
import type { JournalRow, Repo, SignalRow } from "../../db/repo";
import type { OpenRisk } from "../risk/portfolio";
import { defaultPsychologyState, type PsychologyState } from "../psychology/gate";
import { isTimeframe } from "../domain/timeframes";
import { opportunityFreshness } from "./freshness";

export type DeclaredPsychState = PsychologyState["declared_state"];

export const OPEN_BOOK_MAX_SIGNAL_ROWS = 500;
/** One extra row is a sentinel: receiving it means the active book is incomplete. */
export const OPEN_BOOK_SIGNAL_QUERY_LIMIT = OPEN_BOOK_MAX_SIGNAL_ROWS + 1;

export interface LiveGateContext {
  psychology: PsychologyState;
  /** null means the bounded active-signal inventory is incomplete or cannot be represented; never a partial/fabricated book */
  open_risks: OpenRisk[] | null;
  /**
   * Account-currency realized loss today. `null` = UNAVAILABLE (the journal
   * stores a self-reported R-multiple, not venue PnL) — callers MUST NOT
   * substitute 0.
   */
  daily_realized_loss: number | null;
  period_realized_loss: number | null;
  daily_loss_reason: string;
  open_book_reason: string;
}

function utcDayStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function parseDeclaredState(raw: string | null): DeclaredPsychState {
  if (raw === "ok" || raw === "tilted" || raw === "stressed" || raw === "unfit") return raw;
  return null;
}

function boolPref(raw: string | null): boolean | null {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

/**
 * Psychology state from the human journal + optional operator prefs.
 * Consecutive losses / last-loss age are MEASURED from signed R-multiples.
 * A missing R-multiple breaks the streak rather than being treated as a win.
 */
export function psychologyStateFromJournal(
  journal: JournalRow[],
  nowMs: number,
  extras: {
    daily_loss_limit_pct: number | null;
    declared_state?: DeclaredPsychState;
    checklist_completed?: boolean | null;
    security_checklist_completed?: boolean | null;
    standards_declared?: boolean | null;
    /** explicit operator attestation; absent means journal coverage is unknown */
    journal_complete?: boolean;
  },
): PsychologyState {
  const state = defaultPsychologyState();
  state.daily_loss_limit_pct = extras.daily_loss_limit_pct;
  if (extras.declared_state !== undefined) state.declared_state = extras.declared_state;
  if (extras.checklist_completed !== undefined) state.checklist_completed = extras.checklist_completed;
  if (extras.security_checklist_completed !== undefined) {
    state.security_checklist_completed = extras.security_checklist_completed;
  }
  if (extras.standards_declared !== undefined) state.standards_declared = extras.standards_declared;

  state.journal_coverage = extras.journal_complete === true
    ? "COMPLETE"
    : extras.journal_complete === false ? "PARTIAL" : "UNKNOWN";
  // A journal table is not presumed to be a complete record of actual trades.
  // Without explicit operator attestation, these computed fields remain UNKNOWN.
  if (extras.journal_complete !== true) return state;

  const sorted = [...journal].sort((a, b) => b.created_ms - a.created_ms);
  const todayStart = utcDayStartMs(nowMs);
  state.trades_today = sorted.filter((j) => j.created_ms >= todayStart).length;

  let consec = 0;
  for (const j of sorted) {
    if (j.r_multiple === null) {
      state.consecutive_losses = null;
      return state;
    }
    if (j.r_multiple < 0) consec += 1;
    else break;
  }
  state.consecutive_losses = consec;

  const lastLoss = sorted.find((j) => j.r_multiple !== null && j.r_multiple < 0);
  state.minutes_since_last_loss = lastLoss ? (nowMs - lastLoss.created_ms) / 60_000 : null;
  return state;
}

function riskNotionalFromSignal(s: SignalRow): number | null {
  try {
    const p = JSON.parse(s.payload_json) as { risk?: { numbers?: { risk_notional?: unknown } } };
    const n = p.risk?.numbers?.risk_notional;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

type SignalFreshness = "FRESH" | "EXPIRED" | "UNKNOWN";

function signalFreshness(s: SignalRow, nowMs: number): SignalFreshness {
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(s.payload_json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "UNKNOWN";
    payload = parsed as Record<string, unknown>;
  } catch {
    return "UNKNOWN";
  }

  const anchor = payload.anchor_close_ms;
  if (typeof anchor !== "number" || !Number.isFinite(anchor) || anchor > nowMs) return "UNKNOWN";
  if (!isTimeframe(s.timeframe)) return "UNKNOWN";
  if (Object.prototype.hasOwnProperty.call(payload, "timeframe") && payload.timeframe !== s.timeframe) return "UNKNOWN";
  return opportunityFreshness(anchor, nowMs, s.timeframe).state === "READY" ? "FRESH" : "EXPIRED";
}

/**
 * Open advisory book = active published/qualified rows whose freshness can be
 * established. Proven-expired rows are ignored. An active row with an absent,
 * invalid, future, or conflicting source anchor is retained with UNKNOWN risk
 * so neither portfolio heat nor concurrency can silently omit it.
 */
export function advisoryOpenRisks(signals: SignalRow[], nowMs: number, excludeOppId?: string | null): OpenRisk[] | null {
  const out: OpenRisk[] = [];
  for (const s of signals) {
    if (s.state !== "published" && s.state !== "qualified") continue;
    if (excludeOppId && s.opp_id === excludeOppId) continue;
    if (typeof s.symbol !== "string" || s.symbol.length === 0 || (s.direction !== "long" && s.direction !== "short")) {
      // The row is active but cannot be represented as a measured OpenRisk.
      // Discarding it would understate both exposure and position count.
      return null;
    }
    const freshness = signalFreshness(s, nowMs);
    if (freshness === "EXPIRED") continue;
    const notional = freshness === "FRESH" ? riskNotionalFromSignal(s) : null;
    out.push({
      symbol: s.symbol,
      direction: s.direction,
      // Preserve UNKNOWN notional (including unknown freshness). The row still
      // occupies a concurrency slot; portfolio heat cannot treat it as zero.
      risk_amount: notional,
    });
  }
  return out;
}

/** Assemble the live gate context from the runtime repo. Never substitutes 0 for unknown PnL. */
export function loadLiveGateContext(
  repo: Repo,
  nowMs: number,
  opts: { daily_loss_limit_pct: number | null; excludeOppId?: string | null },
): LiveGateContext {
  const journal = repo.journalList();
  let declared: DeclaredPsychState = null;
  try {
    declared = parseDeclaredState(repo.configGet("pref.psychology.declared_state"));
  } catch {
    declared = null;
  }
  const checklist = boolPref(safeConfig(repo, "pref.psychology.checklist_completed"));
  const security = boolPref(safeConfig(repo, "pref.psychology.security_checklist_completed"));
  const standards = boolPref(safeConfig(repo, "pref.psychology.standards_declared"));
  const journalComplete = boolPref(safeConfig(repo, "pref.psychology.journal_complete"));

  const psychology = psychologyStateFromJournal(journal, nowMs, {
    daily_loss_limit_pct: opts.daily_loss_limit_pct,
    declared_state: declared,
    checklist_completed: checklist,
    security_checklist_completed: security,
    standards_declared: standards,
    journal_complete: journalComplete ?? undefined,
  });

  // The active-state filter runs in SQL before this bounded query. Fetch one
  // sentinel row beyond the supported inventory; if present, do not use the
  // partial rows or claim that the advisory book is measured.
  const signals = repo.signalOpenList(OPEN_BOOK_SIGNAL_QUERY_LIMIT, opts.excludeOppId);
  const coverageComplete = signals.length <= OPEN_BOOK_MAX_SIGNAL_ROWS;
  const open_risks = coverageComplete
    ? advisoryOpenRisks(signals, nowMs, opts.excludeOppId)
    : null;
  const openBookReason = !coverageComplete
    ? `open advisory book coverage is incomplete: active-signal query returned the ${OPEN_BOOK_SIGNAL_QUERY_LIMIT}-row truncation sentinel (more than ${OPEN_BOOK_MAX_SIGNAL_ROWS} rows); partial results were discarded and exposure/concurrency are UNKNOWN`
    : open_risks === null
      ? "active advisory signal identity is malformed (missing symbol or recognized direction); exposure and concurrency are UNKNOWN"
      : `complete active-signal query returned ${signals.length} row(s); ${open_risks.length} fresh or freshness-UNKNOWN active row(s) retained, including ${open_risks.filter((row) => row.risk_amount !== null).length} measured and ${open_risks.filter((row) => row.risk_amount === null).length} UNKNOWN risk amount(s)`;

  return {
    psychology,
    open_risks,
    daily_realized_loss: null,
    period_realized_loss: null,
    daily_loss_reason:
      "journal records a self-reported R-multiple, not account-currency PnL — daily/period realized loss is UNAVAILABLE (not assumed 0)",
    open_book_reason: openBookReason,
  };
}

function safeConfig(repo: Repo, key: string): string | null {
  try {
    return repo.configGet(key);
  } catch {
    return null;
  }
}

/** Live-only fail-closed requirements. Null policy means no specified limit;
 * null measurement for a specified limit is NOT permission to skip that limit.
 * Research evaluation may still expose its explicit `unenforced` accounting.
 */
export function liveMeasurementBlocks(ctx: LiveGateContext, policy: import("../brain/types").RiskPolicy): string[] {
  const blocks: string[] = [];
  if (ctx.open_risks === null) blocks.push("advisory open book UNAVAILABLE");
  if (policy.daily_loss_limit_pct !== null && (ctx.daily_realized_loss === null || !Number.isFinite(ctx.daily_realized_loss) || ctx.daily_realized_loss < 0))
    blocks.push("daily realized loss UNAVAILABLE for configured hard limit");
  if (policy.period_loss_limit_pct !== null && (ctx.period_realized_loss === null || !Number.isFinite(ctx.period_realized_loss) || ctx.period_realized_loss < 0))
    blocks.push("period realized loss UNAVAILABLE for configured hard limit");
  return blocks;
}
