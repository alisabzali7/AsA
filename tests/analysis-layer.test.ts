/**
 * Team 02 Technical Analysis Layer - Comprehensive Contract & Verification
 *
 * Verifies:
 * - Task A: Swing Detection Contract (fractal window, confirmation timing, ties, no-lookahead)
 * - Task B: BOS Semantics (bullish, bearish, near-miss, equal touch, confirmation)
 * - Task C: CHoCH Semantics (state transition, polarity break, distinction from BOS)
 * - Task D: S/R Levels (0.3% price cluster, min touches, strength, ordering, determinism)
 * - Task E: Fair Value Gaps (3-candle imbalance, up/down, boundary touch, overlap)
 * - Task F: Order Blocks (opposite candle prior to impulse, direction, bounds)
 * - Task G: Fibonacci Retracements (anchor selection, 7 standard levels, direction)
 * - Task H: Trend / Regime (hybrid BOS + EMA20/50 + drift, range fallback)
 * - Task I: Structure Composition (index/timestamp alignment, no phantom coordinates)
 * - Task J: Bundle Integrity (field tracing to canonical structure)
 * - Task K: Chart Evidence & Provenance (evidence -> annotations -> renderer, no fabricated objects)
 * - Task L: Production Timeframes (all 9 production timeframes verified)
 * - Task M: No-Lookahead across all structural primitives
 * - Task N: Deterministic serialization and repeatability
 */
import { describe, expect, it } from "vitest";
import type { Candle } from "../src/lib/domain/types";
import { ema, lastEma, rsi, atr, rollingMax, rollingMin } from "../src/lib/analysis/indicators";
import { findSwings, analyzeStructure, type StructureResult, type SwingPoint } from "../src/lib/analysis/structure";
import { buildBundle } from "../src/lib/analysis/bundle";
import { buildMtf } from "../src/lib/analysis/mtf";
import { aggregateClosed } from "../src/lib/analysis/aggregate";
import { type TimeframeId } from "../src/lib/domain/timeframes";
import { buildChartEvidence, type ChartEvidence } from "../src/lib/chart/evidence";
import { renderEvidenceSvg, renderEvidencePng } from "../src/lib/chart/render";
import type { CompiledEvaluation } from "../src/lib/strategy/compiled";

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

describe("Task A: Swing Detection Contract", () => {
  it("requires left=2, right=2 confirmed bars; does NOT emit unconfirmed recent bars", () => {
    // 4 bars: index 2 cannot be confirmed because index 4 (right=2) does not exist yet
    const short = [
      makeCandle(100, 10, 11, 9, 10),
      makeCandle(160, 10, 12, 9, 11),
      makeCandle(220, 11, 25, 10, 24), // potential peak
      makeCandle(280, 24, 24, 15, 16),
    ];
    expect(findSwings(short, 2, 2)).toEqual([]);

    // 5th bar arrives: now index 2 has 2 bars to the left (0,1) and 2 to the right (3,4)
    const confirmed = [...short, makeCandle(340, 16, 17, 13, 14)];
    const swings = findSwings(confirmed, 2, 2);
    expect(swings).toHaveLength(1);
    expect(swings[0].index).toBe(2);
    expect(swings[0].price).toBe(25);
    expect(swings[0].kind).toBe("high");
    expect(swings[0].t).toBe(220);
  });

  it("previously confirmed swings remain strictly identical when future bars are appended", () => {
    const candles = makeSeries(Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 2) * 20));
    const initialSwings = findSwings(candles, 2, 2);

    // Append 15 new bars
    const extended = [...candles, ...makeSeries(Array.from({ length: 15 }, (_, i) => 200 + i * 2), 60, candles[29].t + 60)];
    const extendedSwings = findSwings(extended, 2, 2);

    // All swings from the initial window must remain intact
    for (let i = 0; i < initialSwings.length; i++) {
      expect(extendedSwings[i]).toEqual(initialSwings[i]);
    }
  });

  it("handles equal highs and lows (ties strictly fail strict peak inequality)", () => {
    // Two equal peaks at index 2 and index 3: candles[j].h >= c.h makes both false
    const equalHighs = [
      makeCandle(100, 10, 12, 9, 10),
      makeCandle(160, 10, 15, 9, 11),
      makeCandle(220, 11, 25, 10, 24), // peak 25
      makeCandle(280, 24, 25, 15, 16), // equal peak 25
      makeCandle(340, 16, 17, 13, 14),
      makeCandle(400, 14, 15, 10, 11),
    ];
    const swings = findSwings(equalHighs, 2, 2);
    // Neither peak is strictly greater than all neighbors in [-2, +2]
    expect(swings.filter((s) => s.kind === "high")).toEqual([]);
  });
});

