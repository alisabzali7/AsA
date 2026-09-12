/**
 * AI layer — provider agnostic (master §57, docs/ai-ext.md).
 *   heuristic : deterministic evidence assembly (default; NOT an LLM)
 *   ollama    : local OpenAI-compatible gateway (health-probed)
 *   openai    : OpenAI-compatible API (server-side key)
 * Structured output only. A failed LLM falls back to the heuristic provider
 * with an explicit label — never a silent "online".
 * The AI explains evidence; canonical market state stays deterministic.
 */
import {
  OLLAMA_URL,
  OPENAI_BASE_URL,
  OPENAI_API_KEY,
  AI_OLLAMA_MODEL,
  AI_OPENAI_MODEL,
  AI_DEFAULT_PROVIDER,
  type AiMode,
} from "../env";
import { eventBus } from "../events";
import type { AnalysisBundle } from "../analysis/bundle";
import type { MtfResult } from "../analysis/mtf";
import type { PsychologySummary } from "../psychology/engine";

/* ------------------------------------------------------------------ types */
export interface AiAnnotation {
  kind: string;
  direction?: string;
  price: number;
  t: number;
}

export interface AiResponse {
  summary: string;
  direction: "long" | "short" | "neutral" | "reject";
  /** deterministic score 0..100 — a score, NOT a probability (§11) */
  score: number;
  thesis: string;
  market_story: string;
  setup_quality: "high" | "medium" | "low" | "none";
  invalidation: string;
  confluences: string[];
  contradictions: string[];
  risks: string[];
  confidence: number; // 0..100, self-reported by provider; not calibrated probability
  evidence: string[];
  annotations: AiAnnotation[];
  missing_data: string[];
  risk_notes: string[];
  strategy_alignment: string;
  psychology_context: string;
  fundamental_context: string;
  data_timestamp: number;
  provider: string;
  model: string;
  latency_ms: number;
  status: "ok" | "fallback" | "error";
}

export interface AiEvidence {
  symbol: string;
  timeframe: string;
  mtf: MtfResult;
  macro: AnalysisBundle | null;
  context: AnalysisBundle | null;
  trigger: AnalysisBundle | null;
  psychology: PsychologySummary;
  risk: { verdict: string; reasons: string[] } | null;
  strategy: { id: string; pass: boolean; reasons: string[] } | null;
  fundamental: string | null;
  data_timestamp: number;
  window: { t_min: number; t_max: number; price_min: number; price_max: number };
}

export interface AiResult {
  provider_used: string;
  model: string;
  label: "HEURISTIC MODE · NOT AN LLM" | "OLLAMA" | "OPENAI" | "HEURISTIC FALLBACK · LLM FAILED";
  response: AiResponse;
  error: string | null;
}

/**
 * Honest provider health lifecycle (never optimistic):
 *   NOT_CONFIGURED - no base URL / key in env
 *   CONNECTING     - configured, no probe result yet this process
 *   ONLINE         - last probe reached the provider AND the configured model
 *                    was present in its catalogue
 *   DEGRADED       - provider reachable but the configured model was NOT in
 *                    its catalogue (calls may still work; we do not claim it)
 *   ERROR          - last probe failed (network/timeout/HTTP), reason attached
 */
export type AiHealthState =
  | "NOT_CONFIGURED"
  | "CONFIGURED"
  | "CONNECTING"
  | "ONLINE"
  | "DEGRADED"
  | "ERROR";

export interface ProviderStatusRow {
  id: "heuristic" | "ollama" | "openai";
  configured: boolean;
  online: boolean | null; // null = not probed yet
  /** honest lifecycle state; `online` kept for existing consumers */
  state: AiHealthState;
  latency_ms: number | null;
  model: string | null;
  /** was the configured model present in the provider catalogue? null = unknown */
  model_available: boolean | null;
  models_count: number | null;
  probed_at_ms: number | null;
  error: string | null;
}

/* ------------------------------------------------------- structured checks */
function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}
function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 20) : [];
}
function asString(v: unknown, fb = ""): string {
  return typeof v === "string" ? v.slice(0, 2000) : fb;
}

