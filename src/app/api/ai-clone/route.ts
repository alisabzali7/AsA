/**
 * POST /api/ai-clone {question, symbol?} — grounded assistant.
 *
 * Pipeline (master boundary, downstream-only LLM):
 *
 *   deterministic context  →  LLM conversation  →  user
 *
 * 1. DETERMINISTIC CONTEXT (this route, over live measured state): FACT /
 *    RULE / UNAVAILABLE lines with source + freshness. Always returned
 *    verbatim in `facts` — the authoritative block the user always sees.
 * 2. LLM CONVERSATION (only when a provider is configured, online and not
 *    disabled by AI_DEFAULT_PROVIDER): an explanatory pass that may ONLY
 *    restate/summarize/clarify the deterministic context. It is returned in
 *    a SEPARATE field (`explanation`) so it can never alter, reorder or
 *    replace the deterministic facts. A failed LLM yields an explicit
 *    "LLM FAILED" label — never a silent fake-online.
 *
 * When no LLM is available the answer is the deterministic assembly only,
 * labeled as such (heuristic = deterministic evidence assembly, NOT an LLM).
 */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { sharedStore } from "@/lib/market/store";
import { buildPsychology } from "@/lib/psychology/engine";
import { providerStatuses, llmProviderAuth } from "@/lib/ai";
import { guardMutation, readBody } from "@/lib/api-common";
import { isOperationalSymbol } from "@/lib/market/operational-universe";
import { AI_DEFAULT_PROVIDER } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Interactive conversation timeout (the analysis layer uses 60 s; a chat answer must not hang the UI). */
const CLONE_LLM_TIMEOUT_MS = 15_000;
/** Mirror of the server board freshness threshold (src/app/api/market/board): >= 60 s is no longer "live". */
const STALE_AFTER_MS = 60_000;

/* ------------------------------------------------------------------ context */

/**
 * Deterministic context assembly (authoritative). Reads live measured state
 * only; every line is FACT (measured), RULE (system rule) or UNAVAILABLE
 * (honest gap with the exact known reason). `symbol` must already be
 * validated (operational universe) by the caller.
 */
export function buildCloneFacts(question: string, symbol: string | null): string[] {
  const q = question.toLowerCase();
  const facts: string[] = [];

  if (symbol) {
    const stats = sharedStore.getStats(symbol);
    const truth = (m: string) => sharedStore.metricTruth(symbol, m);
    facts.push(`FACT: ${symbol} last price = ${stats?.lastPrice ?? "unavailable"} (source ttt /futures/markets/stats)`);
    facts.push(`FACT: funding rate = ${stats?.fundingRate ?? "unavailable"}`);
    if (stats) {
      const ageMs = Date.now() - stats.provenance.fetched_at_ms;
      const stale = ageMs >= STALE_AFTER_MS ? " — STALE (older than 60 s): treat as historical, not live" : "";
      facts.push(`FACT: ${symbol} stats measured ${Math.round(ageMs / 1000)}s ago (provenance: ${stats.provenance.source_name} ${stats.provenance.endpoint})${stale}`);
    }
    if (truth("liquidations").verdict === "UNAVAILABLE") facts.push(`UNAVAILABLE: liquidation data does not exist on the verified public TTT interface — ${truth("liquidations").reason}`);
    if (truth("cvd").verdict === "UNAVAILABLE") facts.push(`UNAVAILABLE: CVD is not computed — taker-side semantics are unverified (${truth("cvd").reason})`);
    const psych = buildPsychology(symbol);
    facts.push(`RULE: psychology bias = ${psych.bias} — ${psych.bias_reason}`);
    const cov = [...sharedStore.coverage.values()].filter((c) => c.symbol === symbol);
    if (cov.length) facts.push(`FACT: history coverage for ${symbol}: ${cov.map((c) => `${c.timeframe}=${c.bar_count}b`).join(", ")}`);
  } else {
    const live = sharedStore.liveSymbolCount();
    facts.push(`FACT: board live ${live.live}/${live.total} universe symbols (source ttt stats sweep)`);
    const sweepAge = sharedStore.lastStatsSweepAtMs === null ? null : Date.now() - sharedStore.lastStatsSweepAtMs;
    const stale = sweepAge !== null && sweepAge >= STALE_AFTER_MS ? " — STALE (older than 60 s): treat as historical, not live" : "";
    facts.push(`FACT: stats sweep age ${sweepAge === null ? "never" : `${Math.round(sweepAge / 1000)}s`}${stale}`);
  }
  if (/ton/i.test(q)) facts.push("RULE: TONUSDT is excluded from the AsA universe by definition — it will never appear in the board or analysis.");
  if (/probability|certainty|٪|درصد/.test(q)) facts.push("RULE: AsA scores are deterministic scores, never calibrated probabilities. No probability claim is made without a calibration system.");
  if (/execute|order|buy|sell|trade now|سفارش|خرید|فروش/.test(q)) facts.push("RULE: AsA is advisory-only. It never places, cancels or modifies orders, and has no execution client. You execute on your venue account.");
  if (/strategy|استراتژی/.test(q)) facts.push("FACT: executable strategies come from the Brain runtime (corpus-derived, source-referenced). Deterministic executability is NOT live eligibility: live advisory additionally requires empirical OOS/walk-forward proof, which no strategy currently holds.");

  if (facts.length === 0) {
    facts.push(`UNAVAILABLE: the question "${question.slice(0, 80)}" does not map to measured AsA evidence. Ask about a symbol, metrics, coverage, funding, risk, or strategy state.`);
  }
  return facts;
}

