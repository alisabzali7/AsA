/** GET /api/market/stats?symbol= — canonical stats snapshot w/ provenance. */
import { NextResponse } from "next/server";
import { ensureEngineBooted } from "@/lib/state";
import { sharedStore } from "@/lib/market/store";
import { operationalUniverse, universeMeta } from "@/lib/market/operational-universe";
import { sym } from "@/lib/api-common";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try {
    await ensureEngineBooted();
  } catch {
    /* state reported below */
  }
  const meta = universeMeta();
  if (!meta.discovery_complete) {
    return NextResponse.json({
      ok: false,
      source: "ttt",
      endpoint: "/futures/markets/stats",
      state: meta.state,
      error: `TTT discovery is ${meta.state}; stats are not ready`,
      last_error: meta.last_error,
      rows: [],
      universe: meta,
      ts: Date.now(),
    }, { status: 503 });
  }
  const url = new URL(req.url);
  const requested = url.searchParams.get("symbol");
  if (requested) {
    const { symbol, error } = sym(url.searchParams, "symbol");
    if (error) return error;
    const s = sharedStore.getStats(symbol as string);
    if (!s) return NextResponse.json({ ok: true, symbol, available: false, state: "CONNECTING", reason: "no stats row yet", universe: meta });
    return NextResponse.json({ ok: true, available: true, ...s, age_ms: Date.now() - s.provenance.fetched_at_ms, universe: meta });
  }
  const rows = [];
  for (const symbol of operationalUniverse()) {
    const s = sharedStore.getStats(symbol);
    rows.push(s ?? { symbol, available: false });
  }
  return NextResponse.json({ ok: true, count: rows.length, rows, universe: meta, ts: Date.now() });
}
