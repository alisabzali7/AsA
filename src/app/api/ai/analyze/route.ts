/**
 * POST /api/ai/analyze {symbol, timeframe, provider?} — structured AI read
 * over deterministic evidence. Risk BLOCK forces reject; AI can never
 * override risk. Result is persisted to the ai_calls audit table.
 */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { candleManager } from "@/lib/market/candles";
import { sharedStore } from "@/lib/market/store";
import { buildBundle } from "@/lib/analysis/bundle";
import { buildMtf } from "@/lib/analysis/mtf";
import { buildPsychology } from "@/lib/psychology/engine";
import { runAi, type AiEvidence } from "@/lib/ai";
import type { AiMode } from "@/lib/env";
import { guardMutation, readBody } from "@/lib/api-common";
import { isOperationalSymbol } from "@/lib/market/operational-universe";
import { isTimeframe } from "@/lib/domain/timeframes";
import { getRepo } from "@/db/sqlite";
import { getNewsContext } from "@/lib/fundamental/context";
import { getAiProviderPref } from "@/lib/prefs";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { body, error } = await readBody(req);
  if (error) return error;
  const symbolRaw = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "BTCUSDT";
  const tf = typeof body.timeframe === "string" ? body.timeframe : "15m";
  if (!isOperationalSymbol(symbolRaw)) return NextResponse.json({ ok: false, error: `'${symbolRaw}' not in the operational TTT universe` }, { status: 400 });
  if (!isTimeframe(tf)) return NextResponse.json({ ok: false, error: `bad timeframe ${tf}` }, { status: 400 });
  // AUDIT FIX (P1): the provider string is VALIDATED instead of `as never` —
  // an unknown provider must be rejected, not coerced.
  const providerRaw = typeof body.provider === "string" ? body.provider : getAiProviderPref();
  if (providerRaw !== "auto" && providerRaw !== "heuristic" && providerRaw !== "ollama" && providerRaw !== "openai") {
    return NextResponse.json({ ok: false, error: `provider must be auto|heuristic|ollama|openai (got '${providerRaw}')` }, { status: 400 });
  }
  const provider: AiMode = providerRaw;

  try {
    await ensureEngineBooted();
  } catch {
    /* degraded */
  }
  // AUDIT FIX (P1): removed the `as never` casts. The symbol is a validated
  // plain string (the operational universe is dynamic — no compile-time union),
  // and the core timeframes are statically known TimeframeIds.
  const symbol = symbolRaw;
  const stats = sharedStore.getStats(symbol);
  const [m4, h1, m15] = await Promise.all([
    candleManager.ensureSeries(symbol, "4h"),
    candleManager.ensureSeries(symbol, "1h"),
    candleManager.ensureSeries(symbol, "15m"),
  ]);
  const mk = (s: typeof m4, t: string) =>
    s && s.candles.length ? buildBundle({ symbol, timeframe: t, candles: s.candles, stats, seriesProvenance: { fetched_at_ms: s.fetched_at_ms, native: s.native, derived_source_tf: s.derived_source_tf } }) : null;
  const macro = mk(m4, "4h");
  const context = mk(h1, "1h");
  const trigger = mk(m15, "15m");
  if (!trigger) {
    return NextResponse.json({ ok: false, error: "insufficient candle data to analyze yet (backfill in progress)" }, { status: 409 });
  }
  const mtf = buildMtf(macro, context, trigger);
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
    data_timestamp: Date.now(),
    window: trigger.candle_window,
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
  return NextResponse.json({ ok: true, symbol, timeframe: tf, ...result });
}
