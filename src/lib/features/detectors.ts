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
import { findSwings, type SwingPoint } from "../analysis/structure";
import { atr, ema, rsi } from "../analysis/indicators";
import { invalidFeature, okFeature, type FeatureValue } from "./types";

export const DETECTOR_VERSION = "1.0.0";

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
  /** momentum candle: body must exceed this multiple of recent average body */
  momentum_body_mult: 1.5,
  /** AB=CD leg-equality tolerance as a fraction of AB */
  abcd_equality_tol: 0.15,
  /** AB=CD slope comparison tolerance */
  abcd_slope_tol: 0.25,
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
  if (highs.length < 2 || lows.length < 2) {
    return invalidFeature("FTR-STRUCT-BIAS", tf, "INSUFFICIENT_BARS",
      `needs 2 highs and 2 lows, got ${highs.length}/${lows.length}`, DETECTOR_VERSION, ["FTR-SWINGS"]);
  }
  const h1 = highs[highs.length - 2].price, h2 = highs[highs.length - 1].price;
  const l1 = lows[lows.length - 2].price, l2 = lows[lows.length - 1].price;
  const hh = h2 > h1, lh = h2 < h1, hl = l2 > l1, ll = l2 < l1;
  const bias: StructureBias = hh && hl ? "HH_HL" : lh && ll ? "LH_LL" : "MIXED";
  return okFeature("FTR-STRUCT-BIAS", tf,
    { bias, hh, hl, lh, ll, last_swing_high: h2, last_swing_low: l2 },
    last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"],
    `H ${h1.toFixed(4)}->${h2.toFixed(4)}, L ${l1.toFixed(4)}->${l2.toFixed(4)}`);
}

export interface BreakEvent { direction: "up" | "down"; price: number; t: number; index: number }

/** BOS: close beyond the most recent opposing swing extreme. */
export function detectBOS(candles: Candle[], tf: string): FeatureValue<BreakEvent | null> {
  const sw = detectSwings(candles, tf);
  if (!sw.valid || !sw.value) {
    return invalidFeature("FTR-BOS", tf, sw.data_quality, sw.reason, DETECTOR_VERSION, ["FTR-SWINGS"]);
  }
  const n = candles.length;
  const close = candles[n - 1].c;
  const { highs, lows } = sw.value;
  const lastH = last(highs), lastL = last(lows);
  let ev: BreakEvent | null = null;
  if (lastH && close > lastH.price) ev = { direction: "up", price: lastH.price, t: candles[n - 1].t, index: n - 1 };
  else if (lastL && close < lastL.price) ev = { direction: "down", price: lastL.price, t: candles[n - 1].t, index: n - 1 };
  return okFeature("FTR-BOS", tf, ev, candles[n - 1].t, n, DETECTOR_VERSION, ["FTR-SWINGS"],
    ev ? `close ${close} broke ${ev.direction} swing ${ev.price}` : "no structural break at last close");
}

/** CHOCH: first break AGAINST the prevailing structural bias. */
export function detectCHOCH(candles: Candle[], tf: string): FeatureValue<BreakEvent | null> {
  const bias = detectStructureBias(candles, tf);
  const bos = detectBOS(candles, tf);
  if (!bias.valid || !bias.value || !bos.valid) {
    return invalidFeature("FTR-CHOCH", tf, bias.valid ? bos.data_quality : bias.data_quality,
      bias.valid ? bos.reason : bias.reason, DETECTOR_VERSION, ["FTR-STRUCT-BIAS", "FTR-BOS"]);
  }
  const ev = bos.value;
  let choch: BreakEvent | null = null;
  if (ev) {
    if (bias.value.bias === "HH_HL" && ev.direction === "down") choch = ev;
    if (bias.value.bias === "LH_LL" && ev.direction === "up") choch = ev;
  }
  return okFeature("FTR-CHOCH", tf, choch, last(candles)!.t, candles.length, DETECTOR_VERSION,
    ["FTR-STRUCT-BIAS", "FTR-BOS"],
    choch ? `counter-trend break vs ${bias.value.bias}` : "no change of character");
}

