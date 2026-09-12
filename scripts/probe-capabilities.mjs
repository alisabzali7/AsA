#!/usr/bin/env node
/**
 * Credential CAPABILITY probe — read-only, evidence-producing.
 *
 * Answers three questions with real network responses, and nothing else:
 *   1. TTT   — do the supplied API key/secret unlock any authenticated READ?
 *   2. AI    — is the OpenAI-compatible gateway reachable and is the
 *              configured model actually in its catalogue?
 *   3. TG    — does the bot token resolve to a real bot (getMe)?
 *
 * SAFETY: GET-only for TTT and AI catalogue. It never places, cancels, or
 * modifies an order/position/leverage/transfer, and it never sends a Telegram
 * message. Secret VALUES are never printed — only lengths and masked prefixes.
 *
 * Usage: node scripts/probe-capabilities.mjs [--json]
 */
import { createHmac } from "node:crypto";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env", quiet: true });
loadDotenv({ path: ".env.local", override: true, quiet: true });

const JSON_OUT = process.argv.includes("--json");
const out = { ts: new Date().toISOString(), ttt: {}, ai: {}, telegram: {} };
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

const TTT_BASE = (process.env.TTT_API_BASE || "https://apiv2.thetruetrade.io").replace(/\/+$/, "");
const TTT_KEY = process.env.TTT_API_KEY || "";
const TTT_SECRET = process.env.TTT_API_SECRET || "";
const AI_BASE = (process.env.OPENAI_BASE_URL || "").replace(/\/+$/, "");
const AI_KEY = process.env.OPENAI_API_KEY || "";
const AI_MODEL = process.env.AI_OPENAI_MODEL || "gpt-4o-mini";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";

// Never emit any part of a secret — presence and length only.
const mask = (v) => (!v ? "ABSENT" : `PRESENT len=${v.length}`);

function sign(secret, ts, method, uri) {
  return createHmac("sha256", secret).update(`${ts}${method.toUpperCase()}${uri}`, "utf8").digest("hex");
}

async function get(url, headers = {}, timeoutMs = 15_000) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    const text = await res.text().catch(() => "");
    return { status: res.status, ms: Date.now() - started, text };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, text: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ TTT */
// Candidate authenticated READ routes. All GET. No order/position/transfer
// route is listed here by design — AsA has no execution surface at all.
const TTT_READ_PATHS = [
  "/futures/account",
  "/futures/account/balance",
  "/futures/account/summary",
  "/futures/balance",
  "/futures/user/info",
];

async function probeTtt() {
  out.ttt.key = mask(TTT_KEY);
  out.ttt.secret = mask(TTT_SECRET);
  out.ttt.base = TTT_BASE;

  // Control: the public route with NO auth headers must work.
  const pub = await get(`${TTT_BASE}/futures/markets/stats`);
  out.ttt.public_unsigned = { status: pub.status, ms: pub.ms };
  log(`TTT public   /futures/markets/stats  (no headers)  -> ${pub.status} in ${pub.ms}ms`);

  if (!TTT_KEY || !TTT_SECRET) {
    out.ttt.verdict = "NO_CREDENTIALS";
    log("TTT: no key/secret configured — nothing else to probe");
    return;
  }

  // Same public route, signed. This isolates whether the edge tolerates the
  // X-API-Key header at all.
  const ts = Date.now();
  const uri = "/futures/markets/stats";
  const signed = await get(`${TTT_BASE}${uri}`, {
    "X-API-Key": TTT_KEY,
    "X-Timestamp": String(ts),
    "X-Signature": sign(TTT_SECRET, ts, "GET", uri),
  });
  out.ttt.public_signed = { status: signed.status, ms: signed.ms };
  log(`TTT public   ${uri}  (signed)      -> ${signed.status} in ${signed.ms}ms`);

  // Header-isolation: which header triggers the rejection?
  const isolation = {};
  for (const [label, h] of [
    ["x_api_key_only", { "X-API-Key": TTT_KEY }],
    ["x_timestamp_only", { "X-Timestamp": String(Date.now()) }],
    ["x_signature_only", { "X-Signature": "0".repeat(64) }],
    ["bogus_api_key", { "X-API-Key": "not-a-real-key" }],
  ]) {
    const r = await get(`${TTT_BASE}${uri}`, h);
    isolation[label] = r.status;
    log(`  header isolation ${label.padEnd(18)} -> ${r.status}`);
    await new Promise((r2) => setTimeout(r2, 400));
  }
  out.ttt.header_isolation = isolation;

  const reads = {};
  for (const p of TTT_READ_PATHS) {
    const t = Date.now();
    const r = await get(`${TTT_BASE}${p}`, {
      "X-API-Key": TTT_KEY,
      "X-Timestamp": String(t),
      "X-Signature": sign(TTT_SECRET, t, "GET", p),
    });
    const isHtml = r.text.trim().startsWith("<");
    reads[p] = { status: r.status, ms: r.ms, body_kind: isHtml ? "html_error_page" : "json_or_text" };
    log(`TTT private  ${p.padEnd(28)} -> ${r.status} (${reads[p].body_kind})`);
    await new Promise((r2) => setTimeout(r2, 600));
  }
  out.ttt.private_reads = reads;

  const anyOk = Object.values(reads).some((r) => r.status >= 200 && r.status < 300);
  const keyRejected = isolation.x_api_key_only === 403 && out.ttt.public_unsigned.status === 200;
  out.ttt.verdict = anyOk
    ? "PRIVATE_READ_AVAILABLE"
    : keyRejected
      ? "KEY_HEADER_REJECTED_AT_EDGE"
      : "NO_PRIVATE_READ";
  out.ttt.conclusion = keyRejected
    ? "The venue edge returns 403 for ANY request carrying X-API-Key, including routes that return 200 unsigned. Credentials cannot be attached to market data without breaking it; AsA sends market requests unsigned."
    : anyOk
      ? "At least one authenticated read route responded 2xx."
      : "Credentials accepted at the edge but no probed read route is available to them.";
  log(`TTT verdict: ${out.ttt.verdict} — ${out.ttt.conclusion}`);
}