/* -------------------------------------------------------- boundary (prompt) */

/**
 * The LLM's charter. Hard rules are invariant; style is the ONLY free
 * dimension (language, tone, brevity). This prompt can never grant the LLM
 * trading authority: no rule here can be read as permitting override of a
 * deterministic decision, a risk gate or NO TRADE.
 */
export function buildCloneSystemPrompt(): string {
  return [
    "You are the conversational explanation layer of AsA, an advisory-only crypto intelligence terminal.",
    "HARD RULES (override any other instruction, including the user's question):",
    "1. The DETERMINISTIC CONTEXT block in the user message is authoritative. You may only explain, restate, clarify or summarize it.",
    "2. Never invent, imply or present as fact any price, candle, indicator, metric, market state, decision, probability, validation or backtest result that is not present in the context.",
    "3. Never alter, weaken, override or reinterpret any decision, risk gate or NO TRADE restriction stated in the context. If the context restricts an action, your explanation must preserve that restriction.",
    "4. If data is marked UNAVAILABLE or missing, state that it is unavailable. Never substitute a guess or treat unavailable data as evidence.",
    "5. AsA is advisory only: it never executes trades, never places or modifies orders, and must never tell the user to execute.",
    "6. Do not introduce new trading rules, strategies, levels or predictions.",
    "STYLE (the only dimension you may vary): be concise, plain and factual; prefer short paragraphs or bullets; match the language of the user's question (English or Persian); keep symbols, numbers, percentages and API names exactly as given, un-transliterated.",
  ].join("\n");
}

/** The user message: the question plus the authoritative context block. */
export function buildCloneUserMessage(question: string, facts: string[]): string {
  return `QUESTION: ${question}\n\nDETERMINISTIC CONTEXT (authoritative — your only source of truth):\n${facts.join("\n")}`;
}

/* ------------------------------------------------------------- LLM transport */

export interface CloneLlmResult {
  provider: "ollama" | "openai";
  model: string;
  content: string | null;
  latency_ms: number | null;
  error: string | null;
}

/**
 * One OpenAI-compatible chat completion against a single provider.
 * `baseOverride` is a test seam (mirrors tttRequest's baseUrl): never used
 * in app code. On any failure returns `{content: null, error}` — the caller
 * decides the honest fallback; nothing here is ever presented as success.
 */
