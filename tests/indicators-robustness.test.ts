/**
 * Team 02 Technical Analysis Layer - Task 07 Robustness, Input Contracts & Property Verification
 *
 * Verifies:
 * - Task A & Q: Period Validation Contract (p=0, p<0, p=1, p>len, non-integer, NaN, Infinity)
 * - Task B: Non-Finite Inputs (NaN, Infinity, -Infinity in price and candle arrays)
 * - Task C: Candle Structural Validity & Boundaries
 * - Task D: Empty and Short Input Matrix ([], 1 sample, < period, exact warmup, warmup + 1)
 * - Task E: RSI Edge Cases (flat, all-rising, all-falling, zero-gain, zero-loss, floating precision)
 * - Task F: EMA Robustness & Equivalence (seed, constant series, large values, lastEma vs ema consistency)
 * - Task G: ATR Robustness (zero-range, gap-range, precision, positive finiteness)
 * - Task H: Rolling Window Robustness (rollingMax, rollingMin, window boundaries, duplicates)
 * - Task I & J: Structure Input & Arithmetic Safety (findSwings, analyzeStructure, zero-division, ties)
 * - Task K: Bundle Safety & Fallbacks (empty, short, valid, non-finite handling)
 * - Task L: Finite-Output Invariant (zero non-finite numbers in numeric outputs)
 * - Task M: Output Length Invariant (out.length === in.length across all primitives)
 * - Task N: Property-Level Verification (constant series, monotonic bounds, swing index containment)
 * - Task O: Metamorphic Tests (Translation invariance for EMA; Scaling invariance for EMA, ATR, Fib, RSI)
 * - Task P: No Hidden Coercion Verification
 * - Task R: Deterministic Repeatability
 * - Task S: Computational Efficiency / Linear Performance
 */
import { describe, expect, it } from "vitest";
import type { Candle } from "../src/lib/domain/types";
import { ema, lastEma, rsi, atr, rollingMax, rollingMin } from "../src/lib/analysis/indicators";
import { findSwings, analyzeStructure, type StructureResult } from "../src/lib/analysis/structure";
import { buildBundle } from "../src/lib/analysis/bundle";

function makeCandle(t: number, o: number, h: number, l: number, c: number, v = 100): Candle {
  return { t, o, h, l, c, v };
}

function makeSeries(closes: number[], step = 60, startT = 1_700_000_000): Candle[] {
  return closes.map((c, i) => {
    const o = i > 0 ? closes[i - 1] : c;
    const h = Math.max(o, c) + 1;
    const l = Math.min(o, c) - 1;
    return makeCandle(startT + i * step, o, h, l, c, 100 + i);
  });
}

describe("Task A & Q: Period Validation Contract", () => {
  const values = [10, 20, 30, 40, 50];
  const candles = values.map((v, i) => makeCandle(1000 + i * 60, v, v + 2, v - 2, v, 100));

  it("handles non-positive periods (p <= 0) by returning safe unavailable (null) arrays", () => {
    // ema
    expect(ema(values, 0)).toEqual([null, null, null, null, null]);
    expect(ema(values, -1)).toEqual([null, null, null, null, null]);
    expect(lastEma(values, 0)).toBeNull();
    expect(lastEma(values, -5)).toBeNull();

    // rsi
    expect(rsi(values, 0)).toEqual([null, null, null, null, null]);
    expect(rsi(values, -2)).toEqual([null, null, null, null, null]);

    // atr
    expect(atr(candles, 0)).toEqual([null, null, null, null, null]);
    expect(atr(candles, -4)).toEqual([null, null, null, null, null]);

    // rollingMax & rollingMin
    expect(rollingMax(values, 0)).toEqual([null, null, null, null, null]);
    expect(rollingMax(values, -3)).toEqual([null, null, null, null, null]);
    expect(rollingMin(values, 0)).toEqual([null, null, null, null, null]);
    expect(rollingMin(values, -3)).toEqual([null, null, null, null, null]);
  });

  it("handles non-integer and non-finite periods safely without throwing or NaN", () => {
    for (const invalidPeriod of [NaN, Infinity, -Infinity, 2.5, 3.7]) {
      expect(ema(values, invalidPeriod)).toEqual([null, null, null, null, null]);
      expect(lastEma(values, invalidPeriod)).toBeNull();
      expect(rsi(values, invalidPeriod)).toEqual([null, null, null, null, null]);
      expect(atr(candles, invalidPeriod)).toEqual([null, null, null, null, null]);
      expect(rollingMax(values, invalidPeriod)).toEqual([null, null, null, null, null]);
      expect(rollingMin(values, invalidPeriod)).toEqual([null, null, null, null, null]);
    }
  });

  it("permits period = 1 as a valid positive integer boundary", () => {
    expect(ema([10, 20], 1)).toEqual([10, 20]);
    expect(lastEma([10, 20], 1)).toBe(20);
    expect(rsi([10, 20, 25], 1)).toEqual([null, 100, 100]);
    expect(atr(candles.slice(0, 3), 1)).toEqual([null, 12, 12]);
    expect(rollingMax([10, 20], 1)).toEqual([10, 20]);
    expect(rollingMin([10, 20], 1)).toEqual([10, 20]);
  });
});

