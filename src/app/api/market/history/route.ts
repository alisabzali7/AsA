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
  let persistedEvidenceRead = false;
  if (!market) {
    // AUDIT FIX (swallow-site triage): "not found" and "catalog unavailable"
    // are different failures. A discovery outage with no snapshot must NOT be
    // reported as "symbol does not exist".
    const meta = universeMeta();
    if (!meta.discovery_complete) {
      // DURABLE-RECOVERY PATH (Task 06 — restart during a venue outage must
      // not sever persistence → API). A symbol whose history THIS deployment
      // already persisted carries durable evidence of its prior discovery
      // membership; refusing to read it during a discovery outage made the
      // boundary-proven store unreachable exactly when it matters most (the
      // venue being down). Such reads are served WITH an explicit degraded
      // marker — never as a clean, fully-validated response. A symbol with no
      // persisted evidence stays 503: membership still cannot be confirmed.
      // Permanent exclusions (TONUSDT) are rejected above and can never reach
      // this path through the persisted-evidence bypass.
      const store = getHistoryStore();
      const hasPersistedEvidence =
        store.count(symbol, tf) > 0 ||
        store.allSyncRows().some((r) => r.symbol === symbol);
      if (!hasPersistedEvidence) {
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
      persistedEvidenceRead = true;
    } else {
      return NextResponse.json(
        { ok: false, error: `${symbol} is not in the discovered TTT catalog`, source: "ttt" },
        { status: 404 },
      );
    }
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
      // Absence of a local row is NOT a venue no_data. A sync that just failed
      // (invalid payload, transport, ambiguous empty) must be reported as that
      // state — the previous hard-coded NO_DATA claimed a boundary the venue
      // never proved, and the chart treated an empty page as "boundary reached".
      const state = row?.completion_state ?? "NOT_SYNCED";
      return NextResponse.json({
        ok: true, symbol, timeframe: tf, candles: [], count: 0,
        source: "ttt",
        native: true,
        metadata: {
          completion_state: state,
          data_quality: state === "NO_DATA" ? "NO_DATA" : "INSUFFICIENT",
          reason: row?.last_error
            ?? (row
              ? `no candles stored (completion ${state})`
              : "no history stored yet — call with sync=full to backfill to the TTT boundary"),
          earliest_available: null,
          latest_available: null,
          earliest_boundary_reached: false,
          boundary_proof: row?.boundary_proof ?? null,
          boundary_proven_this_attempt: boundaryProvenThisAttempt,
          last_error: row?.last_error ?? null,
          // served from persisted evidence while live discovery was down —
          // never presented as a fully-validated, discovery-complete read
          discovery_degraded: persistedEvidenceRead ? "DISCOVERY_UNAVAILABLE" : null,
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
        // When no sync row exists (bars written by the live candle path only),
        // gap_count is measured over the RETURNED window instead of assuming 0.
        gap_count: row?.gap_count ?? detectGaps(candles, spec.minutes).length,
        data_quality: row
          ? (row.gap_count ?? 0) > 0 ? "GAPPED" : "OK"
          : detectGaps(candles, spec.minutes).length > 0 ? "GAPPED" : "OK",
        dataset_fingerprint: row?.dataset_fingerprint ?? fingerprint(candles),
        last_sync_ms: row?.last_sync_ms ?? null,
        last_attempt_ms: row?.last_attempt_ms ?? null,
        last_successful_sync_ms: row && row.last_successful_sync_ms > 0 ? row.last_successful_sync_ms : null,
        last_error: row?.last_error ?? null,
        retrieval_version: row?.retrieval_version ?? null,
        // progressive-loading hints for the chart
        has_more_history: candles.length > 0 && bounds.earliest !== null && candles[0].t > bounds.earliest,
        // THE BOUNDARY FLAG IS PROOF-GATED (mandate §7.8). A retained
        // completion flag WITHOUT a recorded evidence type (a legacy row from
        // before `boundary_proof` existed) is UNKNOWN evidence — it may keep
        // its historical completion_state, but it may NOT be announced to the
        // chart as a proven TTT boundary. The badge requires the actual proof.
        earliest_boundary_reached:
          row?.completion_state === "COMPLETE_TO_TTT_BOUNDARY" &&
          row?.boundary_proof != null,
        // the EVIDENCE behind the completion flag: 'TTT_NO_DATA' when the
        // boundary was proven by an explicit upstream answer, null when no
        // proof is recorded (legacy row / never proven)
        boundary_proof: row?.boundary_proof ?? null,
        boundary_proof_ms: row && row.boundary_proof_ms > 0 ? row.boundary_proof_ms : null,
        boundary_proven_this_attempt: boundaryProvenThisAttempt,
        transport_window_applied: limit !== undefined,
        // served from persisted evidence while live discovery was down —
        // never presented as a fully-validated, discovery-complete read
        discovery_degraded: persistedEvidenceRead ? "DISCOVERY_UNAVAILABLE" : null,
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
