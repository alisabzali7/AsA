/**
 * POST /api/research/backtest — deterministic run over TTT (or fixture)
 * 15m candles using the SAME strategy definition as live. Job stored
 * durably; result carries full lineage. Never claims profitability.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { ensureEngineBooted } from "@/lib/state";
import { getHistoryStore, syncHistory, type SyncResult } from "@/lib/market/history-store";
import { describeFreshSync } from "@/lib/backtest/data-freshness";
import type { TimeframeId } from "@/lib/domain/timeframes";
import { getRepo } from "@/db/sqlite";
import { guardMutation, readBody } from "@/lib/api-common";
import { isOperationalSymbol } from "@/lib/market/operational-universe";
import { runBacktest, type BacktestInput } from "@/lib/backtest/engine";
import { getRuntimeStrategy } from "@/lib/strategy/runtime";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;
  const { body, error } = await readBody(req);
  if (error) return error;
  const strategyId = typeof body.strategyId === "string" ? body.strategyId : "";
  const strat = getRuntimeStrategy(strategyId);
  if (!strat) return NextResponse.json({ ok: false, error: `unknown strategy ${strategyId}` }, { status: 400 });
  if (!strat.impl) {
    return NextResponse.json(
      { ok: false, error: `strategy ${strategyId} is ${strat.availability}`, reason: strat.blocked_reason },
      { status: 409 },
    );
  }
  const rawSym = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "BTCUSDT";
  if (!isOperationalSymbol(rawSym)) return NextResponse.json({ ok: false, error: "symbol not in the operational TTT universe" }, { status: 400 });
  const sameBarPolicy = body.sameBarPolicy === "target_first" ? "target_first" : "stop_first";
  // AUDIT FIX (P0-7): the previous code accepted `dataMode: "fixture"` from the
  // body while ALWAYS reading candles from the TTT history store — the lineage
  // could claim "fixture" over TTT data. The data mode is now fixed to what the
  // route actually does: TTT stored history.
  const dataMode = "ttt" as const;

  try {
    await ensureEngineBooted();
  } catch {
    /* degraded — surfaced through the data-freshness contract below */
  }
  // Use the STRATEGY'S OWN timeframe — never a hard-coded 15m for everything.
  const tf = strat.timeframe as TimeframeId;
  // History comes from the SHARED TTT history manager (remediation §16): the
  // same chunked, boundary-aware loader the chart and scanner use. There is no
  // 5000-bar ceiling — `days` selects a RANGE, not a bar cap, and omitting it
  // uses everything stored back to the TTT boundary.
  const days = typeof body.days === "number" ? Math.max(1, Math.floor(body.days)) : undefined;

  // AUDIT FIX (P0-7): a failed fresh sync is NO LONGER swallowed. The run may
  // proceed on previously stored TTT history, but the result explicitly says
  // so via the data-freshness contract (see lib/backtest/data-freshness.ts).
  let syncOutcome: SyncResult | null = null;
  let syncError: unknown = null;
  try {
    syncOutcome = await syncHistory(rawSym, tf, { full: true });
  } catch (err) {
    syncError = err;
  }
  const freshness = describeFreshSync(syncOutcome, syncError);

  const store = getHistoryStore();
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = days !== undefined ? nowSec - days * 86400 : undefined;
  const candles = store.get(rawSym, tf, fromSec);
  const syncRow = store.syncRow(rawSym, tf);

  const needed = strat.min_bars + 20;
  if (candles.length < needed) {
    return NextResponse.json(
      {
        ok: false,
        error: `insufficient ${strat.timeframe} candles for backtest (need >= ${needed} closed, have ${candles.length})`,
        earliest_available: store.bounds(rawSym, tf).earliest,
        completion_state: syncRow?.completion_state ?? "NOT_SYNCED",
        fresh_sync_status: freshness.fresh_sync_status,
        fresh_sync_error: freshness.fresh_sync_error,
      },
      { status: 409 },
    );
  }
  const series = { candles, native: true, fetched_at_ms: Date.now() };
  const requestedRangeNote =
    syncRow?.completion_state === "GAPPED"
      ? `history contains ${syncRow.gap_count} genuine venue gap(s); no candle was fabricated`
      : null;
  const input: BacktestInput = {
    strategyId,
    symbol: rawSym,
    candles: series.candles,
    dataMode,
    dataFreshness: freshness,
    sameBarPolicy,
    warningsSeed: requestedRangeNote ? [requestedRangeNote] : undefined,
    feeRoundTripPct: typeof body.feeRoundTripPct === "number" ? body.feeRoundTripPct : undefined,
    slippagePct: typeof body.slippagePct === "number" ? body.slippagePct : undefined,
    accountEquity: typeof body.accountEquity === "number" ? body.accountEquity : undefined,
  };
  const jobId = `bt-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const repo = getRepo();
  repo.backtestCreate({
    id: jobId,
    created_ms: Date.now(),
    status: "running",
    symbol: rawSym,
    timeframe: strat.timeframe,
    strategy_id: strategyId,
    params_json: JSON.stringify({ days, sameBarPolicy, dataMode, fresh_sync_status: freshness.fresh_sync_status }),
    result_json: null,
    error: null,
  });
  try {
    // Exits already carry ABSOLUTE timestamps from the shared runner, so the
    // old slice-index -> timestamp remapping step is gone entirely.
    const result = runBacktest(input);
    repo.backtestUpdate(jobId, result.ok ? "done" : "error", JSON.stringify(result), result.ok ? null : (result.error ?? "unknown"));
    return NextResponse.json({
      ok: true, jobId, status: result.ok ? "done" : "error",
      data_freshness: {
        fresh_sync_status: freshness.fresh_sync_status,
        fresh_sync_error: freshness.fresh_sync_error,
        last_successful_sync_ms: freshness.last_successful_sync_ms,
        used_stored_data_after_failed_sync: freshness.used_stored_data_after_failed_sync,
      },
      result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    repo.backtestUpdate(jobId, "error", null, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
