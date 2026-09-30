/**
 * CHART RENDER ADAPTER (Task 10).
 *
 * Pure projection of server payloads (market candles, analysis bundle, chart
 * overlay) into the exact inputs the web chart hands to lightweight-charts.
 * It lives outside the React component so the whole chain
 *   bundle → overlay → JSON → adapter → render input
 * is testable in node (no DOM).
 *
 * Rules (Team 02):
 *   - computes NO technical object: no EMA/RSI/ATR/structure/zones. EMA lines
 *     are the bundle's own series (overlay.series); volume is the venue's
 *     per-bar `v` (market truth), coloured by candle direction only.
 *   - identity: every payload must match the requested symbol+timeframe, and
 *     the overlay must carry the bundle's fingerprint, or it is not drawn.
 *   - the forming (unclosed) bar is shown distinctly, never as a closed candle.
 *   - price precision adapts to magnitude, so sub-cent symbols stay readable.
 *   - freshness is displayed as the SERVER computed it; no threshold here.
 */
import type { ChartOverlay } from "./technical";

export interface BarIn { t: number; o: number; h: number; l: number; c: number; v?: number }

/**
 * Presentation-boundary normalization for progressive chart history.
 * A failed older-page request must remain an error; HTTP 503 with an empty
 * array is not proof that the venue history ended. Keeping this pure makes
 * the pagination contract regression-testable without mounting a chart.
 */
export interface HistoryPage {
  ok: true;
  candles: { t: number; o: number; h: number; l: number; c: number }[];
  earliest: number | null;
  venueBoundary: boolean;
}

export interface HistoryPageError {
  ok: false;
  error: string;
}

export type NormalizedHistoryPage = HistoryPage | HistoryPageError;

export function normalizeHistoryPage(status: number, body: unknown): NormalizedHistoryPage {
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? body as {
        ok?: unknown;
        error?: unknown;
        reason?: unknown;
        candles?: unknown;
        metadata?: { earliest_available?: unknown; earliest_boundary_reached?: unknown };
      }
    : null;

  if (status < 200 || status >= 300 || payload?.ok !== true) {
    const message = typeof payload?.error === "string" && payload.error.trim()
      ? payload.error
      : typeof payload?.reason === "string" && payload.reason.trim()
        ? payload.reason
        : `history request failed (HTTP ${status})`;
    return { ok: false, error: message };
  }

  const candles = Array.isArray(payload.candles)
    ? payload.candles.filter((c): c is { t: number; o: number; h: number; l: number; c: number } => {
        if (!c || typeof c !== "object") return false;
        const row = c as Record<string, unknown>;
        return [row.t, row.o, row.h, row.l, row.c].every((v) => typeof v === "number" && Number.isFinite(v));
      })
    : [];
  const earliest = typeof payload.metadata?.earliest_available === "number" && Number.isFinite(payload.metadata.earliest_available)
    ? payload.metadata.earliest_available
    : null;
  return {
    ok: true,
    candles,
    earliest,
    venueBoundary: payload.metadata?.earliest_boundary_reached === true,
  };
}

/** subset of the /api/analysis/{symbol}/{tf} bundle the chart reads */
export interface BundleView {
  symbol: string;
  timeframe: string;
  as_of_t: number | null;
  provenance?: { input_fingerprint?: string; freshness?: string; source_ts_ms?: number | null; data_age_ms?: number | null };
}

/* ------------------------------------------------------------ precision */

/**
 * Decimal places for a price of this magnitude: ~5 significant digits,
 * at least 2 (≥ 1) and at most 12. 65 000 → 2, 1.2345 → 4, 0.012345 → 6,
 * 0.0000012345 → 10. Never loses a sub-cent price to "0.00".
 */
export function decimalsFor(price: number): number {
  const a = Math.abs(price);
  if (!Number.isFinite(a) || a === 0) return 2;
  return Math.min(12, Math.max(2, 4 - Math.floor(Math.log10(a))));
}

