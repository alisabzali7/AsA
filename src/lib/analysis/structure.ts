/**
 * CANONICAL STRUCTURE ENGINE (Team 02 recovery).
 *
 * One causal implementation of swings, structural breaks (BOS / CHoCH),
 * swing-sequence bias, trend, S/R clusters, FVGs, order blocks and the
 * Fibonacci leg. The feature detectors (features/detectors.ts) and the
 * analysis bundle both consume THIS module, so the chart, the AI evidence and
 * the strategy layer can no longer disagree about what a "BOS" or an "S/R
 * level" is.
 *
 * CAUSALITY CONTRACT
 *  - Input is an ascending array of CLOSED candles (the analysis-input contract
 *    removes the forming bar upstream).
 *  - A fractal swing at index i is only KNOWABLE at the close of bar
 *    i + right (`confirmed_index`). Structural events never reference a swing
 *    before that bar has closed.
 *  - Every event carries the index/timestamp of the closed bar that produced
 *    it; nothing is back-dated to the pivot bar.
 *  - Appending future bars never changes an event that was already emitted
 *    for an earlier prefix (tested: tests/team02-structure.test.ts).
 *
 * SOURCE vs ENGINEERING (asa-source-fidelity)
 *  - BOS  — RAW_5:670  "break of the previous structural high/low".  SOURCE
 *  - CHoCH — RAW_5:674 "first time within a trend the opposite structure
 *            forms".  SOURCE.  Prevailing trend = direction of the last
 *            structural break (ENGINEERING formalisation).
 *  - OB   — RAW_5:668/679 an order block MUST lead to a BOS; RAW_5:957 the
 *            zone is the node's High/Low.  SOURCE.  Choice of the node (last
 *            opposing candle at/before the leg extreme) is ENGINEERING and
 *            matches the repository primitive PRM-OB description.
 *  - Trend — repository feature spec FTR-TREND / FTR-MA-ALIGN (swing sequence
 *            confirmed by EMA20/EMA50 alignment, flat band 0.05% of price).
 *  - Fractal width, level clustering tolerance, window bounds: ENGINEERING
 *    parameters, listed in STRUCTURE_PARAMS.
 */
import type { Candle } from "../domain/types";
import { atr, ema } from "./indicators";

export const STRUCTURE_ENGINE_VERSION = "2.0.0";

export const STRUCTURE_PARAMS = {
  /** ENGINEERING: fractal half-widths (same values as features ENGINEERING_PARAMS) */
  swing_left: 2,
  swing_right: 2,
  /** ENGINEERING: S/R clustering tolerance in ATR(14) multiples — shared with FTR-LEVELS */
  level_cluster_atr: 0.35,
  /** REPOSITORY-DEFINED (FTR-MA-ALIGN): EMA20/EMA50 flat band as a fraction of price */
  ma_flat_band_frac: 0.0005,
  /** ENGINEERING: minimum closed bars before any structural read is attempted */
  min_structure_bars: 20,
  /** REPOSITORY-DEFINED (bundle contract): Fibonacci retracement levels */
  fib_levels: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as readonly number[],
  /** ENGINEERING: output bounds (storage / payload limits, most recent kept) */
  max_levels: 8,
  max_fvgs: 6,
  max_order_blocks: 3,
  max_events: 10,
  max_swings: 10,
} as const;

/* ------------------------------------------------------------------ swings */

export interface SwingPoint {
  /** pivot bar */
  index: number;
  t: number;
  price: number;
  kind: "high" | "low";
  /** bar whose CLOSE confirms the pivot (index + right) */
  confirmed_index: number;
  confirmed_t: number;
}

