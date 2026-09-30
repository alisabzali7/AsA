"use client";
/**
 * AsA FLAGSHIP CHART WORKSPACE (Cinematic Intelligence Terminal).
 *
 * Professional trading terminal architecture:
 * 1. Top Bar: Symbol selector & search, live price, 24h change & range, timeframe strip,
 *    chart style, indicators menu, real screenshot PNG export, real fullscreen, settings.
 * 2. Left Toolbar: Real interactive drawing tools (cursor, crosshair, trendline, horizontal line,
 *    vertical line, ray, rectangle box, measurement ruler, Fibonacci retracement, text notes,
 *    clear drawings, toggle hide/show).
 * 3. Main Chart Pane: Lightweight Charts with progressive history loading on pan-left, venue volume,
 *    real server technical overlay (S/R, Fib, FVG, OB, BOS/CHoCH, Divergence, canonical EMAs),
 *    live forming price line, crosshair hover inspection (OHLC tooltip), imperative drawing canvas overlay.
 * 4. Right Context Panel: Collapsible tabs (Orderbook & Trades, Evidence & MTF, Opportunities,
 *    Signals, AI Clone context jump, Provenance & Data Quality).
 * 5. Bottom Bar: Quick range buttons, venue boundary & provenance indicators, data age.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  AreaSeries,
  BarSeries,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartOverlay } from "@/lib/chart/technical";
import { normalizeHistoryPage } from "@/lib/chart/adapter";
import {
  analysisStatus,
  gateAnalysis,
  mergeBars,
  overlayToRender,
  priceFormatFor,
  CHART_RANGES,
  rangePartial,
  toCandleData,
  toVolumeData,
  visibleRangeFor,
  type ChartRange,
} from "@/lib/chart/adapter";

import { useLang } from "./lang";
import { usePoll, formatPrice, fmtAge } from "./hooks";
import { useSelection, useWatchlist } from "./selection";
import { effectiveAgeMs } from "./board-selectors";
import { Badge, Button, IconButton, Panel, Popover, Stat, StatusBadge, Tabs } from "./ui";
import { TruthState } from "./data-state";
import { useToast } from "./toast";
import {
  IconAi,
  IconCamera,
  IconChart,
  IconClose,
  IconCrosshair,
  IconCursor,
  IconEye,
  IconEyeOff,
  IconFibonacci,
  IconFullscreen,
  IconFullscreenExit,
  IconHorizontalLine,
  IconInfo,
  IconLayers,
  IconOpportunity,
  IconPin,
  IconPinFilled,
  IconRay,
  IconRectangle,
  IconRuler,
  IconSignal,
  IconSliders,
  IconText,
  IconTrash,
  IconTrendLine,
  IconVerticalLine,
} from "./icons";
import { useRouter } from "next/navigation";
import { TIMEFRAME_IDS } from "@/lib/domain/timeframes";

/**
 * Three-tier historical data model:
 * - DURABLE_HISTORY: stored TTT candle database loaded progressively on pan-left
 * - COMPUTE_WINDOW: indicator/analysis calculation window
 * - CHART_VIEWPORT: visible candles currently rendered in lightweight-charts
 */
const TFS = TIMEFRAME_IDS;
type Timeframe = (typeof TIMEFRAME_IDS)[number];

type DrawingTool =
  | "cursor"
  | "crosshair"
  | "trendline"
  | "horizontal"
  | "vertical"
  | "ray"
  | "rectangle"
  | "ruler"
  | "fibonacci"
  | "text";

type ChartType = "candlestick" | "line" | "area" | "bar";

interface DrawingPoint {
  time: number;
  price: number;
}

interface UserDrawing {
  id: string;
  tool: DrawingTool;
  symbol: string;
  points: DrawingPoint[];
  text?: string;
  color?: string;
}

interface CandleShape {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface CandlesShape {
  ok: boolean;
  symbol: string;
  timeframe: string;
  bars: number;
  candles: CandleShape[];
  native: boolean;
  provenance: string;
  derived_source_tf: string | null;
  coverage: { status: string; gap_count: number; bar_count: number; first_ts_ms: number | null } | null;
  forming_price: number | null;
  age_ms: number;
  /** market-data age of the series (server-computed, distinct from transport age) */
  data_age_ms: number | null;
  source_ts_ms: number | null;
  fetched_at_ms: number;
  reason?: string;
  last_bar_forming?: boolean;
  closed_count?: number;
  freshness?: string;
  source?: string;
}

interface AnalysisShape {
  ok: boolean;
  available?: boolean;
  reason?: string;
  error_class?: string | null;
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
  overlay?: ChartOverlay | null;
}

interface MtfShape {
  ok: boolean;
  symbol?: string;
  mtf?: {
    verdict: string;
    reason: string;
    symbol: string | null;
    macro_bias: string | null;
    context_bias: string | null;
    trigger_bias: string | null;
    components: { role: string; timeframe: string | null; state: string; bars: number; freshness: string }[];
    macro: { structure: { trend: string } } | null;
    context: { structure: { trend: string } } | null;
    trigger: { structure: { trend: string } } | null;
  };
}

interface StatsShape {
  ok: boolean;
  symbol: string;
  price: number | null;
  change24hPct: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24hQuote: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  age_ms: number | null;
  state: string;
  tick_size: number | null;
}

interface OrderbookShape {
  ok: boolean;
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  ts: number;
}

interface TradesShape {
  ok: boolean;
  symbol: string;
  trades: { id: string | number; price: number; size: number; side: "buy" | "sell" | "unknown"; ts: number }[];
}

interface OppItem {
  id: string;
  symbol: string;
  timeframe: string;
  direction: string;
  score: number;
  strategy_id: string;
  state: string;
  thesis?: string;
  entry_zone?: { top: number; bottom: number } | null;
  stop?: number | null;
  targets?: number[];
  risk?: { verdict: string; reasons: string[] } | null;
}

interface SigItem {
  id: string;
  symbol: string;
  timeframe: string;
  direction: string;
  score: number;
  state: string;
  strategy_id: string;
}

const VERDICT_COLOR: Record<string, string> = {
  ALIGNED: "var(--color-up)",
  PARTIAL: "var(--color-warn)",
  CONFLICT: "var(--color-down)",
};

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];

function readSavedDrawings(sym: string): UserDrawing[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(`asa-drawings-${sym}`);
    if (raw) return JSON.parse(raw);
    return [];
  } catch {
    return [];
  }
}

