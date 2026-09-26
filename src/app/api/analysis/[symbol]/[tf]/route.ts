/** GET /api/analysis/[symbol]/[tf] — deterministic intelligence bundle. */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { loadTf } from "@/lib/analysis/load";
import { isOperationalSymbol, universeMeta } from "@/lib/market/operational-universe";
import { isTimeframe } from "@/lib/domain/timeframes";
import { buildChartOverlay } from "@/lib/chart/technical";
import { inputErrorClass, inputHttpStatus, insufficientHistory, internalErrorBody } from "@/lib/analysis/errors";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string; tf: string }> }): Promise<NextResponse> {
  try {
    return await handle(ctx);
  } catch (err) {
    // unexpected failure: typed 500, never an HTML error page or a fake empty success
    return NextResponse.json(internalErrorBody(err), { status: 500 });
  }
}

async function handle(ctx: { params: Promise<{ symbol: string; tf: string }> }): Promise<NextResponse> {
  const { symbol: rawSym, tf } = await ctx.params;
  const symbol = rawSym.toUpperCase();
  try {
    await ensureEngineBooted();
  } catch {
    /* degraded path; validation below may return NOT_READY */
  }
  if (!isOperationalSymbol(symbol)) {
    const meta = universeMeta();
    return NextResponse.json({ ok: false, error_class: meta.discovery_complete ? "INVALID_REQUEST" : "MARKET_SOURCE_UNAVAILABLE", error: `'${symbol}' not in the operational TTT universe`, universe: meta }, { status: meta.discovery_complete ? 400 : 503 });
  }
  if (!isTimeframe(tf)) return NextResponse.json({ ok: false, error_class: "INVALID_REQUEST", error: `unsupported timeframe '${tf}'` }, { status: 400 });
  const loaded = await loadTf(symbol, tf);
  const input = loaded.input;
  const meta = {
    closed_bars: input.closed_bars, freshness: input.freshness, source_ts_ms: input.source_ts_ms,
    data_age_ms: input.data_age_ms, forming_bar_excluded: input.forming_bar_excluded,
    native: input.native, derived_source_tf: input.derived_source_tf ?? null, reason: input.reason ?? null,
    reason_code: input.reason_code, last_closed_open_ts: input.last_closed_open_ts,
  };
  const error_class = inputErrorClass(input, loaded.error);
  // Absolute-final: one truthful status table (analysis/errors inputHttpStatus)
  const status = inputHttpStatus(input, loaded.error);
  if (loaded.error !== null) {
    // venue failure is an outage (502), never an "empty" success
    return NextResponse.json({ ok: false, available: false, error_class, error: `TTT candle history unavailable: ${loaded.error}`, input: meta }, { status });
  }
  if (status !== 200) {
    // IDENTITY_MISMATCH 500 (server fault) · INVALID_SERIES 502 (refused source
    // data) · SERIES_UNAVAILABLE 503 — chart-view usePoll surfaces error_class
    return NextResponse.json({ ok: false, available: false, error_class, error: input.reason ?? input.reason_code, input: meta }, { status });
  }
  if (!loaded.bundle) {
    // NO_CLOSED_BARS: a legitimate "not yet" state — 200 available:false
    return NextResponse.json({ ok: true, available: false, error_class, reason: input.reason ?? "no closed candles available yet (backfill in progress)", input: meta });
  }
  // overlay: the render-ready projection of the bundle — the chart draws it and computes nothing
  const warm = insufficientHistory(loaded.bundle);
  return NextResponse.json({
    ok: true, available: true, error_class: warm.length ? "INSUFFICIENT_HISTORY" : null, insufficient_history: warm,
    bundle: loaded.bundle, overlay: buildChartOverlay(loaded.bundle, loaded.series), input: meta,
  });
}
