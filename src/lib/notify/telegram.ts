/**
 * Telegram adapter + notification outbox consumer (master §64).
 * The outbox is DURABLE: a Telegram outage never breaks signal generation.
 * Default: NOT CONFIGURED (dry-run rows kept). Sends only after provider
 * acceptance (HTTP 200 from api.telegram.org). Advisory text only.
 */
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_CONFIGURED, TELEGRAM_DRY_RUN } from "../env";
import { getRepo } from "../../db/sqlite";
import type { ChartEvidence } from "../chart/evidence";
import type { OutboxRow } from "../../db/repo";
import { eventBus } from "../events";
import type { AppState } from "../domain/types";

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

/**
 * Render the annotated advisory chart for an outbox payload.
 * Uses the SAME ChartEvidence + renderer as the web chart route, so the image
 * a user receives is exactly what the decision was based on. Returns null when
 * the opportunity has no stored evidence — we never invent a picture.
 */
async function renderAdvisoryPng(payload: TelegramSignalPayload): Promise<Uint8Array | null> {
  const oppId = payload.opportunity_id;
  if (!oppId) return null;
  try {
    const { getRepo: repoFn } = await import("../../db/sqlite");
    const row = repoFn().opportunityGet(oppId);
    if (!row) return null;
    const parsed = JSON.parse(row.payload_json) as { chart_evidence?: ChartEvidence };
    const evidence = parsed.chart_evidence;
    if (!evidence) return null;
    const { candleManager } = await import("../market/candles");
    const series = await candleManager.ensureSeries(row.symbol, evidence.timeframe as never, true);
    const { renderEvidencePng } = await import("../chart/render");
    return renderEvidencePng(evidence, series?.candles ?? []);
  } catch {
    return null; // never block the advisory text on a rendering failure
  }
}

/** Deliver ONE outbox row through the Telegram provider. */
export async function deliverOutboxRow(row: OutboxRow): Promise<{ ok: boolean; error?: string }> {
  const repo = getRepo();
  if (!TELEGRAM_CONFIGURED) {
    repo.outboxMark(row.id, "FAILED", "telegram not configured");
    return { ok: false, error: "telegram not configured" };
  }
  if (TELEGRAM_DRY_RUN) {
    repo.outboxMark(row.id, "QUEUED", "dry-run — no send attempted");
    return { ok: false, error: "dry-run mode" };
  }
  try {
    let payload: TelegramSignalPayload;
    try {
      payload = JSON.parse(row.payload_json) as TelegramSignalPayload;
    } catch {
      repo.outboxMark(row.id, "DEAD", "unparseable payload");
      return { ok: false, error: "unparseable payload" };
    }
    // GATE 20: send the ANNOTATED CHART IMAGE rendered from the same
    // ChartEvidence the web chart uses, then the full advisory text.
    const caption = formatSignalText(payload);
    let ok = false;
    const png = await renderAdvisoryPng(payload);
    if (png) {
      const photoOk = await sendTelegramPhoto(png, caption);
      // the text message always follows so nothing is truncated by the caption cap
      const textOk = await sendTelegram(caption);
      ok = photoOk && textOk;
    } else {
      ok = await sendTelegram(caption);
    }
    if (ok) {
      repo.outboxMark(row.id, "SENT");
      eventBus.emit("system", { message: `telegram outbox row ${row.id} sent`, level: "info" });
      return { ok: true };
    }
    const attempts = row.attempts + 1;
    if (attempts >= 5) {
      repo.outboxMark(row.id, "DEAD", "max attempts reached");
      return { ok: false, error: "max attempts reached" };
    }
    repo.outboxMark(row.id, "FAILED", "provider did not accept");
    return { ok: false, error: "provider did not accept" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    repo.outboxMark(row.id, row.attempts + 1 >= 5 ? "DEAD" : "FAILED", msg);
    return { ok: false, error: msg };
  }
}

/** Process all QUEUED rows (called by engine every minute). */
export async function drainOutbox(): Promise<{ attempted: number; sent: number }> {
  const repo = getRepo();
  const queued = repo.outboxList("QUEUED", 50);
  let sent = 0;
  for (const row of queued) {
    const r = await deliverOutboxRow(row);
    if (r.ok) sent++;
  }
  return { attempted: queued.length, sent };
}
