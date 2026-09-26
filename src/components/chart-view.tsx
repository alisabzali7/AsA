"use client";
/**
 * Chart-centric terminal: real TTT candles via the AsA API, TF switch including
 * native 1D, symbol switch over the DYNAMIC operational universe, structure
 * annotation lines, live forming price (labeled, never a fabricated candle).
 *
 * Task 10: every server payload goes through the pure adapter
 * (src/lib/chart/adapter.ts) — identity gating, forming-bar distinction,
 * adaptive price precision, venue volume, canonical EMA series, overlay specs.
 * This component only hands those specs to lightweight-charts.
 *
 * History model: an initial bounded CHART_VIEWPORT is rendered immediately and
 * older DURABLE_HISTORY is paged in as the user scrolls left, down to the TTT
 * venue boundary. A viewport limit is never a retention limit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChart, createSeriesMarkers, ColorType, CandlestickSeries, HistogramSeries, LineSeries, type IChartApi, type ISeriesApi, type IPriceLine, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import type { ChartOverlay } from "@/lib/chart/technical";
import { analysisStatus, gateAnalysis, mergeBars, overlayToRender, priceFormatFor, toCandleData, toVolumeData, utcLabel } from "@/lib/chart/adapter";
import { useLang } from "./lang";
import { usePoll, formatPrice, fmtAge } from "./hooks";
import { effectiveAgeMs } from "./board-selectors";
import { Badge, Panel } from "./ui";

const TFS = ["1m", "5m", "15m", "30m", "45m", "1h", "2h", "4h", "8h", "1d"] as const;
const CORE = new Set(["4h", "1h", "15m"]);

interface CandleShape { t: number; o: number; h: number; l: number; c: number; v: number }
interface CandlesShape {
  ok: boolean; symbol: string; timeframe: string; bars: number;
  candles: CandleShape[]; native: boolean; provenance: string; derived_source_tf: string | null;
  coverage: { status: string; gap_count: number; bar_count: number; first_ts_ms: number | null } | null;
  forming_price: number | null; age_ms: number; fetched_at_ms: number; reason?: string;
  /** true → the LAST candle is still forming (not closed) */
  last_bar_forming?: boolean; closed_count?: number; freshness?: string;
  /** server-declared origin ("ttt" in production) — displayed, never assumed */
  source?: string;
}
interface SymbolsShape { symbols: string[] }
interface AnalysisShape {
  ok: boolean;
  available?: boolean;
  reason?: string;
  error_class?: string | null;
  insufficient_history?: string[];
  bundle?: {
    symbol: string;
    timeframe: string;
    as_of_t: number | null;
    last_close: number | null;
    structure: { trend: string; reason: string };
    indicators: { rsi14: number | null; ema20: number | null; ema50: number | null; atr14_pct: number | null };
    indicator_status?: Record<string, { state: string; reason: string | null }>;
    momentum?: { last_leg: { direction: string; slope_atr: number | null } | null; last_vs_previous_slope_ratio: number | null };
    provenance?: { input_fingerprint?: string; freshness?: string; source_ts_ms?: number | null; data_age_ms?: number | null };
  };
  /** server-built render contract — the chart only draws it */
  overlay?: ChartOverlay | null;
}
interface MtfShape {
  ok: boolean;
  symbol?: string;
  error?: string;
  mtf?: {
    verdict: string;
    reason: string;
    symbol: string | null;
    macro_bias: string | null; context_bias: string | null; trigger_bias: string | null;
    components: { role: string; timeframe: string | null; state: string; bars: number; freshness: string }[];
    macro: { structure: { trend: string } } | null;
    context: { structure: { trend: string } } | null;
    trigger: { structure: { trend: string } } | null;
  };
}

const VERDICT_COLOR: Record<string, string> = { ALIGNED: "#3fb68b", PARTIAL: "#d6a24a", CONFLICT: "#d9605e" };

