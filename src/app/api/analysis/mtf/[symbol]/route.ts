/**
 * GET /api/analysis/mtf/[symbol] — 4H macro / 1H context / 15M trigger with
 * explicit alignment (ALIGNED/PARTIAL/CONFLICT/INSUFFICIENT).
 */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { loadMtf } from "@/lib/analysis/load";
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
  const { mtf, parts } = await loadMtf(symbol);
  const [m4, h1, m15] = parts;
  const macro = m4.bundle, context = h1.bundle, trigger = m15.bundle;
  const psychology = buildPsychology(symbol);
  const inputs = parts.map((p) => ({ timeframe: p.timeframe, closed_bars: p.input.closed_bars, freshness: p.input.freshness, source_ts_ms: p.input.source_ts_ms, data_age_ms: p.input.data_age_ms, forming_bar_excluded: p.input.forming_bar_excluded, native: p.input.native, reason: p.input.reason ?? null, error: p.error }));
  // every component failed at the venue: an outage, not an analysis
  if (parts.every((p) => p.error !== null)) {
    return NextResponse.json({ ok: false, symbol, error: "TTT candle history unavailable for all core timeframes", mtf, inputs }, { status: 502 });
  }
  return NextResponse.json({ ok: true, symbol, mtf, psychology, macro, context, trigger, inputs });
}
