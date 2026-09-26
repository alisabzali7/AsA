/**
 * MOMENTUM — source-defined meaning (Team 02 recovery).
 *
 * The corpus defines momentum as the strength/angle of the market's LAST LEG
 * (RAW_4:1196 "مومنتوم / لگ آخر: قدرت و زاویه حرکت در آخرین لگ بازار") and
 * stresses that it is RELATIVE — it only means something by comparison
 * (RAW_4:1193). It also states momentum must NOT be used as a trigger/entry
 * (RAW_4:1248). Therefore this module:
 *   - MEASURES legs between confirmed alternating swings (canonical swings),
 *   - exposes slope comparisons between legs AND leg-size ("step size")
 *     comparisons: the transcript names both dimensions — the angle got
 *     steeper and "اندازه گام حرکتیم بزرگ‌تر شده" (the step got bigger),
 *     judged against the previous same-kind move (RAW_4 transcript before
 *     line 1193). v1.1.0 adds the size ratios; slope values are unchanged,
 *   - does NOT classify strong/weak (no threshold exists in the source:
 *     OPEN SPECIFICATION) and emits no direction/entry/score.
 *
 * It is distinct from:
 *   - FTR-MOMENTUM-CANDLE (features/detectors.ts): a single large-body candle
 *     (ENGINEERING threshold 1.5x average body) — a price-action concept.
 *     It is NOT the source's Marubozu (RAW_1:1103 no-wick body; RAW_2:1212
 *     "e.g. 2x ATR" is only an example) and has no strategy consumer;
 *   - range/volatility expansion (ATR, atr14_pct in the bundle) — a
 *     volatility measure, never a momentum reading;
 *   - a rate-of-change oscillator — NOT defined by the source, not implemented.
 *
 * The in-progress leg (last confirmed swing → last closed bar) is reported
 * separately as UNCONFIRMED: its end point is not a confirmed swing.
 */
import type { Candle } from "../domain/types";
import { alternatingSwings, type SwingPoint } from "./structure";

export const MOMENTUM_VERSION = "1.1.0";

export interface MomentumLeg {
  direction: "up" | "down";
  from: { index: number; t: number; price: number };
  to: { index: number; t: number; price: number };
  bars: number;
  change: number;
  /** change / |from| · 100; null when from == 0 */
  change_pct: number | null;
  slope_per_bar: number;
  /** |change| / bars / ATR14(at leg end); null when ATR unavailable */
  slope_atr: number | null;
  status: "CONFIRMED" | "UNCONFIRMED";
}

export interface MomentumResult {
  version: string;
  definition: "last-leg slope (RAW_4:1196), relative by comparison (RAW_4:1193)";
  /** most recent confirmed legs, ascending, at most 4 */
  legs: MomentumLeg[];
  last_leg: MomentumLeg | null;
  /** last confirmed swing → last closed bar; null when no swing or zero change */
  current_leg: MomentumLeg | null;
  /** |slope(last leg)| / |slope(previous, opposite leg)| */
  last_vs_previous_slope_ratio: number | null;
  /** |slope(last leg)| / |slope(prior leg in the same direction)| */
  last_vs_prior_same_direction_slope_ratio: number | null;
  /** |change(last leg)| / |change(previous, opposite leg)| — step size */
  last_vs_previous_size_ratio: number | null;
  /** |change(last leg)| / |change(prior leg in the same direction)| — step size */
  last_vs_prior_same_direction_size_ratio: number | null;
  classification: "OPEN_SPECIFICATION";
  reason: string;
}

function leg(candles: Candle[], a: { index: number; price: number }, bIndex: number, bPrice: number, atr14: (number | null)[], status: MomentumLeg["status"]): MomentumLeg | null {
  const bars = bIndex - a.index;
  const change = bPrice - a.price;
  if (bars <= 0 || change === 0) return null;
  const at = atr14[bIndex] ?? null;
  const slope = change / bars;
  return {
    direction: change > 0 ? "up" : "down",
    from: { index: a.index, t: candles[a.index].t, price: a.price },
    to: { index: bIndex, t: candles[bIndex].t, price: bPrice },
    bars,
    change,
    change_pct: a.price !== 0 ? (change / Math.abs(a.price)) * 100 : null,
    slope_per_bar: slope,
    slope_atr: at !== null && at > 0 ? Math.abs(slope) / at : null,
    status,
  };
}

function ratio(a: MomentumLeg | null | undefined, b: MomentumLeg | null | undefined): number | null {
  if (!a || !b || b.slope_per_bar === 0) return null;
  return Math.abs(a.slope_per_bar) / Math.abs(b.slope_per_bar);
}

function sizeRatio(a: MomentumLeg | null | undefined, b: MomentumLeg | null | undefined): number | null {
  if (!a || !b || b.change === 0) return null;
  return Math.abs(a.change) / Math.abs(b.change);
}

export function legMomentum(candles: Candle[], swings: SwingPoint[], atr14: (number | null)[]): MomentumResult {
  const base = {
    version: MOMENTUM_VERSION,
    definition: "last-leg slope (RAW_4:1196), relative by comparison (RAW_4:1193)" as const,
    classification: "OPEN_SPECIFICATION" as const,
  };
  const alt = alternatingSwings(swings);
  const all: MomentumLeg[] = [];
  for (let i = 1; i < alt.length; i++) {
    const l = leg(candles, alt[i - 1], alt[i].index, alt[i].price, atr14, "CONFIRMED");
    if (l) all.push(l);
  }
  const lastSwing = alt[alt.length - 1];
  const n = candles.length;
  const current = lastSwing && n > 0 ? leg(candles, lastSwing, n - 1, candles[n - 1].c, atr14, "UNCONFIRMED") : null;
  if (all.length === 0) {
    return { ...base, legs: [], last_leg: null, current_leg: current, last_vs_previous_slope_ratio: null, last_vs_prior_same_direction_slope_ratio: null, last_vs_previous_size_ratio: null, last_vs_prior_same_direction_size_ratio: null, reason: "fewer than 2 alternating confirmed swings — no confirmed leg" };
  }
  const k = all.length;
  return {
    ...base,
    legs: all.slice(-4),
    last_leg: all[k - 1],
    current_leg: current,
    last_vs_previous_slope_ratio: ratio(all[k - 1], all[k - 2]),
    last_vs_prior_same_direction_slope_ratio: ratio(all[k - 1], all[k - 3]),
    last_vs_previous_size_ratio: sizeRatio(all[k - 1], all[k - 2]),
    last_vs_prior_same_direction_size_ratio: sizeRatio(all[k - 1], all[k - 3]),
    reason: `${k} confirmed legs measured; strength classification has no source threshold`,
  };
}