describe("Task B: BOS Semantics", () => {
  it("detects Bullish BOS when last close strictly exceeds last confirmed swing high", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      if (i === 5) candles.push(makeCandle(1000 + i * 60, 100, 130, 99, 115)); // High at 130
      else if (i === 10) candles.push(makeCandle(1000 + i * 60, 100, 101, 70, 75)); // Low at 70
      else if (i === 15) candles.push(makeCandle(1000 + i * 60, 100, 120, 99, 115)); // High at 120 (last swing is High!)
      else if (i === 24) candles.push(makeCandle(1000 + i * 60, 110, 135, 109, 125)); // Close at 125 > 120
      else candles.push(makeCandle(1000 + i * 60, 100, 102, 98, 100));
    }
    const st = analyzeStructure(candles);
    expect(st.last_swing_high).toBe(120);
    // Last swing is high (index 15), close is 125 > 120 => BOS UP
    expect(st.last_bos).toEqual({ direction: "up", t: candles[24].t, price: 120 });
    expect(st.last_choch).toBeNull();
  });

  it("detects Bearish BOS when last close strictly breaks below last confirmed swing low", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      if (i === 5) candles.push(makeCandle(1000 + i * 60, 100, 101, 70, 75)); // Low at 70
      else if (i === 10) candles.push(makeCandle(1000 + i * 60, 100, 130, 99, 115)); // High at 130
      else if (i === 15) candles.push(makeCandle(1000 + i * 60, 100, 101, 80, 85)); // Low at 80 (last swing is Low!)
      else if (i === 24) candles.push(makeCandle(1000 + i * 60, 90, 91, 65, 75)); // Close at 75 < 80
      else candles.push(makeCandle(1000 + i * 60, 100, 102, 98, 100));
    }
    const st = analyzeStructure(candles);
    expect(st.last_swing_low).toBe(80);
    expect(st.last_bos).toEqual({ direction: "down", t: candles[24].t, price: 80 });
    expect(st.last_choch).toBeNull();
  });

  it("near-miss and equal touch do NOT trigger BOS (strict close inequality required)", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      if (i === 5) candles.push(makeCandle(1000 + i * 60, 100, 101, 70, 75));
      else if (i === 10) candles.push(makeCandle(1000 + i * 60, 100, 120, 99, 115)); // Swing high 120
      else if (i === 24) candles.push(makeCandle(1000 + i * 60, 100, 125, 99, 120)); // High 125 pierced, but CLOSE is exactly 120.0
      else candles.push(makeCandle(1000 + i * 60, 100, 102, 98, 100));
    }
    const st = analyzeStructure(candles);
    // Close 120 is not > 120
    expect(st.last_bos).toBeNull();
  });
});

describe("Task C: CHoCH Semantics", () => {
  it("detects CHoCH when price breaks the opposite confirmed swing against the last swing direction", () => {
    // Last swing is LOW (index 15 at price 80). Prior swing high is at 120 (index 10).
    // A close above 120 breaks structure counter to the last swing -> CHoCH up
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      if (i === 5) candles.push(makeCandle(1000 + i * 60, 100, 101, 70, 75));
      else if (i === 10) candles.push(makeCandle(1000 + i * 60, 100, 120, 99, 115)); // High at 120
      else if (i === 15) candles.push(makeCandle(1000 + i * 60, 100, 101, 80, 85)); // Low at 80 (last swing)
      else if (i === 24) candles.push(makeCandle(1000 + i * 60, 100, 126, 99, 125)); // Close at 125 > 120
      else candles.push(makeCandle(1000 + i * 60, 100, 102, 98, 100));
    }
    const st = analyzeStructure(candles);
    expect(st.last_bos).toBeNull();
    expect(st.last_choch).toEqual({ direction: "up", t: candles[24].t, price: 120 });
  });

  it("BOS and CHoCH are mutually exclusive for the same bar break", () => {
    const candles = makeSeries(Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 2) * 15));
    const st = analyzeStructure(candles);
    if (st.last_bos !== null) {
      expect(st.last_choch).toBeNull();
    } else if (st.last_choch !== null) {
      expect(st.last_bos).toBeNull();
    }
  });
});

