/**
 * Chart technical overlay contract (server-side, pure).
 *
 * The frontend must not compute EMA/RSI/ATR/structure/BOS/CHoCH/FVG/OB/Fib/
 * divergence/MTF. It receives this overlay — a render-ready projection of an
 * engine-produced AnalysisBundle — and only draws it. Every object carries the
 * bundle field it came from (`source`) so any drawn line is traceable to
 * engine evidence (implementation contract line 83: "draw only engine-produced
 * objects"; "do not show an indicator merely to decorate the chart").
 *
 * Nothing here creates a price: every price/time is copied from the bundle.
 * Display caps (how many zones are drawn) are ENGINEERING choices and each
 * omission is reported in `omitted`, never silently dropped.
 */
import type { AnalysisBundle, BundleSeries } from "../analysis/bundle";

export const OVERLAY_SCHEMA = "asa.chart.overlay.v1" as const;

/** ENGINEERING display caps — reported via `omitted` when they bite */
export const OVERLAY_LIMITS = { open_fvgs: 4, open_order_blocks: 3 } as const;

export type LineStyle = "solid" | "dashed" | "dotted";

/**
 * Absolute-final token rename (documented in docs/api-contract.md):
 *   TRENDLINE_SPEC_UNKNOWN → TRENDLINES_SPEC_LOCKED
 *   LIQUIDITY "UNKNOWN"    → LIQUIDITY_SPEC_UNKNOWN
 * so every token names its layer and why it is not drawn.
 */
export type UnavailableLayerState =
  | "TRENDLINES_SPEC_LOCKED"
  | "PARAMETERS_UNSPECIFIED"
  | "LIQUIDITY_SPEC_UNKNOWN"
  | "MOMENTUM_STRENGTH_THRESHOLD_UNKNOWN";

export interface UnavailableLayer {
  layer: "TRENDLINES" | "MACD" | "ICHIMOKU" | "ADX" | "LIQUIDITY" | "MOMENTUM_STRENGTH";
  state: UnavailableLayerState;
  reason: string;
}

/**
 * Layers the chart deliberately does NOT draw because their specification is
 * missing. Static spec status, identical for every bundle — listed so no
 * consumer can mistake absence for "nothing detected". See
 * docs/team02/spec-ledger.json for the evidence behind each entry.
 */
export const UNAVAILABLE_LAYERS: readonly UnavailableLayer[] = [
  { layer: "TRENDLINES", state: "TRENDLINES_SPEC_LOCKED", reason: "source describes post-break behaviour (the breakout zone is retested, not the line itself — RAW_1:301) but gives no rule for anchor selection, touch count, tolerance or validity" },
  { layer: "MACD", state: "PARAMETERS_UNSPECIFIED", reason: "source uses MACD but states no periods (12/26/9 appears only in document-generated code, RAW_2:666)" },
  { layer: "ICHIMOKU", state: "PARAMETERS_UNSPECIFIED", reason: "source states signal conditions but no tenkan/kijun/senkou periods" },
  { layer: "ADX", state: "PARAMETERS_UNSPECIFIED", reason: "source mentions ADX only as an example filter; no period" },
  { layer: "LIQUIDITY", state: "LIQUIDITY_SPEC_UNKNOWN", reason: "source discusses liquidity grabs at range highs/lows only conceptually (RAW_5:423/510); no computable pool or sweep definition" },
  { layer: "MOMENTUM_STRENGTH", state: "MOMENTUM_STRENGTH_THRESHOLD_UNKNOWN", reason: "legs are measured; the source gives no strong/weak threshold" },
];

export interface OverlayLine {
  id: string;
  kind: "SR" | "FIB" | "SWING";
  price: number;
  label: string;
  tone: "support" | "resistance" | "fib" | "neutral";
  style: LineStyle;
  source: string;
  /**
   * FIB only: open time (epoch s) of the bar whose close confirmed the leg
   * end — the grid did not exist before it. Absent for window-wide S/R/swing.
   */
  knowable_t?: number;
}

export interface OverlayZone {
  id: string;
  kind: "FVG" | "OB";
  direction: "up" | "down";
  top: number;
  bottom: number;
  /** open time (epoch s) of the bar where the zone became knowable */
  from_t: number;
  /**
   * Always HISTORICAL_ONLY: an unmitigated-as-of-window-end zone that was
   * detected in the past. The source defines no active/live/entry semantics
   * for FVG/OB (spec-ledger), so the chart never claims one.
   */
  status: "HISTORICAL_ONLY";
  label: string;
  source: string;
}

