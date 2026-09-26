/**
 * Deterministic feature detectors (Phase 2 §2).
 *
 * LOOKAHEAD SAFETY: every detector consumes an array of CLOSED candles and may
 * only reference indexes <= the last element. Callers slice the history to the
 * decision bar; nothing here peeks forward.
 *
 * SOURCE DISCIPLINE: numeric thresholds appear here ONLY where the corpus
 * states them (e.g. the pin-bar wick rules and the AB=CD 50% deep-correction
 * boundary). Structural tolerances that the corpus never quantified are
 * declared as explicit, named ENGINEERING PARAMETERS with a comment saying so —
 * they are never presented as instructor rules.
 */
import type { Candle } from "../domain/types";
import {
  clusterSwingLevels, fibOfLastLeg, findSwings, structureEvents, swingBias, type SwingPoint,
} from "../analysis/structure";
import { atr, ema, rsi } from "../analysis/indicators";
import { invalidFeature, okFeature, type FeatureValue } from "./types";

/**
 * 1.1.0 (Team 02 recovery): FTR-BOS / FTR-CHOCH / FTR-FIB now delegate to the
 * canonical causal structure engine (analysis/structure.ts) instead of a
 * competing local definition. Detectors consumed by compiled strategies
 * (swings, structure bias, levels, ATR, ABCD, double, pinbar, rejection,
 * momentum candle, volatility regime) are numerically unchanged — they share
 * code with the engine but keep identical outputs (tests/strategy-engine).
 * The version bump is still required by the FeatureValue contract because
 * detector semantics changed.
 */
export const DETECTOR_VERSION = "1.1.0";

/**
 * ENGINEERING PARAMETERS (not from the corpus).
 * Structural detectors need tolerances the transcripts never quantified.
 * They are grouped here so an audit can see every non-source number at once,
 * and so they can be swept during parameter-sensitivity testing.
 */
export const ENGINEERING_PARAMS = {
  /** fractal half-width for swing detection */
  swing_left: 2,
  swing_right: 2,
  /** level clustering tolerance, in ATR multiples */
  level_cluster_atr: 0.35,
  /** how close price must be to a level to count as "touching" it */
  level_touch_atr: 0.30,
  /** double top/bottom: max separation of the two peaks, in ATR */
  double_peak_tol_atr: 0.50,
  /** double top/bottom: minimum bars between the two peaks */
  double_peak_min_gap: 3,
  /**
   * momentum candle: body must exceed this multiple of recent average body.
   * NOT the source Marubozu (RAW_1:1103; RAW_2:1212's "2x ATR" is an example)
   * and NOT swing-leg momentum (analysis/momentum.ts, RAW_4:1196).
   */
  momentum_body_mult: 1.5,
  /** pin bar: range must exceed this multiple of the 5-bar average range (corpus says only "not equal-sized") */
  pinbar_size_mult: 1.1,
  /** rejection: wick must exceed this fraction of the candle range */
  rejection_wick_min_ratio: 0.3,
  /** AB=CD leg-equality tolerance as a fraction of AB */
  abcd_equality_tol: 0.15,
  /** AB=CD slope comparison tolerance */
  abcd_slope_tol: 0.25,
  /** volatility regime: current ATR above this multiple of its 30-value mean = EXPANSION */
  vol_expansion_mult: 1.2,
  /** volatility regime: current ATR below this multiple of its 30-value mean = COMPRESSION */
  vol_compression_mult: 0.8,
} as const;

/** Corpus-stated constants, with the source line that states them. */
export const SOURCE_PARAMS = {
  /** RAW_4: pin-bar wick must be at least 2x the body */
  pinbar_wick_body_ratio: 2,
  /** RAW_4: body must be a small part of the total range */
  pinbar_body_max_range_frac: 1 / 3,
  /** RAW_4 AB=CD: correction deeper than 50% of AB = "deep correction" */
  deep_correction_frac: 0.5,
  /** RAW_2: a PRZ needs repeated historical reactions (5-7 stated) */
  prz_min_touches: 5,
  /** RAW_2 (invisible levels): 2-3 prior reactions stated */
  invisible_level_min_touches: 2,
} as const;

