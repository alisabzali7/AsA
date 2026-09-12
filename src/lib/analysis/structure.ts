/**
 * Structure layer: swings, BOS/CHoCH, S/R clusters, FVGs, order blocks,
 * fibonacci retracement levels — all deterministic, annotation-ready,
 * and always bounded by the data window actually analyzed.
 */
import type { Candle } from "../domain/types";

export interface SwingPoint {
  index: number;
  t: number;
  price: number;
  kind: "high" | "low";
}

export function findSwings(candles: Candle[], left = 2, right = 2): SwingPoint[] {
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
    if (isHigh) out.push({ index: i, t: candles[i].t, price: c.h, kind: "high" });
    if (isLow) out.push({ index: i, t: candles[i].t, price: c.l, kind: "low" });
  }
  return out;
}

export interface StructureResult {
  trend: "up" | "down" | "range";
  reason: string;
  last_bos: { direction: "up" | "down"; t: number; price: number } | null;
  last_choch: { direction: "up" | "down"; t: number; price: number } | null;
  sr_levels: { price: number; strength: number; kind: "support" | "resistance" }[];
  fvgs: { direction: "up" | "down"; top: number; bottom: number; t: number }[];
  order_blocks: { direction: "up" | "down"; top: number; bottom: number; t: number }[];
  swing_points: SwingPoint[];
  last_swing_high: number | null;
  last_swing_low: number | null;
  fib: { level: number; price: number }[];
}

/**
 * Structural read over an array of CLOSED candles (indexes are in the past;
 * no lookahead: decisions only reference candles <= the last closed one).
 */
export function analyzeStructure(candles: Candle[]): StructureResult {
  const n = candles.length;
  const empty: StructureResult = {
    trend: "range",
    reason: "insufficient bars",
    last_bos: null,
    last_choch: null,
    sr_levels: [],
    fvgs: [],
    order_blocks: [],
    swing_points: [],
    last_swing_high: null,
    last_swing_low: null,
    fib: [],
  };
  if (n < 20) return empty;

  const swings = findSwings(candles, 2, 2);
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  const lastH = highs.length ? highs[highs.length - 1].price : null;
  const lastL = lows.length ? lows[lows.length - 1].price : null;
  const lastClose = candles[n - 1].c;

  // BOS / CHoCH: a close beyond the most recent confirmed swing
  let last_bos: StructureResult["last_bos"] = null;
  let last_choch: StructureResult["last_choch"] = null;
  if (lastH !== null && lastL !== null) {
    const swingSeq = swings.map((s) => s.kind === "high" ? 1 : -1);
    const lastKind = swingSeq[swingSeq.length - 1];
    if (lastKind === 1) {
      // last swing was a HIGH: a close above it = BOS up; a close below last LOW = CHoCH down
      if (lastClose > lastH) last_bos = { direction: "up", t: candles[n - 1].t, price: lastH };
      else if (lastClose < lastL) last_choch = { direction: "down", t: candles[n - 1].t, price: lastL };
    } else {
      if (lastClose < lastL) last_bos = { direction: "down", t: candles[n - 1].t, price: lastL };
      else if (lastClose > lastH) last_choch = { direction: "up", t: candles[n - 1].t, price: lastH };
    }
  }

  // S/R clusters: pivot prices within ~0.3% band merge into levels
  const tol = (p: number) => p * 0.003;
  const levels: { price: number; count: number; kind: "support" | "resistance" }[] = [];
  for (const s of swings) {
    const kind = s.kind === "high" ? "resistance" : "support";
    const band = tol(s.price);
    let found = false;
    for (const lv of levels) {
      if (Math.abs(lv.price - s.price) <= Math.max(band, tol(lv.price))) {
        lv.count++;
        lv.price = (lv.price * (lv.count - 1) + s.price) / lv.count;
        found = true;
        break;
      }
    }
    if (!found) levels.push({ price: s.price, count: 1, kind });
  }
  const sr_levels = levels
    .filter((l) => l.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((l) => ({ price: round8(l.price), strength: Math.min(5, l.count), kind: l.kind }));

  // FVGs: candle i's low strictly above candle i-2's high (up gap wick) etc.
  const fvgs: StructureResult["fvgs"] = [];
  for (let i = 2; i < n; i++) {
    const c = candles[i], a = candles[i - 2];
    if (c.l > a.h) fvgs.push({ direction: "up", top: c.l, bottom: a.h, t: c.t });
    else if (c.h < a.l) fvgs.push({ direction: "down", top: a.l, bottom: c.h, t: c.t });
  }

  // Order blocks: the last opposite-colour candle before a 1-ATR+ impulse
  const order_blocks: StructureResult["order_blocks"] = [];
  {
    let i = n - 1;
    let impulses = 0;
    while (i >= 1 && impulses < 3) {
      const c = candles[i];
      const body = Math.abs(c.c - c.o);
      if (body > 0.9 * (c.h - c.l) && body > 0) {
        const prev = candles[i - 1];
        const dir = c.c > c.o ? "up" : "down";
        const prevDir = prev.c > prev.o ? "up" : "down";
        if (prevDir !== dir) {
          order_blocks.push({
            direction: dir,
            top: Math.max(prev.o, prev.c),
            bottom: Math.min(prev.o, prev.c),
            t: prev.t,
          });
          impulses++;
        }
      }
      i--;
    }
  }

  // Fib retracement of the last major swing leg
  const fib: StructureResult["fib"] = [];
  if (swings.length >= 2) {
    const a = swings[swings.length - 2], b = swings[swings.length - 1];
    const hi = Math.max(a.price, b.price), lo = Math.min(a.price, b.price);
    if (hi > lo) {
      for (const lv of [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
        fib.push({ level: lv, price: round8(hi - (hi - lo) * lv) });
      }
    }
  }

  // regime
  const closes = candles.map((c) => c.c);
  const e20 = emaShort(closes, 20), e50 = emaShort(closes, 50);
  let trend: "up" | "down" | "range" = "range";
  let reason = "price between EMAs / no recent break";
  if (e20 !== null && e50 !== null) {
    const a = candles.slice(-10);
    const drift = a.length ? (a[a.length - 1].c - a[0].c) / a[0].c : 0;
    if (last_bos?.direction === "up" && e20 > e50) { trend = "up"; reason = "BOS up + EMA20>EMA50"; }
    else if (last_bos?.direction === "down" && e20 < e50) { trend = "down"; reason = "BOS down + EMA20<EMA50"; }
    else if (drift > 0.01) { trend = "up"; reason = "EMA20>EMA50 and positive drift"; }
    else if (drift < -0.01) { trend = "down"; reason = "EMA20<EMA50 and negative drift"; }
    else reason = "no structural break; EMA flat";
  }

  return {
    trend,
    reason,
    last_bos,
    last_choch,
    sr_levels,
    fvgs: fvgs.slice(-6),
    order_blocks: order_blocks.slice(0, 3),
    swing_points: swings.slice(-10),
    last_swing_high: lastH,
    last_swing_low: lastL,
    fib,
  };
}

function emaShort(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}

function round8(v: number): number {
  return Math.round(v * 1e8) / 1e8;
}
