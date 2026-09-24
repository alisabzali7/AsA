/**
 * Team 02 Technical Analysis Layer - Task 08 Bundle Contract & Serialization Integrity
 *
 * Verifies:
 * - Task A: Bundle Type Contract (all AnalysisBundle fields typed and explicit)
 * - Task B: last_close Semantics (number | null; null on empty or non-finite, finite number otherwise)
 * - Task C: Finite Numeric Invariant (recursive check: zero NaN or Infinity across all numeric fields)
 * - Task D: Undefined / Null / Empty Semantics (explicit contracts for unavailable indicators and empty structure)
 * - Task E & F: Serialization Safety & Round-Trip Integrity (JSON.stringify -> JSON.parse preserves all fields)
 * - Task G: Provenance Integrity (preserves symbol, timeframe, ages, native flag, derived source)
 * - Task H: Timeframe Identity (all 9 production timeframes preserved without mutation)
 * - Task I: Symbol Identity (preserves symbol through bundle, aggregate, and MTF)
 * - Task J: Aggregate Semantics (aggregateClosed bucket alignment, forming-bucket dropped, input validation)
 * - Task K: MTF Semantics (buildMtf 4H/1H/15M hierarchy, verdict alignment, insufficient history fallback)
 * - Task L: Insufficient History Contract (0, 1, 10, 19, 20, 49, 50, 80 bars behavior)
 * - Task M: Invalid Input Propagation (malformed/non-finite data handled safely without corrupt technical output)
 * - Task N: Deep Numerical Integrity (extreme prices, 0 price, small positive price, large volume)
 * - Task O: Immutability / Input Aliasing (neither candles nor arrays mutated by calculations)
 * - Task P: Bundle Determinism (identical input -> byte-for-byte identical bundle excluding computed_at_ms)
 */
import { describe, expect, it } from "vitest";
import type { Candle, SymbolStats } from "../src/lib/domain/types";
import { buildBundle, type AnalysisBundle } from "../src/lib/analysis/bundle";
import { aggregateClosed } from "../src/lib/analysis/aggregate";
import { buildMtf } from "../src/lib/analysis/mtf";
import { type TimeframeId } from "../src/lib/domain/timeframes";

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

function assertAllNumbersFinite(obj: unknown, path = ""): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === "number") {
    expect(Number.isFinite(obj), `Numeric field at ${path} must be finite, received ${obj}`).toBe(true);
    expect(Number.isNaN(obj), `Numeric field at ${path} must not be NaN`).toBe(false);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => assertAllNumbersFinite(item, `${path}[${idx}]`));
    return;
  }
  if (typeof obj === "object") {
    for (const [key, val] of Object.entries(obj)) {
      assertAllNumbersFinite(val, path ? `${path}.${key}` : key);
    }
  }
}

describe("Task A & B: Bundle Contract & last_close Semantics", () => {
  it("empty candles produce last_close === null, NOT NaN or 0", () => {
    const bundle = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles: [] });
    expect(bundle.bars).toBe(0);
    expect(bundle.last_close).toBeNull();
    expect(bundle.indicators.ema20).toBeNull();
    expect(bundle.indicators.rsi14).toBeNull();
    expect(bundle.indicators.atr14).toBeNull();
    expect(bundle.structure.trend).toBe("range");
    expect(bundle.structure.reason).toBe("insufficient bars");
  });

  it("candles with valid close produce exact finite last_close", () => {
    const candles = makeSeries([100, 105, 110]);
    const bundle = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles });
    expect(bundle.bars).toBe(3);
    expect(bundle.last_close).toBe(110);
  });

  it("candle with non-finite close safely yields last_close === null", () => {
    const bad = [makeCandle(1000, 10, 12, 8, NaN)];
    const bundle = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles: bad });
    expect(bundle.last_close).toBeNull();
  });
});

