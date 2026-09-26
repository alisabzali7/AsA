/**
 * Telegram adapter + notification outbox consumer (master §64).
 * The outbox is DURABLE: a Telegram outage never breaks signal generation.
 * Default: NOT CONFIGURED (dry-run rows kept). Sends only after provider
 * acceptance (HTTP 200 from api.telegram.org). Advisory text only.
 */
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_CONFIGURED, TELEGRAM_DRY_RUN } from "../env";
import { getRepo } from "../../db/sqlite";
import type { ChartEvidence, SnapshotCheckState } from "../chart/evidence";
import type { OutboxRow, OutboxClaim, Repo } from "../../db/repo";
import { OUTBOX_CLAIM_LEASE_MS, OUTBOX_MAX_ATTEMPTS } from "../../db/repo";
import { eventBus } from "../events";
import type { AppState } from "../domain/types";
import { randomUUID } from "node:crypto";

export interface TelegramSignalPayload {
  kind: "signal" | "opportunity" | "system";
  advisory_only?: boolean;
  symbol?: string;
  timeframe?: string;
  direction?: string;
  strategy?: string;
  strategy_id?: string;
  setup_id?: string | null;
  score?: number;
  score_semantics?: string;
  entry?: number | null;
  stop?: number | null;
  targets?: number[];
  rr?: number | null;
  risk?: unknown;
  psychology?: unknown;
  reason?: string;
  thesis?: string;
  invalidation?: number | null;
  data_quality?: unknown;
  source_refs?: unknown;
  timestamp?: number;
  /** opportunity id — used to fetch the annotated chart image */
  opportunity_id?: string | null;
  chart_json_url?: string | null;
  generated_at_ms: number;
  /** sub-step delivery progress (persisted on the row by the outbox consumer) */
  delivery_progress?: DeliveryProgress;
}

/**
 * Sub-step delivery progress for ONE logical outbox item (closure §L: the
 * annotated chart image AND the full advisory text are two transport steps of
 * one delivery). Persisted inside the row's payload_json after each provider
 * acceptance so a retry of the SAME row resumes instead of repeating an
 * already-accepted sub-step.
 */
export interface DeliveryProgress {
  /**
   * Set the first time an annotated chart image was produced for this item.
   * From then on the photo is a REQUIRED sub-step until delivered — a
   * chart-bearing advisory is not complete until its chart actually went out.
   * Items that can never produce a picture ("we never invent a picture") stay
   * text-only, matching the historical fallback contract.
   */
  photo_required: boolean;
  photo_sent: boolean;
  text_sent: boolean;
}

export type TelegramHealth =
  | "NOT_CONFIGURED"
  | "CONFIGURED"
  | "CONNECTING"
  | "ONLINE"
  | "DEGRADED"
  | "ERROR";

export interface TelegramStatus {
  state: AppState;
  /** honest lifecycle state from the last real getMe probe */
  health: TelegramHealth;
  reason?: string;
  configured: boolean;
  dry_run: boolean;
  /** bot @username confirmed by the provider — never the token */
  bot_username: string | null;
  chat_id_masked: string | null;
  latency_ms: number | null;
  probed_at_ms: number | null;
}

interface TgProbe { health: TelegramHealth; bot_username: string | null; latency_ms: number | null; error: string | null; probed_at_ms: number }
let tgProbe: TgProbe | null = null;
const TG_PROBE_TTL_MS = 60_000;

function maskChatId(id: string): string {
  return id.length <= 4 ? "****" : `${id.slice(0, 3)}***${id.slice(-2)}`;
}

/**
 * Real provider probe (getMe). Truthful connection state only: we never
 * report CONNECTED from configuration alone. The token is used solely to
 * build the request URL and is never returned, logged, or emitted.
 */
export async function probeTelegram(force = false): Promise<TgProbe> {
  if (!TELEGRAM_CONFIGURED) {
    tgProbe = { health: "NOT_CONFIGURED", bot_username: null, latency_ms: null, error: null, probed_at_ms: Date.now() };
    return tgProbe;
  }
  if (!force && tgProbe && Date.now() - tgProbe.probed_at_ms < TG_PROBE_TTL_MS) return tgProbe;
  const started = Date.now();
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const latency_ms = Date.now() - started;
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { username?: string }; description?: string } | null;
    if (!res.ok || !body?.ok) {
      tgProbe = { health: "ERROR", bot_username: null, latency_ms, error: body?.description ?? `getMe HTTP ${res.status}`, probed_at_ms: Date.now() };
    } else {
      tgProbe = { health: "ONLINE", bot_username: body.result?.username ?? null, latency_ms, error: null, probed_at_ms: Date.now() };
    }
  } catch (err) {
    tgProbe = { health: "ERROR", bot_username: null, latency_ms: Date.now() - started, error: err instanceof Error ? err.message : String(err), probed_at_ms: Date.now() };
  }
  return tgProbe;
}

