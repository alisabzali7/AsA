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
