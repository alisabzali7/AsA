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
 *   - DEAD    : terminal after the transport budget (or poison payload)
 *   - UNLINKED: signal has no outbox row (never published, or the legacy
 *               fallback found nothing) — reported as such, never as "sent"
 */
import type { OutboxRow, Repo, SignalRow } from "../../db/repo";

export type DeliveryState = "QUEUED" | "SENDING" | "FAILED" | "SENT" | "DEAD" | "UNLINKED";

export interface DeliveryProgressView {
  photo_required: boolean;
  photo_sent: boolean;
  text_sent: boolean;
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
    return { photo_required: p.photo_required === true, photo_sent: p.photo_sent === true, text_sent: p.text_sent === true };
  } catch {
    return null;
  }
}

/** Resolve the outbox row for a signal: stable `outbox_id` first, legacy payload match second. */
export function outboxRowForSignal(repo: Repo, sig: SignalRow): { row: OutboxRow | null; link: SignalDeliveryView["link"] } {
  if (sig.outbox_id != null) {
    const row = repo.outboxGet(sig.outbox_id);
    if (row) return { row, link: "outbox_id" };
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
    progress: row ? progressOf(row) : null,
    queued_ms: row?.created_ms ?? null,
    sent_ms: row?.sent_ms ?? null,
    sending:
      state === "SENDING" && row
        ? { claimed_by: row.claimed_by as string, claim_ms: row.claim_ms, claim_expires_ms: row.claim_expires_ms }
        : null,
  };
}