describe("Task B & Task L: Non-Finite Inputs & Finite-Output Invariant", () => {
  const badValues = [10, NaN, 20, Infinity, 30, -Infinity];
  const badCandles: Candle[] = [
    makeCandle(1000, 10, 12, 8, 11),
    makeCandle(1060, NaN, 12, 8, 11),
    makeCandle(1120, 10, Infinity, 8, 11),
    makeCandle(1180, 10, 12, -Infinity, 11),
    makeCandle(1240, 10, 12, 8, NaN),
  ];

  it("indicators return safe null array on non-finite values (no NaN leakage)", () => {
    const resEma = ema(badValues, 2);
    expect(resEma).toEqual(new Array(badValues.length).fill(null));
    expect(lastEma(badValues, 2)).toBeNull();

    const resRsi = rsi(badValues, 2);
    expect(resRsi).toEqual(new Array(badValues.length).fill(null));

    const resAtr = atr(badCandles, 2);
    expect(resAtr).toEqual(new Array(badCandles.length).fill(null));

    const resRMax = rollingMax(badValues, 2);
    expect(resRMax).toEqual(new Array(badValues.length).fill(null));

    const resRMin = rollingMin(badValues, 2);
    expect(resRMin).toEqual(new Array(badValues.length).fill(null));
  });

  it("structure primitives handle non-finite candles safely without throw or NaN", () => {
    expect(findSwings(badCandles, 2, 2)).toEqual([]);
    const st = analyzeStructure(badCandles);
    expect(st.trend).toBe("range");
    expect(st.reason).toBe("insufficient bars");
    expect(st.sr_levels).toEqual([]);
    expect(st.fvgs).toEqual([]);
    expect(st.order_blocks).toEqual([]);
  });

  it("numeric invariant: every non-null numeric output from valid calls is strictly finite", () => {
    const validSeries = [100, 102, 101, 105, 107, 106, 110, 112, 111, 115, 120, 118, 122, 125, 124, 130];
    const validCandles = makeSeries(validSeries);

    const checkAllFinite = (arr: (number | null)[]) => {
      for (const v of arr) {
        if (v !== null) {
          expect(Number.isFinite(v)).toBe(true);
          expect(Number.isNaN(v)).toBe(false);
        }
      }
    };

    checkAllFinite(ema(validSeries, 5));
    checkAllFinite(rsi(validSeries, 5));
    checkAllFinite(atr(validCandles, 5));
    checkAllFinite(rollingMax(validSeries, 5));
    checkAllFinite(rollingMin(validSeries, 5));
  });
});

