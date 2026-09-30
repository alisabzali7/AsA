/**
 * Signal → outbox → delivery provenance (T05 T4).
 *
 * Answers, from persisted rows only: which outbox item belongs to a signal,
 * and what its CURRENT delivery state is (queued / sending / failed / sent /
 * dead), with attempts, sub-step progress and the real timestamps. Nothing is
 * copied or cached — the outbox row is read live, so the view is truthful
 * across FAILED → retry → partial → SENT/DEAD.
 *
 * `delivery_state` vocabulary is derived strictly from outbox facts:
 *   - QUEUED  : row QUEUED, no live claim
 *   - SENDING : a consumer holds an UNEXPIRED claim (transport cycle in progress)
 *   - FAILED  : row FAILED (retryable) and no live claim
 *   - SENT    : full logical delivery accepted by the provider
 *   - DEAD    : terminal after the transport budget, a deterministic content
 *               failure (poison payload) or a link that can no longer be
 *               delivered — `error_kind` states WHICH, never one generic label
 *   - UNLINKED: signal has no outbox row (never published, or the legacy
 *               fallback found nothing) — reported as such, never as "sent"
 */
import type { OutboxErrorKind, OutboxRow, Repo, SignalRow } from "../../db/repo";

export type DeliveryState = "QUEUED" | "SENDING" | "FAILED" | "SENT" | "DEAD" | "UNLINKED";

export interface DeliveryProgressView {
  photo_required: boolean;
  photo_sent: boolean;
  text_sent: boolean;
  photo_message_id?: number | null;
  text_message_id?: number | null;
  photo_accepted_ms?: number;
  text_accepted_ms?: number;
}

export interface SignalDeliveryView {
  outbox_id: number | null;
  /** how the outbox row was resolved; null when unlinked */
  link: "outbox_id" | "legacy_payload_match" | null;
  delivery_state: DeliveryState;
  /** raw outbox state, when a row exists */
  outbox_state: OutboxRow["state"] | null;
  /** logical TRANSPORT attempts consumed (T05 T3 semantics) */
  attempts: number | null;
  error: string | null;
  /**
   * Stable classification of `error` (OutboxErrorKind); null when the row has
   * no recorded failure or predates the taxonomy. NEVER inferred from the
   * prose: an unclassified legacy DEAD row stays null rather than being
   * retro-labeled.
   */
  error_kind: OutboxErrorKind | null;
  progress: DeliveryProgressView | null;
  /** publication instant — when the signal row + outbox row were written */
  queued_ms: number | null;
  /** provider acceptance of the FULL logical delivery (outbox.sent_ms); null until SENT */
  sent_ms: number | null;
  /** current claim (only while a delivery cycle is in progress) */
  sending: { claimed_by: string; claim_ms: number | null; claim_expires_ms: number | null } | null;
}

export function deliveryStateOf(row: OutboxRow | null, nowMs = Date.now()): DeliveryState {
  if (!row) return "UNLINKED";
  if (row.state === "SENT") return "SENT";
  if (row.state === "DEAD") return "DEAD";
  const live = row.claimed_by != null && row.claim_expires_ms != null && nowMs < row.claim_expires_ms;
  if (live) return "SENDING";
  return row.state; // QUEUED | FAILED
}

function progressOf(row: OutboxRow): DeliveryProgressView | null {
  try {
    const p = (JSON.parse(row.payload_json) as { delivery_progress?: Partial<DeliveryProgressView> }).delivery_progress;
    if (!p) return null;
    return { ...(p.photo_sent && p.photo_message_id !== undefined ? { photo_message_id: p.photo_message_id, photo_accepted_ms: p.photo_accepted_ms } : {}),
      ...(p.text_sent && p.text_message_id !== undefined ? { text_message_id: p.text_message_id, text_accepted_ms: p.text_accepted_ms } : {}),
      photo_required: p.photo_required === true, photo_sent: p.photo_sent === true, text_sent: p.text_sent === true };
  } catch {
    return null;
  }
}

/** Resolve the outbox row for a signal: stable `outbox_id` first, legacy payload match second. */
export function outboxRowForSignal(repo: Repo, sig: SignalRow): { row: OutboxRow | null; link: SignalDeliveryView["link"] } {
  if (sig.outbox_id != null) {
    const row = repo.outboxGet(sig.outbox_id);
    // A broken modern reference is not a legacy row. Never hide reference
    // loss by searching for some other delivery with a matching payload.
    let matches = false;
    try {
      const payload = row ? JSON.parse(row.payload_json) : null;
      matches = row?.kind === "signal" && payload?.kind === "signal"
        && payload?.opportunity_id === sig.opp_id
        && (payload?.signal_id === undefined || payload.signal_id === sig.id);
    } catch { /* corrupt reference is unavailable, not another signal's SENT */ }
    return { row: matches ? row : null, link: matches ? "outbox_id" : null };
  }
  if (sig.opp_id) {
    const row = repo.outboxForOpportunity(sig.opp_id);
    if (row) return { row, link: "legacy_payload_match" };
  }
  return { row: null, link: null };
}