export function ChartView({ urlSymbol }: { urlSymbol?: string | null }) {
  const { lang } = useLang();
  const [symbol, setSymbol] = useState<string>(urlSymbol && urlSymbol !== "BTCUSDT" ? urlSymbol : "BTCUSDT");
  const [tf, setTf] = useState<(typeof TFS)[number]>("15m");
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaRefs = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const linesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [priceScaleId] = useState("right");

  /**
   * THREE DISTINCT CONCEPTS (remediation P0-5) — never conflated:
   *
   *   DURABLE_HISTORY  every candle TTT has, held server-side in history.db
   *   COMPUTE_WINDOW   the bounded live window used by /api/market/candles
   *   CHART_VIEWPORT   what is currently rendered, grown by paging older bars
   *
   * The initial viewport is intentionally small for fast first paint; older
   * DURABLE_HISTORY is pulled progressively as the user scrolls left, until
   * the venue boundary is reached.
   */
  const INITIAL_VIEWPORT_BARS = tf === "1m" ? 400 : 700;
  const PAGE_BARS = 1000;
  type Bar = { t: number; o: number; h: number; l: number; c: number; v?: number };
  interface HistoryBucket { bars: Bar[]; exhausted: boolean; boundary: boolean; earliest: number | null }
  const [historyBySeries, setHistoryBySeries] = useState<Record<string, HistoryBucket>>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingRef = useRef(false);

  const symState = usePoll<SymbolsShape>("/api/market/symbols", 600_000);
  const availableSymbols = symState.data?.symbols ?? [];
  const activeSymbol = availableSymbols.length > 0 && !availableSymbols.includes(symbol) ? availableSymbols[0] : symbol;
  const candles = usePoll<CandlesShape>(`/api/market/candles?symbol=${activeSymbol}&tf=${tf}&limit=${INITIAL_VIEWPORT_BARS}&refresh=1`, tf === "1m" ? 12000 : 20000);
  const analysis = usePoll<AnalysisShape>(`/api/analysis/${activeSymbol}/${tf}`, 30000);
  const focus = usePoll<{ symbol: string }>("/api/market/focus", 30000);
  const mtfState = usePoll<MtfShape>(`/api/analysis/mtf/${activeSymbol}`, 60000);
  // identity guard (adapter): never draw one series' evidence on another
  // series' chart; the overlay only when it projects the SAME snapshot
  // (fingerprint + as_of) as the bundle shown in the panel
  const analysisData = analysis.data;
  const gated = useMemo(() => gateAnalysis(analysisData, activeSymbol, tf), [analysisData, activeSymbol, tf]);
  const bundle = gated.bundle;
  const overlay = gated.overlay;
  const status = analysisStatus(bundle, analysis.error);
  const liveCandles = candles.data && candles.data.symbol === activeSymbol && candles.data.timeframe === tf ? candles.data : null;
  const mtf = mtfState.data?.mtf && (mtfState.data.mtf.symbol === null || mtfState.data.mtf.symbol === activeSymbol) ? mtfState.data.mtf : null;

  // create chart once
  useEffect(() => {
    if (!chartRef.current) return;
    const api = createChart(chartRef.current, {
      width: 0, height: 0,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8b8f99", fontFamily: "JetBrains Mono, monospace" },
      grid: { vertLines: { color: "#151922" }, horzLines: { color: "#151922" } },
      rightPriceScale: { borderColor: "#272d39" },
      timeScale: { borderColor: "#272d39", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    const series = api.addSeries(CandlestickSeries, {
      upColor: "#3fb68b", downColor: "#d9605e",
      wickUpColor: "#3fb68b", wickDownColor: "#d9605e",
      borderVisible: false,
    });
    // venue volume on its own overlay scale in the lower fifth of the pane
    const volume = api.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    api.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    // candles keep clear of the volume pane (visual QA V1: they overlapped)
    api.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });
    chartApi.current = api;
    seriesRef.current = series;
    volumeRef.current = volume;
    markersRef.current = createSeriesMarkers(series, []);
    api.timeScale().fitContent();
    const emas = emaRefs.current;
    return () => { api.remove(); chartApi.current = null; seriesRef.current = null; volumeRef.current = null; markersRef.current = null; emas.clear(); };
  }, []);

  // symbol change -> set server focus (advisory preference; mutation-guarded route)
  useEffect(() => {
    if (focus.data && focus.data.symbol !== activeSymbol) {
      fetch("/api/market/focus", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: activeSymbol }) }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSymbol]);

  /**
   * Reset progressive history when the series identity changes.
   * The loaded pages are stored KEYED BY SERIES, so switching symbol/timeframe
   * simply selects a different bucket — no state reset is required, which keeps
   * this free of effect-driven setState.
   */
  const seriesKey = `${activeSymbol}|${tf}`;

  /**
   * Pull one page of OLDER durable history from /api/market/history.
   * Deduplicates by timestamp and keeps ascending order.
   */
  const loadOlder = useCallback(async () => {
    const key = `${activeSymbol}|${tf}`;
    const bucket = historyBySeries[key];
    if (loadingRef.current || bucket?.exhausted) return;
    const live = candles.data?.candles ?? [];
    const known = [...(bucket?.bars ?? []), ...live];
    if (known.length === 0) return;
    const oldest = known.reduce((m, c) => Math.min(m, c.t), known[0].t);

    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const r = await fetch(`/api/market/history?symbol=${activeSymbol}&tf=${tf}&to=${oldest - 1}&limit=${PAGE_BARS}`);
      const j = (await r.json()) as {
        ok: boolean;
        candles?: { t: number; o: number; h: number; l: number; c: number }[];
        metadata?: { earliest_available: number | null; earliest_boundary_reached?: boolean };
      };
      const page = j.candles ?? [];
      const earliest = j.metadata?.earliest_available ?? null;
      // An empty page means the durable store has nothing older to serve. That
      // is NOT a venue boundary — only explicit completion evidence is. An
      // empty page used to be painted as "TTT boundary reached" for a
      // never-synced series.
      const venueBoundary = j.metadata?.earliest_boundary_reached === true;
      setHistoryBySeries((prev) => {
        const cur = prev[key] ?? { bars: [], exhausted: false, boundary: false, earliest: null };
        const seen = new Set(cur.bars.map((c) => c.t));
        const bars = [...cur.bars];
        for (const c of page) if (!seen.has(c.t)) bars.push(c);
        bars.sort((a, b) => a.t - b.t);
        const reachedStored = earliest !== null && bars.length > 0 && bars[0].t <= earliest;
        const noMoreStored = page.length === 0 || reachedStored;
        return { ...prev, [key]: { bars, exhausted: noMoreStored, boundary: venueBoundary, earliest: earliest ?? cur.earliest } };
      });
    } catch {
      /* transient; the user can scroll again */
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [activeSymbol, tf, candles.data, historyBySeries]);

  // DURABLE_HISTORY pages + the live COMPUTE_WINDOW → one series (adapter)
  const merged = useMemo(() => {
    const live = liveCandles && liveCandles.ok ? liveCandles.candles : [];
    return mergeBars(historyBySeries[seriesKey]?.bars ?? [], live, liveCandles?.last_bar_forming);
  }, [liveCandles, historyBySeries, seriesKey]);
  const barTimes = useMemo(() => new Set(merged.bars.map((b) => b.t)), [merged]);

  // candles + volume into the chart. Identity-gated: a late response for the
  // previous symbol/tf never reaches setData (liveCandles is null then) —
  // the chart is cleared instead of showing the old series under a new title.
  useEffect(() => {
    const s = seriesRef.current;
    const vol = volumeRef.current;
    if (!s || !vol) return;
    if (merged.bars.length === 0) { s.setData([]); vol.setData([]); return; }
    s.applyOptions({ priceFormat: priceFormatFor(merged.bars) });
    s.setData(toCandleData(merged.bars, merged.formingT).map((d) => ({ ...d, time: d.time as UTCTimestamp })));
    vol.setData(toVolumeData(merged.bars, merged.formingT).data.map((d) => ({ ...d, time: d.time as UTCTimestamp })));
    if ((historyBySeries[seriesKey]?.bars.length ?? 0) === 0) chartApi.current?.timeScale().fitContent();
  }, [merged, historyBySeries, seriesKey]);

  // scrolling to the left edge pulls the next page of durable history
  useEffect(() => {
    const api = chartApi.current;
    if (!api) return;
    const onRange = (range: { from: number; to: number } | null) => {
      if (!range) return;
      if (range.from <= 2) void loadOlder();
    };
    api.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => { try { api.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); } catch { /* disposed */ } };
  }, [loadOlder]);

  /**
   * Engine evidence -> chart. Everything drawn comes from the server overlay
   * (S/R, Fib, swings, open FVG/OB zones as top/bottom bands, BOS/CHoCH and
   * RSI-divergence markers). The component computes no technical object.
   * The forming price is the only live element and is labeled as such.
   */
  const render = useMemo(() => overlayToRender(overlay, barTimes), [overlay, barTimes]);
  useEffect(() => {
    const s = seriesRef.current;
    const api = chartApi.current;
    if (!s || !api) return;
    for (const ln of linesRef.current) { try { s.removePriceLine(ln); } catch { /* already gone */ } }
    linesRef.current = [];
    const lines = render.priceLines.map((l) => ({ price: l.price, color: l.color, lineStyle: l.lineStyle, title: l.title, axisLabel: l.axisLabel }));
    if (liveCandles?.forming_price != null && Number.isFinite(liveCandles.forming_price) && liveCandles.forming_price > 0) {
      lines.push({ price: liveCandles.forming_price, color: "#d4b874aa", lineStyle: 0, title: `live ${formatPrice(liveCandles.forming_price)}`, axisLabel: true });
    }
    for (const l of lines) {
      try {
        const pl = s.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.lineStyle, axisLabelVisible: l.axisLabel, title: l.title });
        linesRef.current.push(pl);
      } catch { /* invalid price line */ }
    }
    const markers: SeriesMarker<Time>[] = render.markers.map((m) => ({ ...m, time: m.time as UTCTimestamp }));
    try { markersRef.current?.setMarkers(markers); } catch { /* series disposed */ }
    // canonical EMA series from the server overlay (never computed here)
    const want = new Set(render.lineSeries.map((l) => l.id));
    for (const [id, ser] of emaRefs.current) {
      if (!want.has(id)) { try { api.removeSeries(ser); } catch { /* disposed */ } emaRefs.current.delete(id); }
    }
    for (const l of render.lineSeries) {
      let ser = emaRefs.current.get(l.id);
      if (!ser) {
        ser = api.addSeries(LineSeries, { color: l.color, lineWidth: 1, title: l.title, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        emaRefs.current.set(l.id, ser);
      }
      // ids are reused across symbol/tf switches: re-apply every visual option
      ser.applyOptions({ color: l.color, title: l.title, priceFormat: priceFormatFor(merged.bars) });
      ser.setData(l.data.map((d) => ({ ...d, time: d.time as UTCTimestamp })));
    }
  }, [render, merged, liveCandles?.forming_price]);

  const coverage = candles.data?.coverage;
  // show the provenance the server declared; only NATIVE is green
  const chartSrc = candles.data ? (candles.data.provenance === "NATIVE" || candles.data.provenance === "DERIVED" ? candles.data.provenance : String(candles.data.provenance ?? "UNKNOWN")) : null;

  return (
    <div className="grid gap-2 lg:grid-cols-[1fr_300px]">
      <Panel className="p-1">
        {/* symbol + tf bar */}
        <div className="flex flex-wrap items-center gap-1 border-b hairline px-1.5 py-1.5">
          <select
            aria-label="symbol"
            className="input w-[130px] px-2 py-1 text-[12.5px] font-semibold"
            value={activeSymbol}
            onChange={(e) => setSymbol(e.target.value)}
          >
            {(symState.data?.symbols ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="flex flex-wrap gap-0.5">
            {TFS.map((f) => (
              <button
                key={f}
                className={`btn px-2 py-1 text-[10.5px] ${tf === f ? "btn-active" : ""}`}
                onClick={() => setTf(f)}
              >
                {f}
                {f === "1d" ? " N" : ""}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5 text-[9.5px]">
            {candles.error && <Badge color="#d9605e">candles {candles.error}</Badge>}
            {chartSrc && <Badge color={chartSrc === "NATIVE" ? "#3fb68b" : "#d6a24a"}>{chartSrc}{candles.data?.derived_source_tf ? ` from ${candles.data.derived_source_tf}` : ""}</Badge>}
            {coverage && coverage.status === "PARTIAL" && <Badge color="#d6a24a">gaps {coverage.gap_count}</Badge>}
            {candles.data?.bars !== undefined && (
              <span className="text-dim">
                bars {(candles.data.bars ?? 0) + (historyBySeries[seriesKey]?.bars.length ?? 0)}
                {(historyBySeries[seriesKey]?.bars.length ?? 0) > 0 ? ` (+${historyBySeries[seriesKey]!.bars.length} history)` : ""}
              </span>
            )}
            {loadingOlder && <Badge color="#5f8fd0">loading older…</Badge>}
            {historyBySeries[seriesKey]?.boundary && <Badge color="#3fb68b">TTT boundary reached</Badge>}
            {historyBySeries[seriesKey]?.exhausted && !historyBySeries[seriesKey]?.boundary && (
              <Badge color="#8b8f98">no older stored history</Badge>
            )}
            {!historyBySeries[seriesKey]?.exhausted && !loadingOlder && (historyBySeries[seriesKey]?.bars.length ?? 0) > 0 && (
              <Badge color="#8b8f98">scroll left for more</Badge>
            )}
            {historyBySeries[seriesKey]?.earliest != null && (
              <span className="text-dim" title="earliest candle TTT has for this series">
                from {new Date(historyBySeries[seriesKey]!.earliest! * 1000).toISOString().slice(0, 10)}
              </span>
            )}
            <span className="text-dim">age {candles.data ? fmtAge(effectiveAgeMs(candles.data.age_ms ?? null, candles.age_ms)) : "…"}</span>
          </div>
        </div>
        <div ref={chartRef} style={{ height: 540 }} />
        {(!candles.data || candles.data.bars === 0) && (
          <div className="flex h-[540px] flex-col items-center justify-center gap-2" style={{ marginTop: -540 }}>
            <div className="text-[12px] text-muted">{candles.data?.reason ?? "waiting for real TTT candles…"}</div>
            <div className="text-[10px] text-dim">No fabricated candles, ever. Backfill runs inside the TTT rate budget.</div>
          </div>
        )}
      </Panel>

      <div className="flex flex-col gap-2">
        <Panel title={`${activeSymbol} · ${tf} analysis`}>
          {status && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[9.5px]" data-testid="analysis-status">
              <Badge color={status.color}>{status.label}</Badge>
              <span className="text-dim">{status.detail}</span>
            </div>
          )}
          {analysis.data?.available === false && (
            <div className="text-[11px] text-muted" data-testid="analysis-unavailable">
              {analysis.data.error_class && <Badge color="#8b8f98">{analysis.data.error_class}</Badge>} {analysis.data.reason ?? "analysis pending series…"}
            </div>
          )}
          {!bundle && analysis.error && <div className="text-[11px] text-muted">analysis unavailable ({analysis.error}) — not neutral, not zero</div>}
          {gated.bundleGate === "IDENTITY_MISMATCH" && <div className="text-[11px]" style={{ color: "#d9605e" }}>response belongs to another series — not shown</div>}
          {bundle && (
            <div className="grid grid-cols-2 gap-1.5">
              <Stat k="close" v={formatPrice(bundle.last_close)} />
              <Stat k="rsi14" v={fmt(bundle.indicators.rsi14)} title={bundle.indicator_status?.rsi14?.reason ?? undefined} />
              <Stat k="ema20" v={formatPrice(bundle.indicators.ema20)} title={bundle.indicator_status?.ema20?.reason ?? undefined} color="#d4b874" />
              <Stat k="ema50" v={formatPrice(bundle.indicators.ema50)} title={bundle.indicator_status?.ema50?.reason ?? undefined} color="#5f8fd0" />
              <Stat k="atr%" v={fmt(bundle.indicators.atr14_pct)} />
              <Stat k="trend" v={bundle.structure.trend} title={bundle.structure.reason} color={bundle.structure.trend === "up" ? "#3fb68b" : bundle.structure.trend === "down" ? "#d9605e" : undefined} />
              <Stat k="last leg" v={bundle.momentum?.last_leg ? `${bundle.momentum.last_leg.direction} ${fmt(bundle.momentum.last_leg.slope_atr)}×ATR/bar` : "—"} />
              <Stat k="leg ratio" v={fmt(bundle.momentum?.last_vs_previous_slope_ratio)} title="|slope last leg| / |slope previous leg| — no source threshold" />
            </div>
          )}
          {overlay && (
            <div className="mt-2 text-[10px] leading-relaxed text-dim">
              drawn: {overlay.lines.filter((l) => l.kind === "SR").length} S/R · {overlay.lines.filter((l) => l.kind === "FIB").length} fib · {overlay.zones.filter((z) => z.kind === "FVG").length} FVG · {overlay.zones.filter((z) => z.kind === "OB").length} OB · {overlay.markers.filter((m) => m.kind !== "DIVERGENCE").length} BOS/CHoCH · {overlay.markers.filter((m) => m.kind === "DIVERGENCE").length} div
              {(overlay.series ?? []).length > 0 && <> · {(overlay.series ?? []).map((x) => x.label).join(" / ")} lines</>}
              {overlay.omitted.length > 0 && <> · not drawn: {overlay.omitted.map((o) => `${o.count} ${o.kind} (${o.reason})`).join("; ")}</>}
              {render.unplaced.length > 0 && <> · unplaced: {render.unplaced.map((o) => `${o.count} ${o.kind} (${o.reason})`).join("; ")}</>}
              {(overlay.unavailable_layers ?? []).length > 0 && <><br />not available (spec missing, not &quot;none found&quot;): {(overlay.unavailable_layers ?? []).map((u) => `${u.layer} ${u.state}`).join(" · ")}</>}
              <br />zones = unmitigated as of window end (historical, not &quot;active&quot;) · BOS/CHoCH are structure events, not entries
              <br />closed bars only · last bar opened {utcLabel(overlay.as_of_t, "s")} · knowable at close {utcLabel(bundle?.provenance?.source_ts_ms, "ms")}
              <br /><span className="mono">snapshot {overlay.bundle_fingerprint}</span>
            </div>
          )}
          {!overlay && bundle && gated.overlayGate !== "OK" && (
            <div className="mt-2 text-[10px] text-dim">overlay not drawn: {gated.overlayGate}</div>
          )}
        </Panel>
        <Panel title="multi-timeframe hierarchy">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {(["macro", "context", "trigger"] as const).map((role, i) => {
              const comp = mtf?.components.find((c) => c.role === role);
              const b = mtf ? mtf[role] : null;
              const bias = mtf ? mtf[`${role}_bias` as const] : null;
              const label = role === "macro" ? "4H macro" : role === "context" ? "1H context" : "15M trigger";
              return (
                <span key={role} className="flex items-center gap-2">
                  {i > 0 && <span className="text-dim">→</span>}
                  <span className="panel-2 px-2 py-1" style={role === "trigger" ? { borderColor: "#d4b87455" } : undefined} title={comp ? `${comp.state} · ${comp.bars} bars · ${comp.freshness}` : undefined}>
                    {label}
                    <span className="ml-1 mono text-[10px]" style={{ color: bias === "long" ? "#3fb68b" : bias === "short" ? "#d9605e" : undefined }}>
                      {/* a component that is not OK shows its STATE, never a stale/partial trend */}
                      {comp && comp.state !== "OK" ? comp.state.toLowerCase() : b ? b.structure.trend : comp ? comp.state.toLowerCase() : "…"}
                    </span>
                  </span>
                </span>
              );
            })}
          </div>
          {mtf ? (
            <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
              <Badge color={VERDICT_COLOR[mtf.verdict] ?? "#8b8f98"}>{mtf.verdict}</Badge> {mtf.reason}
            </p>
          ) : (
            <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
              {mtfState.error ? `MTF unavailable: ${mtfState.error}` : "loading 4H/1H/15M…"} {CORE.has(tf) ? `Current view: ${tf}.` : "Switch to 4h/1h/15m for the core stack."}
            </p>
          )}
        </Panel>
        <Panel title="data truth">
          <ul className="space-y-1 text-[10.5px] text-muted">
            <li>· candles: {!candles.data?.source || candles.data.source === "ttt" ? "TTT /futures/udf/history" : `source=${candles.data.source}`} {candles.data?.native === true ? "(native)" : candles.data?.native === false ? "(derived fallback)" : ""}</li>
            <li>· 1D served NATIVE by TTT (verified); derived fallback is labeled</li>
            <li>· forming bar: {liveCandles?.last_bar_forming ? "drawn translucent with an outline (NOT closed; excluded from all analysis)" : "none in this window"}; live stats price drawn as a labeled line</li>
            <li>· volume: venue per-bar volume (lower pane) · EMA lines: server bundle series</li>
            <li>· refresh: symbol {activeSymbol} / TF {tf} / lang {lang}</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function Stat({ k, v, color, title }: { k: string; v: string; color?: string; title?: string }) {
  return (
    <div className="panel-2 px-2 py-1" title={title}>
      <div className="eyebrow">{k}</div>
      <div className="mono text-[13px] font-semibold" style={{ color }}>{v}</div>
    </div>
  );
}
function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  // non-price readouts (RSI, ATR%, ratios): a small non-zero magnitude keeps
  // 2 significant digits instead of collapsing to "0.00"
  if (v !== 0 && Math.abs(v) < 0.01) return v.toPrecision(2);
  return v > 100 ? v.toFixed(1) : v.toFixed(2);
}
