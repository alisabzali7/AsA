/**
 * GET /api/market/candles?symbol=BTCUSDT&tf=15m&limit=700[&focus=1]
 *
 * `limit` is a TRANSPORT window for the live board/chart, NOT a historical
 * ceiling. Full-range history is served by /api/market/history, which walks to
 * the TTT boundary and is backed by the durable history store.
 * Real TTT candles only. Native 1D preferred; a labeled DERIVED 1D flag is
 * returned when (and only when) the 8h fallback was actually used.
 */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { candleManager } from "@/lib/market/candles";
import { sharedStore } from "@/lib/market/store";
import { sym, tff, intParam, jsonError } from "@/lib/api-common";
import { getTimeframe } from "@/lib/domain/timeframes";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try {
    await ensureEngineBooted();
  } catch {
    /* fall through; fetch may still work */
  }
  const url = new URL(req.url);
  const { symbol, error: symErr } = sym(url.searchParams, "symbol", "BTCUSDT");
  if (symErr) return symErr;
  const { tf, error: tfErr } = tff(url.searchParams, "tf", "15m");
  if (tfErr || !tf) return tfErr ?? jsonError("unsupported timeframe");
  // transport window only; see /api/market/history for full-range traversal
  const limit = intParam(url.searchParams, "limit", 700, 50, 5000);
  const force = url.searchParams.get("refresh") === "1";

  try {
    const series = await candleManager.ensureSeries(symbol as string, tf, force);
    if (!series || series.candles.length === 0) {
      const cov = sharedStore.coverageRow(symbol as string, tf as string);
      return NextResponse.json({
        ok: true,
        series: null,
        reason: cov?.reason ?? "no candles yet (backfill in progress within the TTT rate budget)",
        status: cov?.status ?? "PENDING",
      });
    }
    const spec = getTimeframe(tf as string)!;
    const candles = series.candles.slice(-limit);
    const coverage = sharedStore.coverageRow(symbol as string, tf as string);
    const forming = sharedStore.getStats(symbol as string);
    return NextResponse.json({
      ok: true,
      symbol,
      timeframe: tf,
      bars: candles.length,
      closed_count: candles.length,
      candles,
      native: series.native,
      provenance: series.native ? "NATIVE" : "DERIVED",
      derived_source_tf: series.derived_source_tf ?? null,
      source: "ttt",
      endpoint: series.native ? "/futures/udf/history" : "/futures/udf/history (480 → derived 1D fallback)",
      fetched_at_ms: series.fetched_at_ms,
      age_ms: Date.now() - series.fetched_at_ms,
      coverage,
      forming_price: forming?.lastPrice ?? null,
      target_bars: spec.backfillTarget,
      tf_label: tf,
      ts: Date.now(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(msg, 502, { symbol, timeframe: tf, endpoint: "/futures/udf/history" });
  }
}