export interface OverlayMarker {
  id: string;
  kind: "BOS" | "CHOCH" | "DIVERGENCE";
  direction: "up" | "down";
  /** bar the marker is attached to (epoch s) */
  t: number;
  price: number;
  position: "above" | "below";
  label: string;
  source: string;
}

/**
 * Canonical indicator series projected for the chart (Task 10). Points are the
 * SAME arrays the bundle computed (no second calculation); warmup bars are
 * absent — never drawn as 0 — and `first_t` says where the series starts.
 */
export interface OverlaySeries {
  id: "ema20" | "ema50";
  kind: "EMA";
  period: number;
  label: string;
  points: { t: number; value: number }[];
  first_t: number | null;
  source: string;
}

export interface ChartOverlay {
  schema: typeof OVERLAY_SCHEMA;
  symbol: string;
  timeframe: string;
  /** open time of the last closed bar the overlay is valid for */
  as_of_t: number | null;
  engines: AnalysisBundle["provenance"]["engines"];
  /**
   * snapshot identity of the bundle this overlay projects
   * (provenance.input_fingerprint): equal fingerprints ⇒ the chart and a
   * decision consumer describe the SAME candles through the SAME engines
   */
  bundle_fingerprint: string;
  /** source freshness of that bundle (never recomputed by the chart) */
  freshness: AnalysisBundle["provenance"]["freshness"];
  /** canonical indicator series; empty when the caller supplied none */
  series: OverlaySeries[];
  lines: OverlayLine[];
  zones: OverlayZone[];
  markers: OverlayMarker[];
  omitted: { kind: string; count: number; reason: string }[];
  /** spec-missing layers that are never drawn (not "none detected") */
  unavailable_layers: readonly UnavailableLayer[];
}

const fin = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

