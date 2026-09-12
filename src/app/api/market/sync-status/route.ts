/**
 * GET /api/market/sync-status — market-data observability (remediation §24, §28).
 *
 * Reports what the data layer actually knows: discovered market count, AsA
 * eligibility, the TON exclusion state, resolution support, per-cell sync
 * health, oldest/newest cached candles, gaps and failures.
 */
import { NextResponse } from "next/server";
import { cachedCatalog, discoverMarkets, PERMANENT_EXCLUSIONS, isPermanentlyExcluded } from "@/lib/market/catalog";
import { getHistoryStore, RETRIEVAL_VERSION } from "@/lib/market/history-store";
import { PRODUCTION_TIMEFRAMES } from "../matrix/route";
import { TIMEFRAMES } from "@/lib/domain/timeframes";
import { LEGACY_UNIVERSE, discoveredSymbols } from "@/lib/domain/universe";
import { TTT_MAX_BARS_PER_REQUEST } from "@/lib/market/history";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const store = getHistoryStore();
  const rows = store.allSyncRows();

  let catalog = cachedCatalog();
  let discoveryError: string | null = null;
  if (!catalog) {
    try {
      catalog = await discoverMarkets();
    } catch (err) {
      discoveryError = err instanceof Error ? err.message : String(err);
    }
  }

  const oldest = rows.reduce<number | null>((a, r) => (r.earliest_ts && (a === null || r.earliest_ts < a) ? r.earliest_ts : a), null);
  const newest = rows.reduce<number | null>((a, r) => (r.latest_ts && (a === null || r.latest_ts > a) ? r.latest_ts : a), null);
  const failed = rows.filter((r) => r.last_error);
  const gapped = rows.filter((r) => r.gap_count > 0);
  const complete = rows.filter((r) => r.completion_state === "COMPLETE_TO_TTT_BOUNDARY");
  const lastSync = rows.reduce<number | null>((a, r) => (a === null || r.last_sync_ms > a ? r.last_sync_ms : a), null);

  const legacyPresent = catalog
    ? LEGACY_UNIVERSE.filter((s) => catalog!.markets.some((m) => m.symbol === s)).length
    : null;

  return NextResponse.json({
    ok: discoveryError === null,
    source: "ttt",
    discovery: {
      ttt_market_count: catalog?.discovered_count ?? null,
      asa_eligible_count: catalog?.eligible_count ?? null,
      excluded_count: catalog?.excluded.length ?? 0,
      permanent_exclusions: PERMANENT_EXCLUSIONS,
      ton_excluded: isPermanentlyExcluded("TONUSDT"),
      // verifies the exclusion held: must always be false
      excluded_symbol_leaked_into_catalog: catalog
        ? catalog.markets.some((m) => isPermanentlyExcluded(m.symbol))
        : null,
      last_discovery_ms: catalog?.fetched_at_ms ?? null,
      discovery_error: discoveryError,
      dynamic_allow_list_size: discoveredSymbols().length,
      legacy_regression: { expected: LEGACY_UNIVERSE.length, still_listed: legacyPresent },
    },
    resolutions: {
      production_timeframes: PRODUCTION_TIMEFRAMES,
      mapping: Object.fromEntries(
        PRODUCTION_TIMEFRAMES.map((tf) => [tf, TIMEFRAMES.find((t) => t.id === tf)!.tttResolution]),
      ),
      native_1d: true,
      transport_chunk_size: TTT_MAX_BARS_PER_REQUEST,
      note: "transport_chunk_size is the venue RESPONSE cap per request, never a retention limit",
    },
    history: {
      synced_cells: rows.length,
      total_cached_bars: store.totalBars(),
      oldest_candle_ts: oldest,
      newest_candle_ts: newest,
      complete_to_boundary: complete.length,
      gapped_cells: gapped.length,
      total_gaps: rows.reduce((a, r) => a + r.gap_count, 0),
      failed_syncs: failed.length,
      last_successful_sync_ms: lastSync,
      last_error: failed.length ? failed[failed.length - 1].last_error : null,
      retrieval_version: RETRIEVAL_VERSION,
    },
    cells: rows.map((r) => ({
      symbol: r.symbol, timeframe: r.timeframe, bars: r.bar_count,
      earliest: r.earliest_ts, latest: r.latest_ts,
      completion_state: r.completion_state, gaps: r.gap_count,
      last_sync_ms: r.last_sync_ms, error: r.last_error,
      fingerprint: r.dataset_fingerprint,
    })),
    ts: Date.now(),
  });
}