const last = <T>(a: T[]): T | undefined => a[a.length - 1];

/**
 * Value of an indicator series AT THE DECISION BAR (last index), or undefined.
 * Task 09 (DET-1): the previous `last(arr.filter(nonNull))` would silently
 * fall back to an OLDER bar's value if the newest one were null. Canonical
 * indicators never produce that shape today (all-null on non-finite input,
 * contiguous once warm), so outputs are unchanged — but a feature stamped
 * with the last bar's timestamp must describe the last bar, never a previous one.
 */
const atLast = (a: (number | null)[]): number | undefined => {
  const v = a[a.length - 1];
  return v === null || v === undefined || !Number.isFinite(v) ? undefined : v;
};
function guard(
  id: string,
  tf: string,
  candles: Candle[],
  minBars: number,
): FeatureValue<never> | null {
  if (candles.length < minBars) {
    return invalidFeature(
      id, tf, "INSUFFICIENT_BARS",
      `needs ${minBars} closed bars, got ${candles.length}`, DETECTOR_VERSION, ["candles"],
    );
  }
  // Task 09 (DET-3): a non-finite price/time anywhere in the window is corrupt
  // input, not "no pattern" and not "insufficient bars". Volume is not read by
  // any detector and is therefore not guarded here.
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!Number.isFinite(c.t) || !Number.isFinite(c.o) || !Number.isFinite(c.h) || !Number.isFinite(c.l) || !Number.isFinite(c.c)) {
      return invalidFeature(
        id, tf, "UNAVAILABLE",
        `non-finite candle field at window index ${i} — no feature computed`, DETECTOR_VERSION, ["candles"],
      );
    }
  }
  return null;
}

/* ------------------------------------------------------------- STRUCTURE */

export interface SwingSeries {
  swings: SwingPoint[];
  highs: SwingPoint[];
  lows: SwingPoint[];
}

export function detectSwings(candles: Candle[], tf: string): FeatureValue<SwingSeries> {
  const g = guard("FTR-SWINGS", tf, candles, 20);
  if (g) return g as unknown as FeatureValue<SwingSeries>;
  const swings = findSwings(candles, ENGINEERING_PARAMS.swing_left, ENGINEERING_PARAMS.swing_right);
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  if (swings.length === 0) {
    return invalidFeature("FTR-SWINGS", tf, "OK", "no fractal swings in window", DETECTOR_VERSION, ["candles"]);
  }
  return okFeature("FTR-SWINGS", tf, { swings, highs, lows }, last(candles)!.t, candles.length,
    DETECTOR_VERSION, ["candles"], `${highs.length} highs / ${lows.length} lows`);
}

export type StructureBias = "HH_HL" | "LH_LL" | "MIXED";

export interface StructureState {
  bias: StructureBias;
  hh: boolean; hl: boolean; lh: boolean; ll: boolean;
  last_swing_high: number | null;
  last_swing_low: number | null;
}

/** HH/HL/LH/LL classification from the two most recent swings of each kind. */
export function detectStructureBias(candles: Candle[], tf: string): FeatureValue<StructureState> {
  const sw = detectSwings(candles, tf);
  if (!sw.valid || !sw.value) {
    return invalidFeature("FTR-STRUCT-BIAS", tf, sw.data_quality, sw.reason, DETECTOR_VERSION, ["FTR-SWINGS"]);
  }
  const { highs, lows } = sw.value;
  const b = swingBias(sw.value.swings);
  if (!b) {
    return invalidFeature("FTR-STRUCT-BIAS", tf, "INSUFFICIENT_BARS",
      `needs 2 highs and 2 lows, got ${highs.length}/${lows.length}`, DETECTOR_VERSION, ["FTR-SWINGS"]);
  }
  const { prev_high: h1, last_high: h2, prev_low: l1, last_low: l2 } = b;
  return okFeature("FTR-STRUCT-BIAS", tf,
    { bias: b.bias, hh: b.hh, hl: b.hl, lh: b.lh, ll: b.ll, last_swing_high: h2, last_swing_low: l2 },
    last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"],
    `H ${h1.toFixed(4)}->${h2.toFixed(4)}, L ${l1.toFixed(4)}->${l2.toFixed(4)}`);
}