export function signalDelivery(repo: Repo, sig: SignalRow, nowMs = Date.now()): SignalDeliveryView {
  const { row, link } = outboxRowForSignal(repo, sig);
  const state = deliveryStateOf(row, nowMs);
  return {
    outbox_id: row?.id ?? null,
    link,
    delivery_state: state,
    outbox_state: row?.state ?? null,
    attempts: row?.attempts ?? null,
    error: row?.error ?? null,
    error_kind: row?.error_kind ?? null,
    progress: row ? progressOf(row) : null,
    queued_ms: row?.created_ms ?? null,
    sent_ms: row?.sent_ms ?? null,
    sending:
      state === "SENDING" && row
        ? { claimed_by: row.claimed_by as string, claim_ms: row.claim_ms, claim_expires_ms: row.claim_expires_ms }
        : null,
  };
}

/** Persisted JSON may be corrupt or legacy null; APIs must not crash or invent it. */
export function parseStoredPayload(json: string): { payload: Record<string, unknown>; status: "PARSED" | "UNAVAILABLE" } {
  try {
    const value: unknown = JSON.parse(json);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { payload: value as Record<string, unknown>, status: "PARSED" };
    }
  } catch { /* explicit unavailable below */ }
  return { payload: {}, status: "UNAVAILABLE" };
}

/**
 * DECISION-SNAPSHOT IDENTITY AGREEMENT (provenance integrity).
 *
 * A published payload carries the decision window identity in TWO places: the
 * immutable decision snapshot (`provenance.data.snapshot`) and the chart
 * evidence the renderer verifies (`chart_evidence.snapshot`). The publisher
 * writes both from ONE object, so in a healthy database they always agree.
 *
 * If they ever disagree — storage corruption, a partial write, an out-of-band
 * edit — the record contains CONTRADICTORY provenance. That must be reported,
 * never silently resolved by picking one copy: `/api/charts` verifies against
 * `chart_evidence`, so a consumer reading the other copy would otherwise
 * believe an unverified identity had been checked.
 *
 * None of these states is "verified": AGREED means the two stored copies are
 * consistent, not that the venue's candles still reproduce the fingerprint
 * (that is `verifyDecisionSnapshot`'s separate, independent check).
 */
export type SnapshotIdentityState = "AGREED" | "SINGLE_SOURCE" | "CONTRADICTION" | "ABSENT";

export interface SnapshotIdentityCheck {
  state: SnapshotIdentityState;
  reason: string;
}

function describeSnapshot(s: { symbol: string; timeframe: string; as_of_t: number; closed_bars: number; input_fingerprint: string }): string {
  return `${s.symbol}@${s.timeframe} as_of ${s.as_of_t}, ${s.closed_bars} bars, fingerprint ${s.input_fingerprint.slice(0, 12)}…`;
}

function snapshotFields(value: unknown): { symbol: string; timeframe: string; as_of_t: number; closed_bars: number; input_fingerprint: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  if (typeof s.symbol !== "string" || typeof s.timeframe !== "string"
    || typeof s.as_of_t !== "number" || !Number.isFinite(s.as_of_t)
    || typeof s.closed_bars !== "number" || !Number.isFinite(s.closed_bars)
    || typeof s.input_fingerprint !== "string") return null;
  return { symbol: s.symbol, timeframe: s.timeframe, as_of_t: s.as_of_t, closed_bars: s.closed_bars, input_fingerprint: s.input_fingerprint };
}

export function snapshotIdentityCheck(payload: Record<string, unknown>): SnapshotIdentityCheck {
  const provenance = payload.provenance;
  const provenanceSnapshot = provenance !== null && typeof provenance === "object" && !Array.isArray(provenance)
    ? (provenance as Record<string, unknown>).data
    : null;
  const fromProvenance = provenanceSnapshot !== null && typeof provenanceSnapshot === "object" && !Array.isArray(provenanceSnapshot)
    ? (provenanceSnapshot as Record<string, unknown>).snapshot
    : null;
  const evidence = payload.chart_evidence;
  const fromEvidence = evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)
    ? (evidence as Record<string, unknown>).snapshot
    : null;

  const a = snapshotFields(fromProvenance);
  const b = snapshotFields(fromEvidence);
  if (!a && !b) return { state: "ABSENT", reason: "neither stored copy carries a parsable decision snapshot (legacy record)" };
  if (!a || !b) {
    return {
      state: "SINGLE_SOURCE",
      reason: a ? "only provenance.data.snapshot carries the decision identity (chart evidence has none)" : "only chart_evidence.snapshot carries the decision identity (provenance has none)",
    };
  }
  const same = a.symbol === b.symbol && a.timeframe === b.timeframe && a.as_of_t === b.as_of_t
    && a.closed_bars === b.closed_bars && a.input_fingerprint === b.input_fingerprint;
  return same
    ? { state: "AGREED", reason: `both stored copies name the same decision window (${a.symbol}@${a.timeframe} as_of ${a.as_of_t}, ${a.closed_bars} bars, fingerprint ${a.input_fingerprint.slice(0, 12)}…)` }
    : {
      state: "CONTRADICTION",
      reason: `stored provenance copies disagree: provenance.data.snapshot=${describeSnapshot(a)} vs chart_evidence.snapshot=${describeSnapshot(b)} — refusing to present either as verified`,
    };
}