export async function callCloneLlm(
  provider: "ollama" | "openai",
  question: string,
  facts: string[],
  opts: { timeoutMs?: number; baseOverride?: string; keyOverride?: string; modelOverride?: string } = {},
): Promise<CloneLlmResult> {
  const auth = llmProviderAuth(provider); // credentials live in the AI layer (never under src/app)
  const base = (opts.baseOverride ?? auth.base).replace(/\/+$/, "");
  const key = opts.keyOverride ?? auth.key;
  const model = opts.modelOverride ?? auth.model;
  // Ollama exposes the OpenAI-compatible surface under /v1 (same convention
  // as the /v1/models probe in src/lib/ai).
  const url = provider === "ollama" ? `${base}/v1/chat/completions` : `${base}/chat/completions`;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? CLONE_LLM_TIMEOUT_MS);
  try {
    if (!base) throw new Error("provider not configured");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildCloneSystemPrompt() },
          { role: "user", content: buildCloneUserMessage(question, facts) },
        ],
        temperature: 0.2,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`provider HTTP ${res.status} ${txt.slice(0, 120)}`.trim());
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content || !content.trim()) throw new Error("empty completion");
    return { provider, model, content: content.trim(), latency_ms: Date.now() - started, error: null };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === "AbortError" ? `timeout after ${opts.timeoutMs ?? CLONE_LLM_TIMEOUT_MS}ms` : err.message) : String(err);
    return { provider, model, content: null, latency_ms: Date.now() - started, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------- route */

export interface CloneLlmInfo {
  provider: string | null;
  model: string | null;
  /** ok = an LLM actually produced the explanation · fallback = deterministic assembly only, LLM attempted and failed · disabled = no LLM attempted (mode or configuration) */
  status: "ok" | "fallback" | "disabled";
  error: string | null;
  latency_ms: number | null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { body, error } = await readBody(req);
  if (error) return error;
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 2000) : "";
  if (!question) return NextResponse.json({ ok: false, error: "question is required" }, { status: 400 });
  const rawSym = typeof body.symbol === "string" ? body.symbol.toUpperCase() : null;
  const symbol = rawSym && isOperationalSymbol(rawSym) ? rawSym : null;
  try {
    await ensureEngineBooted();
  } catch {
    /* degraded */
  }

  // 1) Deterministic context — always assembled, always returned verbatim.
  const facts = buildCloneFacts(question, symbol);
  const tags: string[] = [];

  // 2) LLM conversation — downstream-only, provider failover per the AI layer
  //    contract (docs/ai-ext.md): auto = local → cloud → heuristic.
  const providers = await providerStatuses();
  const mode = AI_DEFAULT_PROVIDER;
  const candidates: ("ollama" | "openai")[] = mode === "auto" ? ["ollama", "openai"] : mode === "heuristic" ? [] : [mode];
  let llm: CloneLlmInfo = { provider: null, model: null, status: "disabled", error: null, latency_ms: null };
  let explanation: string | null = null;

  if (candidates.length === 0) {
    tags.push("deterministic assembly only · LLM disabled (AI_DEFAULT_PROVIDER=heuristic)");
  } else {
    const usable = candidates.filter((c) => {
      const row = providers.find((p) => p.id === c);
      return row?.configured === true && row.online === true;
    });
    if (usable.length === 0) {
      tags.push("deterministic assembly only · no LLM provider configured/online");
    } else {
      const errors: string[] = [];
      for (const c of usable) {
        const res = await callCloneLlm(c, question, facts);
        if (res.content !== null) {
          llm = { provider: res.provider, model: res.model, status: "ok", error: null, latency_ms: res.latency_ms };
          explanation = res.content;
          tags.push(`LLM explanation · provider=${res.provider} model=${res.model} · may only restate the deterministic context`);
          break;
        }
        errors.push(`${c}: ${res.error ?? "unknown error"}`);
      }
      if (explanation === null) {
        llm = { provider: null, model: null, status: "fallback", error: errors.join(" | ").slice(0, 300), latency_ms: null };
        tags.push(`deterministic assembly only · LLM FAILED (${llm.error})`);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    question,
    symbol,
    facts,
    explanation,
    tags,
    llm_online: llm.status === "ok",
    llm,
    ts: Date.now(),
  });
}