/** Synchronous status from cached probe state — safe for hot status paths. */
export function telegramState(): TelegramStatus {
  const base = {
    configured: TELEGRAM_CONFIGURED,
    dry_run: TELEGRAM_DRY_RUN,
    chat_id_masked: TELEGRAM_CONFIGURED ? maskChatId(TELEGRAM_CHAT_ID) : null,
  };
  if (!TELEGRAM_CONFIGURED) {
    return { ...base, state: "NOT_CONFIGURED", health: "NOT_CONFIGURED", reason: "set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID", bot_username: null, latency_ms: null, probed_at_ms: null };
  }
  const p = tgProbe;
  if (!p) {
    return { ...base, state: "DEGRADED", health: "CONNECTING", reason: "configured; provider not probed yet in this process", bot_username: null, latency_ms: null, probed_at_ms: null };
  }
  if (p.health === "ERROR") {
    return { ...base, state: "DEGRADED", health: "ERROR", reason: `provider unreachable: ${p.error ?? "unknown"}`, bot_username: null, latency_ms: p.latency_ms, probed_at_ms: p.probed_at_ms };
  }
  if (TELEGRAM_DRY_RUN) {
    return { ...base, state: "DEGRADED", health: "DEGRADED", reason: "provider reachable but TELEGRAM_DRY_RUN=1 — outbox rows stay QUEUED, nothing is sent", bot_username: p.bot_username, latency_ms: p.latency_ms, probed_at_ms: p.probed_at_ms };
  }
  return { ...base, state: "CONNECTED", health: "ONLINE", bot_username: p.bot_username, latency_ms: p.latency_ms, probed_at_ms: p.probed_at_ms };
}

/** Probe then report — for status endpoints that can afford one round trip. */
export async function telegramStateLive(): Promise<TelegramStatus> {
  await probeTelegram();
  return telegramState();
}

/** Send an annotated chart image with the advisory caption (closure §L). */
async function sendTelegramPhoto(png: Uint8Array, caption: string): Promise<boolean> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const form = new FormData();
  form.append("chat_id", TELEGRAM_CHAT_ID);
  // Telegram caps captions at 1024 chars; the full advisory follows as text.
  form.append("caption", caption.slice(0, 1000));
  form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "asa-advisory.png");
  try {
    const r = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    return r.ok;
  } catch {
    return false;
  }
}

function sendTelegram(text: string): Promise<boolean> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  })
    .then((r) => r.ok)
    .catch(() => false);
}

/**
 * Advisory message (closure §L1). Contains every required field and uses no
 * execution language anywhere: AsA describes, the human decides and acts.
 */
export function formatSignalText(p: TelegramSignalPayload): string {
  const psy = p.psychology as { state?: string; hard_blocks?: string[] } | undefined;
  const risk = p.risk as { verdict?: string; numbers?: Record<string, unknown> } | undefined;
  const lines = [
    `AsA advisory — ${p.kind}`,
    p.symbol ? `Symbol: ${p.symbol}` : "",
    p.timeframe ? `Timeframe: ${p.timeframe}` : "",
    p.direction ? `Direction: ${p.direction}` : "",
    p.strategy ? `Strategy: ${p.strategy}` : "",
    p.score !== undefined ? `Score: ${p.score} — ${p.score_semantics ?? "decision score, not a probability"}` : "",
    p.entry !== undefined && p.entry !== null ? `Entry: ${p.entry}` : "",
    p.stop !== undefined && p.stop !== null ? `SL: ${p.stop}` : "",
    p.targets?.length ? `TP: ${p.targets.join(" / ")}` : "",
    p.rr !== undefined && p.rr !== null ? `RR: ${p.rr}` : "RR: UNKNOWN",
    risk?.verdict ? `Risk: ${risk.verdict}${risk.numbers?.risk_amount ? ` (risk ${risk.numbers.risk_amount})` : ""}` : "",
    psy?.state ? `Psychology: ${psy.state}${psy.hard_blocks?.length ? ` — ${psy.hard_blocks[0]}` : ""}` : "",
    p.reason ?? p.thesis ? `\nReason: ${p.reason ?? p.thesis}` : "",
    p.invalidation !== undefined && p.invalidation !== null ? `Invalidation: ${p.invalidation}` : "",
    p.timestamp ? `Time: ${new Date(p.timestamp).toISOString()}` : "",
    "\nAdvisory only. AsA never places, cancels or manages any order. The human decides and acts.",
  ];
  return lines.filter(Boolean).join("\n");
}

