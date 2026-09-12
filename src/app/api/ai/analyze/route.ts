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
  const provider = typeof body.provider === "string" ? body.provider : getAiProviderPref();

  try {
    await ensureEngineBooted();
  } catch {
    /* degraded */
  }
  const symbol = symbolRaw as never;
  const stats = sharedStore.getStats(symbol as string);
  const [m4, h1, m15] = await Promise.all([
    candleManager.ensureSeries(symbol as never, "4h"),
    candleManager.ensureSeries(symbol as never, "1h"),
    candleManager.ensureSeries(symbol as never, "15m"),
  ]);
  const mk = (s: typeof m4, t: string) =>
    s && s.candles.length ? buildBundle({ symbol: symbol as string, timeframe: t, candles: s.candles, stats, seriesProvenance: { fetched_at_ms: s.fetched_at_ms, native: s.native, derived_source_tf: s.derived_source_tf } }) : null;
  const macro = mk(m4, "4h");
  const context = mk(h1, "1h");
  const trigger = mk(m15, "15m");
  if (!trigger) {
    return NextResponse.json({ ok: false, error: "insufficient candle data to analyze yet (backfill in progress)" }, { status: 409 });
  }
  const mtf = buildMtf(macro, context, trigger);
  const psychology = buildPsychology(symbol as string);
  const fundamental = getNewsContext(symbol as string);
  const evidence: AiEvidence = {
    symbol: symbol as string,
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
  const result = await runAi(evidence, provider as never);
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
