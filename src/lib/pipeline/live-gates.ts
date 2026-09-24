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
import { opportunityFreshness } from "./freshness";

export type DeclaredPsychState = PsychologyState["declared_state"];

export interface LiveGateContext {
  psychology: PsychologyState;
  /** measured live advisory book; never a fabricated empty list */
  open_risks: OpenRisk[];
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

function boolPref(raw: string | null): boolean {
  return raw === "1" || raw === "true";
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
    checklist_completed?: boolean;
    security_checklist_completed?: boolean;
    standards_declared?: boolean;
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

  const sorted = [...journal].sort((a, b) => b.created_ms - a.created_ms);
  const todayStart = utcDayStartMs(nowMs);
  state.trades_today = sorted.filter((j) => j.created_ms >= todayStart).length;

  let consec = 0;
  for (const j of sorted) {
    if (j.r_multiple === null) break;
    if (j.r_multiple < 0) consec += 1;
    else break;
  }
  state.consecutive_losses = consec;

  const lastLoss = sorted.find((j) => j.r_multiple !== null && (j.r_multiple as number) < 0);
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

function signalStillFresh(s: SignalRow, nowMs: number): boolean {
  let anchor: number | null = null;
  let tf = s.timeframe;
  try {
    const p = JSON.parse(s.payload_json) as { anchor_close_ms?: unknown; timeframe?: unknown };
    if (typeof p.anchor_close_ms === "number" && Number.isFinite(p.anchor_close_ms)) anchor = p.anchor_close_ms;
    if (typeof p.timeframe === "string" && p.timeframe.length > 0) tf = p.timeframe;
  } catch {
    /* payload unreadable — fall through */
  }
  if (anchor === null) return false; // cannot claim a signal is still open without a source anchor
  return opportunityFreshness(anchor, nowMs, tf).state === "READY";
}

/**
 * Open advisory book = currently published (or qualified) signals that are
 * still inside the opportunity freshness window. This is MEASURED from the
 * signal table — it is the book's own exposure, not a claim the human filled
 * the order. Terminal / expired / unanchored rows are excluded.
 */
export function advisoryOpenRisks(signals: SignalRow[], nowMs: number, excludeOppId?: string | null): OpenRisk[] {
  const out: OpenRisk[] = [];
  for (const s of signals) {
    if (s.state !== "published" && s.state !== "qualified") continue;
    if (excludeOppId && s.opp_id === excludeOppId) continue;
    if (s.direction !== "long" && s.direction !== "short") continue;
    if (!signalStillFresh(s, nowMs)) continue;
    const notional = riskNotionalFromSignal(s);
    out.push({
      symbol: s.symbol,
      direction: s.direction,
      // unknown notional is 0 size in the book but still occupies a slot
      // (concurrency / duplicate-symbol); heat uses max(0, amount).
      risk_amount: notional ?? 0,
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

  const psychology = psychologyStateFromJournal(journal, nowMs, {
    daily_loss_limit_pct: opts.daily_loss_limit_pct,
    declared_state: declared,
    checklist_completed: checklist,
    security_checklist_completed: security,
    standards_declared: standards,
  });

  const signals = repo.signalList(500);
  const open_risks = advisoryOpenRisks(signals, nowMs, opts.excludeOppId);

  return {
    psychology,
    open_risks,
    daily_realized_loss: null,
    period_realized_loss: null,
    daily_loss_reason:
      "journal records a self-reported R-multiple, not account-currency PnL — daily/period realized loss is UNAVAILABLE (not assumed 0)",
    open_book_reason: `advisory open book measured from ${open_risks.length} fresh published/qualified signal(s)`,
  };
}

function safeConfig(repo: Repo, key: string): string | null {
  try {
    return repo.configGet(key);
  } catch {
    return null;
  }
}