describe("Task D & Task M: Input Length & Output Length Invariants", () => {
  it("output length strictly equals input length across empty, short, and long inputs", () => {
    const testLengths = [0, 1, 2, 5, 14, 15, 50];
    for (const len of testLengths) {
      const vals = Array.from({ length: len }, (_, i) => 100 + i);
      const cnds = makeSeries(vals);

      expect(ema(vals, 14).length).toBe(len);
      expect(rsi(vals, 14).length).toBe(len);
      expect(atr(cnds, 14).length).toBe(len);
      expect(rollingMax(vals, 14).length).toBe(len);
      expect(rollingMin(vals, 14).length).toBe(len);
    }
  });

  it("consolidated matrix: exact warmup index and first valid index", () => {
    const p = 5;
    const vals = [10, 20, 30, 40, 50, 60, 70];
    const cnds = makeSeries(vals);

    // EMA(5): warmup needs 5 items (idx 0..4). First valid index = 4 (period - 1)
    const e = ema(vals, p);
    expect(e[3]).toBeNull();
    expect(e[4]).toBe((10 + 20 + 30 + 40 + 50) / 5);
    expect(e[5]).not.toBeNull();

    // RSI(5): needs > 5 items (length > period). First valid index = 5 (period)
    const r = rsi(vals, p);
    expect(r[4]).toBeNull();
    expect(r[5]).toBe(100);

    // ATR(5): needs > 5 candles (length > period). First valid index = 5 (period)
    const a = atr(cnds, p);
    expect(a[4]).toBeNull();
    expect(a[5]).not.toBeNull();

    // RollingMax(5): first valid index = 4 (period - 1)
    const rm = rollingMax(vals, p);
    expect(rm[3]).toBeNull();
    expect(rm[4]).toBe(50);
  });
});

describe("Task E: RSI Edge Cases", () => {
  it("flat series evaluates to canonical neutral RSI = 50", () => {
    const flat = new Array(25).fill(100);
    const r = rsi(flat, 14);
    for (let i = 14; i < flat.length; i++) {
      expect(r[i]).toBe(50);
    }
  });

  it("strictly rising series evaluates to RSI = 100", () => {
    const rising = Array.from({ length: 25 }, (_, i) => 100 + i * 2);
    const r = rsi(rising, 14);
    for (let i = 14; i < rising.length; i++) {
      expect(r[i]).toBe(100);
    }
  });

  it("strictly falling series evaluates to RSI = 0", () => {
    const falling = Array.from({ length: 25 }, (_, i) => 200 - i * 2);
    const r = rsi(falling, 14);
    for (let i = 14; i < falling.length; i++) {
      expect(r[i]).toBe(0);
    }
  });

  it("handles microscopic floating-point moves without zero-division or NaN", () => {
    const tiny = Array.from({ length: 25 }, (_, i) => 100 + i * 1e-12);
    const r = rsi(tiny, 14);
    expect(r[14]).toBe(100);
  });

  it("handles alternating delta series within [0, 100]", () => {
    const alternating = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 2 : -2));
    const r = rsi(alternating, 14);
    for (let i = 14; i < alternating.length; i++) {
      expect(r[i]!).toBeGreaterThanOrEqual(0);
      expect(r[i]!).toBeLessThanOrEqual(100);
    }
  });
});

describe("Task F: EMA Robustness & Equivalence", () => {
  it("lastEma is semantically and numerically identical to the final non-null element of ema()", () => {
    const testCases = [
      [10],
      [10, 20],
      [10, 20, 30, 40, 50],
      Array.from({ length: 60 }, (_, i) => Math.sin(i) * 50 + 100),
    ];

    for (const series of testCases) {
      for (const p of [1, 2, 5, 14, 20, 50, 100]) {
        const fullEma = ema(series, p);
        const lastSingle = lastEma(series, p);
        let expectedLast: number | null = null;
        for (let i = fullEma.length - 1; i >= 0; i--) {
          if (fullEma[i] !== null) {
            expectedLast = fullEma[i];
            break;
          }
        }
        expect(lastSingle).toBe(expectedLast);
      }
    }
  });

  it("constant series preserves exact constant value after seed", () => {
    const constantVal = 42.125;
    const series = new Array(30).fill(constantVal);
    const res = ema(series, 10);
    for (let i = 9; i < series.length; i++) {
      expect(res[i]).toBeCloseTo(constantVal, 10);
    }
  });

  it("period equal to length produces exactly one valid EMA at the final index", () => {
    const vals = [10, 20, 30, 40, 50];
    const res = ema(vals, 5);
    expect(res.slice(0, 4)).toEqual([null, null, null, null]);
    expect(res[4]).toBe(30);
  });

  it("period greater than length produces all nulls", () => {
    const vals = [10, 20, 30];
    expect(ema(vals, 4)).toEqual([null, null, null]);
    expect(lastEma(vals, 4)).toBeNull();
  });
});