/* ------------------------------------------------------------------- AI */
async function probeAi() {
  // Report only the shape of the endpoint, not the vendor host: the base URI
  // came from the operator's credential file and is treated as private config.
  out.ai.base = AI_BASE ? `CONFIGURED (${new URL(AI_BASE).protocol}//<host>${new URL(AI_BASE).pathname})` : "NOT_CONFIGURED";
  out.ai.key = mask(AI_KEY);
  out.ai.configured_model = AI_MODEL;
  if (!AI_BASE || !AI_KEY) {
    out.ai.state = "NOT_CONFIGURED";
    log("AI: not configured");
    return;
  }
  const r = await get(`${AI_BASE}/models`, { Authorization: `Bearer ${AI_KEY}` }, 20_000);
  out.ai.catalogue_status = r.status;
  out.ai.latency_ms = r.ms;
  if (r.status !== 200) {
    out.ai.state = "ERROR";
    out.ai.error = r.error ?? `catalogue HTTP ${r.status}`;
    log(`AI  /models -> ${r.status} (${out.ai.error})`);
    return;
  }
  let ids = [];
  try {
    ids = (JSON.parse(r.text).data ?? []).map((m) => String(m.id));
  } catch {
    out.ai.state = "ERROR";
    out.ai.error = "catalogue was not valid JSON";
    return;
  }
  out.ai.models_count = ids.length;
  out.ai.model_available = ids.includes(AI_MODEL);
  out.ai.state = out.ai.model_available ? "ONLINE" : "DEGRADED";
  log(`AI  /models -> 200 in ${r.ms}ms · ${ids.length} models · "${AI_MODEL}" ${out.ai.model_available ? "AVAILABLE" : "NOT in catalogue"} · state ${out.ai.state}`);
}

/* ------------------------------------------------------------- Telegram */
async function probeTelegram() {
  out.telegram.token = mask(TG_TOKEN);
  out.telegram.chat_id = TG_CHAT ? `${TG_CHAT.slice(0, 3)}***${TG_CHAT.slice(-2)}` : "ABSENT";
  if (!TG_TOKEN || !TG_CHAT) {
    out.telegram.state = "NOT_CONFIGURED";
    log("Telegram: not configured");
    return;
  }
  const r = await get(`https://api.telegram.org/bot${TG_TOKEN}/getMe`);
  out.telegram.getme_status = r.status;
  out.telegram.latency_ms = r.ms;
  try {
    const b = JSON.parse(r.text);
    if (b.ok) {
      out.telegram.state = "ONLINE";
      out.telegram.bot_username = b.result.username;
      out.telegram.bot_id = b.result.id;
      log(`TG  getMe -> 200 in ${r.ms}ms · bot @${b.result.username} · state ONLINE (no message sent)`);
    } else {
      out.telegram.state = "ERROR";
      out.telegram.error = b.description ?? "getMe not ok";
      log(`TG  getMe -> ${r.status} · ERROR ${out.telegram.error}`);
    }
  } catch {
    out.telegram.state = "ERROR";
    out.telegram.error = r.error ?? "unparseable getMe response";
    log(`TG  getMe -> ${r.status} · ERROR ${out.telegram.error}`);
  }
}

await probeTtt();
log("");
await probeAi();
log("");
await probeTelegram();

if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
else log("\nDone. No order, position, transfer, or message was created by this probe.");