export interface BreakEvent { direction: "up" | "down"; price: number; t: number; index: number; kind: "BOS" | "CHOCH" }

/**
 * Structural break produced AT THE LAST CLOSED BAR by the canonical causal
 * engine (analysis/structure:structureEvents). Only confirmed swings are ever
 * broken; the event belongs to the bar whose close broke the level.
 */
function breakAtLastBar(candles: Candle[], tf: string, id: string): FeatureValue<BreakEvent | null> {
  const sw = detectSwings(candles, tf);
  if (!sw.valid || !sw.value) {
    return invalidFeature(id, tf, sw.data_quality, sw.reason, DETECTOR_VERSION, ["FTR-SWINGS"]);
  }
  const n = candles.length;
  const events = structureEvents(candles, sw.value.swings);
  const e = events.length && events[events.length - 1].index === n - 1 ? events[events.length - 1] : null;
  const ev: BreakEvent | null = e ? { direction: e.direction, price: e.price, t: e.t, index: e.index, kind: e.kind } : null;
  return okFeature(id, tf, ev, candles[n - 1].t, n, DETECTOR_VERSION, ["FTR-SWINGS"],
    ev ? `close ${candles[n - 1].c} ${ev.kind} ${ev.direction} through swing ${ev.price}` : "no structural break at last close");
}

/** BOS (any structural break at the last close — BOS or CHoCH both break a swing). */
export function detectBOS(candles: Candle[], tf: string): FeatureValue<BreakEvent | null> {
  return breakAtLastBar(candles, tf, "FTR-BOS");
}

/** CHoCH: the break at the last close is the FIRST against the prevailing structure (RAW_5:674). */
export function detectCHOCH(candles: Candle[], tf: string): FeatureValue<BreakEvent | null> {
  const b = breakAtLastBar(candles, tf, "FTR-CHOCH");
  if (!b.valid) return b;
  const choch = b.value && b.value.kind === "CHOCH" ? b.value : null;
  return { ...b, value: choch, reason: choch ? `counter-trend break ${choch.direction} at ${choch.price}` : "no change of character" };
}

export type RangeState = "EXPANSION" | "COMPRESSION" | "NEUTRAL";

/**
 * ATR gate for tolerance-based detectors. Warmup (ATR null) is
 * INSUFFICIENT_BARS; ATR = 0 (zero true range across the ATR window, i.e. a
 * flat series) is NOT a history shortage — it is UNAVAILABLE because an
 * ATR-scaled tolerance is undefined. No substitute tolerance is invented.
 */
function atrGateFailure<T>(id: string, tf: string, curAtr: number | null | undefined, deps: string[]): FeatureValue<T> {
  if (curAtr === null || curAtr === undefined) {
    return invalidFeature<T>(id, tf, "INSUFFICIENT_BARS", "ATR14 warmup not complete: ATR-scaled tolerance unavailable", DETECTOR_VERSION, deps);
  }
  return invalidFeature<T>(id, tf, "UNAVAILABLE", "ATR14 = 0 (zero true range, flat series): ATR-scaled tolerance undefined", DETECTOR_VERSION, deps);
}

/** Expansion/compression from current ATR vs its own longer average. */
export function detectVolatilityRegime(candles: Candle[], tf: string): FeatureValue<{ state: RangeState; atr: number; atr_avg: number }> {
  const g = guard("FTR-VOL-REGIME", tf, candles, 60);
  if (g) return g as unknown as FeatureValue<{ state: RangeState; atr: number; atr_avg: number }>;
  const a = atr(candles, 14);
  const vals = a.filter((x): x is number => x !== null);
  if (vals.length < 30) {
    return invalidFeature("FTR-VOL-REGIME", tf, "INSUFFICIENT_BARS", "ATR series too short", DETECTOR_VERSION, ["candles"]);
  }
  const cur = vals[vals.length - 1];
  const avg = vals.slice(-30).reduce((x, y) => x + y, 0) / Math.min(30, vals.length);
  const state: RangeState = cur > avg * ENGINEERING_PARAMS.vol_expansion_mult ? "EXPANSION"
    : cur < avg * ENGINEERING_PARAMS.vol_compression_mult ? "COMPRESSION" : "NEUTRAL";
  return okFeature("FTR-VOL-REGIME", tf, { state, atr: cur, atr_avg: avg }, last(candles)!.t, candles.length,
    DETECTOR_VERSION, ["candles"], `ATR ${cur.toFixed(6)} vs avg ${avg.toFixed(6)}`);
}