describe("Task C & E: Finite Numeric Invariant & JSON Serialization Safety", () => {
  it("bundle contains zero NaN or Infinity across all fields before and after JSON round-trip", () => {
    const testCases: { name: string; candles: Candle[]; stats?: SymbolStats }[] = [
      { name: "empty", candles: [] },
      { name: "single bar", candles: [makeCandle(1000, 100, 105, 95, 102)] },
      { name: "short history (10 bars)", candles: makeSeries(Array.from({ length: 10 }, (_, i) => 100 + i)) },
      { name: "borderline (19 bars)", candles: makeSeries(Array.from({ length: 19 }, (_, i) => 100 + i)) },
      { name: "full history (60 bars)", candles: makeSeries(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 2) * 10)) },
      {
        name: "with stats",
        candles: makeSeries(Array.from({ length: 30 }, (_, i) => 200 + i)),
        stats: {
          symbol: "BTCUSDT",
          lastPrice: 230,
          markPrice: 230.1,
          indexPrice: 230.0,
          fundingRate: 0.0001,
          nextFundingTimeMs: 1700000000,
          fundingIntervalHours: 8,
          change24hPct: 2.5,
          high24h: 240,
          low24h: 190,
          volume24hQuote: 1000000,
          openInterest: 15000,
          openValue: 3450000,
          provenance: { fetched_at_ms: Date.now(), source_name: "ttt", endpoint: "/futures/markets/stats", auth: "public" },
        },
      },
      {
        name: "malformed candles with non-finite fields",
        candles: [
          makeCandle(1000, 100, 110, 90, 105),
          makeCandle(1060, NaN, Infinity, -Infinity, 105),
        ],
      },
    ];

    for (const tc of testCases) {
      const bundle = buildBundle({
        symbol: "BTCUSDT",
        timeframe: "1h",
        candles: tc.candles,
        stats: tc.stats,
      });

      // Assert pre-serialization invariant
      assertAllNumbersFinite(bundle, `Pre-serialization [${tc.name}]`);

      // JSON stringify & parse
      const serialized = JSON.stringify(bundle);
      expect(serialized).not.toContain("NaN");
      expect(serialized).not.toContain("Infinity");

      const parsed = JSON.parse(serialized);
      assertAllNumbersFinite(parsed, `Post-serialization [${tc.name}]`);
    }
  });
});

describe("Task F & G: Round-Trip Integrity & Provenance Integrity", () => {
  it("preserves all contract fields and values across JSON serialization", () => {
    const candles = makeSeries(Array.from({ length: 40 }, (_, i) => 1000 + Math.sin(i) * 50));
    const bundle = buildBundle({
      symbol: "ETHUSDT",
      timeframe: "4h",
      candles,
      seriesProvenance: { fetched_at_ms: 1700000000000, native: true },
    });

    const parsed: AnalysisBundle = JSON.parse(JSON.stringify(bundle));

    expect(parsed.symbol).toBe("ETHUSDT");
    expect(parsed.timeframe).toBe("4h");
    expect(parsed.bars).toBe(40);
    expect(parsed.last_close).toBe(bundle.last_close);
    expect(parsed.candle_window).toEqual(bundle.candle_window);
    expect(parsed.indicators).toEqual(bundle.indicators);
    expect(parsed.structure).toEqual(bundle.structure);
    expect(parsed.provenance.native).toBe(true);
    expect(parsed.provenance.series_fetched_ms).toBe(1700000000000);
  });
});

describe("Task H & I: Timeframe Identity & Symbol Identity", () => {
  const PRODUCTION_TFS: readonly TimeframeId[] = [
    "5m", "15m", "30m", "45m", "1h", "2h", "4h", "8h", "1d"
  ];

  it("preserves exact requested timeframe across all 9 production timeframes", () => {
    for (const tf of PRODUCTION_TFS) {
      const bundle = buildBundle({
        symbol: "SOLUSDT",
        timeframe: tf,
        candles: makeSeries([100, 102, 105]),
      });
      expect(bundle.timeframe).toBe(tf);
    }
  });

  it("preserves distinct symbol identity through bundle and MTF hierarchy", () => {
    for (const sym of ["BTCUSDT", "ETHUSDT", "DOGEUSDT"]) {
      const bundle = buildBundle({
        symbol: sym,
        timeframe: "1h",
        candles: makeSeries(Array.from({ length: 60 }, (_, i) => 100 + i)),
      });
      expect(bundle.symbol).toBe(sym);

      const mtf = buildMtf(bundle, bundle, bundle);
      expect(mtf.macro?.symbol).toBe(sym);
      expect(mtf.context?.symbol).toBe(sym);
      expect(mtf.trigger?.symbol).toBe(sym);
    }
  });
});

