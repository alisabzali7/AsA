/**
 * GET /api/market/matrix — the symbol × timeframe availability matrix
 * (remediation §13, §24).
 *
 * Generated dynamically from the discovered TTT catalog plus what the history
 * store has actually synced. A cell that has never been synced says so; it is
 * never presented as unsupported.
 *
 * Query: ?symbols=BTCUSDT,ETHUSDT  ?synced=1 (only cells with stored data)
 */
import { NextResponse } from "next/server";
import { discoverMarkets } from "@/lib/market/catalog";
import { getHistoryStore } from "@/lib/market/history-store";
import { TIMEFRAMES, type TimeframeId } from "@/lib/domain/timeframes";

export const dynamic = "force-dynamic";

/** The nine production resolutions required by the product. */
export const PRODUCTION_TIMEFRAMES: TimeframeId[] = ["5m", "15m", "30m", "45m", "1h", "2h", "4h", "8h", "1d"];

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const filter = url.searchParams.get("symbols")?.toUpperCase().split(",").filter(Boolean);
  const syncedOnly = url.searchParams.get("synced") === "1";

  try {
    const outcome = await discoverMarkets();
    // AUDIT FIX (P0): `discoverMarkets()` returns a DiscoveryOutcome, not a
    // snapshot. The previous code read `outcome.markets` (undefined) and threw
    // on every request, so the matrix endpoint was permanently 503. A failed
    // discovery is now surfaced honestly instead of being masked.
    if (outcome.status === "NETWORK_FAILURE" || outcome.status === "INVALID_RESPONSE") {
      return NextResponse.json(
        {
          ok: false,
          discovery_status: outcome.status,
          error: outcome.error,
          reason: "TTT market discovery failed; the availability matrix is not served from a stale snapshot",
          stale_snapshot_returned: outcome.snapshot.markets.length > 0,
          ts: Date.now(),
        },
        { status: 503 },
      );
    }
    const snap = outcome.snapshot;
    const store = getHistoryStore();
    let markets = snap.markets.filter((m) => m.eligibility.includes("ASA_MARKET_ELIGIBLE"));
    if (filter?.length) markets = markets.filter((m) => filter.includes(m.symbol));

    const rows = markets.map((m) => {
      const cells = PRODUCTION_TIMEFRAMES.map((tf) => {
        const spec = TIMEFRAMES.find((t) => t.id === tf)!;
        const row = store.syncRow(m.symbol, tf);
        const bounds = store.bounds(m.symbol, tf);
        const barCount = row?.bar_count ?? store.count(m.symbol, tf);
        return {
          timeframe: tf,
          ttt_resolution: spec.tttResolution,
          // TTT serves all nine natively (verified 2026-09-09)
          supported: true,
          synced: barCount > 0,
          available_from: bounds.earliest,
          available_to: bounds.latest,
          bar_count: barCount,
          data_quality: barCount === 0 ? "NOT_SYNCED" : (row?.gap_count ?? 0) > 0 ? "GAPPED" : "OK",
        completion_state: row?.completion_state ?? "NOT_SYNCED",
        gap_count: row?.gap_count ?? 0,
        last_sync: row?.last_sync_ms ?? null,
        source: "ttt",
        fingerprint: row?.dataset_fingerprint ?? null,
        // boundary evidence type — 'TTT_NO_DATA' only when the stored extent
        // was proven by an explicit upstream answer; null = never proven/legacy
        boundary_proof: row?.boundary_proof ?? null,
        last_successful_sync_ms: row && row.last_successful_sync_ms > 0 ? row.last_successful_sync_ms : null,
        last_error: row?.last_error ?? null,
        };
      });
      return {
        symbol: m.symbol,
        category: m.category,
        status: m.status,
        eligibility: m.eligibility,
        cells: syncedOnly ? cells.filter((c) => c.synced) : cells,
      };
    });

    const filtered = syncedOnly ? rows.filter((r) => r.cells.length > 0) : rows;
    const totalCells = filtered.reduce((a, r) => a + r.cells.length, 0);
    const syncedCells = filtered.reduce((a, r) => a + r.cells.filter((c) => c.synced).length, 0);

    return NextResponse.json({
      ok: true,
      source: "ttt",
      discovery_status: outcome.status,
      generated_at_ms: Date.now(),
      production_timeframes: PRODUCTION_TIMEFRAMES,
      resolution_mapping: Object.fromEntries(
        PRODUCTION_TIMEFRAMES.map((tf) => [tf, TIMEFRAMES.find((t) => t.id === tf)!.tttResolution]),
      ),
      counts: {
        markets: filtered.length,
        timeframes: PRODUCTION_TIMEFRAMES.length,
        cells: totalCells,
        synced_cells: syncedCells,
        total_cached_bars: store.totalBars(),
      },
      matrix: filtered,
      note: "a cell reporting NOT_SYNCED has simply not been backfilled yet — it is never a statement that TTT lacks the data",
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), source: "ttt" },
      { status: 503 },
    );
  }
}