/* ---------------------------------------------------------- PRICE ACTION */

export interface CandleAnatomy {
  body: number; upper_wick: number; lower_wick: number; range: number;
  body_ratio: number; upper_ratio: number; lower_ratio: number;
  bullish: boolean;
}

export function candleAnatomy(c: Candle): CandleAnatomy {
  const range = c.h - c.l;
  const body = Math.abs(c.c - c.o);
  const upper = c.h - Math.max(c.o, c.c);
  const lower = Math.min(c.o, c.c) - c.l;
  return {
    body, upper_wick: upper, lower_wick: lower, range,
    body_ratio: range > 0 ? body / range : 0,
    upper_ratio: range > 0 ? upper / range : 0,
    lower_ratio: range > 0 ? lower / range : 0,
    bullish: c.c >= c.o,
  };
}

export function detectAnatomy(candles: Candle[], tf: string): FeatureValue<CandleAnatomy> {
  const g = guard("FTR-ANATOMY", tf, candles, 1);
  if (g) return g as unknown as FeatureValue<CandleAnatomy>;
  const c = last(candles)!;
  if (c.h - c.l <= 0) {
    return invalidFeature("FTR-ANATOMY", tf, "OK", "zero-range candle", DETECTOR_VERSION, ["candles"]);
  }
  return okFeature("FTR-ANATOMY", tf, candleAnatomy(c), c.t, 1, DETECTOR_VERSION, ["candles"]);
}

/**
 * Pin bar per RAW_4 rules: wick >= 2x body, body <= 1/3 of range, and the
 * candle must NOT be the same size as its predecessors (corpus rule 4:
 * "پین‌بارهای هم‌اندازه با کندل‌های قبلی معتبر نیستند").
 */
export function detectPinbar(candles: Candle[], tf: string): FeatureValue<{ direction: "bullish" | "bearish"; wick_ratio: number } | null> {
  const g = guard("FTR-PINBAR", tf, candles, 6);
  if (g) return g as unknown as FeatureValue<{ direction: "bullish" | "bearish"; wick_ratio: number } | null>;
  const c = last(candles)!;
  const a = candleAnatomy(c);
  if (a.range <= 0) return invalidFeature("FTR-PINBAR", tf, "OK", "zero-range candle", DETECTOR_VERSION, ["candles"]);

  const prior = candles.slice(-6, -1);
  const avgRange = prior.reduce((s, x) => s + (x.h - x.l), 0) / prior.length;
  // corpus: an equal-sized pinbar is invalid — require a genuinely larger candle
  const sizeOk = avgRange > 0 && a.range > avgRange * ENGINEERING_PARAMS.pinbar_size_mult;

  const bodyOk = a.body_ratio <= SOURCE_PARAMS.pinbar_body_max_range_frac;
  const upperOk = a.body > 0 && a.upper_wick >= a.body * SOURCE_PARAMS.pinbar_wick_body_ratio;
  const lowerOk = a.body > 0 && a.lower_wick >= a.body * SOURCE_PARAMS.pinbar_wick_body_ratio;

  let out: { direction: "bullish" | "bearish"; wick_ratio: number } | null = null;
  if (sizeOk && bodyOk && lowerOk && !upperOk) out = { direction: "bullish", wick_ratio: a.lower_wick / Math.max(a.body, 1e-12) };
  else if (sizeOk && bodyOk && upperOk && !lowerOk) out = { direction: "bearish", wick_ratio: a.upper_wick / Math.max(a.body, 1e-12) };

  const why = !sizeOk ? "candle not larger than recent range (corpus: equal-size pinbars invalid)"
    : !bodyOk ? `body ${(a.body_ratio * 100).toFixed(0)}% of range exceeds 1/3`
      : out ? `${out.direction} pin, wick/body ${out.wick_ratio.toFixed(2)}`
        : "no dominant single wick";
  return okFeature("FTR-PINBAR", tf, out, c.t, candles.length, DETECTOR_VERSION, ["candles"], why);
}