/** lightweight-charts priceFormat from the median of the rendered closes */
export function priceFormatFor(bars: BarIn[]): { type: "price"; precision: number; minMove: number } {
  const closes = bars.map((b) => b.c).filter((c) => Number.isFinite(c) && c > 0).sort((x, y) => x - y);
  const ref = closes.length ? closes[Math.floor(closes.length / 2)] : 1;
  const precision = decimalsFor(ref);
  return { type: "price", precision, minMove: Number((10 ** -precision).toFixed(precision)) };
}

/* -------------------------------------------------------------- candles */

const UP = "#3fb68b", DOWN = "#d9605e";
const FORMING_UP = "#3fb68b55", FORMING_DOWN = "#d9605e55", FORMING_BORDER = "#d4b874";

export interface CandleDatum { time: number; open: number; high: number; low: number; close: number; color?: string; wickColor?: string; borderColor?: string }
export interface VolumeDatum { time: number; value: number; color: string }

const finiteBar = (b: BarIn) => [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite);

/**
 * DURABLE_HISTORY pages + live COMPUTE_WINDOW → one ascending, de-duplicated
 * series (live wins on overlap). `formingT` is the open time of the live
 * window's last bar when the server flagged it as still forming.
 */
export function mergeBars(history: BarIn[], live: BarIn[], lastBarForming: boolean | undefined): { bars: BarIn[]; formingT: number | null; dropped: number } {
  const byT = new Map<number, BarIn>();
  let dropped = 0;
  for (const b of history) { if (finiteBar(b)) byT.set(b.t, b); else dropped++; }
  for (const b of live) { if (finiteBar(b)) byT.set(b.t, b); else dropped++; }
  const bars = [...byT.values()].sort((a, b) => a.t - b.t);
  const lastLive = live.length ? live[live.length - 1] : null;
  const formingT = lastBarForming === true && lastLive && bars.length && bars[bars.length - 1].t === lastLive.t ? lastLive.t : null;
  return { bars, formingT, dropped };
}

export function toCandleData(bars: BarIn[], formingT: number | null): CandleDatum[] {
  return bars.map((b) => {
    const d: CandleDatum = { time: b.t, open: b.o, high: b.h, low: b.l, close: b.c };
    if (b.t === formingT) {
      // unclosed bar: translucent body + outlined, so it never reads as closed
      d.color = b.c >= b.o ? FORMING_UP : FORMING_DOWN;
      d.wickColor = FORMING_BORDER;
      d.borderColor = FORMING_BORDER;
    }
    return d;
  });
}

/** venue volume per bar; bars without a finite non-negative `v` are omitted (never 0) */
export function toVolumeData(bars: BarIn[], formingT: number | null): { data: VolumeDatum[]; missing: number } {
  const data: VolumeDatum[] = [];
  let missing = 0;
  for (const b of bars) {
    if (typeof b.v !== "number" || !Number.isFinite(b.v) || b.v < 0) { missing++; continue; }
    const base = b.c >= b.o ? UP : DOWN;
    data.push({ time: b.t, value: b.v, color: b.t === formingT ? `${base}33` : `${base}66` });
  }
  return { data, missing };
}

/* ------------------------------------------------------------- identity */

export type GateState = "OK" | "MISSING" | "IDENTITY_MISMATCH" | "FINGERPRINT_MISMATCH";