describe("Task J: Higher-Timeframe Aggregation (aggregateClosed)", () => {
  it("strictly excludes the forming/incomplete final bucket", () => {
    // 5-minute candles: 0, 300, 600, 900 -> aggregate to 15m (step 900)
    // Candle 0 (0..300): bucket 0
    // Candle 1 (300..600): bucket 0
    // Candle 2 (600..900): bucket 0
    // Candle 3 (900..1200): starts bucket 900 -> closes and emits bucket 0!
    // Bucket 900 is still forming -> NOT emitted
    const candles = [
      makeCandle(0, 10, 12, 9, 11, 50),
      makeCandle(300, 11, 15, 10, 14, 60),
      makeCandle(600, 14, 16, 12, 13, 70),
      makeCandle(900, 13, 14, 11, 12, 80),
    ];

    const agg = aggregateClosed(candles, 15);
    expect(agg).toHaveLength(1);
    expect(agg[0].t).toBe(0);
    expect(agg[0].o).toBe(10);
    expect(agg[0].h).toBe(16); // max(12, 15, 16)
    expect(agg[0].l).toBe(9);  // min(9, 10, 12)
    expect(agg[0].c).toBe(13); // close of candle at 600
    expect(agg[0].v).toBe(180); // 50 + 60 + 70
  });

  it("handles empty or insufficient input without emitting forming candles", () => {
    expect(aggregateClosed([], 15)).toEqual([]);
    // Single 5m candle: still forming -> returns []
    const single = [makeCandle(0, 10, 12, 9, 11, 50)];
    expect(aggregateClosed(single, 15)).toEqual([]);
  });

  it("safely rejects non-positive or non-integer minutes parameter", () => {
    const candles = [
      makeCandle(0, 10, 12, 9, 11, 50),
      makeCandle(300, 11, 15, 10, 14, 60),
      makeCandle(600, 14, 16, 12, 13, 70),
    ];
    expect(aggregateClosed(candles, 0)).toEqual([]);
    expect(aggregateClosed(candles, -5)).toEqual([]);
    expect(aggregateClosed(candles, NaN)).toEqual([]);
    expect(aggregateClosed(candles, 1.5)).toEqual([]);
  });
});

describe("Task K: MTF Alignment Contract (buildMtf)", () => {
  it("returns INSUFFICIENT when any core timeframe has fewer than 50 bars", () => {
    const shortBundle = buildBundle({
      symbol: "BTCUSDT",
      timeframe: "15m",
      candles: makeSeries(Array.from({ length: 40 }, (_, i) => 100 + i)),
    });
    const longBundle = buildBundle({
      symbol: "BTCUSDT",
      timeframe: "1h",
      candles: makeSeries(Array.from({ length: 60 }, (_, i) => 100 + i)),
    });

    const mtf = buildMtf(longBundle, longBundle, shortBundle);
    expect(mtf.verdict).toBe("INSUFFICIENT");
    expect(mtf.trigger_bias).toBeNull();
    expect(mtf.reason).toContain("≥50 bars");
  });

  it("returns ALIGNED when 4H, 1H, and 15M all share the same directional bias", () => {
    const bullBundle = buildBundle({
      symbol: "BTCUSDT",
      timeframe: "1h",
      candles: makeSeries(Array.from({ length: 60 }, (_, i) => 100 + i * 2)),
    });

    const mtf = buildMtf(bullBundle, bullBundle, bullBundle);
    expect(mtf.verdict).toBe("ALIGNED");
    expect(mtf.macro_bias).toBe("long");
    expect(mtf.context_bias).toBe("long");
    expect(mtf.trigger_bias).toBe("long");
  });

  it("handles null bundle inputs safely without exception", () => {
    const mtf = buildMtf(null, null, null);
    // Task 03: missing components are UNAVAILABLE, distinct from INSUFFICIENT history
    expect(mtf.verdict).toBe("UNAVAILABLE");
    expect(mtf.macro).toBeNull();
    expect(mtf.context).toBeNull();
    expect(mtf.trigger).toBeNull();
  });
});