/** Rejection candle: a long wick INTO a supplied level that closes back out. */
export function detectRejectionAt(
  candles: Candle[], tf: string, level: number, direction: "support" | "resistance",
): FeatureValue<{ rejected: boolean; wick_ratio: number }> {
  const g = guard("FTR-REJECTION", tf, candles, 1);
  if (g) return g as unknown as FeatureValue<{ rejected: boolean; wick_ratio: number }>;
  const c = last(candles)!;
  const a = candleAnatomy(c);
  if (a.range <= 0) return invalidFeature("FTR-REJECTION", tf, "OK", "zero-range candle", DETECTOR_VERSION, ["candles"]);
  let rejected = false;
  let ratio = 0;
  if (direction === "resistance") {
    // wick pierced the level, body closed back below it
    rejected = c.h >= level && c.c < level && a.upper_ratio > ENGINEERING_PARAMS.rejection_wick_min_ratio;
    ratio = a.upper_ratio;
  } else {
    rejected = c.l <= level && c.c > level && a.lower_ratio > ENGINEERING_PARAMS.rejection_wick_min_ratio;
    ratio = a.lower_ratio;
  }
  return okFeature("FTR-REJECTION", tf, { rejected, wick_ratio: ratio }, c.t, candles.length,
    DETECTOR_VERSION, ["candles", "level"],
    rejected ? `wick pierced ${direction} ${level} and closed back` : `no rejection at ${level}`);
}

/** Momentum candle: body materially larger than the recent average body. */
export function detectMomentumCandle(candles: Candle[], tf: string): FeatureValue<{ momentum: boolean; mult: number }> {
  const g = guard("FTR-MOMENTUM-CANDLE", tf, candles, 11);
  if (g) return g as unknown as FeatureValue<{ momentum: boolean; mult: number }>;
  const c = last(candles)!;
  const body = Math.abs(c.c - c.o);
  const prior = candles.slice(-11, -1);
  const avgBody = prior.reduce((s, x) => s + Math.abs(x.c - x.o), 0) / prior.length;
  if (avgBody <= 0) return invalidFeature("FTR-MOMENTUM-CANDLE", tf, "OK", "flat prior bodies", DETECTOR_VERSION, ["candles"]);
  const mult = body / avgBody;
  return okFeature("FTR-MOMENTUM-CANDLE", tf,
    { momentum: mult >= ENGINEERING_PARAMS.momentum_body_mult, mult },
    c.t, candles.length, DETECTOR_VERSION, ["candles"], `body ${mult.toFixed(2)}x recent average`);
}

/* --------------------------------------------------------------- LEVELS */

export interface PriceLevel {
  price: number;
  touches: number;
  kind: "support" | "resistance";
  last_touch_t: number;
  /** total close-density near the level — the corpus's "most candle closes" idea */
  close_density: number;
}

/**
 * Cluster swing extremes into levels and count historical touches.
 * The corpus repeatedly defines a strong level as one that produced multiple
 * past reactions, and describes targets as zones with the greatest
 * concentration of candle CLOSES — both are computed here.
 */
export function detectLevels(candles: Candle[], tf: string): FeatureValue<PriceLevel[]> {
  const g = guard("FTR-LEVELS", tf, candles, 40);
  if (g) return g as unknown as FeatureValue<PriceLevel[]>;
  const a = atr(candles, 14);
  const curAtr = atLast(a);
  if (curAtr === null || curAtr === undefined || curAtr <= 0) {
    return atrGateFailure("FTR-LEVELS", tf, curAtr, ["candles"]);
  }
  const sw = findSwings(candles, ENGINEERING_PARAMS.swing_left, ENGINEERING_PARAMS.swing_right);
  const tol = curAtr * ENGINEERING_PARAMS.level_cluster_atr;
  // ONE clustering algorithm shared with the bundle's sr_levels (analysis/structure)
  const levels: PriceLevel[] = clusterSwingLevels(candles, sw, tol);

  return okFeature("FTR-LEVELS", tf, levels, last(candles)!.t, candles.length, DETECTOR_VERSION,
    ["candles", "FTR-ATR14"], `${levels.length} clustered levels (tol ${tol.toFixed(6)})`);
}