export function gateAnalysis<B extends BundleView>(
  data: { bundle?: B | null; overlay?: ChartOverlay | null } | null | undefined,
  symbol: string, timeframe: string,
): { bundle: B | null; overlay: ChartOverlay | null; bundleGate: GateState; overlayGate: GateState } {
  const b = data?.bundle ?? null;
  const o = data?.overlay ?? null;
  const bundleGate: GateState = !b ? "MISSING" : b.symbol === symbol && b.timeframe === timeframe ? "OK" : "IDENTITY_MISMATCH";
  const bundle = bundleGate === "OK" ? b : null;
  let overlayGate: GateState;
  if (!o) overlayGate = "MISSING";
  else if (o.symbol !== symbol || o.timeframe !== timeframe) overlayGate = "IDENTITY_MISMATCH";
  else if (!bundle || o.bundle_fingerprint !== bundle.provenance?.input_fingerprint || o.as_of_t !== bundle.as_of_t) overlayGate = "FINGERPRINT_MISMATCH";
  else overlayGate = "OK";
  return { bundle, overlay: overlayGate === "OK" ? o : null, bundleGate, overlayGate };
}

/* -------------------------------------------------------------- overlay */

const LINE_STYLE: Record<string, 0 | 1 | 2> = { solid: 0, dotted: 1, dashed: 2 };
const TONE: Record<string, string> = { support: "#3fb68b99", resistance: "#d9605e99", fib: "#8f7fd099", neutral: "#5d616b88" };
const EMA_COLOR: Record<string, string> = { ema20: "#d4b874", ema50: "#5f8fd0" };

/**
 * axisLabel: only S/R levels (and the live price) get a price-axis label.
 * Fib levels and zone edges keep their line + in-pane title; stacking 30+
 * axis labels hid the price scale itself (Task 10 visual QA, defect V2).
 */
export interface PriceLineSpec { price: number; color: string; lineStyle: 0 | 1 | 2; title: string; source: string; axisLabel: boolean }
export interface MarkerSpec { time: number; position: "aboveBar" | "belowBar"; shape: "circle" | "arrowUp" | "arrowDown" | "square"; color: string; text: string }
export interface LineSeriesSpec { id: string; title: string; color: string; data: { time: number; value: number }[] }

export interface OverlayRender {
  priceLines: PriceLineSpec[];
  markers: MarkerSpec[];
  lineSeries: LineSeriesSpec[];
  /** overlay objects that could not be placed (e.g. marker bar not loaded) */
  unplaced: { kind: string; count: number; reason: string }[];
}

/**
 * Overlay → render specs. Markers/series points are kept only on bar times
 * present in the drawn candle set (lightweight-charts cannot place anything
 * else) — the rest are counted, not silently lost.
 */