/** Validate + normalize a parsed LLM JSON into the canonical response. */
export function coerceAiResponse(raw: unknown, provider: string, model: string, latency_ms: number, fallbackDirection: "long" | "short" | "neutral"): AiResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // "neutral" is a VALID stance (it means: no setup asserted). Rejecting it
  // here used to mislabel a perfectly good completion as "LLM FAILED", which
  // is exactly the kind of dishonest status this codebase forbids.
  const isDir = (v: unknown): v is AiResponse["direction"] =>
    v === "long" || v === "short" || v === "neutral" || v === "reject";
  const direction: AiResponse["direction"] = isDir(r.direction)
    ? r.direction
    : isDir(r.verdict)
      ? r.verdict
      : fallbackDirection;
  const base: AiResponse = {
    summary: asString(r.summary, ""),
    direction,
    score: clamp(r.score ?? r.confidence, 0, 100, 50),
    thesis: asString(r.thesis),
    market_story: asString(r.market_story),
    setup_quality: ["high", "medium", "low", "none"].includes(asString(r.setup_quality)) ? (asString(r.setup_quality) as AiResponse["setup_quality"]) : "none",
    invalidation: asString(r.invalidation),
    confluences: asStringList(r.confluences),
    contradictions: asStringList(r.contradictions),
    risks: asStringList(r.risks),
    confidence: clamp(r.confidence, 0, 100, 50),
    evidence: asStringList(r.evidence),
    annotations: [],
    missing_data: asStringList(r.missing_data),
    risk_notes: asStringList(r.risk_notes),
    strategy_alignment: asString(r.strategy_alignment),
    psychology_context: asString(r.psychology_context),
    fundamental_context: asString(r.fundamental_context),
    data_timestamp: Date.now(),
    provider,
    model,
    latency_ms,
    status: "ok",
  };
  return base;
}

/** Geometry validation: annotations must lie inside the analyzed window. */
export function validateAnnotations(ann: unknown[], win: AiEvidence["window"]): { kept: AiAnnotation[]; dropped: number } {
  const kept: AiAnnotation[] = [];
  let dropped = 0;
  const pricePad = (win.price_max - win.price_min) * 0.03 || 1;
  const tPad = (win.t_max - win.t_min) * 0.03 || 1;
  for (const a of ann) {
    if (!a || typeof a !== "object") { dropped++; continue; }
    const x = a as Record<string, unknown>;
    const price = Number(x.price), t = Number(x.t);
    const kind = typeof x.kind === "string" ? x.kind : "";
    if (!Number.isFinite(price) || !Number.isFinite(t)) { dropped++; continue; }
    if (price < win.price_min - pricePad || price > win.price_max + pricePad || t < win.t_min - tPad || t > win.t_max + tPad) { dropped++; continue; }
    kept.push({ kind, price, t, direction: typeof x.direction === "string" ? x.direction : undefined });
  }
  return { kept, dropped };
}

/* ------------------------------------------------------------- providers */
export function heuristicAnalyze(ev: AiEvidence): AiResponse {
  const now = Date.now();
  const t = ev.trigger;
  const verdict = resolveHeuristicDirection(ev.mtf);
  const st = t?.structure;
  const indicators = t?.indicators;
  const evidence: string[] = [
    `series bars macro/context/trigger: ${ev.macro?.bars ?? 0}/${ev.context?.bars ?? 0}/${t?.bars ?? 0}`,
  ];
  if (indicators) evidence.push(`rsi14=${fmt(indicators.rsi14)} ema20=${fmt(indicators.ema20)} ema50=${fmt(indicators.ema50)} atr14%=${fmt(indicators.atr14_pct)}`);
  if (st) evidence.push(`trend=${st.trend} (${st.reason})`);
  if (ev.psychology.sections) {
    const fs = ev.psychology.sections.find((s) => s.key === "funding");
    if (fs?.value !== undefined && fs.value !== null) evidence.push(`funding=${fs.value}`);
    const ls = ev.psychology.sections.find((s) => s.key === "liquidation_pressure");
    if (ls) evidence.push(`liquidation data: ${ls.state} — ${ls.reason}`);
  }
  const contradictions = ev.psychology.sections
    .filter((s) => s.state === "UNAVAILABLE" || s.verdict === "UNVERIFIED")
    .map((s) => `${s.label}: ${s.state} (${s.reason ?? s.verdict})`);
  const missing = ev.psychology.sections.filter((s) => s.state === "UNAVAILABLE" || s.state === "INSUFFICIENT_DATA").map((s) => s.label);
  if (!t || t.bars < 100) missing.push("trigger history");

  let riskNotes = ev.risk ? ev.risk.reasons.slice(0, 3) : [];
  if (ev.risk?.verdict === "block") riskNotes = ["RISK BLOCK ACTIVE — AI cannot override", ...riskNotes];
  const score = deterministicScore(ev.mtf);
  return {
    summary: `${ev.symbol} ${ev.timeframe}: ${verdict} (score ${score})`,
    direction: verdict,
    score,
    thesis: heuristicThesis(ev.mtf, ev.psychology),
    market_story: `4H ${ev.macro?.structure.trend ?? "n/a"} · 1H ${ev.context?.structure.trend ?? "n/a"} · 15M ${st?.trend ?? "n/a"} — ${ev.mtf.reason}`,
    setup_quality: score >= 70 ? "medium" : score >= 55 ? "low" : "none",
    invalidation: st?.last_choch ? `structure CHoCH against position at ${fmt(st.last_choch.price)}` : "not defined by structure",
    confluences: evidence.slice(0, 6),
    contradictions,
    risks: [],
    confidence: score,
    evidence,
    annotations: (st?.fvgs ?? []).map((f) => ({ kind: "fvg" as const, direction: f.direction, price: f.direction === "up" ? f.top : f.bottom, t: f.t })).slice(-3),
    missing_data: missing,
    risk_notes: riskNotes,
    strategy_alignment: ev.strategy ? (ev.strategy.pass ? `strategy ${ev.strategy.id} PASS` : `strategy ${ev.strategy.id} not passed: ${ev.strategy.reasons.slice(0, 2).join("; ")}`) : "no live strategy evaluated",
    psychology_context: `bias=${ev.psychology.bias} — ${ev.psychology.bias_reason}`,
    fundamental_context: ev.fundamental ?? "no fundamental context configured",
    data_timestamp: ev.data_timestamp,
    provider: "heuristic",
    model: "heuristic-v1",
    latency_ms: 0,
    status: "ok",
  };
}

