/**
 * Team 02 — semantic / property / metamorphic tests for the canonical
 * structure engine (src/lib/analysis/structure.ts) and the bundle built on it.
 *
 * Properties checked (each a truth rule of the mission):
 *  - causality: every event/swing/FVG reported on a prefix is identical to the
 *    full-series result restricted to that prefix (no repainting, no lookahead)
 *  - confirmation: a swing is only knowable at index + right
 *  - order blocks exist only with a structural break; mitigation is after the break
 *  - Fibonacci runs over an alternating leg and is direction-aware
 *  - momentum/divergence are read only at confirmed swings
 *  - no NaN/Infinity anywhere in the bundle; determinism; metamorphic invariance
 */
import { describe, it, expect } from "vitest";
import type { Candle } from "../src/lib/domain/types";
import {
  analyzeStructure, findSwings, alternatingSwings, structureEvents, findFairValueGaps, fibOfLastLeg, STRUCTURE_PARAMS,
} from "../src/lib/analysis/structure";
import { atr, rsi } from "../src/lib/analysis/indicators";
import { legMomentum } from "../src/lib/analysis/momentum";
import { detectRsiDivergences } from "../src/lib/analysis/divergence";
import { buildBundle } from "../src/lib/analysis/bundle";

/** deterministic LCG — no Math.random in tests either */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** random walk on a 0.25 grid (exact in binary FP), midpoint-free OHLC */
function walk(n: number, seed: number, step = 60): Candle[] {
  const r = lcg(seed);
  let p = 1000;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o + Math.round((r() - 0.5) * 24) * 0.25;
    const h = Math.max(o, c) + Math.round(r() * 8) * 0.25;
    const l = Math.min(o, c) - Math.round(r() * 8) * 0.25;
    out.push({ t: 1_700_000_000 + i * step, o, h, l, c, v: 100 + Math.round(r() * 50) });
    p = c;
  }
  return out;
}

const SEEDS = [1, 7, 42, 1337, 2026];

function allNumbersFinite(x: unknown, path = "$"): string[] {
  if (typeof x === "number") return Number.isFinite(x) ? [] : [path];
  if (Array.isArray(x)) return x.flatMap((v, i) => allNumbersFinite(v, `${path}[${i}]`));
  if (x && typeof x === "object") return Object.entries(x).flatMap(([k, v]) => allNumbersFinite(v, `${path}.${k}`));
  return [];
}