export function buildChartOverlay(bundle: AnalysisBundle | null | undefined, bundleSeries?: BundleSeries | null): ChartOverlay | null {
  if (!bundle || bundle.bars === 0) return null;
  const series: OverlaySeries[] = [];
  const st = bundle.structure;
  const lines: OverlayLine[] = [];
  const zones: OverlayZone[] = [];
  const markers: OverlayMarker[] = [];
  const omitted: ChartOverlay["omitted"] = [];

  st.sr_levels.forEach((lv, i) => {
    if (!fin(lv.price)) return;
    lines.push({
      id: `sr:${i}`, kind: "SR", price: lv.price, label: `${lv.kind === "support" ? "S" : "R"} ×${lv.touches}`,
      tone: lv.kind, style: "dashed", source: `structure.sr_levels[${i}]`,
    });
  });

  if (st.fib_leg) {
    st.fib.forEach((f, i) => {
      if (!fin(f.price)) return;
      lines.push({
        id: `fib:${f.level}`, kind: "FIB", price: f.price, label: `fib ${f.level}`,
        tone: "fib", style: "dotted", source: `structure.fib[${i}] (leg ${st.fib_leg!.direction})`,
        knowable_t: st.fib_leg!.confirmed_t,
      });
    });
  }

  if (fin(st.last_swing_high)) lines.push({ id: "swing:high", kind: "SWING", price: st.last_swing_high, label: "swing H", tone: "neutral", style: "dotted", source: "structure.last_swing_high" });
  if (fin(st.last_swing_low)) lines.push({ id: "swing:low", kind: "SWING", price: st.last_swing_low, label: "swing L", tone: "neutral", style: "dotted", source: "structure.last_swing_low" });

  // zones: only OPEN (unmitigated as of the window end) zones are drawn
  const openFvgs = st.fvgs.map((g, i) => ({ g, i })).filter(({ g }) => g.mitigated_index === null && fin(g.top) && fin(g.bottom));
  const fvgMitigated = st.fvgs.length - openFvgs.length;
  if (fvgMitigated > 0) omitted.push({ kind: "FVG", count: fvgMitigated, reason: "mitigated (price traded back into the gap)" });
  const shownFvgs = openFvgs.slice(-OVERLAY_LIMITS.open_fvgs);
  if (openFvgs.length > shownFvgs.length) omitted.push({ kind: "FVG", count: openFvgs.length - shownFvgs.length, reason: `display cap ${OVERLAY_LIMITS.open_fvgs} most recent open gaps` });
  for (const { g, i } of shownFvgs) {
    zones.push({ id: `fvg:${g.index}`, kind: "FVG", direction: g.direction, top: g.top, bottom: g.bottom, from_t: g.t, status: "HISTORICAL_ONLY", label: `FVG ${g.direction === "up" ? "↑" : "↓"}`, source: `structure.fvgs[${i}]` });
  }

  const openObs = st.order_blocks.map((o, i) => ({ o, i })).filter(({ o }) => o.mitigated_index === null && fin(o.top) && fin(o.bottom));
  const obMitigated = st.order_blocks.length - openObs.length;
  if (obMitigated > 0) omitted.push({ kind: "OB", count: obMitigated, reason: "mitigated (price re-entered the block after the break)" });
  // order_blocks are most-recent-first
  const shownObs = openObs.slice(0, OVERLAY_LIMITS.open_order_blocks);
  if (openObs.length > shownObs.length) omitted.push({ kind: "OB", count: openObs.length - shownObs.length, reason: `display cap ${OVERLAY_LIMITS.open_order_blocks} most recent open blocks` });
  for (const { o, i } of shownObs) {
    zones.push({ id: `ob:${o.index}`, kind: "OB", direction: o.direction, top: o.top, bottom: o.bottom, from_t: o.t, status: "HISTORICAL_ONLY", label: `OB ${o.direction === "up" ? "↑" : "↓"} (${o.break_kind})`, source: `structure.order_blocks[${i}]` });
  }

  st.events.forEach((e, i) => {
    markers.push({
      id: `${e.kind.toLowerCase()}:${e.index}`, kind: e.kind, direction: e.direction, t: e.t, price: e.price,
      position: e.direction === "up" ? "above" : "below",
      label: e.kind === "CHOCH" ? `CHoCH ${e.direction === "up" ? "↑" : "↓"}` : `BOS ${e.direction === "up" ? "↑" : "↓"}`,
      source: `structure.events[${i}]`,
    });
  });

  bundle.divergence.events.forEach((d, i) => {
    const bearish = d.kind === "regular_bearish";
    markers.push({
      id: `div:${d.kind}:${d.to.index}`, kind: "DIVERGENCE", direction: bearish ? "down" : "up", t: d.to.t, price: d.to.price,
      position: bearish ? "above" : "below",
      label: `${d.kind.replace("_", " ")} (RSI)`,
      source: `divergence.events[${i}]`,
    });
  });
  if (bundleSeries) {
    // the series must belong to THIS bundle: same length and same last bar
    const aligned = bundleSeries.t.length === bundle.bars && bundleSeries.t[bundleSeries.t.length - 1] === bundle.as_of_t;
    for (const [id, period, last] of [["ema20", 20, bundle.indicators.ema20], ["ema50", 50, bundle.indicators.ema50]] as const) {
      const arr = bundleSeries[id];
      const lastArr = arr[arr.length - 1];
      if (!aligned || arr.length !== bundle.bars) { omitted.push({ kind: id.toUpperCase(), count: 1, reason: "series not aligned to the bundle window — not drawn" }); continue; }
      if ((lastArr ?? null) !== last) { omitted.push({ kind: id.toUpperCase(), count: 1, reason: "series last value differs from bundle.indicators — not drawn" }); continue; }
      const points: { t: number; value: number }[] = [];
      for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (fin(v)) points.push({ t: bundleSeries.t[i], value: v }); }
      series.push({ id, kind: "EMA", period, label: `EMA ${period}`, points, first_t: points.length ? points[0].t : null, source: `indicators.${id} (canonical ema, period ${period}, closed bars)` });
      if (points.length === 0) omitted.push({ kind: id.toUpperCase(), count: 1, reason: `warmup: needs ${period} closed bars` });
    }
  }

  // lightweight-charts requires ascending marker time
  markers.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));

  return {
    schema: OVERLAY_SCHEMA,
    symbol: bundle.symbol,
    timeframe: bundle.timeframe,
    as_of_t: bundle.as_of_t,
    bundle_fingerprint: bundle.provenance.input_fingerprint,
    freshness: bundle.provenance.freshness,
    engines: bundle.provenance.engines,
    series, lines, zones, markers, omitted,
    unavailable_layers: UNAVAILABLE_LAYERS,
  };
}
