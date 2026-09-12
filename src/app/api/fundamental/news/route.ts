/**
 * GET /api/fundamental/news?days=&symbol=&kind= — stored news (30d window),
 * plus connector state. News is an AUXILIARY source: never price truth.
 */
import { NextResponse } from "next/server";
import { getRepo } from "@/db/sqlite";
import { newsState, connectors } from "@/lib/fundamental/engine";
import type { NewsRow } from "@/db/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const days = Math.min(30, Math.max(1, Number.parseInt(url.searchParams.get("days") ?? "30", 10) || 30));
  const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200));
  const symbolFilter = url.searchParams.get("symbol")?.toUpperCase() ?? null;
  const kindFilter = url.searchParams.get("kind") ?? null;
  const state = newsState();
  let rows: (NewsRow & { related_symbols: string[] })[] = [];
  try {
    rows = getRepo().newsList({ days, limit }).map((n) => {
      let symbols: string[] = [];
      try { symbols = JSON.parse(n.symbols_json) as string[]; } catch { /* ignore */ }
      return { ...n, related_symbols: symbols };
    });
  } catch {
    /* db unavailable */
  }
  if (symbolFilter) rows = rows.filter((r) => r.related_symbols.includes(symbolFilter));
  if (kindFilter) rows = rows.filter((r) => r.impact === kindFilter || r.source_type === kindFilter);
  return NextResponse.json({
    ok: true,
    state,
    connectors: connectors.map((c) => ({ id: c.id, name: c.name, source_type: c.source_type, configured: c.configured, state: c.state() })),
    note: "auxiliary news source — NEVER market price truth (separate from MarketDataSource)",
    items: rows,
    count: rows.length,
    ts: Date.now(),
  });
}
