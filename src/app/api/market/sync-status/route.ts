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
import { LEGACY_48_REGRESSION_SET, discoveredSymbols } from "@/lib/domain/universe";
import { TTT_MAX_BARS_PER_REQUEST } from "@/lib/market/history";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const store = getHistoryStore();
  const rows = store.allSyncRows();

  let catalog = cachedCatalog();
  let discoveryStatus: string | null = null;
  let discoveryError: string | null = null;
  if (!catalog) {
    // AUDIT FIX (P0): discoverMarkets() returns a DiscoveryOutcome, not a
    // snapshot. The previous code assigned the whole outcome into the snapshot
    // variable, which (a) failed typecheck and (b) threw a TypeError on
    // `catalog.markets.some(...)` after a cold-cache discovery, 500-ing the
    // route. The failure status is now surfaced instead of discarded.
    try {
      const outcome = await discoverMarkets();
      if (outcome.status === "NETWORK_FAILURE" || outcome.status === "INVALID_RESPONSE") {
        discoveryStatus = outcome.status;
        discoveryError = outcome.error;
        catalog = null; // never present a failure as a healthy read
      } else {
        catalog = outcome.snapshot;
      }
    } catch (err) {
      discoveryStatus = "NETWORK_FAILURE";
      discoveryError = err instanceof Error ? err.message : String(err);
    }
  }

  const oldest = rows.reduce<number | null>((a, r) => (r.earliest_ts && (a === null || r.earliest_ts < a) ? r.earliest_ts : a), null);
  const newest = rows.reduce<number | null>((a, r) => (r.latest_ts && (a === null || r.latest_ts > a) ? r.latest_ts : a), null);
  const failed = rows.filter((r) => r.last_error);
  const gapped = rows.filter((r) => r.gap_count > 0);
  const complete = rows.filter((r) => r.completion_state === "COMPLETE_TO_TTT_BOUNDARY");
  // AUDIT FIX (P0-6): a successful sync is read from the SUCCESS column, never
  // from the attempt column — a failed sync used to be reported as the last
  // successful one.
  const lastSuccessful = rows.reduce<number | null>(
    (a, r) => (r.last_successful_sync_ms > 0 && (a === null || r.last_successful_sync_ms > a) ? r.last_successful_sync_ms : a),
    null,
  );
  const lastAttempt = rows.reduce<number | null>(
    (a, r) => (r.last_attempt_ms > 0 && (a === null || r.last_attempt_ms > a) ? r.last_attempt_ms : a),
    null,
  );

  const legacyPresent = catalog
    ? LEGACY_48_REGRESSION_SET.filter((s) => catalog!.markets.some((m) => m.symbol === s)).length
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
      discovery_status: discoveryStatus,
      discovery_error: discoveryError,
      dynamic_allow_list_size: discoveredSymbols().length,
      legacy_regression: { expected: LEGACY_48_REGRESSION_SET.length, still_listed: legacyPresent },
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
      last_attempt_ms: lastAttempt,
      last_successful_sync_ms: lastSuccessful,
      last_error: failed.length ? failed[failed.length - 1].last_error : null,
      retrieval_version: RETRIEVAL_VERSION,
      note: "last_successful_sync_ms moves ONLY on a successful sync; a failed attempt updates last_attempt_ms and last_error instead",
    },
    cells: rows.map((r) => ({
      symbol: r.symbol, timeframe: r.timeframe, bars: r.bar_count,
      earliest: r.earliest_ts, latest: r.latest_ts,
      completion_state: r.completion_state, gaps: r.gap_count,
      last_attempt_ms: r.last_attempt_ms,
      last_successful_sync_ms: r.last_successful_sync_ms > 0 ? r.last_successful_sync_ms : null,
      error: r.last_error,
      fingerprint: r.dataset_fingerprint,
      // evidence behind the completion flag: 'TTT_NO_DATA' when the stored
      // extent was proven by an explicit upstream answer, null = never proven
      boundary_proof: r.boundary_proof,
      boundary_proof_ms: r.boundary_proof_ms > 0 ? r.boundary_proof_ms : null,
      retrieval_version: r.retrieval_version,
      source: r.source,
    })),
    ts: Date.now(),
  });
}