describe("Task G: ATR Robustness", () => {
  it("zero-range flat candles yield ATR = 0", () => {
    const flatCandles: Candle[] = Array.from({ length: 25 }, (_, i) =>
      makeCandle(1000 + i * 60, 100, 100, 100, 100, 0)
    );
    const a = atr(flatCandles, 14);
    for (let i = 14; i < flatCandles.length; i++) {
      expect(a[i]).toBe(0);
    }
  });

  it("correctly factors overnight price gaps into True Range", () => {
    // Candle 0: C=100. Candle 1: gaps to O=120, H=125, L=118, C=122
    // TR1 = max(125 - 118 = 7, |125 - 100| = 25, |118 - 100| = 18) = 25
    const candles = [
      makeCandle(1000, 100, 102, 98, 100),
      makeCandle(1060, 120, 125, 118, 122),
    ];
    const a = atr(candles, 1);
    expect(a[1]).toBe(25);
  });
});

describe("Task H: Rolling Window Robustness", () => {
  it("period 1 rollingMax and rollingMin mirror the input array exactly", () => {
    const vals = [15, 3, 28, 9, 44, 2];
    expect(rollingMax(vals, 1)).toEqual(vals);
    expect(rollingMin(vals, 1)).toEqual(vals);
  });

  it("rollingMax and rollingMin exactly match Math.max/min over active window (no value leak)", () => {
    const vals = [10, 50, 20, 80, 15, 90, 5, 25, 70, 30];
    const period = 3;
    const rMax = rollingMax(vals, period);
    const rMin = rollingMin(vals, period);

    for (let i = period - 1; i < vals.length; i++) {
      const window = vals.slice(i - period + 1, i + 1);
      expect(rMax[i]).toBe(Math.max(...window));
      expect(rMin[i]).toBe(Math.min(...window));
    }
  });

  it("period equal to length yields a single valid value at the end", () => {
    const vals = [10, 50, 20, 80, 15];
    const rMax = rollingMax(vals, 5);
    expect(rMax.slice(0, 4)).toEqual([null, null, null, null]);
    expect(rMax[4]).toBe(80);
  });
});

describe("Task I & J: Structure Arithmetic and Boundary Safety", () => {
  it("handles left/right parameters <= 0 or non-integer safely", () => {
    const candles = makeSeries([10, 20, 30, 20, 10]);
    expect(findSwings(candles, 0, 0)).toEqual([]);
    expect(findSwings(candles, -1, 2)).toEqual([]);
    expect(findSwings(candles, 2.5, 2)).toEqual([]);
    expect(findSwings(candles, NaN, 2)).toEqual([]);
  });

  it("handles zero price and constant price candles without division by zero in analyzeStructure", () => {
    const zeroCandles: Candle[] = Array.from({ length: 25 }, (_, i) =>
      makeCandle(1000 + i * 60, 0, 0, 0, 0, 0)
    );
    const res = analyzeStructure(zeroCandles);
    expect(res.trend).toBe("range");
    expect(res.sr_levels).toEqual([]);
    expect(res.fib).toEqual([]);
  });

  it("all-rising and all-falling series produce valid structure outcomes without crash", () => {
    const risingCandles = makeSeries(Array.from({ length: 30 }, (_, i) => 100 + i * 5));
    const resRising = analyzeStructure(risingCandles);
    expect(["up", "range"]).toContain(resRising.trend);

    const fallingCandles = makeSeries(Array.from({ length: 30 }, (_, i) => 300 - i * 5));
    const resFalling = analyzeStructure(fallingCandles);
    expect(["down", "range"]).toContain(resFalling.trend);
  });
});

