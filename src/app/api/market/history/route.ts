/**
 * GET /api/market/history — full-range historical candles (remediation §11, §28).
 *
 * There is NO fixed recent-N ceiling. Omitting `from`/`to` returns everything
 * stored back to the TTT boundary. `limit` is an optional TRANSPORT window for
 * progressive loading; it never limits what the backend retains or can serve.
 *
 * Query:
 *   symbol   required
 *   tf       required (5m|15m|30m|45m|1h|2h|4h|8h|1d|1m)
 *   from,to  optional unix seconds — an explicit user range
 *   limit    optional transport window (newest N of the selected range)
 *   sync     1 = ensure a sync first (incremental), full = re-walk the boundary
 *   metadata 0 = omit the metadata block
 *   gaps     1 = include the gap report
 */
import { NextResponse } from "next/server";
import { getHistoryStore, syncHistory } from "@/lib/market/history-store";
import { detectGaps, fingerprint } from "@/lib/market/history";
import { getTimeframe, isTimeframe } from "@/lib/domain/timeframes";
import { isPermanentlyExcluded, getMarket } from "@/lib/market/catalog";
import { universeMeta } from "@/lib/market/operational-universe";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase().trim();
  const tf = url.searchParams.get("tf") ?? "1h";
  const syncMode = url.searchParams.get("sync");
  const wantGaps = url.searchParams.get("gaps") === "1";
  const wantMeta = url.searchParams.get("metadata") !== "0";

  if (!symbol) return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });
  if (isPermanentlyExcluded(symbol)) {
    return NextResponse.json(
      { ok: false, error: `${symbol} is permanently excluded from the AsA universe` },
      { status: 400 },
    );
  }
  if (!isTimeframe(tf)) {
    return NextResponse.json({ ok: false, error: `unsupported timeframe '${tf}'` }, { status: 400 });
  }

  const market = await getMarket(symbol).catch(() => null);
  if (!market) {
    // AUDIT FIX (swallow-site triage): "not found" and "catalog unavailable"
    // are different failures. A discovery outage with no snapshot must NOT be
    // reported as "symbol does not exist".
    const meta = universeMeta();
    if (!meta.discovery_complete) {
      return NextResponse.json(
        {
          ok: false,
          error: `TTT catalog unavailable (${meta.state}${meta.last_error ? `: ${meta.last_error}` : ""}) — cannot confirm '${symbol}'`,
          source: "ttt",
          degraded: "DISCOVERY_UNAVAILABLE",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: `${symbol} is not in the discovered TTT catalog`, source: "ttt" },
      { status: 404 },
    );
  }

  const numParam = (k: string): number | undefined => {
    const v = url.searchParams.get(k);
    if (v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : undefined;
  };
  const from = numParam("from");
  const to = numParam("to");
  const limit = numParam("limit");

  try {
    let syncNote: string | undefined;
    // FORENSIC TASK (no false boundary proof): whether THIS attempt obtained
    // explicit upstream boundary evidence is reported separately from the
    // dataset-level completion flag, so a retained historical completion can
    // never be read as a fresh proof.
    let boundaryProvenThisAttempt: boolean | null = null;
    if (syncMode === "1" || syncMode === "full") {
      const r = await syncHistory(symbol, tf, { full: syncMode === "full" });
      boundaryProvenThisAttempt = r.boundary_proven_this_attempt;
      syncNote = r.skipped_reason ?? `${r.added} bar(s) added (${r.incremental ? "incremental" : "full walk"})`;
    }

    const store = getHistoryStore();
    const candles = store.get(symbol, tf, from, to, limit);
    const bounds = store.bounds(symbol, tf);
    const row = store.syncRow(symbol, tf);
    const spec = getTimeframe(tf)!;

    if (candles.length === 0 && bounds.earliest === null) {
      return NextResponse.json({
        ok: true, symbol, timeframe: tf, candles: [], count: 0,
        metadata: {
          completion_state: "NO_DATA",
          data_quality: "NO_DATA",
          reason: "no history stored yet — call with sync=full to backfill to the TTT boundary",
          earliest_available: null, latest_available: null,
        },
        ts: Date.now(),
      });
    }

    const body: Record<string, unknown> = {
      ok: true,
      symbol,
      timeframe: tf,
      ttt_resolution: spec.tttResolution,
      native: true,
      source: "ttt",
      count: candles.length,
      candles,
    };

    if (wantMeta) {
      body.metadata = {
        // stored boundaries — independent of the requested window
        earliest_available: bounds.earliest,
        latest_available: bounds.latest,
        stored_bar_count: store.count(symbol, tf),
        requested_range: { from: from ?? null, to: to ?? null, limit: limit ?? null },
        returned_range: {
          from: candles.length ? candles[0].t : null,
          to: candles.length ? candles[candles.length - 1].t : null,
        },
        completion_state: row?.completion_state ?? "PARTIAL",
        data_quality: (row?.gap_count ?? 0) > 0 ? "GAPPED" : "OK",
        gap_count: row?.gap_count ?? 0,
        dataset_fingerprint: row?.dataset_fingerprint ?? fingerprint(candles),
        last_sync_ms: row?.last_sync_ms ?? null,
        last_attempt_ms: row?.last_attempt_ms ?? null,
        last_successful_sync_ms: row && row.last_successful_sync_ms > 0 ? row.last_successful_sync_ms : null,
        last_error: row?.last_error ?? null,
        retrieval_version: row?.retrieval_version ?? null,
        // progressive-loading hints for the chart
        has_more_history: candles.length > 0 && bounds.earliest !== null && candles[0].t > bounds.earliest,
        earliest_boundary_reached: row?.completion_state === "COMPLETE_TO_TTT_BOUNDARY",
        // the EVIDENCE behind the completion flag: 'TTT_NO_DATA' when the
        // boundary was proven by an explicit upstream answer, null when no
        // proof is recorded (legacy row / never proven)
        boundary_proof: row?.boundary_proof ?? null,
        boundary_proof_ms: row && row.boundary_proof_ms > 0 ? row.boundary_proof_ms : null,
        boundary_proven_this_attempt: boundaryProvenThisAttempt,
        transport_window_applied: limit !== undefined,
        note: "limit is a TRANSPORT window only; the backend retains and can serve the full TTT-available range",
        sync: syncNote ?? null,
      };
    }
    if (wantGaps) {
      body.gap_report = detectGaps(candles, spec.minutes);
    }
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), source: "ttt" },
      { status: 503 },
    );
  }
}
