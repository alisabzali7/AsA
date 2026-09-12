/**
 * POST /api/research/backtest — deterministic run over TTT (or fixture)
 * 15m candles using the SAME strategy definition as live. Job stored
 * durably; result carries full lineage. Never claims profitability.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { ensureEngineBooted } from "@/lib/state";
import { getHistoryStore, syncHistory } from "@/lib/market/history-store";
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
  const dataMode = body.dataMode === "fixture" ? "fixture" : "ttt";
  const sameBarPolicy = body.sameBarPolicy === "target_first" ? "target_first" : "stop_first";

  try {
    await ensureEngineBooted();
  } catch {
    /* degraded */
  }
  // Use the STRATEGY'S OWN timeframe — never a hard-coded 15m for everything.
  const tf = strat.timeframe as TimeframeId;
  // History comes from the SHARED TTT history manager (remediation §16): the
  // same chunked, boundary-aware loader the chart and scanner use. There is no
  // 5000-bar ceiling — `days` selects a RANGE, not a bar cap, and omitting it
  // uses everything stored back to the TTT boundary.
  const days = typeof body.days === "number" ? Math.max(1, Math.floor(body.days)) : undefined;
  await syncHistory(rawSym, tf, { full: true }).catch(() => undefined);

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
    params_json: JSON.stringify({ days, sameBarPolicy, dataMode }),
    result_json: null,
    error: null,
  });
  try {
    // Exits already carry ABSOLUTE timestamps from the shared runner, so the
    // old slice-index -> timestamp remapping step is gone entirely.
    const result = runBacktest(input);
    repo.backtestUpdate(jobId, result.ok ? "done" : "error", JSON.stringify(result), result.ok ? null : (result.error ?? "unknown"));
    return NextResponse.json({ ok: true, jobId, status: result.ok ? "done" : "error", result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    repo.backtestUpdate(jobId, "error", null, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