function resolveHeuristicDirection(mtf: MtfResult): "long" | "short" | "neutral" {
  if (mtf.verdict === "ALIGNED" && mtf.macro_bias !== "neutral") return mtf.macro_bias === "long" ? "long" : "short";
  if (mtf.verdict === "PARTIAL") return "neutral"; // partial = wait, no assertion
  return "neutral";
}

function deterministicScore(mtf: MtfResult): number {
  // deterministic composite, NOT calibrated probability (master §11)
  if (mtf.verdict === "ALIGNED") return 62;
  if (mtf.verdict === "PARTIAL") return 48;
  if (mtf.verdict === "CONFLICT") return 25;
  return 0;
}

function heuristicThesis(mtf: MtfResult, psych: PsychologySummary): string {
  if (mtf.verdict === "ALIGNED" && mtf.macro_bias !== "neutral") {
    return `All core timeframes aligned ${mtf.macro_bias}. Psychology neutral; liquidation metrics unavailable — no crowding assertion.`;
  }
  return `Timeframes not aligned (${mtf.verdict}: ${mtf.reason}). Psychology bias neutral (${psych.bias_reason}). No opportunity asserted.`;
}

function fmt(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v > 100 ? v.toFixed(1) : v.toFixed(2);
}

/* ------------------------------------------------------------- router */
const LLM_TIMEOUT_MS = 60_000;