/** Is price currently touching/inside a level zone? */
export function detectLevelTouch(
  candles: Candle[], tf: string, levels: PriceLevel[], minTouches: number,
): FeatureValue<{ level: PriceLevel; distance_atr: number } | null> {
  const g = guard("FTR-LEVEL-TOUCH", tf, candles, 20);
  if (g) return g as unknown as FeatureValue<{ level: PriceLevel; distance_atr: number } | null>;
  const a = atr(candles, 14);
  const curAtr = atLast(a);
  if (curAtr === null || curAtr === undefined || curAtr <= 0) {
    return atrGateFailure("FTR-LEVEL-TOUCH", tf, curAtr, ["FTR-LEVELS"]);
  }
  const c = last(candles)!;
  const qualified = levels.filter((l) => l.touches >= minTouches);
  if (qualified.length === 0) {
    return okFeature("FTR-LEVEL-TOUCH", tf, null, c.t, candles.length, DETECTOR_VERSION, ["FTR-LEVELS"],
      `no level with >= ${minTouches} historical touches`);
  }
  const tol = curAtr * ENGINEERING_PARAMS.level_touch_atr;
  let best: { level: PriceLevel; distance_atr: number } | null = null;
  for (const l of qualified) {
    // touch = the bar's range reached the level
    const touched = c.l <= l.price + tol && c.h >= l.price - tol;
    if (!touched) continue;
    const d = Math.abs(c.c - l.price) / curAtr;
    if (!best || d < best.distance_atr) best = { level: l, distance_atr: d };
  }
  return okFeature("FTR-LEVEL-TOUCH", tf, best, c.t, candles.length, DETECTOR_VERSION, ["FTR-LEVELS"],
    best ? `touching ${best.level.kind} ${best.level.price.toFixed(6)} (${best.level.touches} touches)` : "price not at a qualified level");
}

/* ------------------------------------------------------------ PATTERNS */

export interface DoublePattern {
  kind: "double_top" | "double_bottom";
  p1: number; p2: number; t1: number; t2: number;
  /**
   * Most extreme CONFIRMED opposite swing between the peaks (ENGINEERING_DEFINED
   * reading of the source's M/W shape, RAW_1:1217-1218; the corpus defines a
   * "neckline" computation only for Head & Shoulders, RAW_4:2314). null when
   * no opposite swing was confirmed between the peaks — UNKNOWN, never a
   * substitute value.
   */
  neckline: number | null;
  /**
   * SWING = the canonical reading above. UNKNOWN = no confirmed opposite swing
   * between the peaks. Absolute-final: the Task 10 BAR_EXTREME fallback (raw
   * bar extreme) was a NON-canonical second computation and is removed; pre-
   * Task-10 the fallback was the lower PEAK price (a neckline at the peak).
   */
  neckline_source: "SWING" | "UNKNOWN";
}

/**
 * Double top / double bottom: two swing extremes at a comparable price with a
 * minimum bar separation. Used by STR-RAW-2-1258.
 */
