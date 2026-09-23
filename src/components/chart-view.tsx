"use client";
/**
 * Chart-centric terminal: real TTT candles via the AsA API, TF switch including
 * native 1D, symbol switch over the DYNAMIC operational universe, structure
 * annotation lines, live forming price (labeled, never a fabricated candle).
 *
 * History model: an initial bounded CHART_VIEWPORT is rendered immediately and
 * older DURABLE_HISTORY is paged in as the user scrolls left, down to the TTT
 * venue boundary. A viewport limit is never a retention limit.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createChart, ColorType, CandlestickSeries, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp } from "lightweight-charts";
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
}
interface SymbolsShape { symbols: string[] }
interface AnalysisShape {
  ok: boolean;
  available?: boolean;
  bundle?: {
    last_close: number | null;
    structure: { trend: string; sr_levels: { price: number; strength: number; kind: string }[]; fvgs: { direction: string; top: number; bottom: number; t: number }[]; last_swing_high: number | null; last_swing_low: number | null };
    indicators: { rsi14: number | null; ema20: number | null; ema50: number | null; atr14_pct: number | null };
  };
}

export function ChartView({ urlSymbol }: { urlSymbol?: string | null }) {
  const { lang } = useLang();
  const [symbol, setSymbol] = useState<string>(urlSymbol && urlSymbol !== "BTCUSDT" ? urlSymbol : "BTCUSDT");
  const [tf, setTf] = useState<(typeof TFS)[number]>("15m");
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
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
  type Bar = { t: number; o: number; h: number; l: number; c: number };
  interface HistoryBucket { bars: Bar[]; exhausted: boolean; boundary: boolean; earliest: number | null }
  const [historyBySeries, setHistoryBySeries] = useState<Record<string, HistoryBucket>>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingRef = useRef(false);

  const symState = usePoll<SymbolsShape>("/api/market/symbols", 600_000);
  const candles = usePoll<CandlesShape>(`/api/market/candles?symbol=${symbol}&tf=${tf}&limit=${INITIAL_VIEWPORT_BARS}&refresh=1`, tf === "1m" ? 12000 : 20000);
  const analysis = usePoll<AnalysisShape>(`/api/analysis/${symbol}/${tf}`, 30000);
  const focus = usePoll<{ symbol: string }>("/api/market/focus", 30000);

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
    chartApi.current = api;
    seriesRef.current = series;
    api.timeScale().fitContent();
    return () => { api.remove(); chartApi.current = null; seriesRef.current = null; };
  }, []);

  // symbol change -> set server focus (advisory preference; mutation-guarded route)
  useEffect(() => {
    if (focus.data && focus.data.symbol !== symbol) {
      fetch("/api/market/focus", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol }) }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  /**
   * Reset progressive history when the series identity changes.
   * The loaded pages are stored KEYED BY SERIES, so switching symbol/timeframe
   * simply selects a different bucket — no state reset is required, which keeps
   * this free of effect-driven setState.
   */
  const seriesKey = `${symbol}|${tf}`;

  /**
   * Pull one page of OLDER durable history from /api/market/history.
   * Deduplicates by timestamp and keeps ascending order.
   */
  const loadOlder = useCallback(async () => {
    const key = `${symbol}|${tf}`;
    const bucket = historyBySeries[key];
    if (loadingRef.current || bucket?.exhausted) return;
    const live = candles.data?.candles ?? [];
    const known = [...(bucket?.bars ?? []), ...live];
    if (known.length === 0) return;
    const oldest = known.reduce((m, c) => Math.min(m, c.t), known[0].t);

    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const r = await fetch(`/api/market/history?symbol=${symbol}&tf=${tf}&to=${oldest - 1}&limit=${PAGE_BARS}`);
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
  }, [symbol, tf, candles.data, historyBySeries]);

  // candles into series: DURABLE_HISTORY pages + the live COMPUTE_WINDOW
  useEffect(() => {
    const s = seriesRef.current;
    if (!s || !candles.data || !candles.data.ok || !candles.data.candles.length) return;
    const byTs = new Map<number, Bar>();
    for (const c of historyBySeries[seriesKey]?.bars ?? []) byTs.set(c.t, c);
    for (const c of candles.data.candles) byTs.set(c.t, c); // live wins on overlap
    const merged = [...byTs.values()].sort((a, b) => a.t - b.t);
    s.setData(merged.map((c) => ({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })));
    if ((historyBySeries[seriesKey]?.bars.length ?? 0) === 0) chartApi.current?.timeScale().fitContent();
  }, [candles.data, historyBySeries, seriesKey, tf, symbol]);

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

  // analysis lines: S/R + last swing + forming price (live, labeled)
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const ln of linesRef.current) { try { s.removePriceLine(ln); } catch { /* already gone */ } }
    linesRef.current = [];
    const lines: { price: number; color: string; lineStyle: number; title: string }[] = [];
    const st = analysis.data?.bundle?.structure;
    if (st) {
      for (const lv of st.sr_levels ?? []) {
        lines.push({ price: lv.price, color: lv.kind === "support" ? "#3fb68b88" : "#d9605e88", lineStyle: 2, title: `S/R ${lv.strength}` });
      }
      if (st.last_swing_low) lines.push({ price: st.last_swing_low, color: "#5d616b88", lineStyle: 3, title: "swing L" });
      if (st.last_swing_high) lines.push({ price: st.last_swing_high, color: "#5d616b88", lineStyle: 3, title: "swing H" });
    }
    if (candles.data?.forming_price && candles.data.forming_price > 0) {
      lines.push({ price: candles.data.forming_price, color: "#d4b874aa", lineStyle: 0, title: `live ${formatPrice(candles.data.forming_price)}` });
    }
    for (const l of lines) {
      try {
        const pl = s.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.lineStyle as 0, axisLabelVisible: true, title: l.title });
        linesRef.current.push(pl);
      } catch { /* invalid price line */ }
    }
  }, [analysis.data, candles.data?.forming_price, candles.data?.candles?.length]);

  const coverage = candles.data?.coverage;
  const chartSrc = candles.data ? (candles.data.provenance === "NATIVE" ? "NATIVE" : "DERIVED") : null;

  return (
    <div className="grid gap-2 lg:grid-cols-[1fr_300px]">
      <Panel className="p-1">
        {/* symbol + tf bar */}
        <div className="flex flex-wrap items-center gap-1 border-b hairline px-1.5 py-1.5">
          <select
            aria-label="symbol"
            className="input w-[130px] px-2 py-1 text-[12.5px] font-semibold"
            value={symbol}
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
        <Panel title={`${symbol} · ${tf} analysis`}>
          {analysis.data?.available === false && <div className="text-[11px] text-muted">analysis pending series…</div>}
          {analysis.data?.bundle && (
            <div className="grid grid-cols-2 gap-1.5">
              <Stat k="close" v={formatPrice(analysis.data.bundle.last_close)} />
              <Stat k="rsi14" v={fmt(analysis.data.bundle.indicators.rsi14)} />
              <Stat k="ema20" v={formatPrice(analysis.data.bundle.indicators.ema20)} />
              <Stat k="ema50" v={formatPrice(analysis.data.bundle.indicators.ema50)} />
              <Stat k="atr%" v={fmt(analysis.data.bundle.indicators.atr14_pct)} />
              <Stat k="trend" v={analysis.data.bundle.structure.trend} color={analysis.data.bundle.structure.trend === "up" ? "#3fb68b" : analysis.data.bundle.structure.trend === "down" ? "#d9605e" : undefined} />
            </div>
          )}
        </Panel>
        <Panel title="multi-timeframe hierarchy">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="panel-2 px-2 py-1">4H macro</span>
            <span className="text-dim">→</span>
            <span className="panel-2 px-2 py-1">1H context</span>
            <span className="text-dim">→</span>
            <span className="panel-2 px-2 py-1" style={{ borderColor: "#d4b87455" }}>15M trigger</span>
          </div>
          <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
            Core hierarchy: 4H defines the macro regime, 1H the context, 15M the setup/trigger. {CORE.has(tf) ? `Current view: ${tf}.` : "Switch to 4h/1h/15m for the core stack."}
          </p>
        </Panel>
        <Panel title="data truth">
          <ul className="space-y-1 text-[10.5px] text-muted">
            <li>· candles: TTT /futures/udf/history {candles.data?.native === true ? "(native)" : candles.data?.native === false ? "(derived fallback)" : ""}</li>
            <li>· 1D served NATIVE by TTT (verified); derived fallback is labeled</li>
            <li>· forming bar: TTT stats price, drawn as a labeled line — not a candle</li>
            <li>· refresh: symbol {symbol} / TF {tf} / lang {lang}</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function Stat({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="panel-2 px-2 py-1">
      <div className="eyebrow">{k}</div>
      <div className="mono text-[13px] font-semibold" style={{ color }}>{v}</div>
    </div>
  );
}
function fmt(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v > 100 ? v.toFixed(1) : v.toFixed(2);
}
