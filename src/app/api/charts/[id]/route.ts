/**
 * GET /api/charts/[id] — annotated chart for an opportunity (closure §K).
 *
 * Formats:
 *   /api/charts/<id>          -> JSON evidence spec (default)
 *   /api/charts/<id>.json     -> JSON evidence spec
 *   /api/charts/<id>.svg      -> annotated SVG
 *   /api/charts/<id>.png      -> annotated PNG (same renderer Telegram uses)
 *
 * GATE 19: this route now CONSUMES ChartEvidence. Every annotation returned
 * carries annotation_id -> produced_by(feature|rule) -> source_refs ->
 * detector_version. Nothing decorative is emitted: if the decision did not use
 * a concept, it does not appear here.
 */
import { NextResponse } from "next/server";
import { getRepo } from "@/db/sqlite";
import { candleManager } from "@/lib/market/candles";
import { isOperationalSymbol } from "@/lib/market/operational-universe";
import { renderEvidenceSvg, renderEvidencePng } from "@/lib/chart/render";
import { getHistoryStore } from "@/lib/market/history-store";
import type { ChartEvidence } from "@/lib/chart/evidence";
import type { TimeframeId } from "@/lib/domain/timeframes";

export const dynamic = "force-dynamic";

function splitFormat(raw: string): { id: string; format: "json" | "svg" | "png" } {
  if (raw.endsWith(".svg")) return { id: raw.slice(0, -4), format: "svg" };
  if (raw.endsWith(".png")) return { id: raw.slice(0, -4), format: "png" };
  if (raw.endsWith(".json")) return { id: raw.slice(0, -5), format: "json" };
  return { id: raw, format: "json" };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: rawId } = await ctx.params;
  const { id, format } = splitFormat(rawId);

  const repo = getRepo();
  const opp = repo.opportunityGet(id) ?? (id.startsWith("sig-") ? repo.opportunityGet(id.slice(4)) : null);
  if (!opp) {
    return NextResponse.json(
      { ok: false, error: "opportunity not found", note: "charts render decision evidence; there is no decorative chart mode" },
      { status: 404 },
    );
  }
  if (!isOperationalSymbol(opp.symbol)) {
    return NextResponse.json({ ok: false, error: "symbol not in the canonical universe" }, { status: 400 });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(opp.payload_json) as Record<string, unknown>;
  } catch {
    /* payload stays empty */
  }
  const evidence = (payload.chart_evidence as ChartEvidence | undefined) ?? null;
  if (!evidence) {
    return NextResponse.json(
      {
        ok: false,
        error: "no chart evidence stored for this opportunity",
        reason: "the opportunity predates evidence capture; re-run the scan to produce lineage",
      },
      { status: 409 },
    );
  }

  // Candles on the STRATEGY'S OWN timeframe — never a hard-coded 15m.
  // History comes from the durable store (full TTT-available range); the
  // optional `bars` param is a TRANSPORT window for rendering only.
  const tf = (evidence.timeframe || opp.timeframe) as TimeframeId;
  const url = new URL(_req.url);
  const barsParam = Number(url.searchParams.get("bars") ?? NaN);
  const renderWindow = Number.isFinite(barsParam) && barsParam > 0 ? Math.floor(barsParam) : undefined;
  const fromParam = Number(url.searchParams.get("from") ?? NaN);
  const toParam = Number(url.searchParams.get("to") ?? NaN);

  const store = getHistoryStore();
  let candles = store.get(
    opp.symbol, tf,
    Number.isFinite(fromParam) ? Math.floor(fromParam) : undefined,
    Number.isFinite(toParam) ? Math.floor(toParam) : undefined,
    renderWindow,
  );
  let series: { native: boolean; fetched_at_ms: number } | null = null;
  if (candles.length === 0) {
    const live = await candleManager.ensureSeries(opp.symbol, tf, true);
    candles = live?.candles ?? [];
    series = live ? { native: live.native, fetched_at_ms: live.fetched_at_ms } : null;
  }
  const bounds = store.bounds(opp.symbol, tf);

  if (format === "svg") {
    const svg = renderEvidenceSvg(evidence, candles, { title: opp.id });
    return new NextResponse(svg, {
      status: 200,
      headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (format === "png") {
    const png = renderEvidencePng(evidence, candles);
    return new NextResponse(Buffer.from(png), {
      status: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
  }

  return NextResponse.json({
    ok: true,
    kind: "opportunity",
    id: opp.id,
    symbol: evidence.symbol,
    timeframe: evidence.timeframe,
    direction: evidence.direction,
    strategy_id: evidence.strategy_id,
    setup_id: evidence.setup_id,
    score: evidence.score,
    score_semantics: evidence.score_semantics,
    // EVERY annotation carries its lineage
    annotations: evidence.annotations,
    rules: evidence.rules,
    assumptions: evidence.assumptions,
    lineage_complete: evidence.lineage_complete,
    candles,
    candles_provenance: {
      native: series?.native ?? true,
      fetched_at_ms: series?.fetched_at_ms ?? null,
      source: "ttt",
      // full-range traversal metadata (no fixed-N ceiling)
      earliest_available: bounds.earliest,
      latest_available: bounds.latest,
      stored_bar_count: store.count(opp.symbol, tf),
      transport_window_applied: renderWindow !== undefined,
      has_more_history: candles.length > 0 && bounds.earliest !== null && candles[0].t > bounds.earliest,
      note: "`bars`/`from`/`to` are transport windows; omit them to receive the full stored TTT range",
    },
    images: { svg: `/api/charts/${opp.id}.svg`, png: `/api/charts/${opp.id}.png` },
    data_ts: Date.now(),
    note: "every annotation maps to a rule/feature and its source lines; nothing decorative is rendered",
  });
}
