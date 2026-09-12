/** GET /api/analysis/[symbol]/[tf] — deterministic intelligence bundle. */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { candleManager } from "@/lib/market/candles";
import { sharedStore } from "@/lib/market/store";
import { buildBundle } from "@/lib/analysis/bundle";
import { isOperationalSymbol } from "@/lib/market/operational-universe";
import { isTimeframe } from "@/lib/domain/timeframes";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string; tf: string }> }): Promise<NextResponse> {
  const { symbol: rawSym, tf } = await ctx.params;
  const symbol = rawSym.toUpperCase();
  if (!isOperationalSymbol(symbol)) return NextResponse.json({ ok: false, error: `'${symbol}' not in the operational TTT universe` }, { status: 400 });
  if (!isTimeframe(tf)) return NextResponse.json({ ok: false, error: `unsupported timeframe '${tf}'` }, { status: 400 });
  try {
    await ensureEngineBooted();
  } catch {
    /* degraded path */
  }
  const series = await candleManager.ensureSeries(symbol, tf);
  if (!series || series.candles.length === 0) {
    return NextResponse.json({ ok: true, available: false, reason: "candles not available yet (backfill in progress)" });
  }
  const stats = sharedStore.getStats(symbol);
  const bundle = buildBundle({ symbol, timeframe: tf, candles: series.candles, stats, seriesProvenance: { fetched_at_ms: series.fetched_at_ms, native: series.native, derived_source_tf: series.derived_source_tf } });
  return NextResponse.json({ ok: true, bundle });
}