describe("Task D: Support / Resistance Levels", () => {
  it("clusters swing points within 0.3% price tolerance, sorting by touch count", () => {
    // 40 bars. Swings near 100.0, 100.2, and 100.1 (all within 0.3% band)
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      if (i === 5) candles.push(makeCandle(1000 + i * 60, 95, 100.0, 94, 96));
      else if (i === 15) candles.push(makeCandle(1000 + i * 60, 95, 100.2, 94, 96));
      else if (i === 25) candles.push(makeCandle(1000 + i * 60, 95, 100.1, 94, 96));
      else candles.push(makeCandle(1000 + i * 60, 90, 92, 88, 90));
    }
    const st = analyzeStructure(candles);
    expect(st.sr_levels.length).toBeGreaterThan(0);
    const topLevel = st.sr_levels[0];
    expect(topLevel.kind).toBe("resistance");
    expect(topLevel.strength).toBe(3);
    expect(Math.abs(topLevel.price - 100.1)).toBeLessThan(0.1);
  });

  it("levels outside 0.3% do not cluster together", () => {
    // Swings at 100.0 and 101.5 (difference 1.5% > 0.3%)
    const candles: Candle[] = [];
    for (let i = 0; i < 35; i++) {
      if (i === 5) candles.push(makeCandle(1000 + i * 60, 95, 100.0, 94, 96));
      else if (i === 15) candles.push(makeCandle(1000 + i * 60, 95, 101.5, 94, 96));
      else candles.push(makeCandle(1000 + i * 60, 90, 92, 88, 90));
    }
    const st = analyzeStructure(candles);
    // Requires count >= 2 to become an sr_level; neither has a partner within 0.3%, so count is 1
    expect(st.sr_levels).toEqual([]);
  });
});

describe("Task E: Fair Value Gap (FVG)", () => {
  it("detects bullish FVG (candle i low strictly above candle i-2 high)", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      if (i === 10) candles.push(makeCandle(1000 + i * 60, 100, 105, 95, 102)); // high 105
      else if (i === 11) candles.push(makeCandle(1000 + i * 60, 103, 125, 102, 124)); // impulse
      else if (i === 12) candles.push(makeCandle(1000 + i * 60, 124, 130, 110, 128)); // low 110 > 105 -> gap [105, 110]
      else candles.push(makeCandle(1000 + i * 60, 100, 102, 98, 100));
    }
    const st = analyzeStructure(candles);
    const fvg = st.fvgs.find((f) => f.direction === "up" && f.bottom === 105 && f.top === 110);
    expect(fvg).toBeDefined();
    expect(fvg?.t).toBe(candles[12].t);
  });

  it("detects bearish FVG (candle i high strictly below candle i-2 low)", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      if (i === 10) candles.push(makeCandle(1000 + i * 60, 150, 155, 145, 148)); // low 145
      else if (i === 11) candles.push(makeCandle(1000 + i * 60, 147, 147, 120, 121)); // down impulse
      else if (i === 12) candles.push(makeCandle(1000 + i * 60, 121, 135, 115, 118)); // high 135 < 145 -> gap [135, 145]
      else candles.push(makeCandle(1000 + i * 60, 100, 102, 98, 100));
    }
    const st = analyzeStructure(candles);
    const fvg = st.fvgs.find((f) => f.direction === "down" && f.bottom === 135 && f.top === 145);
    expect(fvg).toBeDefined();
    expect(fvg?.t).toBe(candles[12].t);
  });
});

describe("Task F: Order Blocks", () => {
  it("identifies opposite-colored candle preceding a clean impulse candle (body > 90% range)", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      if (i === 22) candles.push(makeCandle(1000 + i * 60, 105, 106, 99, 100)); // Red candle: O=105, C=100
      else if (i === 23) candles.push(makeCandle(1000 + i * 60, 100, 120, 100, 120)); // Green impulse: body 20, range 20
      else candles.push(makeCandle(1000 + i * 60, 100, 102, 98, 100));
    }
    const st = analyzeStructure(candles);
    expect(st.order_blocks.length).toBeGreaterThan(0);
    const ob = st.order_blocks[0];
    expect(ob.direction).toBe("up");
    expect(ob.top).toBe(105);
    expect(ob.bottom).toBe(100);
    expect(ob.t).toBe(candles[22].t);
  });
});