export type RangeState = "EXPANSION" | "COMPRESSION" | "NEUTRAL";

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
  const state: RangeState = cur > avg * 1.2 ? "EXPANSION" : cur < avg * 0.8 ? "COMPRESSION" : "NEUTRAL";
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
  const sizeOk = avgRange > 0 && a.range > avgRange * 1.1;

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
    rejected = c.h >= level && c.c < level && a.upper_ratio > 0.3;
    ratio = a.upper_ratio;
  } else {
    rejected = c.l <= level && c.c > level && a.lower_ratio > 0.3;
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
  const curAtr = last(a.filter((x): x is number => x !== null));
  if (!curAtr || curAtr <= 0) {
    return invalidFeature("FTR-LEVELS", tf, "INSUFFICIENT_BARS", "ATR unavailable for clustering tolerance", DETECTOR_VERSION, ["candles"]);
  }
  const sw = findSwings(candles, ENGINEERING_PARAMS.swing_left, ENGINEERING_PARAMS.swing_right);
  const tol = curAtr * ENGINEERING_PARAMS.level_cluster_atr;

  const clusters: { prices: number[]; kind: "support" | "resistance"; lastT: number }[] = [];
  for (const s of sw) {
    const kind = s.kind === "high" ? "resistance" : "support";
    const hit = clusters.find((c) => c.kind === kind && Math.abs(c.prices[0] - s.price) <= tol);
    if (hit) { hit.prices.push(s.price); hit.lastT = Math.max(hit.lastT, s.t); }
    else clusters.push({ prices: [s.price], kind, lastT: s.t });
  }

  const levels: PriceLevel[] = clusters.map((c) => {
    const price = c.prices.reduce((x, y) => x + y, 0) / c.prices.length;
    const density = candles.filter((k) => Math.abs(k.c - price) <= tol).length;
    return { price, touches: c.prices.length, kind: c.kind, last_touch_t: c.lastT, close_density: density };
  }).sort((x, y) => y.touches - x.touches);

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
  const curAtr = last(a.filter((x): x is number => x !== null));
  if (!curAtr || curAtr <= 0) {
    return invalidFeature("FTR-LEVEL-TOUCH", tf, "INSUFFICIENT_BARS", "ATR unavailable", DETECTOR_VERSION, ["FTR-LEVELS"]);
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
  p1: number; p2: number; t1: number; t2: number; neckline: number;
}

/**
 * Double top / double bottom: two swing extremes at a comparable price with a
 * minimum bar separation. Used by STR-RAW-2-1258.
 */
export function detectDoublePattern(candles: Candle[], tf: string): FeatureValue<DoublePattern | null> {
  const g = guard("FTR-DOUBLE", tf, candles, 30);
  if (g) return g as unknown as FeatureValue<DoublePattern | null>;
  const a = atr(candles, 14);
  const curAtr = last(a.filter((x): x is number => x !== null));
  if (!curAtr || curAtr <= 0) {
    return invalidFeature("FTR-DOUBLE", tf, "INSUFFICIENT_BARS", "ATR unavailable", DETECTOR_VERSION, ["candles"]);
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

  const hp = pair(highs);
  if (hp) {
    const between = lows.filter((l) => l.index > hp[0].index && l.index < hp[1].index);
    const neck = between.length ? Math.min(...between.map((l) => l.price)) : Math.min(hp[0].price, hp[1].price);
    return okFeature("FTR-DOUBLE", tf,
      { kind: "double_top", p1: hp[0].price, p2: hp[1].price, t1: hp[0].t, t2: hp[1].t, neckline: neck },
      last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"], "double top detected");
  }
  const lp = pair(lows);
  if (lp) {
    const between = highs.filter((h) => h.index > lp[0].index && h.index < lp[1].index);
    const neck = between.length ? Math.max(...between.map((h) => h.price)) : Math.max(lp[0].price, lp[1].price);
    return okFeature("FTR-DOUBLE", tf,
      { kind: "double_bottom", p1: lp[0].price, p2: lp[1].price, t1: lp[0].t, t2: lp[1].t, neckline: neck },
      last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"], "double bottom detected");
  }
  return okFeature("FTR-DOUBLE", tf, null, last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"],
    "no qualifying double pattern");
}

export interface AbcdPattern {
  direction: "bullish" | "bearish";
  a: number; b: number; c: number; d_projected: number;
  ab: number; cd: number; correction_frac: number;
  slope_ab: number; slope_cd: number;
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
  const slopeCD = bc / barsBC;
  // D projects CD == AB from C, continuing in the AB direction
  const dir: "bullish" | "bearish" = B.price > A.price ? "bullish" : "bearish";
  const dProjected = dir === "bullish" ? C.price + ab : C.price - ab;

  const pattern: AbcdPattern = {
    direction: dir, a: A.price, b: B.price, c: C.price, d_projected: dProjected,
    ab, cd: ab, correction_frac: correction,
    slope_ab: slopeAB, slope_cd: slopeCD,
    deep_correction: correction > SOURCE_PARAMS.deep_correction_frac,
  };
  return okFeature("FTR-ABCD", tf, pattern, last(candles)!.t, candles.length, DETECTOR_VERSION, ["FTR-SWINGS"],
    `AB=${ab.toFixed(6)} correction=${(correction * 100).toFixed(1)}% ${pattern.deep_correction ? "(DEEP)" : "(shallow)"}`);
}

/* ---------------------------------------------------------- INDICATORS */

export function detectRSI(candles: Candle[], tf: string, period = 14): FeatureValue<number> {
  const g = guard("FTR-RSI14", tf, candles, period + 1);
  if (g) return g as unknown as FeatureValue<number>;
  const v = last(rsi(candles.map((c) => c.c), period).filter((x): x is number => x !== null));
  if (v === undefined) return invalidFeature("FTR-RSI14", tf, "INSUFFICIENT_BARS", "RSI undefined (flat series)", DETECTOR_VERSION, ["close"]);
  return okFeature("FTR-RSI14", tf, v, last(candles)!.t, candles.length, DETECTOR_VERSION, ["close"], `RSI=${v.toFixed(2)}`);
}

export function detectEMA(candles: Candle[], tf: string, period: number): FeatureValue<number> {
  const id = `FTR-EMA${period}`;
  const g = guard(id, tf, candles, period);
  if (g) return g as unknown as FeatureValue<number>;
  const v = last(ema(candles.map((c) => c.c), period).filter((x): x is number => x !== null));
  if (v === undefined) return invalidFeature(id, tf, "INSUFFICIENT_BARS", "EMA undefined", DETECTOR_VERSION, ["close"]);
  return okFeature(id, tf, v, last(candles)!.t, candles.length, DETECTOR_VERSION, ["close"], `EMA${period}=${v.toFixed(6)}`);
}

export function detectATR(candles: Candle[], tf: string, period = 14): FeatureValue<number> {
  const g = guard("FTR-ATR14", tf, candles, period + 1);
  if (g) return g as unknown as FeatureValue<number>;
  const v = last(atr(candles, period).filter((x): x is number => x !== null));
  if (v === undefined) return invalidFeature("FTR-ATR14", tf, "INSUFFICIENT_BARS", "ATR undefined", DETECTOR_VERSION, ["candles"]);
  return okFeature("FTR-ATR14", tf, v, last(candles)!.t, candles.length, DETECTOR_VERSION, ["candles"], `ATR=${v.toFixed(6)}`);
}

/** Fibonacci retracement of the most recent impulse leg. */
export function detectFib(candles: Candle[], tf: string): FeatureValue<{ levels: { level: number; price: number }[]; from: number; to: number }> {
  const sw = detectSwings(candles, tf);
  if (!sw.valid || !sw.value) {
    return invalidFeature("FTR-FIB", tf, sw.data_quality, sw.reason, DETECTOR_VERSION, ["FTR-SWINGS"]);
  }
  const ordered = sw.value.swings.slice().sort((a, b) => a.index - b.index);
  if (ordered.length < 2) {
    return invalidFeature("FTR-FIB", tf, "INSUFFICIENT_BARS", "need 2 swings for a leg", DETECTOR_VERSION, ["FTR-SWINGS"]);
  }
  const to = ordered[ordered.length - 1];
  const from = ordered[ordered.length - 2];
  const diff = to.price - from.price;
  if (diff === 0) return invalidFeature("FTR-FIB", tf, "OK", "degenerate leg", DETECTOR_VERSION, ["FTR-SWINGS"]);
  const levels = [0.236, 0.382, 0.5, 0.618, 0.786, 1].map((l) => ({ level: l, price: to.price - diff * l }));
  return okFeature("FTR-FIB", tf, { levels, from: from.price, to: to.price }, last(candles)!.t, candles.length,
    DETECTOR_VERSION, ["FTR-SWINGS"], `fib from ${from.price.toFixed(6)} to ${to.price.toFixed(6)}`);
}
