/**
 * GET /api/market/symbols — the DYNAMIC operational universe.
 *
 * Derived from TTT discovery, not from any hard-coded list. Permanently
 * excluded symbols can never appear. `source` reports honestly whether
 * discovery has completed; before that the universe is EMPTY (NOT_READY).
 */
import { NextResponse } from "next/server";
import { CORE_TFS, TIMEFRAME_IDS } from "@/lib/domain/timeframes";
import { operationalUniverse, refreshOperationalUniverse, universeMeta } from "@/lib/market/operational-universe";
import { PERMANENT_EXCLUSIONS } from "@/lib/market/catalog";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  // ensure discovery has run at least once before answering.
  // AUDIT (swallow-site triage): refreshOperationalUniverse NEVER throws —
  // it returns {state, error} — so this catch is a defensive no-op, and the
  // failure is reported honestly below via state/last_error, never masked.
  if (!universeMeta().discovery_complete) await refreshOperationalUniverse().catch(() => undefined);

  const symbols = operationalUniverse();
  const meta = universeMeta();
  return NextResponse.json({
    ok: true,
    symbols,
    count: symbols.length,
    source: meta.source,
    // AUDIT FIX (observability mandate): expose the discovery STATE and the
    // last error so a degraded universe can never be presented as healthy.
    state: meta.state,
    last_error: meta.last_error,
    last_attempt_ms: meta.last_attempt_ms,
    discovery_complete: meta.discovery_complete,
    last_refresh_ms: meta.last_refresh_ms,
    permanent_exclusions: PERMANENT_EXCLUSIONS,
    timeframes: TIMEFRAME_IDS,
    core: CORE_TFS,
    ttt_only: true,
    note: "the production universe is discovered from TTT; the legacy 48-symbol list is a test-only regression fixture",
  });
}