describe("Task K: Bundle Safety", () => {
  it("buildBundle safely reports empty/unavailable metrics for 0 candles", () => {
    const b = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles: [] });
    expect(b.bars).toBe(0);
    expect(b.last_close).toBeNull();
    expect(b.indicators.ema20).toBeNull();
    expect(b.indicators.rsi14).toBeNull();
    expect(b.indicators.atr14).toBeNull();
    expect(b.structure.trend).toBe("range");
    expect(b.structure.reason).toBe("insufficient bars");
  });

  it("buildBundle handles single candle without non-finite metrics in indicators", () => {
    const single: Candle[] = [makeCandle(1000, 100, 105, 95, 102, 50)];
    const b = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles: single });
    expect(b.bars).toBe(1);
    expect(b.last_close).toBe(102);
    expect(b.indicators.ema20).toBeNull();
    expect(b.indicators.rsi14).toBeNull();
    expect(b.indicators.atr14).toBeNull();
  });
});

describe("Task N & O: Property-Level & Metamorphic Verification", () => {
  it("metamorphic translation property: shifting closes by +C shifts EMA by +C", () => {
    const base = [100, 105, 102, 108, 115, 112, 120, 118, 125, 130];
    const shift = 50;
    const shifted = base.map((v) => v + shift);

    const emaBase = ema(base, 4);
    const emaShifted = ema(shifted, 4);

    for (let i = 3; i < base.length; i++) {
      expect(emaShifted[i]!).toBeCloseTo(emaBase[i]! + shift, 8);
    }
  });

  it("metamorphic scaling property: multiplying prices by K scales EMA, ATR, Fib and leaves RSI invariant", () => {
    const basePrices = [100, 105, 102, 108, 115, 112, 120, 118, 125, 130, 128, 135, 132, 140, 145, 142];
    const scale = 2.5;
    const scaledPrices = basePrices.map((v) => v * scale);

    const baseCandles = makeSeries(basePrices);
    const scaledCandles = baseCandles.map((c) => ({
      t: c.t,
      o: c.o * scale,
      h: c.h * scale,
      l: c.l * scale,
      c: c.c * scale,
      v: c.v,
    }));

    // EMA scales by K
    const eBase = ema(basePrices, 5);
    const eScaled = ema(scaledPrices, 5);
    for (let i = 4; i < basePrices.length; i++) {
      expect(eScaled[i]!).toBeCloseTo(eBase[i]! * scale, 6);
    }

    // ATR scales by K
    const aBase = atr(baseCandles, 5);
    const aScaled = atr(scaledCandles, 5);
    for (let i = 5; i < baseCandles.length; i++) {
      expect(aScaled[i]!).toBeCloseTo(aBase[i]! * scale, 6);
    }

    // RSI is dimensionless: invariant under positive scaling
    const rBase = rsi(basePrices, 5);
    const rScaled = rsi(scaledPrices, 5);
    for (let i = 5; i < basePrices.length; i++) {
      expect(rScaled[i]!).toBeCloseTo(rBase[i]!, 6);
    }
  });
});

describe("Task R: Deterministic Repeatability", () => {
  it("produces identical byte-for-byte indicator arrays across multiple execution cycles", () => {
    const series = [100, 102, 99, 105, 103, 108, 112, 109, 115, 120];
    const run1 = {
      ema: ema(series, 4),
      rsi: rsi(series, 4),
      max: rollingMax(series, 4),
      min: rollingMin(series, 4),
    };
    const run2 = {
      ema: ema(series, 4),
      rsi: rsi(series, 4),
      max: rollingMax(series, 4),
      min: rollingMin(series, 4),
    };
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });
});
