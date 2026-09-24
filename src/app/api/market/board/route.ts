/**
 * GET /api/market/board — the market board over the DYNAMIC discovered
 * universe, with the metrics that are actually measurable per symbol
 * (price/24h/volume/funding/OI/mark…) plus per-metric truth flags. One bounded
 * pass over cached state; never per-symbol deep requests. Focus-symbol deep
 * metrics come from their own lanes.
 */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { sharedStore, statsRowState } from "@/lib/market/store";
import { operationalUniverse, universeMeta } from "@/lib/market/operational-universe";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    await ensureEngineBooted();
  } catch {
    /* degraded board: reported through universe state below */
  }
  const meta = universeMeta();
  if (!meta.discovery_complete) {
    return NextResponse.json({
      ok: false,
      source: "ttt",
      state: meta.state,
      error: `TTT discovery is ${meta.state}; market board is not ready`,
      last_error: meta.last_error,
      rows: [],
      stats_age_ms: null,
      universe: meta,
      ts: Date.now(),
    }, { status: 503 });
  }
  const now = Date.now();
  const focus = sharedStore.focusSymbol;
  const rows = [];
  for (const symbol of operationalUniverse()) {
    const s = sharedStore.getStats(symbol);
    const meta = sharedStore.catalog.get(symbol);
    const age = s ? now - s.provenance.fetched_at_ms : null;
    const truth = (m: string) => sharedStore.metricTruth(symbol, m);
    rows.push({
      symbol,
      price: s?.lastPrice ?? null,
      change24hPct: s?.change24hPct ?? null,
      volume24hQuote: s?.volume24hQuote ?? null,
      fundingRate: s?.fundingRate ?? null,
      openInterest: s?.openInterest ?? null,
      markPrice: s?.markPrice ?? null,
      indexPrice: s?.indexPrice ?? null,
      age_ms: age,
      state: age === null ? "CONNECTING" : age >= 300_000 ? "DEGRADED" : age >= 60_000 ? "STALE" : statsRowState(s!, now).state === "STALE" ? "STALE" : "LIVE",
      source_ts_ms: s?.provenance.source_ts_ms ?? null,
      source_age_ms: s && typeof s.provenance.source_ts_ms === "number" ? now - s.provenance.source_ts_ms : null,
      state_reason: s ? statsRowState(s, now).reason ?? null : "no stats measurement yet",
      t: {
        price: truth("last_price"),
        funding: truth("funding"),
        oi: truth("open_interest"),
        mark: truth("mark_price"),
        index: truth("index_price"),
      },
      tick_size: meta?.tickSize ?? null,
      max_leverage: meta?.maxLeverage ?? null,
      focus: symbol === focus,
    });
  }
  return NextResponse.json({
    ok: true,
    source: "ttt",
    endpoint: "/futures/markets/stats",
    stats_age_ms: sharedStore.lastStatsSweepAtMs === null ? null : now - sharedStore.lastStatsSweepAtMs,
    universe: meta,
    focus,
    rows,
    ts: now,
  });
}