export function overlayToRender(overlay: ChartOverlay | null, barTimes: Set<number>): OverlayRender {
  const out: OverlayRender = { priceLines: [], markers: [], lineSeries: [], unplaced: [] };
  if (!overlay) return out;
  // one marker where the fib grid became knowable (leg end confirmed)
  const fibT = overlay.lines.find((l) => l.kind === "FIB" && typeof l.knowable_t === "number")?.knowable_t;
  if (fibT !== undefined) {
    if (barTimes.has(fibT)) out.markers.push({ time: fibT, position: "aboveBar", shape: "square", color: TONE.fib, text: "fib leg confirmed" });
    else out.unplaced.push({ kind: "FIB_ORIGIN", count: 1, reason: "leg confirmation bar not in the drawn candle set" });
  }
  for (const l of overlay.lines) {
    if (!Number.isFinite(l.price)) continue;
    out.priceLines.push({ price: l.price, color: TONE[l.tone] ?? TONE.neutral, lineStyle: LINE_STYLE[l.style] ?? 2, title: l.label, source: l.source, axisLabel: l.kind === "SR" });
  }
  // HISTORICAL_ONLY zones (unmitigated as of window end), TIME-BOUNDED: each
  // edge is a segment from the bar where the zone became knowable (from_t) to
  // the last closed bar (as_of_t) — never before it existed, never into the
  // forming bar. The server label is attached as a marker at the start bar.
  let lostZones = 0;
  let nonHistorical = 0;
  const zoneMarkers: MarkerSpec[] = [];
  const end = overlay.as_of_t;
  for (const z of overlay.zones) {
    // fail closed: the contract only defines HISTORICAL_ONLY zones; anything
    // else (missing status, or a claimed active/live zone) is not drawn
    if ((z as { status?: string }).status !== "HISTORICAL_ONLY") { nonHistorical++; continue; }
    if (!Number.isFinite(z.top) || !Number.isFinite(z.bottom)) continue;
    if (end === null || z.from_t > end || !barTimes.has(z.from_t) || !barTimes.has(end)) { lostZones++; continue; }
    const color = z.kind === "OB" ? (z.direction === "up" ? "#3f9bb6cc" : "#b65f9bcc") : (z.direction === "up" ? "#3fb68b99" : "#d9605e99");
    const seg = (v: number) => (z.from_t === end ? [{ time: z.from_t, value: v }] : [{ time: z.from_t, value: v }, { time: end, value: v }]);
    out.lineSeries.push({ id: `${z.id}:top`, title: "", color, data: seg(z.top) });
    out.lineSeries.push({ id: `${z.id}:bot`, title: "", color, data: seg(z.bottom) });
    zoneMarkers.push({ time: z.from_t, position: z.direction === "up" ? "belowBar" : "aboveBar", shape: "square", color, text: z.label });
  }
  if (lostZones) out.unplaced.push({ kind: "ZONE", count: lostZones, reason: "start bar or window end not in the drawn candle set" });
  if (nonHistorical) out.unplaced.push({ kind: "ZONE", count: nonHistorical, reason: "zone status is not HISTORICAL_ONLY — the contract defines no other zone semantics" });
  out.markers.push(...zoneMarkers);
  let lostMarkers = 0;
  for (const m of overlay.markers) {
    if (!barTimes.has(m.t)) { lostMarkers++; continue; }
    out.markers.push({
      time: m.t,
      position: m.position === "above" ? "aboveBar" : "belowBar",
      shape: m.kind === "DIVERGENCE" ? "circle" : m.direction === "up" ? "arrowUp" : "arrowDown",
      color: m.kind === "CHOCH" ? "#d4b874" : m.kind === "DIVERGENCE" ? "#8f7fd0" : m.direction === "up" ? UP : DOWN,
      text: m.label,
    });
  }
  if (lostMarkers) out.unplaced.push({ kind: "MARKER", count: lostMarkers, reason: "bar not in the drawn candle set" });
  for (const s of overlay.series ?? []) {
    const data = s.points.filter((p) => barTimes.has(p.t) && Number.isFinite(p.value)).map((p) => ({ time: p.t, value: p.value }));
    if (data.length < s.points.length) out.unplaced.push({ kind: s.id.toUpperCase(), count: s.points.length - data.length, reason: "points outside the drawn candle set" });
    out.lineSeries.push({ id: s.id, title: s.label, color: EMA_COLOR[s.id] ?? "#8b8f99", data });
  }
  out.markers.sort((a, b) => a.time - b.time);
  return out;
}

/* ------------------------------------------------------------ freshness */

export interface AnalysisStatus { label: string; color: string; detail: string }

/**
 * What the panel must say about the analysis it shows: the server's
 * freshness verdict, plus STALE-ON-ERROR when the latest poll failed and the
 * panel is still showing the previous good response.
 */
export function analysisStatus(bundle: BundleView | null, pollError: string | null): AnalysisStatus | null {
  if (!bundle) return pollError ? { label: "UNAVAILABLE", color: "#d9605e", detail: `analysis request failed: ${pollError}` } : null;
  const f = bundle.provenance?.freshness ?? "UNAVAILABLE";
  if (pollError) return { label: `${f} · LAST GOOD`, color: "#d6a24a", detail: `latest refresh failed (${pollError}); showing the previous response` };
  const color = f === "FRESH" ? "#3fb68b" : f === "STALE" ? "#d6a24a" : "#8b8f98";
  const age = bundle.provenance?.data_age_ms;
  return { label: f, color, detail: `server source freshness${typeof age === "number" ? ` · last close ${Math.round(age / 1000)}s ago` : ""}` };
}

