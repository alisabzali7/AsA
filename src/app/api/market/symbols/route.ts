/**
 * GET /api/market/symbols — the DYNAMIC operational universe.
 *
 * Derived from TTT discovery, not from the legacy 48-symbol list. Permanently
 * excluded symbols can never appear. `source` reports honestly whether
 * discovery has completed or the bootstrap fallback is still in effect.
 */
import { NextResponse } from "next/server";
import { CORE_TFS, TIMEFRAME_IDS } from "@/lib/domain/timeframes";
import { operationalUniverse, refreshOperationalUniverse, universeMeta } from "@/lib/market/operational-universe";
import { PERMANENT_EXCLUSIONS } from "@/lib/market/catalog";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  // ensure discovery has run at least once before answering
  if (!universeMeta().discovery_complete) await refreshOperationalUniverse().catch(() => undefined);

  const symbols = operationalUniverse();
  const meta = universeMeta();
  return NextResponse.json({
    ok: true,
    symbols,
    count: symbols.length,
    source: meta.source,
    discovery_complete: meta.discovery_complete,
    last_refresh_ms: meta.last_refresh_ms,
    permanent_exclusions: PERMANENT_EXCLUSIONS,
    timeframes: TIMEFRAME_IDS,
    core: CORE_TFS,
    ttt_only: true,
    note: "the production universe is discovered from TTT; the legacy 48-symbol list is a test-only regression fixture",
  });
}