/** The PNG has no text rasteriser: an unverified chart window is disclosed in the caption. */
export function photoCaption(caption: string, state: SnapshotCheckState): string {
  if (state === "VERIFIED") return caption;
  return `[chart window ${state}: record has no decision snapshot, the image cannot be proven to be the decision window]\n${caption}`;
}

/**
 * Render the annotated advisory chart for an outbox payload.
 * Uses the SAME ChartEvidence + renderer as the web chart route, so the image
 * a user receives is exactly what the decision was based on. Returns null when
 * the opportunity has no stored evidence — we never invent a picture.
 */
async function renderAdvisoryPng(payload: TelegramSignalPayload): Promise<{ png: Uint8Array; state: SnapshotCheckState } | null> {
  const oppId = payload.opportunity_id;
  if (!oppId) return null;
  try {
    const { getRepo: repoFn } = await import("../../db/sqlite");
    const row = repoFn().opportunityGet(oppId);
    if (!row) return null;
    const parsed = JSON.parse(row.payload_json) as { chart_evidence?: ChartEvidence };
    const evidence = parsed.chart_evidence;
    if (!evidence) return null;
    const { chartEvidenceMatches } = await import("../chart/evidence");
    if (!chartEvidenceMatches(evidence, { symbol: row.symbol, timeframe: row.timeframe })) return null;
    const { candleManager } = await import("../market/candles");
    const { isTimeframe } = await import("../domain/timeframes");
    // AUDIT FIX (P1): validate the stored timeframe instead of `as never` —
    // a corrupt payload must not reach the fetcher.
    if (!isTimeframe(evidence.timeframe)) return null;
    const series = await candleManager.ensureSeries(evidence.symbol, evidence.timeframe, true);
    if (!series || series.symbol !== evidence.symbol || series.timeframe !== evidence.timeframe) return null;
    // Task 10: the image claims to be "what the decision was based on" — so it
    // must be the decision window. A re-fetched series whose window no longer
    // reproduces the stored fingerprint is NOT sent as if it were.
    const { verifyDecisionSnapshot } = await import("../chart/evidence");
    const check = verifyDecisionSnapshot(evidence, series.candles);
    // MISMATCH: the window changed. UNVERIFIABLE: the fetched history no
    // longer holds the decision window, so the image could not be it. Only
    // VERIFIED, or a LEGACY record (disclosed in the caption), is sent.
    if (check.state === "MISMATCH" || check.state === "UNVERIFIABLE") return null;
    const { renderEvidencePng } = await import("../chart/render");
    return { png: renderEvidencePng(evidence, series.candles, { snapshotState: check.state }), state: check.state };
  } catch {
    return null; // never block the advisory text on a rendering failure
  }
}

/** Internal sentinel: the row's claim was reclaimed elsewhere — stop, write nothing. */
class ClaimLostError extends Error {
  constructor() {
    super("outbox claim lost mid-delivery");
  }
}

