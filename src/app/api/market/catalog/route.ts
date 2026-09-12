/**
 * GET /api/market/catalog — the DYNAMIC TTT market catalog (remediation §1, §28).
 *
 * The universe is discovered from TTT at runtime, not hard-coded. Newly listed
 * contracts appear here without a code change. TONUSDT is excluded at the
 * discovery layer and can never reappear.
 *
 * Query: ?refresh=1 forces rediscovery · ?symbol=BTCUSDT returns one record
 *        ?eligible=1 restricts to ASA_MARKET_ELIGIBLE instruments
 */
import { NextResponse } from "next/server";
import { discoverMarkets, PERMANENT_EXCLUSIONS } from "@/lib/market/catalog";
import { TIMEFRAMES } from "@/lib/domain/timeframes";
import { LEGACY_UNIVERSE } from "@/lib/domain/universe";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const force = url.searchParams.get("refresh") === "1";
  const only = url.searchParams.get("symbol")?.toUpperCase();
  const eligibleOnly = url.searchParams.get("eligible") === "1";

  try {
    const outcome = await discoverMarkets(force);
    const snap = outcome.snapshot;
    // Surface a failed/ambiguous discovery instead of presenting a stale or
    // empty catalog as a healthy read (audit P0-4).
    if (outcome.status === "NETWORK_FAILURE" || outcome.status === "INVALID_RESPONSE") {
      return NextResponse.json({
        ok: false,
        discovery_status: outcome.status,
        error: outcome.error,
        reason: "TTT market discovery failed; AsA does not fall back to any other exchange or to a legacy symbol list",
        stale_snapshot_returned: snap.markets.length > 0,
        counts: { catalog: snap.markets.length, eligible: snap.eligible_count },
        ts: Date.now(),
      }, { status: 503 });
    }
    let markets = snap.markets;
    if (eligibleOnly) markets = markets.filter((m) => m.eligibility.includes("ASA_MARKET_ELIGIBLE"));
    if (only) markets = markets.filter((m) => m.symbol === only);

    if (only && markets.length === 0) {
      return NextResponse.json(
        { ok: false, error: `symbol ${only} is not in the discovered TTT catalog`, excluded: (PERMANENT_EXCLUSIONS as readonly string[]).includes(only) },
        { status: 404 },
      );
    }

    const legacyPresent = LEGACY_UNIVERSE.filter((s) => snap.markets.some((m) => m.symbol === s));
    const legacyMissing = LEGACY_UNIVERSE.filter((s) => !snap.markets.some((m) => m.symbol === s));

    return NextResponse.json({
      ok: true,
      source: "ttt",
      endpoint: snap.endpoint,
      discovery_status: outcome.status,
      fetched_at_ms: snap.fetched_at_ms,
      counts: {
        discovered: snap.discovered_count,
        catalog: snap.markets.length,
        eligible: snap.eligible_count,
        excluded: snap.excluded.length,
        returned: markets.length,
      },
      permanent_exclusions: PERMANENT_EXCLUSIONS,
      excluded: snap.excluded,
      legacy_regression: {
        note: "the previous 48-symbol list is now a REGRESSION SET, not the universe",
        expected: LEGACY_UNIVERSE.length,
        still_listed: legacyPresent.length,
        missing_from_ttt: legacyMissing,
      },
      supported_timeframes: TIMEFRAMES.map((t) => ({ id: t.id, ttt_resolution: t.tttResolution, minutes: t.minutes })),
      markets,
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        reason: "TTT market discovery failed; AsA does not fall back to any other exchange",
      },
      { status: 503 },
    );
  }
}
