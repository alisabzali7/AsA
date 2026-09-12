/**
 * UDF normalization tests over LIVE captured TTT fixtures (2026-09-05):
 *  - duplicated final timestamp dedupe (last wins)
  - malformed rows rejected, OHLC validity enforced
 *  - s:"no_data" at HTTP 200 is NOT an empty ok series
 *  - native 1D exists; labeled 8H->1D derivation is deterministic and
 *    only emits COMPLETE days (no partial/forming day, no lookahead)
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseUdfHistory, derive1DFrom8h } from "../src/lib/ttt/udf";
import type { Candle } from "../src/lib/domain/types";

const F = (n: string): unknown => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/live", n), "utf8"));

describe("parseUdfHistory over live TTT payloads", () => {
  it("normalizes the live 15m payload (1152 bars, dup final ts dropped)", () => {
    const r = parseUdfHistory(F("udf-15.json"), 15);
    expect(r.meta.ok).toBe(true);
    expect(r.meta.no_data).toBe(false);
    expect(r.meta.received).toBe(1152);
    expect(r.candles.length).toBeLessThanOrEqual(r.meta.received);
    expect(r.meta.dropped_duplicates).toBeGreaterThanOrEqual(1); // venue repeats final ts
    // strictly ascending, aligned, valid OHLC
    for (let i = 0; i < r.candles.length; i++) {
      const c = r.candles[i];
      if (i > 0) expect(c.t).toBeGreaterThan(r.candles[i - 1].t);
      expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
      expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
      expect(c.v).toBeGreaterThanOrEqual(0);
    }
    expect(r.meta.gaps).toBe(0); // continuous 15m venue history
  });

  it("keeps NATIVE 1D bars from the live payload (resolution 1D exists)", () => {
    const r = parseUdfHistory(F("udf-1d.json"), 1440);
    expect(r.meta.ok).toBe(true);
    // 13 rows but the final ts is repeated by the venue -> 12 unique candles
    expect(r.meta.dropped_duplicates).toBe(1);
    expect(r.candles.length).toBe(12);
    // UTC aligned days
    for (const c of r.candles) expect(c.t % 86400).toBe(0);
    expect(r.meta.gaps).toBe(0);
  });

  it("treats s=no_data as no_data, not an empty ok series", () => {
    const r = parseUdfHistory(F("udf-nodata.json"), 15);
    expect(r.meta.no_data).toBe(true);
    expect(r.meta.ok).toBe(true);
    expect(r.candles.length).toBe(0);
  });

  it("rejects non-payload garbage and mismatched arrays", () => {
    const a = parseUdfHistory(null, 15);
    expect(a.meta.ok).toBe(false);
    const b = parseUdfHistory({ s: "ok", t: [1, 2], o: [1], h: [], l: [], c: [], v: [] }, 15);
    expect(b.meta.ok).toBe(false);
    expect(b.meta.reason).toContain("mismatch");
    const c = parseUdfHistory("text", 15);
    expect(c.meta.ok).toBe(false);
  });

  it("drops invalid rows: NaN, non-positive ts, negative volume, broken OHLC", () => {
    const raw = {
      s: "ok",
      t: [1000, 1100, 1200, 1300, 1400, 1500],
      o: [10, 10, NaN, 10, 10, 10],
      h: [11, 5, 11, 11, 11, 11], // row1: high < open/close -> invalid
      l: [9, 9, 9, 9, 9, 9],
      c: [10.5, 10.5, 10.5, 10.5, 10.5, 10.5],
      v: [1, 1, 1, 1, -5, 1], // row4: negative volume
    };
    const r = parseUdfHistory(raw, 15);
    expect(r.meta.ok).toBe(true);
    expect(r.meta.dropped_invalid).toBe(3);
    expect(r.candles.length).toBe(3);
  });

  it("last-wins dedupe for a repeated timestamp", () => {
    const raw = { s: "ok", t: [100, 200, 300, 300], o: [1, 1, 1, 9], h: [2, 2, 2, 10], l: [0, 0, 0, 0], c: [1.5, 1.5, 1.5, 9.5], v: [1, 1, 1, 2] };
    const r = parseUdfHistory(raw, 15);
    expect(r.meta.dropped_duplicates).toBe(1);
    expect(r.candles.map((c) => c.t)).toEqual([100, 200, 300]);
    expect(r.candles[2].c).toBe(9.5); // last occurrence kept
  });

  it("detects gaps when bars are missing", () => {
    const raw = { s: "ok", t: [0, 900, 2700, 3600], o: [1, 1, 1, 1], h: [2, 2, 2, 2], l: [0, 0, 0, 0], c: [1, 1, 1, 1], v: [1, 1, 1, 1] };
    const r = parseUdfHistory(raw, 15);
    expect(r.meta.gaps).toBe(1); // 900 -> 2700 skips a bar
  });
});

describe("8H -> 1D derivation (labeled fallback only)", () => {
  function dayBars(dayStartSec: number, closes: number[]): Candle[] {
    // three 8h bars for one UTC day + (optionally) partial next-day bars
    return closes.map((c, i) => ({
      t: dayStartSec + i * 28800,
      o: c - 1,
      h: Math.max(c, c - 1) + 2,
      l: Math.min(c, c - 1) - 2,
      c,
      v: 100 + i,
    }));
  }
  const D = (n: number) => n * 86400; // day epoch

  it("aggregates complete days deterministically and skips partial days", () => {
    // day0: full; day1: only 1 of 3 bars -> not emitted
    const bars = [...dayBars(D(1), [100, 101, 102]), ...dayBars(D(2), [200])];
    const r = derive1DFrom8h(bars);
    expect(r.candles.length).toBe(1);
    expect(r.candles[0]).toMatchObject({ t: D(1), o: 99, h: 104, l: 97, c: 102, v: 303 });
    expect(r.source_tf).toBe("8h");
    expect(r.daysUsed).toBe(1);
  });

  it("produces no candles from a single partial day (no lookahead/forming)", () => {
    const bars = dayBars(D(5), [10, 11]);
    const r = derive1DFrom8h(bars);
    expect(r.candles.length).toBe(0);
  });

  it("is deterministic (same input -> same output)", () => {
    const bars = dayBars(D(3), [50, 51, 52]);
    const a = derive1DFrom8h(bars);
    const b = derive1DFrom8h(bars);
    expect(a).toEqual(b);
  });
});
