/**
 * GET /api/analysis/mtf/[symbol] — 4H macro / 1H context / 15M trigger with
 * explicit alignment (ALIGNED/PARTIAL/CONFLICT/INSUFFICIENT).
 */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { candleManager } from "@/lib/market/candles";
import { sharedStore } from "@/lib/market/store";
import { buildBundle } from "@/lib/analysis/bundle";
import { buildMtf } from "@/lib/analysis/mtf";
import { buildPsychology } from "@/lib/psychology/engine";
import { isOperationalSymbol, universeMeta } from "@/lib/market/operational-universe";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string }> }): Promise<NextResponse> {
  const { symbol: rawSym } = await ctx.params;
  const symbol = rawSym.toUpperCase();
  try {
    await ensureEngineBooted();
  } catch {
    /* degraded path; validation below may return NOT_READY */
  }
  if (!isOperationalSymbol(symbol)) {
    const meta = universeMeta();
    return NextResponse.json({ ok: false, error: `'${symbol}' not in the operational TTT universe`, universe: meta }, { status: meta.discovery_complete ? 400 : 503 });
  }
  const stats = sharedStore.getStats(symbol);
  const [m4, h1, m15] = await Promise.all([
    candleManager.ensureSeries(symbol, "4h"),
    candleManager.ensureSeries(symbol, "1h"),
    candleManager.ensureSeries(symbol, "15m"),
  ]);
  const bundle = (series: typeof m4, tf: string) =>
    series && series.candles.length
      ? buildBundle({ symbol, timeframe: tf, candles: series.candles, stats, seriesProvenance: { fetched_at_ms: series.fetched_at_ms, native: series.native, derived_source_tf: series.derived_source_tf } })
      : null;
  const macro = bundle(m4, "4h");
  const context = bundle(h1, "1h");
  const trigger = bundle(m15, "15m");
  const mtf = buildMtf(macro, context, trigger);
  const psychology = buildPsychology(symbol);
  return NextResponse.json({ ok: true, symbol, mtf, psychology, macro, context, trigger });
}