export function hasNonFiniteCandles(candles: Candle[]): boolean {
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (
      !c ||
      !Number.isFinite(c.t) ||
      !Number.isFinite(c.o) ||
      !Number.isFinite(c.h) ||
      !Number.isFinite(c.l) ||
      !Number.isFinite(c.c)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Strict fractal pivots. A bar that is BOTH a swing high and a swing low (an
 * outside bar) yields two points at the same index, high first.
 */
export function findSwings(candles: Candle[], left = 2, right = 2): SwingPoint[] {
  if (
    !Number.isInteger(left) ||
    !Number.isInteger(right) ||
    left < 1 ||
    right < 1 ||
    hasNonFiniteCandles(candles)
  ) {
    return [];
  }

  const out: SwingPoint[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isHigh = false;
      if (candles[j].l <= c.l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    const ci = i + right;
    if (isHigh) out.push({ index: i, t: c.t, price: c.h, kind: "high", confirmed_index: ci, confirmed_t: candles[ci].t });
    if (isLow) out.push({ index: i, t: c.t, price: c.l, kind: "low", confirmed_index: ci, confirmed_t: candles[ci].t });
  }
  return out;
}

/**
 * Zig-zag view of the swing list: consecutive swings of the same kind are
 * collapsed to the more extreme one (higher high / lower low), so legs always
 * run low→high or high→low. A second point at the SAME index as the last kept
 * point (outside bar) is dropped — a zero-bar leg is not a leg. An opposite
 * swing that does not extend beyond the last kept point (a swing high at or
 * below the last swing low, or a low at or above the last high) is skipped:
 * a "low→high" leg that goes DOWN is not a leg (pre-fix it produced
 * same-direction consecutive momentum legs and inverted Fib legs). ENGINEERING.
 */
export function alternatingSwings(swings: SwingPoint[]): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (const s of swings) {
    const last = out[out.length - 1];
    if (!last) { out.push(s); continue; }
    if (s.index === last.index) continue;
    if (s.kind !== last.kind && (s.kind === "high" ? s.price <= last.price : s.price >= last.price)) continue;
    if (s.kind === last.kind) {
      const moreExtreme = s.kind === "high" ? s.price > last.price : s.price < last.price;
      if (moreExtreme) out[out.length - 1] = s;
      continue;
    }
    out.push(s);
  }
  return out;
}

/* -------------------------------------------------------------- swing bias */

export type SwingBias = "HH_HL" | "LH_LL" | "MIXED";

export interface SwingBiasState {
  bias: SwingBias;
  hh: boolean; hl: boolean; lh: boolean; ll: boolean;
  prev_high: number; last_high: number;
  prev_low: number; last_low: number;
}

/** HH/HL vs LH/LL from the two most recent swings of each kind; null if < 2 of either. */
export function swingBias(swings: SwingPoint[]): SwingBiasState | null {
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  if (highs.length < 2 || lows.length < 2) return null;
  const h1 = highs[highs.length - 2].price, h2 = highs[highs.length - 1].price;
  const l1 = lows[lows.length - 2].price, l2 = lows[lows.length - 1].price;
  const hh = h2 > h1, lh = h2 < h1, hl = l2 > l1, ll = l2 < l1;
  const bias: SwingBias = hh && hl ? "HH_HL" : lh && ll ? "LH_LL" : "MIXED";
  return { bias, hh, hl, lh, ll, prev_high: h1, last_high: h2, prev_low: l1, last_low: l2 };
}

/* -------------------------------------------------------- structural events */

export interface StructureEvent {
  kind: "BOS" | "CHOCH";
  direction: "up" | "down";
  /** the broken swing level */
  price: number;
  /** closed bar whose CLOSE broke the level (the event is knowable at its close) */
  index: number;
  t: number;
  close: number;
  broken_swing_index: number;
  broken_swing_t: number;
  /** trend state (last break direction) BEFORE this event; null = none established */
  prior_trend: "up" | "down" | null;
}

/**
 * Forward, causal walk. Before evaluating bar j, every swing whose
 * confirmation bar closed strictly before j becomes the active high/low of its
 * kind (most recent wins). A close strictly beyond the active level is a
 * break; the level is then consumed (no duplicate events on one level).
 *  - break in the direction of the prevailing trend, or with no trend yet: BOS
 *  - first break against the prevailing trend: CHOCH (RAW_5:674)
 * A bar closing beyond BOTH active levels at once is ambiguous: both levels are
 * consumed and no event is emitted.
 */
export function structureEvents(candles: Candle[], swings: SwingPoint[]): StructureEvent[] {
  if (hasNonFiniteCandles(candles)) return [];
  const ordered = swings.slice().sort((a, b) => a.confirmed_index - b.confirmed_index || a.index - b.index);
  const out: StructureEvent[] = [];
  let si = 0;
  let activeHigh: SwingPoint | null = null;
  let activeLow: SwingPoint | null = null;
  let trend: "up" | "down" | null = null;
  for (let j = 0; j < candles.length; j++) {
    while (si < ordered.length && ordered[si].confirmed_index < j) {
      const s = ordered[si++];
      if (s.kind === "high") activeHigh = s; else activeLow = s;
    }
    const c = candles[j].c;
    const up = activeHigh !== null && c > activeHigh.price;
    const down = activeLow !== null && c < activeLow.price;
    if (up && down) { activeHigh = null; activeLow = null; continue; }
    if (up) {
      const s = activeHigh as SwingPoint;
      out.push({ kind: trend === "down" ? "CHOCH" : "BOS", direction: "up", price: s.price, index: j, t: candles[j].t, close: c, broken_swing_index: s.index, broken_swing_t: s.t, prior_trend: trend });
      trend = "up";
      activeHigh = null;
    } else if (down) {
      const s = activeLow as SwingPoint;
      out.push({ kind: trend === "up" ? "CHOCH" : "BOS", direction: "down", price: s.price, index: j, t: candles[j].t, close: c, broken_swing_index: s.index, broken_swing_t: s.t, prior_trend: trend });
      trend = "down";
      activeLow = null;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ levels */

export interface LevelCluster {
  price: number;
  touches: number;
  kind: "support" | "resistance";
  last_touch_t: number;
  /** closes within the clustering tolerance of the level */
  close_density: number;
}

/**
 * Cluster swing extremes of the same kind within `tol` of the cluster's first
 * price. This is the ONE clustering algorithm: FTR-LEVELS (strategy layer) and
 * the bundle's sr_levels (chart / AI) both call it with the same ATR-scaled
 * tolerance (repository spec FTR-SR: "clustered swing touches within
 * ATR-scaled tolerance").
 */
export function clusterSwingLevels(candles: Candle[], swings: SwingPoint[], tol: number): LevelCluster[] {
  if (!Number.isFinite(tol) || tol <= 0) return [];
  const clusters: { prices: number[]; kind: "support" | "resistance"; lastT: number }[] = [];
  for (const s of swings) {
    const kind = s.kind === "high" ? "resistance" : "support";
    const hit = clusters.find((c) => c.kind === kind && Math.abs(c.prices[0] - s.price) <= tol);
    if (hit) { hit.prices.push(s.price); hit.lastT = Math.max(hit.lastT, s.t); }
    else clusters.push({ prices: [s.price], kind, lastT: s.t });
  }
  return clusters.map((c) => {
    const price = c.prices.reduce((x, y) => x + y, 0) / c.prices.length;
    const density = candles.filter((k) => Math.abs(k.c - price) <= tol).length;
    return { price, touches: c.prices.length, kind: c.kind, last_touch_t: c.lastT, close_density: density };
  }).sort((x, y) => y.touches - x.touches);
}

/* -------------------------------------------------------------- zones */

export interface FairValueGap {
  direction: "up" | "down";
  top: number;
  bottom: number;
  /** third candle of the pattern — the gap is knowable at its close */
  t: number;
  index: number;
  /** first candle of the pattern */
  origin_t: number;
  /** first LATER closed bar that traded back into the gap (factual, as of the window end) */
  mitigated_index: number | null;
  mitigated_t: number | null;
}

export interface OrderBlock {
  direction: "up" | "down";
  /** node High/Low (RAW_5:957 — the zone is the node's High/Low range) */
  top: number;
  bottom: number;
  /** the node (last opposing candle before the breaking leg) */
  t: number;
  index: number;
  /** the structural break the node led to (RAW_5:679 — an OB MUST lead to a BOS) */
  break_kind: "BOS" | "CHOCH";
  break_index: number;
  break_t: number;
  broken_level: number;
  /** |break close − node far edge| / ATR14 at the break bar; null when ATR unavailable */
  displacement_atr: number | null;
  mitigated_index: number | null;
  mitigated_t: number | null;
}

export function findFairValueGaps(candles: Candle[]): FairValueGap[] {
  const out: FairValueGap[] = [];
  for (let i = 2; i < candles.length; i++) {
    const c = candles[i], a = candles[i - 2];
    if (c.l > a.h) out.push({ direction: "up", top: c.l, bottom: a.h, t: c.t, index: i, origin_t: a.t, mitigated_index: null, mitigated_t: null });
    else if (c.h < a.l) out.push({ direction: "down", top: a.l, bottom: c.h, t: c.t, index: i, origin_t: a.t, mitigated_index: null, mitigated_t: null });
  }
  return out;
}

function firstEntry(candles: Candle[], from: number, top: number, bottom: number, direction: "up" | "down"): number | null {
  for (let k = from; k < candles.length; k++) {
    // bullish zone sits BELOW price: re-entry = a low trading down into it
    if (direction === "up" ? candles[k].l <= top : candles[k].h >= bottom) return k;
  }
  return null;
}

function withMitigation<T extends { direction: "up" | "down"; top: number; bottom: number; mitigated_index: number | null; mitigated_t: number | null }>(
  candles: Candle[], zone: T, fromIndex: number,
): T {
  const k = firstEntry(candles, fromIndex, zone.top, zone.bottom, zone.direction);
  return { ...zone, mitigated_index: k, mitigated_t: k === null ? null : candles[k].t };
}

export function findOrderBlocks(candles: Candle[], events: StructureEvent[], atr14: (number | null)[]): OrderBlock[] {
  const out: OrderBlock[] = [];
  for (const e of events) {
    const lo = e.broken_swing_index + 1, hi = e.index - 1;
    if (hi < lo) continue;
    // extreme of the breaking leg (lowest low for an up break, highest high for a down break)
    let m = lo;
    for (let k = lo; k <= hi; k++) {
      if (e.direction === "up" ? candles[k].l < candles[m].l : candles[k].h > candles[m].h) m = k;
    }
    let node = -1;
    for (let k = m; k >= lo; k--) {
      const c = candles[k];
      if (e.direction === "up" ? c.c < c.o : c.c > c.o) { node = k; break; }
    }
    if (node < 0) continue;
    const n = candles[node];
    const a = atr14[e.index] ?? null;
    const disp = a !== null && a > 0
      ? (e.direction === "up" ? e.close - n.h : n.l - e.close) / a
      : null;
    out.push(withMitigation(candles, {
      direction: e.direction, top: n.h, bottom: n.l, t: n.t, index: node,
      break_kind: e.kind, break_index: e.index, break_t: e.t, broken_level: e.price,
      displacement_atr: disp, mitigated_index: null, mitigated_t: null,
    }, e.index + 1));
  }
  return out;
}

/* -------------------------------------------------------------- fibonacci */

export interface FibLeg {
  direction: "up" | "down";
  from: { index: number; t: number; price: number };
  to: { index: number; t: number; price: number };
  /** the leg is knowable once its END swing is confirmed */
  confirmed_t: number;
}

/**
 * Retracement of the last CONFIRMED alternating leg (low→high or high→low).
 * Level L is measured from the leg end: price = to − (to − from)·L, so level 0
 * is the leg end and level 1 the leg origin, for both directions.
 */
export function fibOfLastLeg(swings: SwingPoint[]): { leg: FibLeg | null; levels: { level: number; price: number }[] } {
  const alt = alternatingSwings(swings);
  if (alt.length < 2) return { leg: null, levels: [] };
  const a = alt[alt.length - 2], b = alt[alt.length - 1];
  if (a.price === b.price) return { leg: null, levels: [] };
  const leg: FibLeg = {
    direction: b.price > a.price ? "up" : "down",
    from: { index: a.index, t: a.t, price: a.price },
    to: { index: b.index, t: b.t, price: b.price },
    confirmed_t: b.confirmed_t,
  };
  const levels = STRUCTURE_PARAMS.fib_levels.map((lv) => ({ level: lv, price: b.price - (b.price - a.price) * lv }));
  return { leg, levels };
}

/* -------------------------------------------------------------- result */

export type Trend = "up" | "down" | "range" | "undetermined";

export interface TrendEvidence {
  swing_bias: SwingBias | null;
  /** sign(EMA20 − EMA50) with the FTR-MA-ALIGN flat band; null when EMA50 unavailable */
  ma_align: -1 | 0 | 1 | null;
  ema20: number | null;
  ema50: number | null;
}

export interface StructureResult {
  engine_version: string;
  /**
   * up/down: swing sequence AND MA alignment agree (FTR-TREND).
   * range: evidence exists but conflicts or is flat.
   * undetermined: not enough evidence (swings or EMA50 warmup) — NOT "range".
   */
  trend: Trend;
  reason: string;
  trend_evidence: TrendEvidence;
  /** most recent BOS / CHoCH inside the analyzed window (any bar, not only the last) */
  last_bos: StructureEvent | null;
  last_choch: StructureEvent | null;
  /** most recent structural events, ascending */
  events: StructureEvent[];
  sr_levels: { price: number; strength: number; touches: number; kind: "support" | "resistance"; last_touch_t: number }[];
  fvgs: FairValueGap[];
  /** most recent first */
  order_blocks: OrderBlock[];
  swing_points: SwingPoint[];
  last_swing_high: number | null;
  last_swing_low: number | null;
  fib: { level: number; price: number }[];
  fib_leg: FibLeg | null;
}

export function emptyStructure(reason: string): StructureResult {
  return {
    engine_version: STRUCTURE_ENGINE_VERSION,
    trend: "undetermined",
    reason,
    trend_evidence: { swing_bias: null, ma_align: null, ema20: null, ema50: null },
    last_bos: null,
    last_choch: null,
    events: [],
    sr_levels: [],
    fvgs: [],
    order_blocks: [],
    swing_points: [],
    last_swing_high: null,
    last_swing_low: null,
    fib: [],
    fib_leg: null,
  };
}

/**
 * Value AT THE LAST (decision) BAR, or null. Task 09 (STRUCT-1): replaces a
 * last-non-null scan that could have silently used an older bar's value; the
 * canonical indicators never produce that shape (see detectors.atLast), so
 * results are unchanged.
 */
function atLastBar(a: (number | null)[]): number | null {
  const v = a[a.length - 1];
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

export function classifyTrend(
  bias: SwingBiasState | null, ema20: number | null, ema50: number | null, lastClose: number,
): { trend: Trend; reason: string; evidence: TrendEvidence } {
  let align: -1 | 0 | 1 | null = null;
  if (ema20 !== null && ema50 !== null) {
    const band = Math.abs(lastClose) * STRUCTURE_PARAMS.ma_flat_band_frac;
    const d = ema20 - ema50;
    align = Math.abs(d) <= band ? 0 : d > 0 ? 1 : -1;
  }
  const evidence: TrendEvidence = { swing_bias: bias?.bias ?? null, ma_align: align, ema20, ema50 };
  if (!bias) return { trend: "undetermined", reason: "needs ≥2 confirmed swing highs and ≥2 swing lows", evidence };
  if (align === null) return { trend: "undetermined", reason: "EMA50 warmup: needs ≥50 closed bars for MA alignment", evidence };
  if (bias.bias === "HH_HL" && align === 1) return { trend: "up", reason: "HH/HL swing sequence + EMA20>EMA50", evidence };
  if (bias.bias === "LH_LL" && align === -1) return { trend: "down", reason: "LH/LL swing sequence + EMA20<EMA50", evidence };
  const maTxt = align === 0 ? "EMA20≈EMA50 (flat band)" : align === 1 ? "EMA20>EMA50" : "EMA20<EMA50";
  return { trend: "range", reason: `swing sequence ${bias.bias} vs ${maTxt} — no agreement`, evidence };
}

/**
 * Structural read over CLOSED candles. `atr14` may be supplied by a caller
 * that already computed it (the bundle) to avoid duplicate work; it must be
 * aligned to `candles`.
 */
export interface StructureInputs {
  atr14?: (number | null)[];
  /**
   * Task 10 (dedupe): canonical series already computed by the caller
   * (analysis/bundle). Used only when aligned to `candles` (same length);
   * `swings` must come from findSwings(candles, STRUCTURE_PARAMS.swing_left,
   * STRUCTURE_PARAMS.swing_right). Omitted → computed here (same functions).
   */
  ema20?: (number | null)[];
  ema50?: (number | null)[];
  swings?: SwingPoint[];
}

export function analyzeStructure(candles: Candle[], opts: StructureInputs = {}): StructureResult {
  const n = candles.length;
  if (n < STRUCTURE_PARAMS.min_structure_bars) return emptyStructure(`insufficient bars: ${n} < ${STRUCTURE_PARAMS.min_structure_bars}`);
  if (hasNonFiniteCandles(candles)) return emptyStructure("non-finite candle field in input");

  const swings = opts.swings ?? findSwings(candles, STRUCTURE_PARAMS.swing_left, STRUCTURE_PARAMS.swing_right);
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  const atr14 = opts.atr14 && opts.atr14.length === n ? opts.atr14 : atr(candles, 14);
  const curAtr = atLastBar(atr14);

  const events = structureEvents(candles, swings);
  const bosList = events.filter((e) => e.kind === "BOS");
  const chochList = events.filter((e) => e.kind === "CHOCH");

  const tol = curAtr !== null && curAtr > 0 ? curAtr * STRUCTURE_PARAMS.level_cluster_atr : null;
  const sr_levels = tol === null ? [] : clusterSwingLevels(candles, swings, tol)
    .filter((l) => l.touches >= 2)
    .slice(0, STRUCTURE_PARAMS.max_levels)
    .map((l) => ({ price: l.price, strength: Math.min(5, l.touches), touches: l.touches, kind: l.kind, last_touch_t: l.last_touch_t }));

  const fvgs = findFairValueGaps(candles)
    .slice(-STRUCTURE_PARAMS.max_fvgs)
    .map((g) => withMitigation(candles, g, g.index + 1));

  const order_blocks = findOrderBlocks(candles, events, atr14)
    .slice(-STRUCTURE_PARAMS.max_order_blocks)
    .reverse();

  const { leg, levels } = fibOfLastLeg(swings);

  const closes = opts.ema20 && opts.ema20.length === n && opts.ema50 && opts.ema50.length === n ? null : candles.map((c) => c.c);
  const e20 = atLastBar(opts.ema20 && opts.ema20.length === n ? opts.ema20 : ema(closes!, 20));
  const e50 = atLastBar(opts.ema50 && opts.ema50.length === n ? opts.ema50 : ema(closes!, 50));
  const tr = classifyTrend(swingBias(swings), e20, e50, candles[n - 1].c);

  return {
    engine_version: STRUCTURE_ENGINE_VERSION,
    trend: tr.trend,
    reason: tr.reason,
    trend_evidence: tr.evidence,
    last_bos: bosList.length ? bosList[bosList.length - 1] : null,
    last_choch: chochList.length ? chochList[chochList.length - 1] : null,
    events: events.slice(-STRUCTURE_PARAMS.max_events),
    sr_levels,
    fvgs,
    order_blocks,
    swing_points: swings.slice(-STRUCTURE_PARAMS.max_swings),
    last_swing_high: highs.length ? highs[highs.length - 1].price : null,
    last_swing_low: lows.length ? lows[lows.length - 1].price : null,
    fib: levels,
    fib_leg: leg,
  };
}