/** "YYYY-MM-DD HH:MM UTC" from unix seconds or ms (explicit unit) */
export function utcLabel(v: number | null | undefined, unit: "s" | "ms"): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return `${new Date(unit === "s" ? v * 1000 : v).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/* ------------------------------------------------------- visible range model */

/**
 * Quick-range buttons (1D / 5D / 1M / 3M / ALL) for the chart's bottom bar.
 *
 * These controls used to all run `fitContent()`, so five buttons did one thing
 * and "1D" silently showed the whole loaded history. The model below expresses
 * each range as a REAL time window and:
 *   - measures the bar step from the series the server actually returned, so no
 *     timeframe table is duplicated into the browser (a gap can only inflate a
 *     diff, so the MINIMUM positive diff is the true step);
 *   - reports when the requested window reaches back past the oldest loaded
 *     bar, so the UI can label the button partial instead of pretending.
 * No prices, no candles, no fetching — arithmetic over real bar timestamps.
 */
export interface ChartRange {
  id: string;
  /** window length in seconds; null = everything currently loaded */
  seconds: number | null;
}

export const CHART_RANGES: readonly ChartRange[] = [
  { id: "1D", seconds: 86_400 },
  { id: "5D", seconds: 5 * 86_400 },
  { id: "1M", seconds: 30 * 86_400 },
  { id: "3M", seconds: 90 * 86_400 },
  { id: "ALL", seconds: null },
] as const;

export interface RangeBar {
  /** epoch seconds, aligned to the timeframe open */
  t: number;
}

/** Earliest / latest bar time across ascending series; null when none is loaded. */
export function barBounds(...series: (readonly RangeBar[])[]): { earliest: number; latest: number } | null {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const bars of series) {
    for (const b of bars) {
      if (typeof b.t !== "number" || !Number.isFinite(b.t)) continue;
      if (b.t < earliest) earliest = b.t;
      if (b.t > latest) latest = b.t;
    }
  }
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) return null;
  return { earliest, latest };
}

/**
 * Seconds per bar, MEASURED from the series (minimum positive consecutive
 * difference). null when the series has fewer than two bars — the caller then
 * must not claim a bar-accurate window.
 */
export function barStepSeconds(bars: readonly RangeBar[]): number | null {
  let step: number | null = null;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].t - bars[i - 1].t;
    if (!Number.isFinite(d) || d <= 0) continue;
    if (step === null || d < step) step = d;
  }
  return step;
}

/**
 * true when the requested window reaches back further than the oldest loaded
 * bar — i.e. the chart would show LESS than the button claims. Never true for
 * ALL (which means "everything loaded"), and never true without bars.
 */
export function rangePartial(range: ChartRange, bars: readonly RangeBar[]): boolean {
  if (range.seconds === null || bars.length === 0) return false;
  const bounds = barBounds(bars);
  if (!bounds) return false;
  return bounds.earliest > bounds.latest - range.seconds;
}

export interface VisibleRange {
  /** epoch seconds, for ITimeScaleApi.setVisibleRange */
  from: number;
  to: number;
}

/**
 * The visible range for a button press. `to` extends one measured bar step past
 * the newest bar so an unclosed forming bar stays visible. Returns null when
 * there is nothing to show, or for ALL — where `fitContent()` is the honest
 * answer (no synthetic window is invented).
 */
export function visibleRangeFor(range: ChartRange, bars: readonly RangeBar[]): VisibleRange | null {
  const bounds = barBounds(bars);
  if (!bounds) return null;
  if (range.seconds === null) return null;
  const step = barStepSeconds(bars);
  return { from: bounds.latest - range.seconds, to: bounds.latest + (step ?? 0) };
}
