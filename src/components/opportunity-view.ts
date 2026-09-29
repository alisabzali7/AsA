/**
 * Opportunity view-model — PURE derivations over the stored opportunity
 * contract (`GET /api/opportunities`), no React, no fetch.
 *
 * WHY THIS MODULE EXISTS (truth discipline, mission §12 / §37):
 *   An opportunity row carries THREE independent verdicts that must never be
 *   collapsed into one another:
 *
 *     1. `state`      — the stored ADMISSION decision (READY | REJECTED |
 *                        EXPIRED | SCANNING | ANALYZING | CANDIDATE |
 *                        RISK_CHECK | COOLDOWN). Server-owned, immutable once
 *                        written; READY never overrides a block.
 *     2. `risk`       — the deterministic risk-engine verdict for the geometry
 *                        (`pass` | `block`). A `pass` here is NOT an approval
 *                        of the opportunity: the portfolio/daily-loss boundary
 *                        can still refuse it (see `portfolio`).
 *     3. `portfolio`  — the portfolio/account boundary (verdict + reasons +
 *                        `unenforced` dimensions that the selected policy does
 *                        not specify). `block` here refuses the opportunity
 *                        even when the risk engine passed.
 *
 *   The old UI mapped `risk.verdict === "pass"` straight onto a READY badge,
 *   which displayed a REJECTED opportunity (portfolio BLOCK — daily realized
 *   loss UNKNOWN) as READY. That is exactly the "blocked looks actionable"
 *   failure this module prevents: the displayed verdict is ALWAYS the stored
 *   admission state, downgraded (never upgraded) by the linked signal's
 *   terminal lifecycle and by freshness.
 *
 * Everything here only READS the payload. Nothing computes market values.
 */

/** Stored opportunity lifecycle states (src/lib/pipeline/orchestrator.ts). */
export const OPPORTUNITY_STATES = [
  "SCANNING",
  "ANALYZING",
  "CANDIDATE",
  "RISK_CHECK",
  "READY",
  "REJECTED",
  "COOLDOWN",
  "EXPIRED",
] as const;
export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

/** Signal states that make an opportunity permanently non-actionable. */
export const TERMINAL_SIGNAL_STATES = ["expired", "invalidated", "closed", "archived"] as const;

export interface OpportunityGateReasons {
  verdict: string;
  reasons: string[];
  unenforced?: string[];
}

export interface OpportunityRecord {
  id: string;
  symbol: string;
  timeframe: string;
  direction: string;
  score: number | null;
  state: string;
  /** freshness verdict recomputed on read: READY | EXPIRED */
  fresh?: string | null;
  age_ms?: number | null;
  actionable?: boolean;
  signal_state?: string | null;
  risk?: { verdict: string; reasons?: string[]; unenforced?: string[] } | null;
  portfolio?: OpportunityGateReasons | null;
  psychology?: { state?: string; hard_blocks?: string[]; soft_warnings?: string[]; not_evaluated?: string[] } | null;
  /** the server's own sentence describing what the score means */
  score_semantics?: string | null;
  blocked_factors?: string[];
  unknown_factors?: string[];
  negative_factors?: string[];
  positive_factors?: string[];
  data_quality?: { state?: string; stale?: boolean; age_ms?: number | null; bars?: number | null } | null;
}

/** True when the row is a stored opportunity the pipeline could not admit. */
export function isRejected(o: OpportunityRecord): boolean {
  return o.state === "REJECTED";
}

/** True when the row's freshness window has closed (server verdict, verbatim). */
export function isExpiredFreshness(o: OpportunityRecord): boolean {
  return o.fresh === "EXPIRED";
}

/**
 * The word the UI is allowed to show for this opportunity.
 *
 * Order of authority (most conservative wins — never an upgrade):
 *   1. the stored admission `state`;
 *   2. a linked signal in a terminal lifecycle (the decision was consumed and
 *      is no longer actionable — the signal's own state is the truth);
 *   3. nothing else. `risk.verdict` can NEVER promote REJECTED to READY.
 */
export function opportunityDisplayState(o: OpportunityRecord): string {
  const signal = o.signal_state;
  if (typeof signal === "string" && signal && !["candidate", "qualified", "published"].includes(signal)) {
    // terminal lifecycle wins over the stored admission state; the signal's own
    // vocabulary is shown verbatim (upper-cased for the status chip only)
    return signal.toUpperCase();
  }
  return o.state || "UNAVAILABLE";
}

/**
 * Engine verdict for the decision block: the STORED ADMISSION state.
 * A blocked/rejected/expired opportunity is never rendered READY, no matter
 * what the risk engine or the score says.
 */
export function opportunityEngineVerdict(o: OpportunityRecord): string {
  return opportunityDisplayState(o);
}

/** Semantic tone for the verdict, so colour is never the only signal. */
export function opportunityVerdictTone(o: OpportunityRecord): "pass" | "block" | "warn" | "neutral" {
  const state = opportunityDisplayState(o);
  if (state === "READY") return "pass";
  if (state === "REJECTED" || state === "EXPIRED" || state === "INVALIDATED" || state === "CLOSED" || state === "ARCHIVED") return "block";
  if (state === "COOLDOWN") return "warn";
  return "neutral";
}