describe("causality: prefix invariance (no repainting / no lookahead)", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: swings, BOS/CHoCH events and FVGs on every prefix equal the full-series result up to that bar`, () => {
      const full = walk(220, seed);
      const fullSwings = findSwings(full);
      const fullEvents = structureEvents(full, fullSwings);
      const fullFvgs = findFairValueGaps(full);
      expect(fullEvents.length).toBeGreaterThan(0); // the fixture must actually exercise the engine
      for (let k = 25; k <= full.length; k += 13) {
        const pre = full.slice(0, k);
        const sw = findSwings(pre);
        // a swing is reported on the prefix iff it is confirmed inside the prefix
        expect(sw).toEqual(fullSwings.filter((s) => s.confirmed_index < k));
        expect(structureEvents(pre, sw)).toEqual(fullEvents.filter((e) => e.index < k));
        expect(findFairValueGaps(pre).map((g) => [g.index, g.direction, g.top, g.bottom]))
          .toEqual(fullFvgs.filter((g) => g.index < k).map((g) => [g.index, g.direction, g.top, g.bottom]));
      }
    });
  }

  it("appending future bars never changes a past event's kind/direction/level", () => {
    const full = walk(300, 99);
    const a = analyzeStructure(full.slice(0, 150)).events;
    const b = structureEvents(full, findSwings(full)).filter((e) => e.index < 150);
    // analyzeStructure keeps only the most recent events; each must appear in the full history unchanged
    for (const e of a) expect(b).toContainEqual(e);
  });
});

describe("confirmation discipline", () => {
  it("every swing is confirmed exactly `right` bars later and is a strict fractal", () => {
    const c = walk(200, 5);
    for (const s of findSwings(c)) {
      expect(s.confirmed_index).toBe(s.index + STRUCTURE_PARAMS.swing_right);
      expect(s.confirmed_t).toBe(c[s.confirmed_index].t);
      for (let j = s.index - 2; j <= s.index + 2; j++) {
        if (j === s.index) continue;
        if (s.kind === "high") expect(c[j].h).toBeLessThan(s.price);
        else expect(c[j].l).toBeGreaterThan(s.price);
      }
    }
  });

  it("a structural event only breaks a swing that was ALREADY confirmed before the breaking bar", () => {
    for (const seed of SEEDS) {
      const c = walk(220, seed);
      const sw = findSwings(c);
      for (const e of structureEvents(c, sw)) {
        const broken = sw.find((s) => s.index === e.broken_swing_index)!;
        expect(broken).toBeDefined();
        expect(broken.confirmed_index).toBeLessThan(e.index);
        if (e.direction === "up") expect(c[e.index].c).toBeGreaterThan(e.price);
        else expect(c[e.index].c).toBeLessThan(e.price);
      }
    }
  });

  it("CHoCH is always against the prior trend; BOS never is", () => {
    for (const seed of SEEDS) {
      const c = walk(220, seed);
      for (const e of structureEvents(c, findSwings(c))) {
        if (e.kind === "CHOCH") expect(e.prior_trend).toBe(e.direction === "up" ? "down" : "up");
        else expect(e.prior_trend === null || e.prior_trend === e.direction).toBe(true);
      }
    }
  });
});

describe("zones: FVG / order block lifecycle", () => {
  it("FVG mitigation is the first LATER bar trading back into the gap, never the pattern itself", () => {
    for (const seed of SEEDS) {
      const c = walk(220, seed);
      for (const g of analyzeStructure(c).fvgs) {
        expect(g.top).toBeGreaterThan(g.bottom);
        if (g.mitigated_index === null) continue;
        expect(g.mitigated_index).toBeGreaterThan(g.index);
        for (let k = g.index + 1; k < g.mitigated_index; k++) {
          if (g.direction === "up") expect(c[k].l).toBeGreaterThan(g.top);
          else expect(c[k].h).toBeLessThan(g.bottom);
        }
      }
    }
  });

  it("every order block references a real BOS/CHoCH, sits before it, and is an opposing candle", () => {
    let seen = 0;
    for (const seed of SEEDS) {
      const c = walk(220, seed);
      const st = analyzeStructure(c);
      const all = structureEvents(c, findSwings(c));
      for (const ob of st.order_blocks) {
        seen++;
        const ev = all.find((e) => e.index === ob.break_index)!;
        expect(ev).toBeDefined();
        expect(ev.kind).toBe(ob.break_kind);
        expect(ob.index).toBeLessThan(ob.break_index);
        const n = c[ob.index];
        expect(ob.direction === "up" ? n.c < n.o : n.c > n.o).toBe(true);
        expect([ob.top, ob.bottom]).toEqual([n.h, n.l]);
        if (ob.mitigated_index !== null) expect(ob.mitigated_index).toBeGreaterThan(ob.break_index);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("Fibonacci", () => {
  it("leg endpoints are alternating swings; level 0 = leg end, level 1 = leg origin, monotone ladder", () => {
    for (const seed of SEEDS) {
      const c = walk(220, seed);
      const { leg, levels } = fibOfLastLeg(findSwings(c));
      expect(leg).not.toBeNull();
      const sw = findSwings(c);
      const from = sw.find((s) => s.index === leg!.from.index && s.price === leg!.from.price)!;
      const to = sw.find((s) => s.index === leg!.to.index && s.price === leg!.to.price)!;
      expect(from.kind).not.toBe(to.kind);
      expect(leg!.direction).toBe(to.kind === "high" ? "up" : "down");
      expect(levels[0].price).toBe(to.price);
      expect(levels[levels.length - 1].price).toBe(from.price);
      for (let i = 1; i < levels.length; i++) {
        if (leg!.direction === "up") expect(levels[i].price).toBeLessThan(levels[i - 1].price);
        else expect(levels[i].price).toBeGreaterThan(levels[i - 1].price);
      }
    }
  });
});

describe("momentum (RAW_4:1193/1196 — relative last-leg slope, thresholds OPEN SPEC)", () => {
  it("regression: a swing high BELOW the last swing low is not a leg end (alternatingSwings)", () => {
    const sp = (index: number, kind: "high" | "low", price: number) => ({ index, t: index * 60, price, kind, confirmed_index: index + 2, confirmed_t: (index + 2) * 60 });
    // pre-fix: [low 95, high 94, low 80] -> a "low->high" leg that goes DOWN
    const alt = alternatingSwings([sp(5, "low", 95), sp(8, "high", 94), sp(12, "low", 80), sp(16, "high", 100)]);
    expect(alt.map((s) => [s.index, s.kind, s.price])).toEqual([[12, "low", 80], [16, "high", 100]]);
    const alt2 = alternatingSwings([sp(5, "high", 110), sp(8, "low", 112), sp(12, "high", 120)]);
    expect(alt2.map((s) => [s.index, s.kind, s.price])).toEqual([[12, "high", 120]]);
  });

  it("legs alternate, run between confirmed swings, and the ratio equals the slope quotient", () => {
    const c = walk(220, 42);
    const sw = findSwings(c);
    const m = legMomentum(c, sw, atr(c, 14));
    expect(m.classification).toBe("OPEN_SPECIFICATION");
    expect(m.legs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < m.legs.length; i++) expect(m.legs[i].direction).not.toBe(m.legs[i - 1].direction);
    for (const l of m.legs) {
      expect(l.status).toBe("CONFIRMED");
      expect(sw.some((s) => s.index === l.to.index)).toBe(true);
      expect(l.slope_per_bar).toBeCloseTo(l.change / l.bars, 12);
    }
    const [p, q] = m.legs.slice(-2);
    expect(m.last_vs_previous_slope_ratio).toBeCloseTo(Math.abs(q.slope_per_bar) / Math.abs(p.slope_per_bar), 12);
    // the current leg (last swing -> last closed bar) is never labelled confirmed
    if (m.current_leg) expect(m.current_leg.status).toBe("UNCONFIRMED");
  });

  it("no swings -> no legs, with a stated reason (no fabricated momentum)", () => {
    const flat: Candle[] = Array.from({ length: 40 }, (_, i) => ({ t: i * 60, o: 1, h: 1, l: 1, c: 1, v: 1 }));
    const m = legMomentum(flat, findSwings(flat), atr(flat, 14));
    expect(m.legs).toEqual([]);
    expect(m.last_leg).toBeNull();
    expect(m.reason.length).toBeGreaterThan(0);
  });
});

describe("divergence (RAW_1:891/892/899 — RSI-only, PARTIAL)", () => {
  // Two swing highs at 10 and 20, two swing lows at 5 and 15; RSI supplied directly.
  const mk = (highs: [number, number], lows: [number, number]): Candle[] =>
    Array.from({ length: 30 }, (_, i) => {
      let h = 101, l = 99;
      if (i === 10) h = highs[0];
      if (i === 20) h = highs[1];
      if (i === 5) l = lows[0];
      if (i === 15) l = lows[1];
      return { t: 1000 + i * 60, o: 100, h, l, c: 100, v: 1 };
    });
  const rsiWith = (vals: Record<number, number>) => Array.from({ length: 30 }, (_, i) => vals[i] ?? 50);

  it("regular bearish: higher price high with a lower RSI high, confirmed at the 2nd pivot + right", () => {
    const c = mk([110, 115], [90, 92]);
    const d = detectRsiDivergences(c, findSwings(c), rsiWith({ 10: 70, 20: 60, 5: 30, 15: 35 }));
    const ev = d.events.find((e) => e.kind === "regular_bearish")!;
    expect(ev).toMatchObject({ indicator: "RSI14", from: { index: 10, price: 110, value: 70 }, to: { index: 20, price: 115, value: 60 }, confirmed_index: 22 });
    expect(d.spec_status).toBe("PARTIAL");
    expect(d.unsupported.hidden_bearish).toBe("NOT_IN_SOURCE");
  });

  it("regular bullish (lower low, higher RSI) and hidden bullish (higher low, lower RSI)", () => {
    const a = mk([110, 108], [90, 85]);
    expect(detectRsiDivergences(a, findSwings(a), rsiWith({ 5: 25, 15: 32, 10: 60, 20: 55 })).events.map((e) => e.kind)).toContain("regular_bullish");
    const b = mk([110, 108], [90, 93]);
    expect(detectRsiDivergences(b, findSwings(b), rsiWith({ 5: 35, 15: 28, 10: 60, 20: 55 })).events.map((e) => e.kind)).toContain("hidden_bullish");
  });

  it("warmup RSI (null) at a pivot yields no divergence, never a guessed value", () => {
    const c = mk([110, 115], [90, 92]);
    const r: (number | null)[] = rsiWith({ 20: 60, 5: 30, 15: 35 });
    r[10] = null;
    expect(detectRsiDivergences(c, findSwings(c), r).events.filter((e) => e.kind === "regular_bearish")).toEqual([]);
  });

  it("hidden bearish is never emitted (not in source)", () => {
    for (const seed of SEEDS) {
      const c = walk(220, seed);
      const kinds = detectRsiDivergences(c, findSwings(c), rsi(c.map((x) => x.c), 14)).events.map((e) => e.kind as string);
      expect(kinds).not.toContain("hidden_bearish");
    }
  });
});

describe("bundle integrity: finiteness, determinism, metamorphic invariance", () => {
  it("no NaN/Infinity anywhere in the bundle for any bar count 0..120", () => {
    const c = walk(120, 3);
    for (let n = 0; n <= 120; n += 7) {
      const b = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles: c.slice(0, n), nowMs: 1_800_000_000_000 });
      expect(allNumbersFinite(b)).toEqual([]);
    }
  });

  it("identical input -> byte-identical bundle (nowMs injected; no hidden clock in calculations)", () => {
    const c = walk(150, 11);
    const a = JSON.stringify(buildBundle({ symbol: "X", timeframe: "1h", candles: c, nowMs: 1 }));
    const b = JSON.stringify(buildBundle({ symbol: "X", timeframe: "1h", candles: c, nowMs: 1 }));
    expect(a).toBe(b);
    // metadata is the only thing nowMs may influence
    const later = buildBundle({ symbol: "X", timeframe: "1h", candles: c, nowMs: 999_999 });
    const early = buildBundle({ symbol: "X", timeframe: "1h", candles: c, nowMs: 1 });
    expect(later.structure).toEqual(early.structure);
    expect(later.indicators).toEqual(early.indicators);
  });

  it("price scaling by 2 (exact in FP) preserves every structural index and trend", () => {
    for (const seed of SEEDS) {
      const c = walk(200, seed);
      const c2 = c.map((x) => ({ ...x, o: x.o * 2, h: x.h * 2, l: x.l * 2, c: x.c * 2 }));
      const a = analyzeStructure(c), b = analyzeStructure(c2);
      expect(b.trend).toBe(a.trend);
      expect(b.events.map((e) => [e.kind, e.direction, e.index])).toEqual(a.events.map((e) => [e.kind, e.direction, e.index]));
      expect(b.swing_points.map((s) => s.index)).toEqual(a.swing_points.map((s) => s.index));
      expect(b.fvgs.map((g) => g.index)).toEqual(a.fvgs.map((g) => g.index));
      expect(b.order_blocks.map((o) => o.index)).toEqual(a.order_blocks.map((o) => o.index));
    }
  });

  it("price mirroring (p -> K - p on an exact grid) swaps highs/lows and up/down at the same indices", () => {
    const K = 4000;
    for (const seed of SEEDS) {
      const c = walk(200, seed);
      const m = c.map((x) => ({ ...x, o: K - x.o, h: K - x.l, l: K - x.h, c: K - x.c }));
      const sa = findSwings(c), sb = findSwings(m);
      // outside bars emit high+low at one index; compare as a set ordered by (index, kind)
      const key = (x: [number, string]) => `${String(x[0]).padStart(5, "0")}${x[1]}`;
      const norm = (xs: [number, string][]) => xs.map(key).sort();
      expect(norm(sb.map((s) => [s.index, s.kind === "high" ? "low" : "high"]))).toEqual(norm(sa.map((s) => [s.index, s.kind])));
      const ea = structureEvents(c, sa), eb = structureEvents(m, sb);
      expect(eb.map((e) => [e.kind, e.direction === "up" ? "down" : "up", e.index])).toEqual(ea.map((e) => [e.kind, e.direction, e.index]));
    }
  });

  it("time translation (shift every t by one bar) changes no structural reading", () => {
    const c = walk(160, 8);
    const s = c.map((x) => ({ ...x, t: x.t + 3600 }));
    const a = analyzeStructure(c), b = analyzeStructure(s);
    expect(b.trend).toBe(a.trend);
    expect(b.events.map((e) => e.index)).toEqual(a.events.map((e) => e.index));
  });
});