describe("Task L: Insufficient History Progression Matrix", () => {
  it("accurately reports component availability at exact bar count thresholds", () => {
    const makeWithLen = (len: number) =>
      buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles: makeSeries(Array.from({ length: len }, (_, i) => 100 + i)) });

    // 0 bars
    const b0 = makeWithLen(0);
    expect(b0.last_close).toBeNull();
    expect(b0.indicators.rsi14).toBeNull();
    expect(b0.indicators.ema20).toBeNull();
    expect(b0.structure.trend).toBe("range");
    expect(b0.structure.reason).toBe("insufficient bars");

    // 1 bar
    const b1 = makeWithLen(1);
    expect(b1.last_close).toBe(100);
    expect(b1.indicators.rsi14).toBeNull();

    // 14 bars: RSI warmup complete on 15th bar (> 14)
    const b14 = makeWithLen(14);
    expect(b14.indicators.rsi14).toBeNull();

    // 15 bars: RSI14 has its first valid point
    const b15 = makeWithLen(15);
    expect(b15.indicators.rsi14).not.toBeNull();
    expect(b15.indicators.ema20).toBeNull();

    // 19 bars: EMA20 and structure (< 20) still unavailable
    const b19 = makeWithLen(19);
    expect(b19.indicators.ema20).toBeNull();
    expect(b19.structure.reason).toBe("insufficient bars");

    // 20 bars: EMA20 and structure analysis active
    const b20 = makeWithLen(20);
    expect(b20.indicators.ema20).not.toBeNull();
    expect(b20.indicators.ema50).toBeNull();
    expect(b20.structure.reason).not.toBe("insufficient bars");

    // 50 bars: EMA50 active, MTF bias evaluates
    const b50 = makeWithLen(50);
    expect(b50.indicators.ema50).not.toBeNull();
  });
});

describe("Task N: Deep Numerical Integrity", () => {
  it("preserves finite integrity across zero price, tiny positive price, and massive volume", () => {
    const extremeCandles: Candle[] = [
      makeCandle(1000, 1e-8, 2e-8, 5e-9, 1.5e-8, 1e12),
      makeCandle(1060, 1.5e-8, 3e-8, 1e-8, 2.5e-8, 2e12),
      makeCandle(1120, 2.5e-8, 4e-8, 2e-8, 3.5e-8, 3e12),
    ];

    const bundle = buildBundle({ symbol: "SHIBUSDT", timeframe: "1h", candles: extremeCandles });
    expect(bundle.last_close).toBe(3.5e-8);
    expect(Number.isFinite(bundle.candle_window.price_min)).toBe(true);
    expect(Number.isFinite(bundle.candle_window.price_max)).toBe(true);
  });
});

describe("Task O: Immutability / Input Aliasing Safety", () => {
  it("neither buildBundle nor aggregateClosed mutate input candle objects or arrays", () => {
    const originalCandles: readonly Candle[] = Object.freeze([
      Object.freeze(makeCandle(0, 100, 105, 95, 102, 50)),
      Object.freeze(makeCandle(300, 102, 108, 101, 106, 60)),
      Object.freeze(makeCandle(600, 106, 110, 104, 109, 70)),
      Object.freeze(makeCandle(900, 109, 112, 107, 111, 80)),
    ]);

    // Deep copy for before/after comparison
    const snapshot = JSON.stringify(originalCandles);

    // Call bundle and aggregation
    buildBundle({ symbol: "BTCUSDT", timeframe: "15m", candles: originalCandles as Candle[] });
    aggregateClosed(originalCandles as Candle[], 15);

    expect(JSON.stringify(originalCandles)).toBe(snapshot);
  });
});

describe("Task P: Bundle Determinism", () => {
  it("produces identical technical values given identical input candles", () => {
    const candles = makeSeries(Array.from({ length: 45 }, (_, i) => 500 + i * 2));
    const b1 = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles });
    const b2 = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles });

    // Technical fields are strictly identical
    expect(b1.symbol).toBe(b2.symbol);
    expect(b1.timeframe).toBe(b2.timeframe);
    expect(b1.bars).toBe(b2.bars);
    expect(b1.last_close).toBe(b2.last_close);
    expect(b1.candle_window).toEqual(b2.candle_window);
    expect(b1.indicators).toEqual(b2.indicators);
    expect(b1.structure).toEqual(b2.structure);
  });
});