/**
 * Why an opportunity is not actionable, in the server's own words.
 * Returns [] only when nothing blocks it (READY + fresh + live signal).
 */
export function opportunityBlockers(o: OpportunityRecord): string[] {
  const out: string[] = [];
  if (o.state === "REJECTED") {
    for (const f of o.blocked_factors ?? []) if (f) out.push(f);
    if (o.portfolio?.verdict === "block") {
      out.push(`portfolio boundary BLOCK: ${(o.portfolio.reasons ?? []).join("; ") || "the account boundary refused this decision"}`);
    }
    if (o.psychology?.state === "BLOCKED") {
      out.push(`psychology gate BLOCK: ${(o.psychology.hard_blocks ?? []).join("; ") || "a hard psychology guard refused this decision"}`);
    }
    if (out.length === 0) out.push("admission refused by the pipeline — no blocking factor was recorded");
  }
  if (o.state === "EXPIRED" || isExpiredFreshness(o)) {
    out.push(`freshness ${o.fresh ?? "EXPIRED"} — the decision window closed; publication revalidates current gates`);
  }
  if (o.signal_state && TERMINAL_SIGNAL_STATES.includes(o.signal_state as (typeof TERMINAL_SIGNAL_STATES)[number])) {
    out.push(`linked signal is ${o.signal_state} — the decision was consumed and is no longer actionable`);
  }
  if (o.actionable === false && o.state === "READY" && o.fresh !== "EXPIRED" && !o.signal_state) {
    out.push("the server marks this row not actionable (source freshness or lifecycle)");
  }
  return out;
}

/**
 * Gate ledger: each independent boundary with its own verdict, so a `pass`
 * from the risk engine is never read as approval of the whole opportunity.
 */
export interface OpportunityGateRow {
  key: "risk" | "portfolio" | "psychology" | "data";
  label: string;
  verdict: string;
  tone: "pass" | "block" | "warn" | "neutral" | "unknown";
  reasons: string[];
  unenforced: string[];
}

/**
 * Gate verdict as the UI shows it. The engine's own words (`pass` / `block`)
 * are mapped onto the ADMISSION vocabulary (PASS / BLOCKED) so a blocked gate
 * never reads as a softer word than it is. Anything unknown stays verbatim,
 * upper-cased — never downgraded to a pass.
 */
export function gateVerdictLabel(verdict: string): string {
  if (verdict === "pass") return "PASS";
  if (verdict === "block") return "BLOCKED";
  return String(verdict).toUpperCase();
}

export function opportunityGates(o: OpportunityRecord): OpportunityGateRow[] {
  const rows: OpportunityGateRow[] = [];
  const riskVerdict = o.risk?.verdict ?? "UNAVAILABLE";
  rows.push({
    key: "risk",
    label: "risk engine",
    verdict: gateVerdictLabel(riskVerdict),
    tone: riskVerdict === "pass" ? "pass" : riskVerdict === "block" ? "block" : "unknown",
    reasons: o.risk?.reasons ?? [],
    unenforced: o.risk?.unenforced ?? [],
  });
  if (o.portfolio) {
    const v = o.portfolio.verdict ?? "UNAVAILABLE";
    rows.push({
      key: "portfolio",
      label: "portfolio / account boundary",
      verdict: gateVerdictLabel(v),
      tone: v === "pass" ? "pass" : v === "block" ? "block" : "unknown",
      reasons: o.portfolio.reasons ?? [],
      unenforced: o.portfolio.unenforced ?? [],
    });
  }
  if (o.psychology) {
    const v = o.psychology.state ?? "UNAVAILABLE";
    rows.push({
      key: "psychology",
      label: "psychology gate",
      verdict: String(v).toUpperCase(),
      tone: v === "READY" ? "pass" : v === "BLOCKED" ? "block" : v === "CAUTION" ? "warn" : "unknown",
      reasons: [...(o.psychology.hard_blocks ?? []), ...(o.psychology.soft_warnings ?? [])],
      unenforced: o.psychology.not_evaluated ?? [],
    });
  }
  if (o.data_quality) {
    const stale = o.data_quality.stale === true;
    const v = o.data_quality.state ?? (stale ? "STALE" : "UNAVAILABLE");
    rows.push({
      key: "data",
      label: "data quality / freshness",
      verdict: String(v).toUpperCase(),
      tone: stale ? "warn" : v === "FRESH" ? "pass" : "unknown",
      reasons: o.data_quality.bars != null ? [`${o.data_quality.bars} closed bars`] : [],
      unenforced: [],
    });
  }
  return rows;
}

/** The score's own documented meaning — never a probability. */
export const SCORE_NOT_PROBABILITY = "decision score (deterministic evidence sum), not a probability";

export function opportunityScoreSemantics(o: OpportunityRecord): string {
  // the server's own sentence wins when it sends one; we never rewrite it
  const own = typeof o.score_semantics === "string" ? o.score_semantics.trim() : "";
  return own.length > 0 ? own : SCORE_NOT_PROBABILITY;
}

/** Score text: null/absent is never rendered as 0. */
export function opportunityScoreText(score: number | null | undefined): string {
  return typeof score === "number" && Number.isFinite(score) ? String(score) : "—";
}