/** Deliver ONE outbox row through the Telegram provider. */
export async function deliverOutboxRow(row: OutboxRow, repo: Repo = getRepo()): Promise<{ ok: boolean; error?: string }> {
  // Terminal/idempotent short-circuits (read-only — no claim, no attempt).
  if (row.state === "SENT") return { ok: true };
  if (row.state === "DEAD") return { ok: false, error: "row is DEAD (terminal) — never delivered again" };

  // PREFLIGHT (T05 T3): preconditions only — NO claim and NO attempt is
  // consumed ("attempts" counts TRANSPORT attempts; these paths never reach a
  // provider request). State notes keep the repository's existing contract:
  // both paths stay retryable.
  if (!TELEGRAM_CONFIGURED) {
    repo.outboxMark(row.id, "FAILED", "telegram not configured");
    return { ok: false, error: "telegram not configured" };
  }
  if (TELEGRAM_DRY_RUN) {
    repo.outboxMark(row.id, "QUEUED", "dry-run — no send attempted");
    return { ok: false, error: "dry-run mode" };
  }

  // CLAIM (T05 T3): atomic persistence-layer ownership of THIS delivery
  // cycle. The winner sends; every loser returns before any provider call.
  // This closes the "read row -> two workers both send" race at the shared
  // storage boundary — effective across processes, timers and API drains.
  const claim: OutboxClaim = {
    token: randomUUID(),
    claimed_at_ms: Date.now(),
    expires_at_ms: Date.now() + OUTBOX_CLAIM_LEASE_MS,
  };
  if (!repo.outboxClaim(row.id, claim)) {
    return { ok: false, error: `outbox row ${row.id} is claimed by another active consumer — no send attempted` };
  }

  // THE attempts counter: one increment per logical delivery cycle, at the
  // moment the cycle ENTERS the transport phase (before the first provider
  // request of the cycle). A crash after this point truthfully keeps the
  // attempt — at-least-once transport semantics (Telegram offers no
  // idempotency keys; exactly-once is NOT claimed).
  let attemptsAfterCount: number | null = null;
  const recordAttempt = (): void => {
    if (attemptsAfterCount !== null) return; // exactly once per cycle
    const n = repo.outboxCountAttempt(row.id, claim);
    if (n === null) throw new ClaimLostError();
    attemptsAfterCount = n;
  };

  try {
    let payload: TelegramSignalPayload;
    try {
      payload = JSON.parse(row.payload_json) as TelegramSignalPayload;
    } catch {
      // poison content: zero provider requests ever possible — DEAD without
      // consuming the transport budget (budget = real delivery attempts only)
      repo.outboxMark(row.id, "DEAD", "unparseable payload", claim);
      return { ok: false, error: "unparseable payload" };
    }
    // GATE 20 / FIX (T05 T2): ONE logical delivery = [annotated chart photo]
    // + [full advisory text] as separate transport sub-steps. Sub-step
    // provider acceptances are persisted on the row (payload.delivery_progress)
    // IMMEDIATELY, so a retry of the SAME row resumes where it stopped. The
    // old code re-sent the photo whenever the text failed after it (and the
    // text whenever the photo failed before it) — duplicate messages for one
    // logical item.
    // T05 T5: formatting is a PURE function of the persisted payload. A throw
    // here (parseable JSON but malformed shape — non-array targets, invalid
    // timestamp, JSON null, ...) would recur identically on every retry: a
    // deterministic poison condition, not a transient failure. It is
    // dead-lettered like an unparseable payload — zero provider requests were
    // ever possible, so the transport budget is untouched (attempts stay 0).
    let caption: string;
    try {
      if (payload === null || typeof payload !== "object") throw new Error("payload is not an object");
      caption = formatSignalText(payload);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      repo.outboxMark(row.id, "DEAD", `poison payload: advisory text cannot be formatted (${why})`, claim);
      eventBus.emit("system", { message: `telegram outbox row ${row.id} DEAD: poison payload — ${why}`, level: "error" });
      return { ok: false, error: `poison payload: ${why}` };
    }
    const prev = payload.delivery_progress;
    const progress: DeliveryProgress = {
      photo_required: prev?.photo_required === true,
      photo_sent: prev?.photo_sent === true,
      text_sent: prev?.text_sent === true,
    };
    const persistProgress = (): void => {
      // owner-conditional write (T05 T3): a stale worker can never overwrite
      // the reclaimed row's delivery progress
      if (!repo.outboxSetPayload(row.id, JSON.stringify({ ...payload, delivery_progress: progress }), claim)) {
        throw new ClaimLostError();
      }
    };
    const failures: string[] = [];

    // SUB-STEP 1: annotated chart image rendered from the SAME ChartEvidence
    // the web chart uses. Skipped entirely once delivered. If no picture can
    // be produced the photo is not part of this item's contract — unless one
    // WAS produced earlier, in which case it stays required until delivered.
    if (!progress.photo_sent) {
      const rendered = await renderAdvisoryPng(payload);
      if (rendered) {
        progress.photo_required = true;
        recordAttempt(); // entering transport: the provider request follows
        if (await sendTelegramPhoto(rendered.png, photoCaption(caption, rendered.state))) {
          progress.photo_sent = true;
        } else {
          failures.push("photo not accepted");
        }
        persistProgress();
      }
    }

    // SUB-STEP 2: the full advisory text (always follows the photo so nothing
    // is truncated by the caption cap). Skipped once delivered.
    if (!progress.text_sent) {
      recordAttempt(); // entering transport: the provider request follows
      if (await sendTelegram(caption)) {
        progress.text_sent = true;
      } else {
        failures.push("text not accepted");
      }
      persistProgress();
    }

    // COMPLETE only when the FULL logical contract is satisfied — never
    // "SENT" merely because an attempt (or a claim) was made.
    const complete = progress.text_sent && (!progress.photo_required || progress.photo_sent);
    if (complete) {
      if (!repo.outboxMark(row.id, "SENT", null, claim)) throw new ClaimLostError();
      eventBus.emit("system", {
        message: `telegram outbox row ${row.id} sent (photo ${progress.photo_required ? "delivered" : "n/a"}, text delivered)`,
        level: "info",
      });
      return { ok: true };
    }
    const missing = [progress.photo_required && !progress.photo_sent ? "photo" : "", !progress.text_sent ? "text" : ""]
      .filter(Boolean)
      .join("+");
    const error = `${missing} not delivered${failures.length ? ` (${failures.join("; ")})` : ""}`;
    // DEAD is reachable ONLY through the exhausted TRANSPORT-attempt budget
    if (attemptsAfterCount !== null && attemptsAfterCount >= OUTBOX_MAX_ATTEMPTS) {
      if (!repo.outboxMark(row.id, "DEAD", error, claim)) throw new ClaimLostError();
      // AUDIT FIX (observability mandate): a permanently lost delivery is a
      // DEGRADED event, not silence.
      eventBus.emit("system", {
        message: `telegram outbox row ${row.id} DEAD after ${attemptsAfterCount} transport attempts — ${error}`,
        level: "error",
      });
      return { ok: false, error: `max attempts reached: ${error}` };
    }
    if (!repo.outboxMark(row.id, "FAILED", error, claim)) throw new ClaimLostError();
    eventBus.emit("system", {
      message: `telegram outbox row ${row.id} FAILED (transport attempt ${attemptsAfterCount ?? "0 (preflight)"}/${OUTBOX_MAX_ATTEMPTS}): ${error} — will retry`,
      level: "warn",
    });
    return { ok: false, error };
  } catch (err) {
    if (err instanceof ClaimLostError) {
      // ownership was legitimately reclaimed — write NOTHING (the new owner's
      // row must stay intact) and leave the retry accounting as it is
      return { ok: false, error: `outbox row ${row.id}: claim lost mid-delivery — another consumer owns it (at-least-once transport semantics apply)` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Unexpected failure. Everything deterministic about the payload was
    // classified above (parse / format → DEAD); what can still throw here is
    // infrastructure (repository write errors, rendering seam) — transient by
    // nature, so the row stays retryable (FAILED) and is NOT dead-lettered on
    // a budget it never spent. DEAD only if the TRANSPORT budget is genuinely
    // exhausted. Retries are bounded by the drain cadence and made visible.
    const dead = attemptsAfterCount !== null && attemptsAfterCount >= OUTBOX_MAX_ATTEMPTS;
    repo.outboxMark(row.id, dead ? "DEAD" : "FAILED", msg, claim);
    eventBus.emit("system", {
      message: `telegram outbox row ${row.id} ${dead ? "DEAD" : "FAILED (transient, will retry)"}: unexpected error — ${msg}`,
      level: dead ? "error" : "warn",
    });
    return { ok: false, error: msg };
  }
}

/**
 * Process retryable rows (called by engine every minute).
 *
 * AUDIT FIX (P1): the drain used to select ONLY QUEUED rows, so any row marked
 * FAILED by a transient Telegram outage was stranded forever — the "durable
 * outbox" silently lost delivery. The drain now retries FAILED rows that have
 * TRANSPORT attempts left; DEAD (budget exhausted after real attempts, or
 * poison content) stays terminal. Concurrent drains (timer + manual API, or
 * overlapping timers) are safe: each row is guarded by the atomic claim, so
 * at most one consumer per row enters the transport phase.
 */
export async function drainOutbox(repo: Repo = getRepo()): Promise<{ attempted: number; sent: number; retried_failed: number }> {
  const retryable = repo.outboxRetryable(50);
  const retriedFailed = retryable.filter((r) => r.state === "FAILED").length;
  let sent = 0;
  for (const row of retryable) {
    const r = await deliverOutboxRow(row, repo);
    if (r.ok) sent++;
  }
  return { attempted: retryable.length, sent, retried_failed: retriedFailed };
}