export function detectDoublePattern(candles: Candle[], tf: string): FeatureValue<DoublePattern | null> {
  const g = guard("FTR-DOUBLE", tf, candles, 30);
  if (g) return g as unknown as FeatureValue<DoublePattern | null>;
  const a = atr(candles, 14);
  const curAtr = atLast(a);
  if (curAtr === null || curAtr === undefined || curAtr <= 0) {
    return atrGateFailure("FTR-DOUBLE", tf, curAtr, ["candles"]);
  }
  const sw = findSwings(candles, ENGINEERING_PARAMS.swing_left, ENGINEERING_PARAMS.swing_right);
  const highs = sw.filter((s) => s.kind === "high");
  const lows = sw.filter((s) => s.kind === "low");
  const tol = curAtr * ENGINEERING_PARAMS.double_peak_tol_atr;

  const pair = <T extends SwingPoint>(arr: T[]): [T, T] | null => {
    if (arr.length < 2) return null;
    const b = arr[arr.length - 1], a2 = arr[arr.length - 2];
    if (b.index - a2.index < ENGINEERING_PARAMS.double_peak_min_gap) return null;
    if (Math.abs(b.price - a2.price) > tol) return null;
    return [a2, b];
  };

  // fail-closed if a parameter change ever allows adjacent peaks (no bar between)
  const pairOk = (pr: [SwingPoint, SwingPoint] | null) => pr !== null && pr[1].index - pr[0].index >= 2;
  const hp0 = pair(highs);
  const hp = pairOk(hp0) ? hp0 : null;
  if (hp) {
    const between = lows.filter((l) => l.index > hp[0].index && l.index < hp[1].index);
    // no confirmed trough between the peaks → neckline UNKNOWN (no fallback)
    const neck = between.length ? Math.min(...between.map((l) => l.price)) : null;
    return okFeature("FTR-DOUBLE", tf,
      { kind: "double_top", p1: hp[0].price, p2: hp[1].price, t1: hp[0].t, t2: hp[1].t, neckline: neck, neckline_source: neck === null ? "UNKNOWN" : "SWING" },
      last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"], "double top detected");
  }
  const lp0 = pair(lows);
  const lp = pairOk(lp0) ? lp0 : null;
  if (lp) {
    const between = highs.filter((h) => h.index > lp[0].index && h.index < lp[1].index);
    const neck = between.length ? Math.max(...between.map((h) => h.price)) : null;
    return okFeature("FTR-DOUBLE", tf,
      { kind: "double_bottom", p1: lp[0].price, p2: lp[1].price, t1: lp[0].t, t2: lp[1].t, neckline: neck, neckline_source: neck === null ? "UNKNOWN" : "SWING" },
      last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"], "double bottom detected");
  }
  return okFeature("FTR-DOUBLE", tf, null, last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"],
    "no qualifying double pattern");
}

export interface AbcdPattern {
  direction: "bullish" | "bearish";
  a: number; b: number; c: number; d_projected: number;
  /**
   * ab = measured |B−A|. `cd` is the PROJECTED CD length (= ab by the AB=CD
   * construction), not a measurement — D has not formed at C.
   */
  ab: number; cd: number; correction_frac: number;
  /** measured slopes (price per bar) of the AB and BC legs */
  slope_ab: number; slope_bc: number;
  /**
   * Task 10: the CD leg does not exist when the pattern is detected at C, so
   * its slope is not measurable — null, never a stand-in. (Pre-fix this field
   * held the BC slope under the CD name.)
   */
  slope_cd: null;
  deep_correction: boolean;
}

/**
 * AB=CD per RAW_4 (STR-RAW-4-2425 / 2449).
 * Corpus conditions: a prior trend leg AB, a correction BC, then CD equal in
 * size to AB, with CD's slope <= AB's slope. "Deep correction" is > 50% of AB
 * (the 50% figure IS stated by the source).
 */
export function detectABCD(candles: Candle[], tf: string): FeatureValue<AbcdPattern | null> {
  const g = guard("FTR-ABCD", tf, candles, 40);
  if (g) return g as unknown as FeatureValue<AbcdPattern | null>;
  const sw = findSwings(candles, ENGINEERING_PARAMS.swing_left, ENGINEERING_PARAMS.swing_right)
    .sort((x, y) => x.index - y.index);
  if (sw.length < 3) {
    return okFeature("FTR-ABCD", tf, null, last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"],
      "fewer than 3 swings — no ABCD");
  }
  // take the last three alternating swings: A -> B -> C
  const s3 = sw.slice(-3);
  const [A, B, C] = s3;
  if (A.kind === B.kind || B.kind === C.kind) {
    return okFeature("FTR-ABCD", tf, null, last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"],
      "swings do not alternate — no clean ABCD legs");
  }
  const ab = Math.abs(B.price - A.price);
  const bc = Math.abs(C.price - B.price);
  if (ab <= 0) {
    return okFeature("FTR-ABCD", tf, null, last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"], "degenerate AB leg");
  }
  const correction = bc / ab;
  const barsAB = Math.max(1, B.index - A.index);
  const barsBC = Math.max(1, C.index - B.index);
  const slopeAB = ab / barsAB;
  const slopeBC = bc / barsBC;
  // D projects CD == AB from C, continuing in the AB direction
  const dir: "bullish" | "bearish" = B.price > A.price ? "bullish" : "bearish";
  const dProjected = dir === "bullish" ? C.price + ab : C.price - ab;

  const pattern: AbcdPattern = {
    direction: dir, a: A.price, b: B.price, c: C.price, d_projected: dProjected,
    ab, cd: ab, correction_frac: correction,
    slope_ab: slopeAB, slope_bc: slopeBC, slope_cd: null,
    deep_correction: correction > SOURCE_PARAMS.deep_correction_frac,
  };
  return okFeature("FTR-ABCD", tf, pattern, last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"],
    `AB=${ab.toFixed(6)} correction=${(correction * 100).toFixed(1)}% ${pattern.deep_correction ? "(DEEP)" : "(shallow)"}`);
}

/* ---------------------------------------------------------- INDICATORS */

export function detectRSI(candles: Candle[], tf: string, period = 14): FeatureValue<number> {
  const g = guard("FTR-RSI14", tf, candles, period + 1);
  if (g) return g as unknown as FeatureValue<number>;
  const v = atLast(rsi(candles.map((c) => c.c), period));
  if (v === undefined) return invalidFeature("FTR-RSI14", tf, "INSUFFICIENT_BARS", "RSI unavailable (non-finite input or invalid period)", DETECTOR_VERSION, ["close"]);
  return okFeature("FTR-RSI14", tf, v, last(candles)!.t, candles.length, DETECTOR_VERSION, ["close"], `RSI=${v.toFixed(2)}`);
}

export function detectEMA(candles: Candle[], tf: string, period: number): FeatureValue<number> {
  const id = `FTR-EMA${period}`;
  const g = guard(id, tf, candles, period);
  if (g) return g as unknown as FeatureValue<number>;
  const v = atLast(ema(candles.map((c) => c.c), period));
  if (v === undefined) return invalidFeature(id, tf, "INSUFFICIENT_BARS", "EMA undefined", DETECTOR_VERSION, ["close"]);
  return okFeature(id, tf, v, last(candles)!.t, candles.length, DETECTOR_VERSION, ["close"], `EMA${period}=${v.toFixed(6)}`);
}

export function detectATR(candles: Candle[], tf: string, period = 14): FeatureValue<number> {
  const g = guard("FTR-ATR14", tf, candles, period + 1);
  if (g) return g as unknown as FeatureValue<number>;
  const v = atLast(atr(candles, period));
  if (v === undefined) return invalidFeature("FTR-ATR14", tf, "INSUFFICIENT_BARS", "ATR undefined", DETECTOR_VERSION, ["candles"]);
  return okFeature("FTR-ATR14", tf, v, last(candles)!.t, candles.length, DETECTOR_VERSION, ["candles"], `ATR=${v.toFixed(6)}`);
}

/**
 * Fibonacci retracement of the last confirmed alternating leg — delegated to
 * the canonical engine (analysis/structure:fibOfLastLeg). Levels are measured
 * from the leg end (0 = leg end, 1 = leg origin) for both directions.
 */
export function detectFib(candles: Candle[], tf: string): FeatureValue<{ levels: { level: number; price: number }[]; from: number; to: number }> {
  const sw = detectSwings(candles, tf);
  if (!sw.valid || !sw.value) {
    return invalidFeature("FTR-FIB", tf, sw.data_quality, sw.reason, DETECTOR_VERSION, ["FTR-SWINGS"]);
  }
  const { leg, levels } = fibOfLastLeg(sw.value.swings);
  if (!leg) {
    return invalidFeature("FTR-FIB", tf, "INSUFFICIENT_BARS", "need 2 alternating confirmed swings for a leg", DETECTOR_VERSION, ["FTR-SWINGS"]);
  }
  return okFeature("FTR-FIB", tf, { levels, from: leg.from.price, to: leg.to.price }, last(candles)!.t, candles.length,
    DETECTOR_VERSION, ["FTR-SWINGS"], `fib ${leg.direction} leg from ${leg.from.price.toFixed(6)} to ${leg.to.price.toFixed(6)}`);
}