export function ChartView({ urlSymbol }: { urlSymbol?: string | null }) {
  const { lang, t } = useLang();
  const toast = useToast();
  const router = useRouter();
  const [sel, setSel] = useSelection();
  const [watchlist, toggleWatchlist] = useWatchlist();

  const symbol = sel.symbol ?? (urlSymbol || "BTCUSDT");
  const tf: Timeframe = (TFS as readonly string[]).includes(sel.tf ?? "") ? (sel.tf as Timeframe) : "15m";

  const setSymbol = (v: string) => setSel({ symbol: v });
  const setTf = (v: string) => setSel({ tf: v });

  // UI States
  const [chartType, setChartType] = useState<ChartType>("candlestick");
  const [activeTool, setActiveTool] = useState<DrawingTool>("cursor");
  const [drawingsVisible, setDrawingsVisible] = useState(true);
  const [rightPanelTab, setRightPanelTab] = useState<"inspector" | "evidence" | "opps" | "sigs" | "ai" | "provenance">("evidence");
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Indicator Visibility Toggles
  const [showEma20, setShowEma20] = useState(true);
  const [showEma50, setShowEma50] = useState(true);
  const [showSrLines, setShowSrLines] = useState(true);
  const [showFibLines, setShowFibLines] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showVolume, setShowVolume] = useState(true);
  const [showFormingLine, setShowFormingLine] = useState(true);

  // Hover Crosshair OHLC Data
  const [hoverOhlc, setHoverOhlc] = useState<{
    time?: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    changePct?: number;
    volume?: number;
  } | null>(null);

  // DOM & Chart API Refs
  const workspaceRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const canvasOverlayRef = useRef<HTMLCanvasElement>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const redrawCanvasRef = useRef<() => void>(() => {});

  const mainSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaRefs = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const linesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // History paging states
  const INITIAL_VIEWPORT_BARS = tf === "1m" ? 400 : 700;
  const PAGE_BARS = 1000;
  type Bar = { t: number; o: number; h: number; l: number; c: number; v?: number };
  interface HistoryBucket { bars: Bar[]; exhausted: boolean; boundary: boolean; earliest: number | null }
  const [historyBySeries, setHistoryBySeries] = useState<Record<string, HistoryBucket>>({});
  const [historyErrors, setHistoryErrors] = useState<Record<string, string | null>>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingRef = useRef(false);

  // Polled Endpoints
  const symState = usePoll<{ symbols: string[] }>("/api/market/symbols", 600_000);
  const availableSymbols = symState.data?.symbols ?? [];
  const activeSymbol = availableSymbols.length > 0 && !availableSymbols.includes(symbol) ? availableSymbols[0] : symbol;

  // User drawings state keyed by symbol
  const [drawingsBySymbol, setDrawingsBySymbol] = useState<Record<string, UserDrawing[]>>({});
  const drawings = drawingsBySymbol[activeSymbol] ?? readSavedDrawings(activeSymbol);
  const [drawingDraft, setDrawingDraft] = useState<DrawingPoint[]>([]);

  const statsPoll = usePoll<StatsShape>(`/api/market/stats?symbol=${activeSymbol}`, 6000);
  const candles = usePoll<CandlesShape>(
    `/api/market/candles?symbol=${activeSymbol}&tf=${tf}&limit=${INITIAL_VIEWPORT_BARS}&refresh=1`,
    tf === "1m" ? 12000 : 20000
  );
  const analysis = usePoll<AnalysisShape>(`/api/analysis/${activeSymbol}/${tf}`, 30000);
  const focus = usePoll<{ symbol: string }>("/api/market/focus", 30000);
  const mtfState = usePoll<MtfShape>(`/api/analysis/mtf/${activeSymbol}`, 60000);
  const obPoll = usePoll<OrderbookShape>(
    rightPanelOpen && rightPanelTab === "inspector" ? `/api/market/orderbook?symbol=${activeSymbol}` : null,
    5000
  );
  const tradesPoll = usePoll<TradesShape>(
    rightPanelOpen && rightPanelTab === "inspector" ? `/api/market/trades?symbol=${activeSymbol}` : null,
    5000
  );
  const oppsPoll = usePoll<{ ok: boolean; items: OppItem[] }>(
    rightPanelOpen && rightPanelTab === "opps" ? `/api/opportunities?symbol=${activeSymbol}&limit=20` : null,
    15000
  );
  const sigsPoll = usePoll<{ ok: boolean; items: SigItem[] }>(
    rightPanelOpen && rightPanelTab === "sigs" ? `/api/signals?symbol=${activeSymbol}&limit=20` : null,
    15000
  );

  const analysisData = analysis.data;
  const gated = useMemo(() => gateAnalysis(analysisData, activeSymbol, tf), [analysisData, activeSymbol, tf]);
  const bundle = gated.bundle;
  const overlay = gated.overlay;
  const status = analysisStatus(bundle, analysis.error);
  const liveCandles = candles.data && candles.data.symbol === activeSymbol && candles.data.timeframe === tf ? candles.data : null;
  const mtf = mtfState.data?.mtf && (mtfState.data.mtf.symbol === null || mtfState.data.mtf.symbol === activeSymbol) ? mtfState.data.mtf : null;

  /**
   * Quick-range buttons: each one sets a real time window derived from the
   * authoritative timeframe model. A window that reaches back past the oldest
   * loaded bar is labelled partial (see rangePartial) instead of pretending.
   */
  const isPinned = watchlist.includes(activeSymbol);
  const stats = statsPoll.data;
  const price = stats?.price ?? (liveCandles?.forming_price ?? null);
  const change24 = stats?.change24hPct;
  const isUp = change24 != null ? change24 >= 0 : null;

  // Redraw drawings to Canvas
  const redrawCanvas = useCallback(() => {
    const canvas = canvasOverlayRef.current;
    const api = chartApi.current;
    const series = mainSeriesRef.current;
    if (!canvas || !api || !series) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!drawingsVisible) return;

    const toX = (time: number) => api.timeScale().timeToCoordinate(time as UTCTimestamp);
    const toY = (priceVal: number) => series.priceToCoordinate(priceVal);

    for (const d of drawings) {
      if (d.tool === "horizontal" && d.points[0]) {
        const y = toY(d.points[0].price);
        if (y != null) {
          ctx.strokeStyle = "#d8bc78";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(canvas.width, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#d8bc78";
          ctx.font = "10px monospace";
          ctx.fillText(formatPrice(d.points[0].price), 10, y - 4);
        }
      } else if (d.tool === "vertical" && d.points[0]) {
        const x = toX(d.points[0].time);
        if (x != null) {
          ctx.strokeStyle = "#6ea3e8";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, canvas.height);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else if (d.tool === "trendline" && d.points[0] && d.points[1]) {
        const x1 = toX(d.points[0].time);
        const y1 = toY(d.points[0].price);
        const x2 = toX(d.points[1].time);
        const y2 = toY(d.points[1].price);
        if (x1 != null && y1 != null && x2 != null && y2 != null) {
          ctx.strokeStyle = "#d8bc78";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.fillStyle = "#d8bc78";
          ctx.beginPath();
          ctx.arc(x1, y1, 3, 0, Math.PI * 2);
          ctx.arc(x2, y2, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (d.tool === "ray" && d.points[0] && d.points[1]) {
        const x1 = toX(d.points[0].time);
        const y1 = toY(d.points[0].price);
        const x2 = toX(d.points[1].time);
        const y2 = toY(d.points[1].price);
        if (x1 != null && y1 != null && x2 != null && y2 != null) {
          const dx = x2 - x1;
          const dy = y2 - y1;
          ctx.strokeStyle = "#d8bc78";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 + dx * 20, y1 + dy * 20);
          ctx.stroke();
        }
      } else if (d.tool === "rectangle" && d.points[0] && d.points[1]) {
        const x1 = toX(d.points[0].time);
        const y1 = toY(d.points[0].price);
        const x2 = toX(d.points[1].time);
        const y2 = toY(d.points[1].price);
        if (x1 != null && y1 != null && x2 != null && y2 != null) {
          const rx = Math.min(x1, x2);
          const ry = Math.min(y1, y2);
          const rw = Math.abs(x2 - x1);
          const rh = Math.abs(y2 - y1);
          ctx.fillStyle = "rgba(216,188,120,0.12)";
          ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeStyle = "#d8bc78";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(rx, ry, rw, rh);
        }
      } else if (d.tool === "ruler" && d.points[0] && d.points[1]) {
        const x1 = toX(d.points[0].time);
        const y1 = toY(d.points[0].price);
        const x2 = toX(d.points[1].time);
        const y2 = toY(d.points[1].price);
        if (x1 != null && y1 != null && x2 != null && y2 != null) {
          const priceDiff = d.points[1].price - d.points[0].price;
          const pctDiff = d.points[0].price > 0 ? (priceDiff / d.points[0].price) * 100 : 0;
          ctx.strokeStyle = "#6ea3e8";
          ctx.lineWidth = 2;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.setLineDash([]);
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          ctx.fillStyle = "#06070a";
          ctx.fillRect(midX - 35, midY - 10, 70, 20);
          ctx.strokeStyle = "#6ea3e8";
          ctx.strokeRect(midX - 35, midY - 10, 70, 20);
          ctx.fillStyle = "#6ea3e8";
          ctx.font = "10px monospace";
          ctx.textAlign = "center";
          ctx.fillText(`${priceDiff >= 0 ? "+" : ""}${pctDiff.toFixed(2)}%`, midX, midY + 4);
          ctx.textAlign = "start";
        }
      } else if (d.tool === "fibonacci" && d.points[0] && d.points[1]) {
        const highP = Math.max(d.points[0].price, d.points[1].price);
        const lowP = Math.min(d.points[0].price, d.points[1].price);
        const diff = highP - lowP;
        for (const lvl of FIB_LEVELS) {
          const lvlPrice = highP - diff * lvl;
          const y = toY(lvlPrice);
          if (y != null) {
            ctx.strokeStyle = "#d8bc78";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
            ctx.fillStyle = "#d8bc78";
            ctx.font = "9px monospace";
            ctx.fillText(`${lvl} (${formatPrice(lvlPrice)})`, 10, y - 3);
          }
        }
      } else if (d.tool === "text" && d.points[0]) {
        const x = toX(d.points[0].time);
        const y = toY(d.points[0].price);
        if (x != null && y != null && d.text) {
          ctx.fillStyle = "#0e1118";
          ctx.fillRect(x, y - 14, d.text.length * 7 + 8, 18);
          ctx.strokeStyle = "#d8bc78";
          ctx.strokeRect(x, y - 14, d.text.length * 7 + 8, 18);
          ctx.fillStyle = "#d8bc78";
          ctx.font = "11px monospace";
          ctx.fillText(d.text, x + 4, y);
        }
      }
    }

    // Draw draft preview point
    if (drawingDraft[0]) {
      const dx = toX(drawingDraft[0].time);
      const dy = toY(drawingDraft[0].price);
      if (dx != null && dy != null) {
        ctx.fillStyle = "#d8bc78";
        ctx.beginPath();
        ctx.arc(dx, dy, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [drawings, drawingsVisible, drawingDraft]);

  // Chart subscriptions are intentionally stable for the lifetime of the
  // chart. Keep their paint callback current without making the chart itself
  // remount every time a drawing draft changes.
  useEffect(() => {
    redrawCanvasRef.current = redrawCanvas;
    redrawCanvas();
  }, [redrawCanvas]);

  // Save drawings helper
  const saveDrawings = useCallback((nextDrawings: UserDrawing[]) => {
    setDrawingsBySymbol((prev) => ({ ...prev, [activeSymbol]: nextDrawings }));
    try {
      localStorage.setItem(`asa-drawings-${activeSymbol}`, JSON.stringify(nextDrawings));
    } catch { /* ignore */ }
  }, [activeSymbol]);

  // Fullscreen listener
  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  const toggleFullscreen = async () => {
    if (!workspaceRef.current) return;
    if (!document.fullscreenElement) {
      try {
        await workspaceRef.current.requestFullscreen();
      } catch {
        toast.push({ title: "Fullscreen not supported", tone: "info" });
      }
    } else {
      try {
        await document.exitFullscreen();
      } catch { /* ignore */ }
    }
  };

  // Create lightweight-charts instance once
  useEffect(() => {
    if (!chartRef.current) return;
    const api = createChart(chartRef.current, {
      width: 0,
      height: 0,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8f95a3",
        fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(158,176,210,0.05)" },
        horzLines: { color: "rgba(158,176,210,0.06)" },
      },
      rightPriceScale: { borderColor: "#262e40" },
      timeScale: { borderColor: "#262e40", timeVisible: true, secondsVisible: false },
      crosshair: { mode: activeTool === "crosshair" ? 1 : 0 },
      autoSize: true,
    });

    let mainSeries: ISeriesApi<any>;
    if (chartType === "candlestick") {
      mainSeries = api.addSeries(CandlestickSeries, {
        upColor: "#43c495",
        downColor: "#e46a68",
        wickUpColor: "#3fae85",
        wickDownColor: "#c95d5b",
        borderVisible: false,
      });
    } else if (chartType === "area") {
      mainSeries = api.addSeries(AreaSeries, {
        topColor: "rgba(216, 188, 120, 0.4)",
        bottomColor: "rgba(216, 188, 120, 0.0)",
        lineColor: "#d8bc78",
        lineWidth: 2,
      });
    } else if (chartType === "bar") {
      mainSeries = api.addSeries(BarSeries, {
        upColor: "#43c495",
        downColor: "#e46a68",
      });
    } else {
      mainSeries = api.addSeries(LineSeries, {
        color: "#d8bc78",
        lineWidth: 2,
      });
    }

    const volume = api.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    api.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: showVolume });
    api.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });

    chartApi.current = api;
    mainSeriesRef.current = mainSeries;
    volumeRef.current = volume;
    markersRef.current = createSeriesMarkers(mainSeries, []);

    // Crosshair hover inspection
    api.subscribeCrosshairMove((param) => {
      redrawCanvasRef.current();
      if (!param.time || !param.seriesData.get(mainSeries)) {
        setHoverOhlc(null);
        return;
      }
      const data = param.seriesData.get(mainSeries) as any;
      if (!data) return;
      const volData = param.seriesData.get(volume) as any;
      if ("open" in data) {
        const changePct = data.open > 0 ? ((data.close - data.open) / data.open) * 100 : 0;
        setHoverOhlc({
          time: param.time as number,
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
          changePct,
          volume: volData?.value,
        });
      } else if ("value" in data) {
        setHoverOhlc({
          time: param.time as number,
          close: data.value,
          volume: volData?.value,
        });
      }
    });

    api.timeScale().subscribeVisibleLogicalRangeChange(() => redrawCanvasRef.current());
    api.timeScale().subscribeVisibleTimeRangeChange(() => redrawCanvasRef.current());

    const emas = emaRefs.current;
    return () => {
      api.remove();
      chartApi.current = null;
      mainSeriesRef.current = null;
      volumeRef.current = null;
      markersRef.current = null;
      emas.clear();
    };
  // activeTool/showVolume are applied by the two stable option effects below;
  // including them here would remount the chart and lose viewport continuity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType]);

  // Changing a tool or hiding the volume pane changes chart options, not the
  // chart instance. This keeps the user's viewport and drawings intact.
  useEffect(() => {
    chartApi.current?.applyOptions({ crosshair: { mode: activeTool === "crosshair" ? 1 : 0 } });
  }, [activeTool]);

  useEffect(() => {
    chartApi.current?.priceScale("vol").applyOptions({ visible: showVolume });
  }, [showVolume]);

  // Symbol change -> server focus update
  useEffect(() => {
    if (focus.data && focus.data.symbol !== activeSymbol) {
      fetch("/api/market/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: activeSymbol }),
      }).catch(() => {});
    }
  }, [activeSymbol, focus.data]);

  const seriesKey = `${activeSymbol}|${tf}`;

  // Load older durable history on scroll left
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
      const r = await fetch(`/api/market/history?symbol=${encodeURIComponent(activeSymbol)}&tf=${encodeURIComponent(tf)}&to=${oldest - 1}&limit=${PAGE_BARS}`, { cache: "no-store" });
      const normalized = normalizeHistoryPage(r.status, await r.json().catch(() => null));
      if (!normalized.ok) {
        setHistoryErrors((prev) => ({ ...prev, [key]: normalized.error }));
        return;
      }
      setHistoryErrors((prev) => ({ ...prev, [key]: null }));
      const page = normalized.candles;
      const earliest = normalized.earliest;
      // The backend proof remains earliest_boundary_reached === true; normalization does not invent it.
      const venueBoundary = normalized.venueBoundary;
      setHistoryBySeries((prev) => {
        const cur = prev[key] ?? { bars: [], exhausted: false, boundary: false, earliest: null };
        const seen = new Set(cur.bars.map((c) => c.t));
        const bars = [...cur.bars];
        for (const c of page) if (!seen.has(c.t)) bars.push(c);
        bars.sort((a, b) => a.t - b.t);
        const reachedStored = earliest !== null && bars.length > 0 && bars[0].t <= earliest;
        const noMoreStored = page.length === 0 || reachedStored;
        return {
          ...prev,
          [key]: { bars, exhausted: noMoreStored, boundary: venueBoundary, earliest: earliest ?? cur.earliest },
        };
      });
    } catch (error) {
      setHistoryErrors((prev) => ({
        ...prev,
        [key]: error instanceof Error ? error.message : "history request failed",
      }));
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [activeSymbol, tf, candles.data, historyBySeries]);

  // Merge history with live candles
  const merged = useMemo(() => {
    const live = liveCandles && liveCandles.ok ? liveCandles.candles : [];
    return mergeBars(historyBySeries[seriesKey]?.bars ?? [], live, liveCandles?.last_bar_forming);
  }, [liveCandles, historyBySeries, seriesKey]);


  const applyRange = useCallback(
    (rng: ChartRange) => {
      const api = chartApi.current;
      if (!api) return;
      if (rng.seconds === null) {
        api.timeScale().fitContent();
        return;
      }
      const range = visibleRangeFor(rng, merged.bars);
      if (!range) return;
      api.timeScale().setVisibleRange({ from: range.from as UTCTimestamp, to: range.to as UTCTimestamp });
    },
    [merged.bars],
  );

  const barTimes = useMemo(() => new Set(merged.bars.map((b) => b.t)), [merged]);

  // Set data to chart series
  useEffect(() => {
    const s = mainSeriesRef.current;
    const vol = volumeRef.current;
    if (!s || !vol) return;
    if (merged.bars.length === 0) {
      s.setData([]);
      vol.setData([]);
      return;
    }
    s.applyOptions({ priceFormat: priceFormatFor(merged.bars) });
    if (chartType === "candlestick" || chartType === "bar") {
      s.setData(toCandleData(merged.bars, merged.formingT).map((d) => ({ ...d, time: d.time as UTCTimestamp })));
    } else {
      s.setData(merged.bars.map((d) => ({ time: d.t as UTCTimestamp, value: d.c })));
    }
    vol.setData(toVolumeData(merged.bars, merged.formingT).data.map((d) => ({ ...d, time: d.time as UTCTimestamp })));
    if ((historyBySeries[seriesKey]?.bars.length ?? 0) === 0) {
      chartApi.current?.timeScale().fitContent();
    }
    redrawCanvasRef.current();
  }, [merged, historyBySeries, seriesKey, chartType]);

  // Pagination on scroll to left edge
  useEffect(() => {
    const api = chartApi.current;
    if (!api) return;
    const onRange = (range: { from: number; to: number } | null) => {
      if (!range) return;
      if (range.from <= 2) void loadOlder();
    };
    api.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => {
      try {
        api.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      } catch { /* disposed */ }
    };
  }, [loadOlder]);

  // Technical overlays from server
  const render = useMemo(() => overlayToRender(overlay, barTimes), [overlay, barTimes]);
  useEffect(() => {
    const s = mainSeriesRef.current;
    const api = chartApi.current;
    if (!s || !api) return;
    for (const ln of linesRef.current) {
      try {
        s.removePriceLine(ln);
      } catch { /* already gone */ }
    }
    linesRef.current = [];

    const lines: { price: number; color: string; lineStyle: number; title: string; axisLabel: boolean }[] = [];
    if (showSrLines) {
      lines.push(
        ...render.priceLines
          .filter((l) => l.title.includes("S/R") || l.title.includes("support") || l.title.includes("resistance"))
          .map((l) => ({ price: l.price, color: l.color, lineStyle: l.lineStyle, title: l.title, axisLabel: l.axisLabel }))
      );
    }
    if (showFibLines) {
      lines.push(
        ...render.priceLines
          .filter((l) => l.title.includes("fib") || l.title.includes("FIB"))
          .map((l) => ({ price: l.price, color: l.color, lineStyle: l.lineStyle, title: l.title, axisLabel: l.axisLabel }))
      );
    }

    if (
      showFormingLine &&
      liveCandles?.forming_price != null &&
      Number.isFinite(liveCandles.forming_price) &&
      liveCandles.forming_price > 0
    ) {
      lines.push({
        price: liveCandles.forming_price,
        color: "rgba(216,188,120,0.85)",
        lineStyle: 0,
        title: `live ${formatPrice(liveCandles.forming_price)}`,
        axisLabel: true,
      });
    }

    for (const l of lines) {
      try {
        const pl = s.createPriceLine({
          price: l.price,
          color: l.color,
          lineWidth: 1,
          lineStyle: l.lineStyle,
          axisLabelVisible: l.axisLabel,
          title: l.title,
        });
        linesRef.current.push(pl);
      } catch { /* ignore */ }
    }

    if (showMarkers) {
      const markers: SeriesMarker<Time>[] = render.markers.map((m) => ({ ...m, time: m.time as UTCTimestamp }));
      try {
        markersRef.current?.setMarkers(markers);
      } catch { /* ignore */ }
    } else {
      try {
        markersRef.current?.setMarkers([]);
      } catch { /* ignore */ }
    }

    // Canonical EMA series
    const want = new Set(
      render.lineSeries
        .filter((l) => (l.id === "ema20" ? showEma20 : l.id === "ema50" ? showEma50 : true))
        .map((l) => l.id)
    );
    for (const [id, ser] of emaRefs.current) {
      if (!want.has(id as any)) {
        try {
          api.removeSeries(ser);
        } catch { /* disposed */ }
        emaRefs.current.delete(id);
      }
    }
    for (const l of render.lineSeries) {
      if (!want.has(l.id)) continue;
      let ser = emaRefs.current.get(l.id);
      if (!ser) {
        ser = api.addSeries(LineSeries, {
          color: l.color,
          lineWidth: 1,
          title: l.title,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        emaRefs.current.set(l.id, ser);
      }
      ser.applyOptions({ color: l.color, title: l.title, priceFormat: priceFormatFor(merged.bars) });
      ser.setData(l.data.map((d) => ({ ...d, time: d.time as UTCTimestamp })));
    }
  }, [render, merged, liveCandles?.forming_price, showEma20, showEma50, showSrLines, showFibLines, showMarkers, showFormingLine]);

  // Real Screenshot capture function
  const handleTakeScreenshot = useCallback(async () => {
    if (!chartRef.current) return;
    const canvases = Array.from(chartRef.current.querySelectorAll("canvas"));
    if (canvases.length === 0) {
      toast.push({ title: "Screenshot failed: Canvas not ready", tone: "error" });
      return;
    }
    try {
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = Math.max(...canvases.map((canvas) => canvas.width));
      exportCanvas.height = Math.max(...canvases.map((canvas) => canvas.height));
      const ctx = exportCanvas.getContext("2d");
      if (!ctx) return;

      // Dark background, then every Lightweight Charts layer (price, volume,
      // grid and labels). The old implementation exported only the first
      // canvas, which silently dropped the volume pane in real screenshots.
      ctx.fillStyle = "#06070a";
      ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
      for (const canvas of canvases) ctx.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);

      // Draw user drawing canvas layer if present
      if (canvasOverlayRef.current) {
        ctx.drawImage(canvasOverlayRef.current, 0, 0);
      }

      // Watermark header
      ctx.fillStyle = "#d8bc78";
      ctx.font = "bold 16px monospace";
      ctx.fillText(`AsA TERMINAL · ${activeSymbol} · ${tf}`, 20, 30);
      ctx.fillStyle = "#8f95a3";
      ctx.font = "11px monospace";
      ctx.fillText(`Price: ${price != null ? formatPrice(price) : "—"} · ${new Date().toISOString()}`, 20, 50);

      // Export as PNG
      const dataUrl = exportCanvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.download = `AsA-${activeSymbol}-${tf}-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
      toast.push({ title: "Chart screenshot exported", body: `${activeSymbol} · ${tf} saved to PNG`, tone: "success" });
    } catch (err) {
      toast.push({ title: "Screenshot export failed", body: String(err), tone: "error" });
    }
  }, [activeSymbol, tf, price, toast]);

  // Coordinate helper for interactive drawings
  const getCoordinatesFromEvent = useCallback((e: React.MouseEvent<HTMLCanvasElement>): DrawingPoint | null => {
    const api = chartApi.current;
    const series = mainSeriesRef.current;
    if (!api || !series || !canvasOverlayRef.current) return null;
    const rect = canvasOverlayRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const time = api.timeScale().coordinateToTime(x) as number | null;
    const priceVal = series.coordinateToPrice(y) as number | null;
    if (time == null || priceVal == null) return null;
    return { time, price: priceVal };
  }, []);

  // Drawing mouse handlers
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === "cursor" || activeTool === "crosshair") return;
    const pt = getCoordinatesFromEvent(e);
    if (!pt) return;

    if (activeTool === "horizontal") {
      const newD: UserDrawing = {
        id: `h_${Date.now()}`,
        tool: "horizontal",
        symbol: activeSymbol,
        points: [pt],
      };
      saveDrawings([...drawings, newD]);
      setActiveTool("cursor");
      toast.push({ title: `Horizontal line placed at ${formatPrice(pt.price)}`, tone: "info" });
      return;
    }

    if (activeTool === "vertical") {
      const newD: UserDrawing = {
        id: `v_${Date.now()}`,
        tool: "vertical",
        symbol: activeSymbol,
        points: [pt],
      };
      saveDrawings([...drawings, newD]);
      setActiveTool("cursor");
      toast.push({ title: "Vertical time line placed", tone: "info" });
      return;
    }

    if (activeTool === "text") {
      const note = window.prompt("Enter annotation text:");
      if (note && note.trim()) {
        const newD: UserDrawing = {
          id: `t_${Date.now()}`,
          tool: "text",
          symbol: activeSymbol,
          points: [pt],
          text: note.trim(),
        };
        saveDrawings([...drawings, newD]);
      }
      setActiveTool("cursor");
      return;
    }

    // Two-point tools: trendline, ray, rectangle, ruler, fibonacci
    if (drawingDraft.length === 0) {
      setDrawingDraft([pt]);
    } else {
      const p1 = drawingDraft[0];
      const newD: UserDrawing = {
        id: `${activeTool}_${Date.now()}`,
        tool: activeTool,
        symbol: activeSymbol,
        points: [p1, pt],
      };
      saveDrawings([...drawings, newD]);
      setDrawingDraft([]);
      setActiveTool("cursor");
      toast.push({ title: `${activeTool} drawing placed`, tone: "info" });
    }
  };

  const clearAllDrawings = () => {
    saveDrawings([]);
    setDrawingDraft([]);
    toast.push({ title: "All drawings cleared", tone: "info" });
  };

  const coverage = candles.data?.coverage;
  /**
   * CANDLE FRESHNESS VERDICT — the server's own word for whether the series
   * on screen is current. It is never upgraded by a local timer: when the poll
   * says STALE the chart says STALE, and the forming bar stays marked unclosed.
   */
  const candleFreshness = candles.data && candles.status === "OK"
    ? {
        verdict: String(candles.data.freshness ?? "UNAVAILABLE").toUpperCase(),
        ageMs: effectiveAgeMs(candles.data.data_age_ms ?? null, candles.data.age_ms ?? null),
        forming: liveCandles?.last_bar_forming === true,
        closed: liveCandles?.closed_count ?? null,
      }
    : null;
  const chartSrc = candles.data
    ? candles.data.provenance === "NATIVE" || candles.data.provenance === "DERIVED"
      ? candles.data.provenance
      : String(candles.data.provenance ?? "UNKNOWN")
    : null;

  return (
    <div
      ref={workspaceRef}
      className={`flex flex-col gap-2 rounded-xl border hairline bg-[var(--color-ink)] p-2 ${
        isFullscreen ? "fixed inset-0 z-[var(--z-dialog)] h-screen w-screen p-3" : ""
      }`}
    >
      {/* -------------------------------------------------- TOP BAR -------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b hairline pb-2 px-1">
        {/* Left: Symbol, Price, Change, 24h Stats */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <select
              aria-label="active symbol"
              className="input w-[130px] font-bold text-[13px] text-gold"
              value={activeSymbol}
              onChange={(e) => setSymbol(e.target.value)}
            >
              {availableSymbols.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button
              onClick={() => toggleWatchlist(activeSymbol)}
              className="focus-ring icon-btn !h-7 !w-7 hover:text-gold"
              title={isPinned ? "remove from watchlist" : "pin to watchlist"}
              aria-pressed={isPinned}
            >
              {isPinned ? <IconPinFilled size={14} className="text-gold" /> : <IconPin size={14} />}
            </button>
          </div>

          <div className="flex items-baseline gap-2 border-s hairline ps-2">
            <span className="mono text-lg font-bold text-text">
              {formatPrice(price, stats?.tick_size)}
            </span>
            <span
              className="mono text-xs font-semibold"
              style={{ color: isUp ? "var(--color-up)" : isUp === false ? "var(--color-down)" : "var(--color-muted)" }}
            >
              {change24 != null ? `${isUp ? "+" : ""}${change24.toFixed(2)}%` : "—"}
            </span>
          </div>

            {/* Server freshness verdict + closed/forming bar truth */}
            {candleFreshness && (
              <div className="flex items-center gap-1.5 border-s hairline ps-2 text-[10px]">
                <StatusBadge
                  state={candleFreshness.verdict === "LIVE" || candleFreshness.verdict === "READY" ? "READY" : candleFreshness.verdict}
                />
                {candleFreshness.verdict !== "LIVE" && candleFreshness.verdict !== "READY" && (
                  <span className="text-dim" dir="auto">{t("chart", "notLive")}</span>
                )}
                <span className="text-dim mono iso">
                  {t("chart", "closedBars")}: {candleFreshness.closed ?? "—"}
                </span>
                <Badge color={candleFreshness.forming ? "var(--color-warn)" : "var(--color-dim)"}>
                  {candleFreshness.forming ? t("chart", "formingBar") : t("chart", "closedBars")}
                </Badge>
              </div>
            )}

          {stats?.high24h != null && stats?.low24h != null && (
            <div className="hidden 2xl:flex items-center gap-2 text-[10px] text-dim mono border-s hairline ps-2">
              <span>24h H: <strong className="text-muted">{formatPrice(stats.high24h)}</strong></span>
              <span>24h L: <strong className="text-muted">{formatPrice(stats.low24h)}</strong></span>
              <span>Vol: <strong className="text-muted">${stats.volume24hQuote ? (stats.volume24hQuote / 1e6).toFixed(1) + "M" : "—"}</strong></span>
            </div>
          )}
        </div>

        {/* Center: Timeframe Selector */}
        <div className="flex flex-wrap items-center gap-0.5 overflow-x-auto py-0.5">
          {TFS.map((f) => (
            <button
              key={f}
              className={`focus-ring btn px-2 py-0.5 text-[11px] font-semibold ${tf === f ? "btn-active" : ""}`}
              onClick={() => setTf(f)}
            >
              {f}
              {f === "1d" ? " N" : ""}
            </button>
          ))}
        </div>

        {/* Right: Chart Type, Indicators Popover, Screenshot, Fullscreen, Context Panel Toggle */}
        <div className="flex items-center gap-1 ms-auto">
          {/* Chart Type Selector */}
          <select
            className="input !py-0.5 text-[10.5px] w-[105px]"
            value={chartType}
            onChange={(e) => setChartType(e.target.value as ChartType)}
            aria-label="chart type"
          >
            <option value="candlestick">Candles</option>
            <option value="line">Line</option>
            <option value="area">Area</option>
            <option value="bar">Bars</option>
          </select>

          {/* Indicators Toggle Menu */}
          <Popover
            align="end"
            trigger={(open: boolean, toggle: () => void) => (
              <button
                className={`focus-ring btn !py-0.5 text-[10.5px] gap-1 ${open ? "btn-active" : ""}`}
                onClick={toggle}
                aria-label="indicators menu"
              >
                <IconLayers size={13} />
                <span className="hidden sm:inline">Indicators</span>
              </button>
            )}
          >
            {() => (
              <div className="w-[200px] space-y-1.5 p-1 text-[11px]">
                <div className="eyebrow text-gold border-b hairline pb-1">Technical Overlays</div>
                <label className="flex items-center justify-between cursor-pointer hover:text-gold">
                  <span>EMA 20</span>
                  <input type="checkbox" checked={showEma20} onChange={(e) => setShowEma20(e.target.checked)} />
                </label>
                <label className="flex items-center justify-between cursor-pointer hover:text-gold">
                  <span>EMA 50</span>
                  <input type="checkbox" checked={showEma50} onChange={(e) => setShowEma50(e.target.checked)} />
                </label>
                <label className="flex items-center justify-between cursor-pointer hover:text-gold">
                  <span>S/R Price Levels</span>
                  <input type="checkbox" checked={showSrLines} onChange={(e) => setShowSrLines(e.target.checked)} />
                </label>
                <label className="flex items-center justify-between cursor-pointer hover:text-gold">
                  <span>Fibonacci Levels</span>
                  <input type="checkbox" checked={showFibLines} onChange={(e) => setShowFibLines(e.target.checked)} />
                </label>
                <label className="flex items-center justify-between cursor-pointer hover:text-gold">
                  <span>BOS / CHoCH Markers</span>
                  <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} />
                </label>
                <label className="flex items-center justify-between cursor-pointer hover:text-gold">
                  <span>Volume Pane</span>
                  <input type="checkbox" checked={showVolume} onChange={(e) => setShowVolume(e.target.checked)} />
                </label>
                <label className="flex items-center justify-between cursor-pointer hover:text-gold">
                  <span>Live Forming Line</span>
                  <input type="checkbox" checked={showFormingLine} onChange={(e) => setShowFormingLine(e.target.checked)} />
                </label>
              </div>
            )}
          </Popover>

          {/* Screenshot Action */}
          <IconButton label="export screenshot to PNG" onClick={() => void handleTakeScreenshot()}>
            <IconCamera size={14} />
          </IconButton>

          {/* Fullscreen Action */}
          <IconButton label={isFullscreen ? "exit fullscreen" : "enter fullscreen"} onClick={() => void toggleFullscreen()}>
            {isFullscreen ? <IconFullscreenExit size={14} /> : <IconFullscreen size={14} />}
          </IconButton>

          {/* Toggle Right Context Panel */}
          <IconButton
            label={rightPanelOpen ? "hide context panel" : "show context panel"}
            onClick={() => setRightPanelOpen((o) => !o)}
            className={rightPanelOpen ? "!text-gold" : ""}
          >
            <IconSliders size={14} />
          </IconButton>
        </div>
      </div>

      {/* -------------------------------------------------- WORKSPACE MAIN -------------------------------------------------- */}
      <div className="grid gap-2 lg:grid-cols-[auto_1fr_auto] flex-1 min-h-[560px]">
        {/* 1. LEFT DRAWING TOOLBAR */}
        <div className="flex flex-row lg:flex-col items-center gap-1 border-b lg:border-b-0 lg:border-e hairline pb-1 lg:pb-0 lg:pe-1.5 shrink-0 overflow-x-auto">
          <IconButton
            label="Cursor / Pan Mode"
            className={activeTool === "cursor" ? "btn-active !text-gold" : ""}
            onClick={() => { setActiveTool("cursor"); setDrawingDraft([]); }}
          >
            <IconCursor size={15} />
          </IconButton>
          <IconButton
            label="Crosshair Inspection"
            className={activeTool === "crosshair" ? "btn-active !text-gold" : ""}
            onClick={() => { setActiveTool("crosshair"); setDrawingDraft([]); }}
          >
            <IconCrosshair size={15} />
          </IconButton>

          <div className="h-px w-full bg-[var(--color-line)] my-1 hidden lg:block" />

          <IconButton
            label="Trend Line"
            className={activeTool === "trendline" ? "btn-active !text-gold" : ""}
            onClick={() => { setActiveTool("trendline"); setDrawingDraft([]); }}
          >
            <IconTrendLine size={15} />
          </IconButton>
          <IconButton
            label="Horizontal Price Line"
            className={activeTool === "horizontal" ? "btn-active !text-gold" : ""}
            onClick={() => { setActiveTool("horizontal"); setDrawingDraft([]); }}
          >
            <IconHorizontalLine size={15} />
          </IconButton>
          <IconButton
            label="Vertical Time Line"
            className={activeTool === "vertical" ? "btn-active !text-gold" : ""}
            onClick={() => { setActiveTool("vertical"); setDrawingDraft([]); }}
          >
            <IconVerticalLine size={15} />
          </IconButton>
          <IconButton
            label="Ray"
            className={activeTool === "ray" ? "btn-active !text-gold" : ""}
            onClick={() => { setActiveTool("ray"); setDrawingDraft([]); }}
          >
            <IconRay size={15} />
          </IconButton>
          <IconButton
            label="Rectangle Zone Box"
            className={activeTool === "rectangle" ? "btn-active !text-gold" : ""}
            onClick={() => { setActiveTool("rectangle"); setDrawingDraft([]); }}
          >
            <IconRectangle size={15} />
          </IconButton>
          <IconButton
            label="Measurement Ruler"
            className={activeTool === "ruler" ? "btn-active !text-gold" : ""}
            onClick={() => { setActiveTool("ruler"); setDrawingDraft([]); }}
          >
            <IconRuler size={15} />
          </IconButton>
          <IconButton
            label="Fibonacci Retracement"
            className={activeTool === "fibonacci" ? "btn-active !text-gold" : ""}
            onClick={() => { setActiveTool("fibonacci"); setDrawingDraft([]); }}
          >
            <IconFibonacci size={15} />
          </IconButton>
          <IconButton
            label="Text Note"
            className={activeTool === "text" ? "btn-active !text-gold" : ""}
            onClick={() => { setActiveTool("text"); setDrawingDraft([]); }}
          >
            <IconText size={15} />
          </IconButton>

          <div className="h-px w-full bg-[var(--color-line)] my-1 hidden lg:block" />

          <IconButton
            label={drawingsVisible ? "Hide Drawings" : "Show Drawings"}
            onClick={() => setDrawingsVisible((v) => !v)}
            className={!drawingsVisible ? "text-dim" : ""}
          >
            {drawingsVisible ? <IconEye size={15} /> : <IconEyeOff size={15} />}
          </IconButton>
          <IconButton
            label="Clear All User Drawings"
            onClick={clearAllDrawings}
            disabled={drawings.length === 0}
          >
            <IconTrash size={15} />
          </IconButton>
        </div>

        {/* 2. MAIN CHART PANE & CANVAS DRAWINGS OVERLAY */}
        <div className="relative flex-1 min-w-0 bg-[var(--color-ink)] rounded-lg overflow-hidden border hairline">
          {/* OHLC Tooltip Banner */}
          {hoverOhlc && (
            <div className="absolute top-2 start-2 z-10 flex flex-wrap items-center gap-2 rounded bg-[rgba(6,7,10,0.88)] px-2 py-1 text-[10.5px] mono border hairline backdrop-blur-sm">
              <span className="text-dim">O: <strong className="text-text">{formatPrice(hoverOhlc.open)}</strong></span>
              <span className="text-dim">H: <strong className="text-text">{formatPrice(hoverOhlc.high)}</strong></span>
              <span className="text-dim">L: <strong className="text-text">{formatPrice(hoverOhlc.low)}</strong></span>
              <span className="text-dim">C: <strong className="text-text">{formatPrice(hoverOhlc.close)}</strong></span>
              {hoverOhlc.changePct != null && (
                <span style={{ color: hoverOhlc.changePct >= 0 ? "var(--color-up)" : "var(--color-down)" }}>
                  {hoverOhlc.changePct >= 0 ? "+" : ""}{hoverOhlc.changePct.toFixed(2)}%
                </span>
              )}
              {hoverOhlc.volume != null && (
                <span className="text-dim">Vol: <strong className="text-muted">{hoverOhlc.volume.toFixed(1)}</strong></span>
              )}
            </div>
          )}

          {/* Active Tool Banner */}
          {activeTool !== "cursor" && activeTool !== "crosshair" && (
            <div className="absolute top-2 end-2 z-10 flex items-center gap-2 rounded bg-gold-dim px-2.5 py-1 text-[10.5px] text-gold border border-gold-3">
              <span>Tool: <strong>{activeTool}</strong> {drawingDraft.length === 1 ? "(click 2nd point)" : "(click 1st point)"}</span>
              <button onClick={() => { setActiveTool("cursor"); setDrawingDraft([]); }} className="hover:text-text">
                <IconClose size={11} />
              </button>
            </div>
          )}

          {/* Lightweight Charts Canvas Container */}
          <div ref={chartRef} className="h-full min-h-[520px] w-full" />

          {/* Interactive Canvas Drawings Overlay */}
          <canvas
            ref={canvasOverlayRef}
            className={`absolute inset-0 h-full w-full pointer-events-${activeTool !== "cursor" && activeTool !== "crosshair" ? "auto" : "none"}`}
            onMouseDown={handleCanvasMouseDown}
          />

          {/* Loading / Error / Empty States */}
          {candles.status !== "OK" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[rgba(6,7,10,0.85)] px-6 backdrop-blur-xs">
              <TruthState
                status={candles.status}
                failure={candles.failure}
                onRetry={candles.refresh}
                staleAgeMs={candles.data ? candles.stale_age_ms : null}
                loadingText="requesting real TTT candles…"
              />
              <div className="text-[10px] text-dim">No fabricated candles. Backfill runs inside TTT rate budget.</div>
            </div>
          )}
          {candles.status === "OK" && liveCandles?.ok === true && (liveCandles.bars ?? 0) === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[rgba(6,7,10,0.85)] px-6">
              <div className="text-[12px] text-muted" dir="auto">
                No closed candles stored for {activeSymbol} · {tf} yet{liveCandles.reason ? ` — ${liveCandles.reason}` : ""}
              </div>
              <div className="text-[10px] text-dim">EMPTY is not an error — backfill in progress inside TTT budget.</div>
            </div>
          )}
        </div>

        {/* 3. RIGHT CONTEXT PANEL */}
        {rightPanelOpen && (
          <div className="w-full lg:w-[320px] flex flex-col gap-2 shrink-0">
            {/* Panel Tabs */}
            <Tabs
              label="Chart context tabs"
              value={rightPanelTab}
              onChange={setRightPanelTab}
              tabs={[
                { id: "evidence", label: "Evidence", icon: <IconLayers size={11} /> },
                { id: "inspector", label: "Depth", icon: <IconChart size={11} /> },
                { id: "opps", label: `Opps (${oppsPoll.data?.items?.length ?? 0})`, icon: <IconOpportunity size={11} /> },
                { id: "sigs", label: `Signals (${sigsPoll.data?.items?.length ?? 0})`, icon: <IconSignal size={11} /> },
                { id: "ai", label: "AI", icon: <IconAi size={11} /> },
                { id: "provenance", label: "Truth", icon: <IconInfo size={11} /> },
              ]}
            />

            {/* Evidence & Structure Tab */}
            {rightPanelTab === "evidence" && (
              <div className="flex flex-col gap-2">
                <Panel title={`${activeSymbol} · ${tf} Analysis`}>
                  {status && (
                    <div className="mb-2 flex items-center gap-1.5 text-[9.5px]">
                      <Badge color={status.color}>{status.label}</Badge>
                      <span className="text-dim truncate">{status.detail}</span>
                    </div>
                  )}
                  {bundle && (
                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat k="close" v={formatPrice(bundle.last_close)} />
                      <Stat k="rsi14" v={fmt(bundle.indicators.rsi14)} />
                      <Stat k="ema20" v={formatPrice(bundle.indicators.ema20)} color="var(--color-gold)" />
                      <Stat k="ema50" v={formatPrice(bundle.indicators.ema50)} color="var(--color-info)" />
                      <Stat k="atr%" v={fmt(bundle.indicators.atr14_pct)} />
                      <Stat
                        k="trend"
                        v={bundle.structure.trend}
                        color={bundle.structure.trend === "up" ? "var(--color-up)" : bundle.structure.trend === "down" ? "var(--color-down)" : undefined}
                      />
                    </div>
                  )}
                  {overlay && (
                    <div className="mt-2 text-[10px] text-dim leading-relaxed border-t hairline pt-1.5">
                      S/R: {overlay.lines.filter((l) => l.kind === "SR").length} · Fib: {overlay.lines.filter((l) => l.kind === "FIB").length} · FVG: {overlay.zones.filter((z) => z.kind === "FVG").length} · OB: {overlay.zones.filter((z) => z.kind === "OB").length} · BOS/CHoCH: {overlay.markers.length}
                    </div>
                  )}
                </Panel>

                <Panel title="Multi-Timeframe Bias">
                  <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
                    {(["macro", "context", "trigger"] as const).map((role, i) => {
                      const comp = mtf?.components.find((c) => c.role === role);
                      const bias = mtf ? mtf[`${role}_bias` as const] : null;
                      const label = role === "macro" ? "4H Macro" : role === "context" ? "1H Context" : "15M Trigger";
                      return (
                        <span key={role} className="flex items-center gap-1">
                          {i > 0 && <span className="text-dim">→</span>}
                          <span className="panel-2 px-1.5 py-0.5" title={comp ? `${comp.state} · ${comp.bars} bars` : undefined}>
                            {label}: <strong className="mono text-[10px]" style={{ color: bias === "long" ? "var(--color-up)" : bias === "short" ? "var(--color-down)" : undefined }}>
                              {comp && comp.state !== "OK" ? comp.state.toLowerCase() : bias ?? "…"}
                            </strong>
                          </span>
                        </span>
                      );
                    })}
                  </div>
                  {mtf && (
                    <p className="mt-1.5 text-[10.5px] text-muted">
                      <Badge color={VERDICT_COLOR[mtf.verdict] ?? "var(--color-muted)"}>{mtf.verdict}</Badge> {mtf.reason}
                    </p>
                  )}
                </Panel>
              </div>
            )}

            {/* Depth & Trades Tab */}
            {rightPanelTab === "inspector" && (
              <div className="flex flex-col gap-2">
                <Panel title="Live Orderbook Depth">
                  <div className="space-y-1 text-[11px] mono">
                    <div className="text-[10px] text-dim flex justify-between border-b hairline pb-1">
                      <span>Price</span>
                      <span>Size</span>
                    </div>
                    {(obPoll.data?.asks ?? []).slice(-5).reverse().map(([p, s], i) => (
                      <div key={i} className="flex justify-between" style={{ color: "var(--color-down)" }}>
                        <span>{formatPrice(p, stats?.tick_size)}</span>
                        <span className="text-dim">{s.toFixed(2)}</span>
                      </div>
                    ))}
                    <div className="py-0.5 text-center text-[10px] text-gold border-y hairline">
                      Mid: {formatPrice(price, stats?.tick_size)}
                    </div>
                    {(obPoll.data?.bids ?? []).slice(0, 5).map(([p, s], i) => (
                      <div key={i} className="flex justify-between" style={{ color: "var(--color-up)" }}>
                        <span>{formatPrice(p, stats?.tick_size)}</span>
                        <span className="text-dim">{s.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </Panel>

                <Panel title="Recent Tape">
                  <div className="max-h-[160px] overflow-y-auto space-y-0.5 text-[10.5px] mono">
                    {(tradesPoll.data?.trades ?? []).slice(0, 15).map((tr, i) => (
                      <div key={tr.id ?? i} className="flex justify-between">
                        <span style={{ color: tr.side === "buy" ? "var(--color-up)" : tr.side === "sell" ? "var(--color-down)" : "inherit" }}>
                          {formatPrice(tr.price, stats?.tick_size)}
                        </span>
                        <span className="text-dim">{tr.size.toFixed(2)}</span>
                        <span className="text-dim text-[9.5px]">{new Date(tr.ts).toLocaleTimeString("en-GB", { hour12: false })}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>
            )}

            {/* Opportunities Tab */}
            {rightPanelTab === "opps" && (
              <Panel title={`Opportunities for ${activeSymbol}`}>
                <div className="space-y-1.5 max-h-[460px] overflow-y-auto">
                  {(oppsPoll.data?.items ?? []).map((opp) => (
                    <div key={opp.id} className="panel-2 p-2 text-[11px]">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">{opp.timeframe} · {opp.direction}</span>
                        <StatusBadge state={opp.state} />
                      </div>
                      <div className="mt-1 flex gap-1">
                        <Badge color="var(--color-gold)">Score {opp.score}</Badge>
                        <Badge>{opp.strategy_id}</Badge>
                      </div>
                      {opp.thesis && <p className="mt-1 text-muted text-[10px]">{opp.thesis}</p>}
                    </div>
                  ))}
                  {(oppsPoll.data?.items?.length ?? 0) === 0 && (
                    <div className="text-center py-6 text-dim text-[11px]">No active opportunities for {activeSymbol}</div>
                  )}
                </div>
              </Panel>
            )}

            {/* Signals Tab */}
            {rightPanelTab === "sigs" && (
              <Panel title={`Signals for ${activeSymbol}`}>
                <div className="space-y-1.5 max-h-[460px] overflow-y-auto">
                  {(sigsPoll.data?.items ?? []).map((sig) => (
                    <div key={sig.id} className="panel-2 p-2 text-[11px]">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">{sig.timeframe} · {sig.direction}</span>
                        <StatusBadge state={sig.state} />
                      </div>
                      <div className="mt-1 flex gap-1">
                        <Badge color="var(--color-gold)">Score {sig.score}</Badge>
                        <Badge>{sig.strategy_id}</Badge>
                      </div>
                    </div>
                  ))}
                  {(sigsPoll.data?.items?.length ?? 0) === 0 && (
                    <div className="text-center py-6 text-dim text-[11px]">No signals for {activeSymbol}</div>
                  )}
                </div>
              </Panel>
            )}

            {/* AI Clone Jump Tab */}
            {rightPanelTab === "ai" && (
              <Panel title="AI Grounded Assistant">
                <p className="text-[11px] text-muted leading-relaxed">
                  Ask AI Clone about the deterministic structure, indicators, and risk verdict of <strong className="text-gold">{activeSymbol}</strong>.
                </p>
                <div className="mt-3 flex flex-col gap-1.5">
                  <Button
                    variant="gold"
                    className="!py-1 text-[11px]"
                    onClick={() => {
                      setSel({ symbol: activeSymbol, tf, returnTo: "/chart" });
                      router.push(`/ai-clone?q=${encodeURIComponent(`What is the technical and risk state of ${activeSymbol} on ${tf}?`)}`);
                    }}
                  >
                    <IconAi size={13} /> Analyze {activeSymbol} on {tf}
                  </Button>
                  <Button
                    variant="default"
                    className="!py-1 text-[11px]"
                    onClick={() => {
                      setSel({ symbol: activeSymbol, tf, returnTo: "/chart" });
                      router.push(`/ai-clone?q=${encodeURIComponent(`Is there liquidation or funding pressure on ${activeSymbol}?`)}`);
                    }}
                  >
                    Check Liquidation & Funding
                  </Button>
                </div>
              </Panel>
            )}

            {/* Provenance Tab */}
            {rightPanelTab === "provenance" && (
              <Panel title="Data Provenance & Truth">
                <ul className="space-y-1 text-[10.5px] text-muted">
                  <li>· Source: <strong className="mono text-text">{candles.data?.source ?? "ttt"}</strong></li>
                  <li>· Resolution: {chartSrc ? <Badge color="var(--color-up)">{chartSrc}</Badge> : "…"}</li>
                  <li>· Stored Bars: <strong className="mono text-text">{(candles.data?.bars ?? 0) + (historyBySeries[seriesKey]?.bars.length ?? 0)}</strong></li>
                  <li>· Gaps in series: <strong className="mono text-text">{coverage?.gap_count ?? 0}</strong></li>
                  <li>· Forming bar: <strong className="text-gold">{liveCandles?.last_bar_forming ? "ACTIVE (unclosed)" : "none"}</strong></li>
                  <li>· Transport age: <strong className="mono text-text">{candles.data ? fmtAge(effectiveAgeMs(candles.data.age_ms ?? null, candles.age_ms)) : "—"}</strong></li>
                </ul>
              </Panel>
            )}
          </div>
        )}
      </div>

      {/* -------------------------------------------------- BOTTOM BAR -------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t hairline pt-1.5 px-1 text-[10px] text-dim">
        <div className="flex items-center gap-1.5" role="group" aria-label={t("chart", "range")}>
          <span className="font-bold text-muted">{t("chart", "range")}:</span>
          {CHART_RANGES.map((rng) => {
            const partial = rangePartial(rng, merged.bars);
            return (
              <button
                key={rng.id}
                className="focus-ring btn !px-1.5 !py-0.5 text-[9.5px] text-dim hover:text-text"
                aria-label={
                  partial
                    ? `${rng.id} — ${t("chart", "rangePartial").replace("{span}", rng.id)}`
                    : `${rng.id}`
                }
                title={partial ? t("chart", "rangePartial").replace("{span}", rng.id) : undefined}
                onClick={() => applyRange(rng)}
              >
                {rng.id}
                {partial && <span aria-hidden className="ms-0.5 text-warn">*</span>}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 ms-auto">
          {historyErrors[seriesKey] && (
            <span role="status" className="flex items-center gap-1.5 rounded border border-[rgba(228,106,104,0.35)] px-2 py-1 text-[9.5px] text-warn" dir="auto">
              <span>older history unavailable — {historyErrors[seriesKey]}</span>
              <button className="focus-ring btn !px-1.5 !py-0.5 text-[9px]" onClick={() => void loadOlder()}>retry</button>
            </span>
          )}
          {loadingOlder && <Badge color="var(--color-info)">loading older history…</Badge>}
          {historyBySeries[seriesKey]?.boundary && <Badge color="var(--color-up)">TTT boundary reached</Badge>}
          <span className="text-dim">
            Age: {candles.data ? fmtAge(effectiveAgeMs(candles.data.age_ms ?? null, candles.age_ms)) : "—"}
          </span>
          <span className="text-dim">· Advisory only</span>
        </div>
      </div>
    </div>
  );
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v !== 0 && Math.abs(v) < 0.01) return v.toPrecision(2);
  return v > 100 ? v.toFixed(1) : v.toFixed(2);
}
