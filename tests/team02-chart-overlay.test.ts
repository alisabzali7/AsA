/**
 * Team 02 — chart intelligence contract.
 *  - the overlay is a pure projection of the bundle: every price/time it
 *    carries exists in the bundle (no fabricated evidence)
 *  - mitigated zones and display caps are reported, never silently dropped
 *  - markers ascend in time (lightweight-charts requirement)
 *  - the frontend chart imports no calculation engine (it draws, never computes)
 *  - the renderer refuses non-finite candles instead of a fabricated 0..1 scale
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Candle } from "../src/lib/domain/types";
import { buildBundle } from "../src/lib/analysis/bundle";
import { buildChartOverlay, OVERLAY_LIMITS, OVERLAY_SCHEMA } from "../src/lib/chart/technical";
import { priceBounds, renderEvidenceSvg } from "../src/lib/chart/render";
import type { ChartEvidence } from "../src/lib/chart/evidence";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function walk(n: number, seed: number): Candle[] {
  const r = lcg(seed);
  let p = 1000;
  return Array.from({ length: n }, (_, i) => {
    const o = p, c = o + Math.round((r() - 0.5) * 24) * 0.25;
    const h = Math.max(o, c) + Math.round(r() * 8) * 0.25, l = Math.min(o, c) - Math.round(r() * 8) * 0.25;
    p = c;
    return { t: 1_700_000_000 + i * 3600, o, h, l, c, v: 100 };
  });
}

describe("chart overlay = projection of engine evidence", () => {
  for (const seed of [1, 7, 42, 1337]) {
    it(`seed ${seed}: every overlay object traces to a bundle field with the same price/time`, () => {
      const b = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles: walk(260, seed), nowMs: 1 });
      const o = buildChartOverlay(b)!;
      expect(o.schema).toBe(OVERLAY_SCHEMA);
      expect([o.symbol, o.timeframe, o.as_of_t]).toEqual([b.symbol, b.timeframe, b.as_of_t]);
      const st = b.structure;
      for (const l of o.lines) {
        if (l.kind === "SR") expect(st.sr_levels.map((x) => x.price)).toContain(l.price);
        if (l.kind === "FIB") expect(st.fib.map((x) => x.price)).toContain(l.price);
        if (l.kind === "SWING") expect([st.last_swing_high, st.last_swing_low]).toContain(l.price);
      }
      for (const z of o.zones) {
        const src = z.kind === "FVG" ? st.fvgs : st.order_blocks;
        const hit = (src as { t: number; top: number; bottom: number; mitigated_index: number | null }[]).find((x) => x.t === z.from_t && x.top === z.top && x.bottom === z.bottom);
        expect(hit).toBeDefined();
        expect(hit!.mitigated_index).toBeNull(); // only OPEN zones are drawn
      }
      for (const m of o.markers) {
        if (m.kind === "DIVERGENCE") expect(b.divergence.events.some((d) => d.to.t === m.t && d.to.price === m.price)).toBe(true);
        else expect(st.events.some((e) => e.kind === m.kind && e.t === m.t && e.price === m.price && e.direction === m.direction)).toBe(true);
      }
      for (let i = 1; i < o.markers.length; i++) expect(o.markers[i].t).toBeGreaterThanOrEqual(o.markers[i - 1].t);
      // accounting: drawn + omitted == produced
      const fvgOmitted = o.omitted.filter((x) => x.kind === "FVG").reduce((a, x) => a + x.count, 0);
      const obOmitted = o.omitted.filter((x) => x.kind === "OB").reduce((a, x) => a + x.count, 0);
      expect(o.zones.filter((z) => z.kind === "FVG").length + fvgOmitted).toBe(st.fvgs.length);
      expect(o.zones.filter((z) => z.kind === "OB").length + obOmitted).toBe(st.order_blocks.length);
      expect(o.zones.filter((z) => z.kind === "FVG").length).toBeLessThanOrEqual(OVERLAY_LIMITS.open_fvgs);
      expect(JSON.stringify(o)).not.toMatch(/NaN|Infinity|null,"price"|"price":null/);
    });
  }

  it("no bundle / empty bundle -> no overlay (nothing to draw is not an empty-but-valid chart)", () => {
    expect(buildChartOverlay(null)).toBeNull();
    expect(buildChartOverlay(buildBundle({ symbol: "X", timeframe: "1h", candles: [], nowMs: 1 }))).toBeNull();
  });

  it("overlay is deterministic", () => {
    const b = buildBundle({ symbol: "X", timeframe: "1h", candles: walk(200, 9), nowMs: 1 });
    expect(JSON.stringify(buildChartOverlay(b))).toBe(JSON.stringify(buildChartOverlay(b)));
  });

  it("the overlay carries no trading instruction vocabulary (Team 02 primitives are not decisions)", () => {
    const o = buildChartOverlay(buildBundle({ symbol: "X", timeframe: "1h", candles: walk(260, 42), nowMs: 1 }))!;
    expect(JSON.stringify(o).toLowerCase()).not.toMatch(/\b(buy|sell|entry|exit|take.?profit|stop.?loss|probability)\b/);
  });
});

describe("frontend draws, never computes", () => {
  const src = readFileSync(path.resolve(__dirname, "../src/components/chart-view.tsx"), "utf8");
  it("chart-view imports no analysis/indicator/structure engine (type-only overlay import allowed)", () => {
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*from\s+"([^"]+)"/gm)].map((m) => ({ typeOnly: !!m[1], mod: m[2] }));
    const runtime = imports.filter((i) => !i.typeOnly).map((i) => i.mod);
    for (const m of runtime) expect(m).not.toMatch(/lib\/analysis|lib\/features|lib\/chart\/technical|indicators|structure/);
    expect(src).not.toMatch(/\b(ema|rsi|atr|findSwings|analyzeStructure)\s*\(/);
  });

  it("chart-view guards every drawn payload by symbol AND timeframe identity", () => {
    // Task 10: bundle/overlay gating moved into the pure adapter (behaviour
    // tested in team10-chart-e2e.test.ts); the component must route through it
    expect(src).toMatch(/gateAnalysis\(analysisData, activeSymbol, tf\)/);
    expect(src).toMatch(/candles\.data\.symbol === activeSymbol && candles\.data\.timeframe === tf/);
    expect(src).not.toMatch(/analysis\.data\.overlay\b/); // no ungated overlay access
  });

  it("usePoll only returns data produced by the currently requested URL", () => {
    const hooks = readFileSync(path.resolve(__dirname, "../src/components/hooks.tsx"), "utf8");
    expect(hooks).toMatch(/const current = snap\.url === url;/);
    expect(hooks).toMatch(/data: current \? snap\.data : null/);
  });
});

describe("renderer bounds: no hidden sentinels", () => {
  it("all non-finite candles -> null bounds (pre-fix: fabricated {lo:0, hi:1})", () => {
    const bad: Candle[] = [{ t: 1, o: NaN, h: NaN, l: NaN, c: NaN, v: 0 }];
    expect(priceBounds(bad, [])).toBeNull();
  });

  it("a non-finite candle inside a valid window is skipped, bounds stay finite and data-anchored", () => {
    const c = walk(20, 3);
    c[5] = { ...c[5], h: Number.POSITIVE_INFINITY };
    const b = priceBounds(c, [])!;
    expect(Number.isFinite(b.lo) && Number.isFinite(b.hi)).toBe(true);
    const valid = c.filter((x) => Number.isFinite(x.h));
    expect(b.lo).toBeLessThan(Math.min(...valid.map((x) => x.l)));
    expect(b.hi).toBeGreaterThan(Math.max(...valid.map((x) => x.h)));
  });

  it("a flat window is padded relative to price, not by an absolute 1.0", () => {
    const flat: Candle[] = Array.from({ length: 10 }, (_, i) => ({ t: i, o: 0.0001, h: 0.0001, l: 0.0001, c: 0.0001, v: 1 }));
    const b = priceBounds(flat, [])!;
    expect(b.hi - b.lo).toBeLessThan(0.00001);
    expect(b.lo).toBeLessThan(0.0001);
  });

  it("an SVG built from only non-finite candles contains no NaN geometry", () => {
    const bad: Candle[] = Array.from({ length: 5 }, (_, i) => ({ t: i, o: NaN, h: NaN, l: NaN, c: NaN, v: 0 }));
    const ev: ChartEvidence = {
      symbol: "X", timeframe: "1h", strategy_id: "s", setup_id: "u", direction: "long", bar_time: null,
      annotations: [], rules: [], score: null, score_semantics: "", assumptions: [], lineage_complete: true,
    };
    const svg = renderEvidenceSvg(ev, bad);
    expect(svg).not.toMatch(/NaN/);
    expect(svg).toMatch(/no valid candles/);
  });
});
