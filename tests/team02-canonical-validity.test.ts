/**
 * Team 02 absolute-final: DUPLICATION CANONICALISATION + EQUIVALENCE.
 *
 * Bar validity used to be implemented three times (ttt/udf.ts inline,
 * market/history.ts validateCandles, analysis/input.ts). All three now call
 * domain/candle-validity ohlcvDefect. This test proves, over an exhaustive
 * matrix of single-field corruptions, that the three boundaries agree on
 * which bars are valid (each keeps its own policy: drop vs refuse).
 * Also pins that swings and indicators have ONE implementation each.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../src/lib/domain/types";
import { ohlcvDefect } from "../src/lib/domain/candle-validity";
import { parseUdfHistory } from "../src/lib/ttt/udf";
import { validateCandles } from "../src/lib/market/history";
import { barViolation } from "../src/lib/analysis/input";

const STEP = 3600;
const T = 1_789_999_200; // aligned to 1h
const NOW_MS = (T + 10 * STEP) * 1000;
const good: Candle = { t: T, o: 100, h: 101, l: 99, c: 100.5, v: 10 };

const corruptions: [string, Partial<Record<keyof Candle, unknown>>][] = [
  ["valid", {}],
  ["zero-range valid", { o: 5, h: 5, l: 5, c: 5 }],
  ["zero volume valid", { v: 0 }],
  ["NaN o", { o: NaN }], ["NaN h", { h: NaN }], ["NaN l", { l: NaN }], ["NaN c", { c: NaN }], ["NaN v", { v: NaN }],
  ["Inf h", { h: Infinity }], ["-Inf l", { l: -Infinity }],
  ["missing v", { v: undefined }], ["missing c", { c: undefined }],
  ["string o", { o: "100" }],
  ["zero o", { o: 0 }], ["negative l", { l: -1 }], ["zero c", { c: 0 }],
  ["negative v", { v: -3 }],
  ["h < c", { h: 100.2 }], ["h < o", { o: 101.5 }], ["l > o", { l: 100.1 }], ["l > c", { c: 98 }],
];

describe("three boundaries, one bar rule", () => {
  for (const [name, patch] of corruptions) {
    it(name, () => {
      const bar = { ...good, ...patch } as Candle;
      const canonical = ohlcvDefect(bar) === null;
      expect(canonical).toBe(name.endsWith("valid"));
      // analysis boundary (refuse policy)
      expect(barViolation([bar], STEP) === null).toBe(canonical);
      // history backfill (drop policy)
      expect(validateCandles([bar]).valid.length).toBe(canonical ? 1 : 0);
      // venue normaliser (drop policy): feed as a UDF payload. The UDF parser
      // coerces numeric strings ("100" → 100) BEFORE the bar rule — a
      // documented parse step, not a validity difference.
      const udf = parseUdfHistory({ s: "ok", t: [bar.t], o: [bar.o], h: [bar.h], l: [bar.l], c: [bar.c], v: [bar.v] }, 60, NOW_MS);
      const udfExpected = name === "string o" ? true : canonical;
      expect(udf.candles.length).toBe(udfExpected ? 1 : 0);
    });
  }
});

describe("single implementations (no copies)", () => {
  const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  it("findSwings is defined once (analysis/structure) and imported by the detectors", () => {
    expect(src("src/lib/analysis/structure.ts")).toMatch(/export function findSwings\(/);
    expect(src("src/lib/features/detectors.ts")).not.toMatch(/function findSwings\(/);
    expect(src("src/lib/features/detectors.ts")).toMatch(/findSwings,[\s\S]*from "..\/analysis\/structure"/);
  });
  it("EMA / RSI / ATR / SMA are defined once (analysis/indicators)", () => {
    for (const f of ["src/lib/features/detectors.ts", "src/lib/analysis/bundle.ts", "src/lib/analysis/structure.ts", "src/lib/analysis/momentum.ts", "src/lib/chart/technical.ts", "src/lib/chart/adapter.ts", "src/components/chart-view.tsx"]) {
      expect(src(f), f).not.toMatch(/function (ema|rsi|atr|sma)\s*\(/);
    }
  });
  it("the bar rule lives only in domain/candle-validity (callers delegate)", () => {
    for (const f of ["src/lib/ttt/udf.ts", "src/lib/market/history.ts", "src/lib/analysis/input.ts"]) {
      expect(src(f), f).toMatch(/ohlcvDefect/);
      expect(src(f), f).not.toMatch(/hh < Math\.max\(oo, cc\)|c\.h >= c\.l && c\.h >= c\.o/);
    }
  });
});