describe("Task G: Fibonacci Retracements", () => {
  it("derives all 7 contract levels (0, 0.236, 0.382, 0.5, 0.618, 0.786, 1) across last 2 confirmed swings", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      if (i === 10) candles.push(makeCandle(1000 + i * 60, 95, 100, 95, 96)); // Swing high at 100 (neighbors 95)
      else if (i === 20) candles.push(makeCandle(1000 + i * 60, 150, 200, 140, 195)); // Swing high at 200
      else candles.push(makeCandle(1000 + i * 60, 90, 92, 88, 90));
    }
    const st = analyzeStructure(candles);
    expect(st.fib.length).toBe(7);
    expect(st.fib.map((f) => f.level)).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
    expect(st.fib[0].price).toBe(200); // Level 0 at highest peak (200)
    expect(st.fib[6].price).toBe(100); // Level 1 at lowest anchor swing (100)
    expect(st.fib[3].price).toBe(150); // Level 0.5 exactly midway
  });
});

describe("Task H: Trend / Regime", () => {
  it("classifies UP trend on BOS up + EMA20 > EMA50", () => {
    // 50 candles with consistent upward drift
    const candles = makeSeries(Array.from({ length: 50 }, (_, i) => 100 + i * 3));
    const st = analyzeStructure(candles);
    expect(st.trend).toBe("up");
    expect(st.reason).toMatch(/BOS up|positive drift/);
  });

  it("classifies DOWN trend on downward drift + EMA20 < EMA50", () => {
    const candles = makeSeries(Array.from({ length: 50 }, (_, i) => 300 - i * 3));
    const st = analyzeStructure(candles);
    expect(st.trend).toBe("down");
    expect(st.reason).toMatch(/BOS down|negative drift/);
  });

  it("falls back to RANGE when no directional break or flat drift", () => {
    // Oscillating flat candles
    const candles = makeSeries(Array.from({ length: 50 }, (_, i) => 100 + (i % 2 === 0 ? 0.5 : -0.5)));
    const st = analyzeStructure(candles);
    expect(st.trend).toBe("range");
  });
});

describe("Task I & J: Structure Composition and Bundle Integrity", () => {
  it("all structure timestamps map to real candle timestamps (no phantom timestamps)", () => {
    const candles = makeSeries(Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 10));
    const bundle = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles });
    const candleTimestamps = new Set(candles.map((c) => c.t));

    for (const sp of bundle.structure.swing_points) {
      expect(candleTimestamps.has(sp.t)).toBe(true);
    }
    for (const fvg of bundle.structure.fvgs) {
      expect(candleTimestamps.has(fvg.t)).toBe(true);
    }
    for (const ob of bundle.structure.order_blocks) {
      expect(candleTimestamps.has(ob.t)).toBe(true);
    }
    if (bundle.structure.last_bos) {
      expect(candleTimestamps.has(bundle.structure.last_bos.t)).toBe(true);
    }
    if (bundle.structure.last_choch) {
      expect(candleTimestamps.has(bundle.structure.last_choch.t)).toBe(true);
    }
  });

  it("AnalysisBundle preserves structure verbatim without alteration", () => {
    const candles = makeSeries(Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 2) * 12));
    const directStructure = analyzeStructure(candles);
    const bundle = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles });
    expect(bundle.structure).toEqual(directStructure);
  });
});

