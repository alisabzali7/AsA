/** GET /api/analysis/[symbol]/[tf] — deterministic intelligence bundle. */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { loadTf } from "@/lib/analysis/load";
import { isOperationalSymbol, universeMeta } from "@/lib/market/operational-universe";
import { isTimeframe } from "@/lib/domain/timeframes";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string; tf: string }> }): Promise<NextResponse> {
  const { symbol: rawSym, tf } = await ctx.params;
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
  if (!isTimeframe(tf)) return NextResponse.json({ ok: false, error: `unsupported timeframe '${tf}'` }, { status: 400 });
  const loaded = await loadTf(symbol, tf);
  const input = loaded.input;
  const meta = {
    closed_bars: input.closed_bars, freshness: input.freshness, source_ts_ms: input.source_ts_ms,
    data_age_ms: input.data_age_ms, forming_bar_excluded: input.forming_bar_excluded,
    native: input.native, derived_source_tf: input.derived_source_tf ?? null, reason: input.reason ?? null,
  };
  if (loaded.error !== null) {
    // venue failure is an outage (502), never an "empty" success
    return NextResponse.json({ ok: false, available: false, error: `TTT candle history unavailable: ${loaded.error}`, input: meta }, { status: 502 });
  }
  if (!loaded.bundle) {
    return NextResponse.json({ ok: true, available: false, reason: input.reason ?? "no closed candles available yet (backfill in progress)", input: meta });
  }
  return NextResponse.json({ ok: true, available: true, bundle: loaded.bundle, input: meta });
}