export async function runAi(ev: AiEvidence, mode: AiMode = AI_DEFAULT_PROVIDER): Promise<AiResult> {
  eventBus.emit("ai.state", { state: "RUNNING", provider: mode });
  const started = Date.now();
  const attempts: { provider: string; online: boolean }[] = [];

  // deterministic fallback always available
  const fallback = (): AiResult => {
    const r = heuristicAnalyze(ev);
    return { provider_used: "heuristic", model: "heuristic-v1", label: "HEURISTIC MODE · NOT AN LLM", response: r, error: null };
  };

  const tryLlm = async (kind: "ollama" | "openai"): Promise<AiResult | null> => {
    const base = kind === "ollama" ? OLLAMA_URL.replace(/\/+$/, "") : OPENAI_BASE_URL.replace(/\/+$/, "");
    const key = kind === "openai" ? OPENAI_API_KEY : "";
    const model = kind === "ollama" ? AI_OLLAMA_MODEL : AI_OPENAI_MODEL;
    const online = await probeProvider(kind);
    attempts.push({ provider: kind, online });
    if (!online) return null;
    const url = `${base}/chat/completions`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    try {
      // The schema MUST be stated explicitly: `response_format: json_object`
      // only guarantees valid JSON, not the shape. Without this, providers
      // legitimately return `{}` and we would report an empty analysis.
      const sys = [
        "You are AsA, an advisory crypto analysis assistant.",
        "You reason ONLY over the evidence object supplied by the user message.",
        "Never invent metrics, prices, or levels that are not present in the evidence.",
        "If the evidence does not support a directional stance, answer with direction \"neutral\" and explain why — that is a valid, expected answer.",
        "AsA is advisory only and never executes trades; never phrase output as an instruction to place an order.",
        "Reply with a single JSON object using EXACTLY these keys:",
        '{"direction":"long|short|neutral|reject","score":0-100,"confidence":0-100,',
        '"summary":"one sentence","thesis":"2-4 sentences","market_story":"how the timeframes line up",',
        '"setup_quality":"high|medium|low|none","invalidation":"what would falsify this",',
        '"confluences":["..."],"contradictions":["..."],"risks":["..."],"evidence":["cite the evidence fields you used"],',
        '"missing_data":["..."],"risk_notes":["..."],"strategy_alignment":"...","psychology_context":"...","fundamental_context":"..."}',
        "Every string field must be non-empty. score is a deterministic-style score, NOT a probability.",
      ].join(" ");
      const user = JSON.stringify({ task: "structure_analysis", symbol: ev.symbol, timeframe: ev.timeframe, evidence: serializeEvidence(ev) });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`provider HTTP ${res.status} ${txt.slice(0, 120)}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("empty completion");
      const parsed = JSON.parse(content) as unknown;
      const latency = Date.now() - started;
      const coerced = coerceAiResponse(parsed, kind, model, latency, "neutral");
      if (!coerced) throw new Error("structured output failed validation");
      // Guard against a syntactically valid but substantively empty answer
      // (e.g. "{}"): reporting that as an LLM analysis would be dishonest.
      if (!coerced.summary.trim() && !coerced.thesis.trim() && coerced.evidence.length === 0) {
        throw new Error("provider returned an empty analysis (no summary/thesis/evidence)");
      }
      // enforce deterministic hard rules (master §57 / ai-ext):
      if (ev.risk?.verdict === "block") coerced.direction = "reject";
      if (ev.macro && ev.macro.bars < 100) coerced.direction = "neutral";
      const rawAnn = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).annotations : undefined;
      const annList = Array.isArray(rawAnn) ? (rawAnn as unknown[]) : [];
      const geo = validateAnnotations(annList, ev.window);
      coerced.annotations = geo.kept;
      if (geo.dropped > 0) coerced.contradictions.push(`annotation geometry: ${geo.dropped} dropped outside window`);
      return { provider_used: kind, model, label: kind === "ollama" ? "OLLAMA" : "OPENAI", response: coerced, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { provider_used: kind, model, label: "HEURISTIC FALLBACK · LLM FAILED", response: heuristicAnalyze(ev), error: msg };
    } finally {
      clearTimeout(timer);
    }
  };

  let result: AiResult;
  if (mode === "ollama") result = (await tryLlm("ollama")) ?? fallback();
  else if (mode === "openai") result = (await tryLlm("openai")) ?? fallback();
  else if (mode === "heuristic") result = fallback();
  else {
    // auto: local -> cloud -> heuristic
    result = (await tryLlm("ollama")) ?? (await tryLlm("openai")) ?? fallback();
  }
  eventBus.emit("ai.state", { state: "IDLE", provider: result.provider_used });
  return result;
}

function serializeEvidence(ev: AiEvidence): unknown {
  return {
    symbol: ev.symbol,
    timeframe: ev.timeframe,
    mtf: { verdict: ev.mtf.verdict, macro_bias: ev.mtf.macro_bias, context_bias: ev.mtf.context_bias, trigger_bias: ev.mtf.trigger_bias, reason: ev.mtf.reason },
    macro: bundleSlice(ev.macro),
    context: bundleSlice(ev.context),
    trigger: bundleSlice(ev.trigger),
    psychology: { bias: ev.psychology.bias, sections: ev.psychology.sections.map((s) => ({ key: s.key, state: s.state, verdict: s.verdict, value: s.value, reason: s.reason })) },
    risk: ev.risk,
    strategy: ev.strategy,
    fundamental: ev.fundamental,
  };
}

function bundleSlice(b: AnalysisBundle | null): unknown {
  if (!b) return null;
  return {
    bars: b.bars,
    last_close: b.last_close,
    indicators: b.indicators,
    structure: { trend: b.structure.trend, reason: b.structure.reason, last_bos: b.structure.last_bos, last_choch: b.structure.last_choch, sr_levels: b.structure.sr_levels.slice(0, 4), last_swing_high: b.structure.last_swing_high, last_swing_low: b.structure.last_swing_low },
    stats: b.stats,
  };
}

/* ---------------------------------------------------------------- health */
export interface ProbeResult {
  state: AiHealthState;
  online: boolean;
  latency_ms: number | null;
  models_count: number | null;
  model_available: boolean | null;
  probed_at_ms: number;
  error: string | null;
}

const probeCache = new Map<string, ProbeResult>();
const PROBE_TTL_MS = 15_000;

function providerConfig(id: "ollama" | "openai"): { base: string; key: string; model: string } {
  return id === "ollama"
    ? { base: OLLAMA_URL.replace(/\/+$/, ""), key: "", model: AI_OLLAMA_MODEL }
    : { base: OPENAI_BASE_URL.replace(/\/+$/, ""), key: OPENAI_API_KEY, model: AI_OPENAI_MODEL };
}

function isConfigured(id: "ollama" | "openai"): boolean {
  const { base, key } = providerConfig(id);
  return id === "ollama" ? base.length > 0 : base.length > 0 && key.length > 0;
}

/**
 * Real network probe: list the provider catalogue and check the configured
 * model is actually offered. No claim is made without a measured response.
 * Secrets are only used to build the Authorization header — never returned.
 */
export async function probeProviderDetailed(id: "ollama" | "openai"): Promise<ProbeResult> {
  const cached = probeCache.get(id);
  if (cached && Date.now() - cached.probed_at_ms < PROBE_TTL_MS) return cached;

  const { base, key, model } = providerConfig(id);
  if (!isConfigured(id)) {
    const r: ProbeResult = { state: "NOT_CONFIGURED", online: false, latency_ms: null, models_count: null, model_available: null, probed_at_ms: Date.now(), error: null };
    probeCache.set(id, r);
    return r;
  }

  // Ollama exposes the OpenAI-compat surface under /v1; OPENAI_BASE_URL already includes it.
  const url = id === "ollama" ? `${base}/v1/models` : `${base}/models`;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: ctrl.signal,
      cache: "no-store",
    });
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      const r: ProbeResult = { state: "ERROR", online: false, latency_ms, models_count: null, model_available: null, probed_at_ms: Date.now(), error: `catalogue HTTP ${res.status}` };
      probeCache.set(id, r);
      return r;
    }
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = Array.isArray(body.data) ? body.data.map((m) => String(m?.id ?? "")) : [];
    const model_available = ids.length > 0 ? ids.includes(model) : null;
    const r: ProbeResult = {
      state: model_available === false ? "DEGRADED" : "ONLINE",
      online: true,
      latency_ms,
      models_count: ids.length,
      model_available,
      probed_at_ms: Date.now(),
      error: model_available === false ? `configured model "${model}" not in provider catalogue (${ids.length} models offered)` : null,
    };
    probeCache.set(id, r);
    return r;
  } catch (err) {
    const msg = err instanceof Error ? (err.name === "AbortError" ? "probe timeout after 6000ms" : err.message) : String(err);
    const r: ProbeResult = { state: "ERROR", online: false, latency_ms: Date.now() - started, models_count: null, model_available: null, probed_at_ms: Date.now(), error: msg };
    probeCache.set(id, r);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

/** Boolean shim kept for existing call sites (router gating). */
export async function probeProvider(id: "ollama" | "openai"): Promise<boolean> {
  return (await probeProviderDetailed(id)).online;
}

export async function providerStatuses(): Promise<ProviderStatusRow[]> {
  const [ollama, openai] = await Promise.all([probeProviderDetailed("ollama"), probeProviderDetailed("openai")]);
  const row = (id: "ollama" | "openai", p: ProbeResult): ProviderStatusRow => ({
    id,
    configured: isConfigured(id),
    online: p.state === "NOT_CONFIGURED" ? null : p.online,
    state: p.state,
    latency_ms: p.latency_ms,
    model: isConfigured(id) ? providerConfig(id).model : null,
    model_available: p.model_available,
    models_count: p.models_count,
    probed_at_ms: p.state === "NOT_CONFIGURED" ? null : p.probed_at_ms,
    error: p.error,
  });
  return [
    { id: "heuristic", configured: true, online: true, state: "ONLINE", latency_ms: 0, model: "heuristic-v1", model_available: true, models_count: 1, probed_at_ms: Date.now(), error: null },
    row("ollama", ollama),
    row("openai", openai),
  ];
}
