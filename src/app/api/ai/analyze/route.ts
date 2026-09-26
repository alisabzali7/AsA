/**
 * POST /api/ai/analyze {symbol, timeframe, provider?} — structured AI read
 * over deterministic evidence. Risk BLOCK forces reject; AI can never
 * override risk. Result is persisted to the ai_calls audit table.
 */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { loadMtf } from "@/lib/analysis/load";
import { buildPsychology } from "@/lib/psychology/engine";
import { runAi, analyzedTimeframes, type AiEvidence } from "@/lib/ai";
import type { AiMode } from "@/lib/env";
import { guardMutation, readBody } from "@/lib/api-common";
import { isOperationalSymbol, universeMeta } from "@/lib/market/operational-universe";
import { isTimeframe } from "@/lib/domain/timeframes";
import { getRepo } from "@/db/sqlite";
import { getNewsContext } from "@/lib/fundamental/context";
import { getAiProviderPref } from "@/lib/prefs";
import { inputErrorClass } from "@/lib/analysis/errors";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { body, error } = await readBody(req);
  if (error) return error;
  const symbolRaw = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "BTCUSDT";
  const tf = typeof body.timeframe === "string" ? body.timeframe : "15m";
  try {
    await ensureEngineBooted();
  } catch {
    /* degraded; validation below may return NOT_READY */
  }
  if (!isOperationalSymbol(symbolRaw)) {
    const meta = universeMeta();
    return NextResponse.json({ ok: false, error: `'${symbolRaw}' not in the operational TTT universe`, universe: meta }, { status: meta.discovery_complete ? 400 : 503 });
  }
  if (!isTimeframe(tf)) return NextResponse.json({ ok: false, error: `bad timeframe ${tf}` }, { status: 400 });
  // AUDIT FIX (P1): the provider string is VALIDATED instead of `as never` —
  // an unknown provider must be rejected, not coerced.
  const providerRaw = typeof body.provider === "string" ? body.provider : getAiProviderPref();
  if (providerRaw !== "auto" && providerRaw !== "heuristic" && providerRaw !== "ollama" && providerRaw !== "openai") {
    return NextResponse.json({ ok: false, error: `provider must be auto|heuristic|ollama|openai (got '${providerRaw}')` }, { status: 400 });
  }
  const provider: AiMode = providerRaw;

  // AUDIT FIX (P1): removed the `as never` casts. The symbol is a validated
  // plain string (the operational universe is dynamic — no compile-time union),
  // and the core timeframes are statically known TimeframeIds.
  const symbol = symbolRaw;
  const { mtf, parts } = await loadMtf(symbol);
  const macro = parts[0].bundle, context = parts[1].bundle, trigger = parts[2].bundle;
  if (!trigger || !trigger.candle_window) {
    const trig = parts[2];
    const error_class = inputErrorClass(trig.input, trig.error) ?? "NO_DATA";
    return NextResponse.json({ ok: false, error_class, error: trig.input.reason ?? "insufficient candle data to analyze yet (backfill in progress)" }, { status: error_class === "UPSTREAM_FAILURE" ? 502 : 409 });
  }
  const window = trigger.candle_window;
  const psychology = buildPsychology(symbol);
  const fundamental = getNewsContext(symbol);
  const evidence: AiEvidence = {
    symbol,
    timeframe: tf,
    mtf,
    macro,
    context,
    trigger,
    psychology,
    risk: null,
    strategy: null,
    fundamental,
    // SOURCE timestamp of the evidence (oldest component close), not compute
    // time; null when unknown — never backfilled with Date.now() (Task 09)
    data_timestamp: mtf.oldest_source_ts_ms ?? trigger.provenance.source_ts_ms ?? null,
    window,
  };
  const result = await runAi(evidence, provider);
  // persist audit row (no secrets; no chain-of-thought)
  getRepo().aiCallInsert({
    created_ms: Date.now(),
    provider: result.provider_used,
    model: result.model,
    latency_ms: result.response.latency_ms || null,
    verdict: result.response.direction,
    structured_json: JSON.stringify(result.response),
    error: result.error,
  });
  return NextResponse.json({ ok: true, symbol, timeframe: tf, requested_timeframe: tf, analyzed_timeframes: analyzedTimeframes(), mtf_as_of_ms: mtf.as_of_ms, ...result });
}