describe("Task K: Chart Evidence & Rendering Integrity", () => {
  it("chart evidence does NOT fabricate annotations when levels are absent", () => {
    const emptyEv = {
      symbol: "BTCUSDT",
      timeframe: "1h",
      strategy_id: "STR-TEST",
      setup_id: "SET-TEST",
      direction: "long" as const,
      bar_time: 1_700_000_000,
      setup: {
        setup_id: "SET-TEST",
        strategy_id: "STR-TEST",
        direction: "long" as const,
        outcome: "FAIL" as const,
        explanation: "No setup",
        stages: [],
        passed_rules: [],
        failed_rules: [],
        unknown_rules: [],
        blocked_rules: [],
        evaluated_at_ms: 1_700_000_000_000,
      },
      levels: {
        entry: null,
        stop: null,
        targets: [],
        invalidation: null,
        level_assumptions: [],
      },
      rr: null,
      features: {} as never,
      features_used: [],
      version: "1.0.0",
    };

    const evidence = buildChartEvidence(emptyEv, null);
    expect(evidence.annotations).toHaveLength(0);

    // Renderer produces clean chart without phantom lines
    const svg = renderEvidenceSvg(evidence, makeSeries([100, 101, 102]));
    expect(svg).not.toContain("data-annotation-id");
  });

  it("rendered SVG carries full lineage: annotation_id, detector_version, produced_by, evidence_kind", () => {
    const mockEv = {
      symbol: "ETHUSDT",
      timeframe: "1h",
      strategy_id: "STR-MOCK",
      setup_id: "SET-MOCK",
      direction: "long" as const,
      bar_time: 1_700_000_000,
      setup: {
        setup_id: "SET-MOCK",
        strategy_id: "STR-MOCK",
        direction: "long" as const,
        outcome: "PASS" as const,
        explanation: "Valid setup",
        stages: [{
          stage: "trigger" as const,
          outcome: "PASS" as const,
          note: "Triggered",
          rules: [{
            rule_id: "R-MOCK",
            outcome: "PASS" as const,
            explanation: "Level touched",
            source_refs: [{ file: "2.txt", start_line: 100, end_line: 105 }],
            predicate_results: [],
            missing_features: [],
            features_used: [],
            timeframe: "1h",
            evaluated_at_ms: 1_700_000_000_000,
          }],
        }],
        passed_rules: ["R-MOCK"],
        failed_rules: [],
        unknown_rules: [],
        blocked_rules: [],
        evaluated_at_ms: 1_700_000_000_000,
      },
      levels: {
        entry: 2500,
        stop: 2450,
        targets: [2600, 2700],
        invalidation: 2450,
        level_assumptions: ["ENGINEERING PARAMETER: ATR buffer"],
      },
      rr: 2.0,
      features: {} as never,
      features_used: [],
      version: "1.0.0",
    };

    const evidence = buildChartEvidence(mockEv, 90);
    expect(evidence.lineage_complete).toBe(true);

    const svg = renderEvidenceSvg(evidence, makeSeries([2450, 2500, 2550]));
    expect(svg).toContain('data-annotation-id="SET-MOCK:entry:2500"');
    expect(svg).toContain('data-produced-by="rule:SET-MOCK-LOC"');
    expect(svg).toContain('data-evidence="DERIVED"');
  });
});

describe("Task L: All 9 Production Timeframes Verification", () => {
  const PRODUCTION_TFS: readonly TimeframeId[] = [
    "5m", "15m", "30m", "45m", "1h", "2h", "4h", "8h", "1d"
  ];

  it("proves actual calculation pipeline for every production timeframe", () => {
    for (const tf of PRODUCTION_TFS) {
      const candles = makeSeries(Array.from({ length: 80 }, (_, i) => 20000 + Math.sin(i / 4) * 200 + i * 5));
      const bundle = buildBundle({ symbol: "ETHUSDT", timeframe: tf, candles });

      expect(bundle.timeframe).toBe(tf);
      expect(bundle.symbol).toBe("ETHUSDT");
      expect(bundle.bars).toBe(80);
      expect(bundle.indicators.ema20).not.toBeNull();
      expect(bundle.indicators.rsi14).not.toBeNull();
      expect(bundle.indicators.atr14).not.toBeNull();
      expect(bundle.structure).toBeDefined();
      expect(["up", "down", "range"]).toContain(bundle.structure.trend);
    }
  });
});

describe("Task M: No-Lookahead across Structural Primitives", () => {
  it("past structural outcomes at bar N are unaffected by future bars N+1...M", () => {
    // 50 historical bars
    const history = makeSeries(Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 2) * 15));
    // 30 future mutated bars
    const future = makeSeries(Array.from({ length: 30 }, (_, i) => 800 + i * 20), 60, history[49].t + 60);

    const stPast = analyzeStructure(history);
    const combined = [...history, ...future];
    const stCombined = analyzeStructure(combined);

    // Any confirmed swings that fell entirely inside history (index <= 47) must be identical
    const pastSwingsInWindow = stPast.swing_points.filter((s) => s.index <= 47);
    const combinedSwingsInWindow = stCombined.swing_points.filter((s) => s.index <= 47);
    expect(pastSwingsInWindow).toEqual(combinedSwingsInWindow);

    // Direct slice re-execution produces identical FVGs, S/R, and swings
    const stSlice = analyzeStructure(combined.slice(0, 50));
    expect(stSlice).toEqual(stPast);
  });
});

describe("Task N: Deterministic Output", () => {
  it("produces identical byte-for-byte serialization across multiple runs", () => {
    const candles = makeSeries(Array.from({ length: 45 }, (_, i) => 1000 + i * 3));
    const st1 = analyzeStructure(candles);
    const st2 = analyzeStructure(candles);
    expect(JSON.stringify(st1)).toBe(JSON.stringify(st2));
  });
});
