/**
 * Team 02 release-gate: edge cases closed in the final pass.
 *  - flat series (zero true range, zero price change) through the whole
 *    canonical chain: no NaN/Infinity, no hidden sentinel, every undefined
 *    value says why;
 *  - ATR-gated detectors distinguish warmup from a flat series;
 *  - legacy evidence (no snapshot) is UNVERIFIABLE_LEGACY_RECORD, and the
 *    Telegram caption discloses it.
 */
import { describe, expect, it } from "vitest";
import type { Candle, CandleSeries } from "../src/lib/domain/types";
import { prepareAnalysisInput } from "../src/lib/analysis/input";
import { buildArtifactsFromInput } from "../src/lib/analysis/bundle";
import { buildMtfAsOf, MTF_ROLE_TF } from "../src/lib/analysis/mtf";
import { buildChartOverlay } from "../src/lib/chart/technical";
import { detectLevels, detectDoublePattern, detectLevelTouch } from "../src/lib/features/detectors";
import { verifyDecisionSnapshot } from "../src/lib/chart/evidence";
import { photoCaption } from "../src/lib/notify/telegram";
import { renderEvidenceSvg } from "../src/lib/chart/render";
import type { ChartEvidence } from "../src/lib/chart/evidence";

const STEP = 3600;
const NOW_SEC = 1_790_000_000 - (1_790_000_000 % STEP) + 120; // 2 min into a forming 1h bar

function flatSeries(n: number, price: number, volume: number): CandleSeries {
  const formingOpen = Math.floor(NOW_SEC / STEP) * STEP;
  const t0 = formingOpen - n * STEP;
  const candles: Candle[] = Array.from({ length: n + 1 }, (_, i) => ({ t: t0 + i * STEP, o: price, h: price, l: price, c: price, v: volume }));
  return { symbol: "FLATUSDT", timeframe: "1h", candles, native: true, source: "ttt" as CandleSeries["source"], fetched_at_ms: NOW_SEC * 1000 };
}

function nonFinitePaths(v: unknown, p = "$", out: string[] = []): string[] {
  if (typeof v === "number") { if (!Number.isFinite(v)) out.push(p); }
  else if (Array.isArray(v)) v.forEach((x, i) => nonFinitePaths(x, `${p}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) nonFinitePaths(x, `${p}.${k}`, out);
  return out;
}

describe("flat series through the canonical chain", () => {
  const input = prepareAnalysisInput("FLATUSDT", "1h", flatSeries(120, 100, 500), NOW_SEC * 1000);
  const art = buildArtifactsFromInput(input, undefined, NOW_SEC * 1000)!;
  const b = art.bundle;

  it("closed-bar window excludes the forming bar", () => {
    expect(b.bars).toBe(120);
    expect(b.as_of_t).toBe(Math.floor(NOW_SEC / STEP) * STEP - STEP);
  });
  it("bundle, series and overlay contain no NaN/Infinity", () => {
    expect(nonFinitePaths(b)).toEqual([]);
    expect(nonFinitePaths(art.series)).toEqual([]);
    expect(nonFinitePaths(buildChartOverlay(b, art.series))).toEqual([]);
  });
  it("RSI 0/0 is reported as 50 WITH the engineering-convention reason (not a silent neutral)", () => {
    expect(b.indicators.rsi14).toBe(50);
    expect(b.indicator_status.rsi14.state).toBe("OK");
    expect(b.indicator_status.rsi14.reason).toMatch(/0\/0.*ENGINEERING_DEFINED/);
  });
  it("ATR 0 and ATR% 0 are true measurements of zero range; EMAs equal the constant price", () => {
    expect(b.indicators.atr14).toBe(0);
    expect(b.indicators.atr14_pct).toBe(0);
    expect(b.indicators.ema20).toBe(100);
    expect(b.indicators.ema50).toBe(100);
  });
  it("structure: no swings, no fib, no zones, no events; no divergence; no momentum leg", () => {
    expect(b.structure.fib_leg).toBeNull();
    expect(b.structure.fib).toEqual([]);
    expect(b.structure.fvgs).toEqual([]);
    expect(b.structure.order_blocks).toEqual([]);
    expect(b.structure.swing_points).toEqual([]);
    expect(b.structure.events).toEqual([]);
    expect(b.structure.trend).not.toBe("up");
    expect(b.structure.trend).not.toBe("down");
    expect(b.divergence.events).toEqual([]);
    expect(b.momentum.last_leg).toBeNull();
    expect(b.momentum.last_vs_previous_slope_ratio).toBeNull();
  });
  it("RSI of a rising non-flat window never carries the flat-convention reason", () => {
    const s = flatSeries(120, 100, 500);
    s.candles = s.candles.map((c, i) => ({ ...c, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
    const bb = buildArtifactsFromInput(prepareAnalysisInput("FLATUSDT", "1h", s, NOW_SEC * 1000), undefined, NOW_SEC * 1000)!.bundle;
    expect(bb.indicator_status.rsi14.reason).toBeNull();
  });
});

describe("zero-volume series", () => {
  it("volume ratio is UNDEFINED with a reason, never 0 or Infinity", () => {
    const b = buildArtifactsFromInput(prepareAnalysisInput("FLATUSDT", "1h", flatSeries(60, 100, 0), NOW_SEC * 1000), undefined, NOW_SEC * 1000)!.bundle;
    expect(b.indicators.volume_avg20).toBe(0);
    expect(b.indicators.last_volume_ratio).toBeNull();
    expect(b.indicator_status.last_volume_ratio.state).toBe("UNDEFINED");
    expect(b.indicator_status.last_volume_ratio.reason).toMatch(/average volume is 0/);
  });
});

describe("ATR-gated detectors: warmup vs flat series", () => {
  const flat = flatSeries(80, 100, 500).candles.slice(0, -1);
  it("flat series → UNAVAILABLE (tolerance undefined), not INSUFFICIENT_BARS", () => {
    for (const f of [detectLevels(flat, "1h"), detectDoublePattern(flat, "1h"), detectLevelTouch(flat, "1h", [], 2)]) {
      expect(f.valid).toBe(false);
      expect(f.data_quality).toBe("UNAVAILABLE");
      expect(f.reason).toMatch(/ATR14 = 0/);
    }
  });
  it("short but non-flat series stays INSUFFICIENT_BARS", () => {
    const short = flat.slice(0, 25).map((c, i) => ({ ...c, h: c.h + 1 + (i % 3), l: c.l - 1 }));
    const f = detectLevels(short, "1h");
    expect(f.valid).toBe(false);
    expect(f.data_quality).toBe("INSUFFICIENT_BARS");
  });
});

describe("legacy records without a decision snapshot", () => {
  const evidence = { symbol: "BTCUSDT", timeframe: "1h", snapshot: undefined };
  it("verify returns UNVERIFIABLE_LEGACY_RECORD — nothing is fabricated", () => {
    const r = verifyDecisionSnapshot(evidence, flatSeries(30, 100, 1).candles);
    expect(r.state).toBe("UNVERIFIABLE_LEGACY_RECORD");
    expect(r.reason).toMatch(/predates snapshot capture/);
  });
  it("telegram photo caption discloses the unverified window; VERIFIED captions are untouched", () => {
    expect(photoCaption("ADVISORY", "VERIFIED")).toBe("ADVISORY");
    const c = photoCaption("ADVISORY", "UNVERIFIABLE_LEGACY_RECORD");
    expect(c.startsWith("[chart window UNVERIFIABLE_LEGACY_RECORD")).toBe(true);
    expect(c.endsWith("\nADVISORY")).toBe(true);
  });
});

describe("MTF and single-timeframe routes share ONE canonical computation", () => {
  const STEPS: Record<string, number> = { "4h": 14400, "1h": 3600, "15m": 900 };
  function wave(tf: string, n: number): CandleSeries {
    const step = STEPS[tf];
    const formingOpen = Math.floor(NOW_SEC / step) * step;
    const t0 = formingOpen - n * step;
    const candles: Candle[] = Array.from({ length: n + 1 }, (_, i) => {
      const c = 100 + 6 * Math.sin(i / 7) + i * 0.02;
      const o = 100 + 6 * Math.sin((i - 1) / 7) + (i - 1) * 0.02;
      return { t: t0 + i * step, o, h: Math.max(o, c) + 0.4, l: Math.min(o, c) - 0.4, c, v: 100 + (i % 13) };
    });
    return { symbol: "EQUSDT", timeframe: tf, candles, native: true, source: "ttt" as CandleSeries["source"], fetched_at_ms: NOW_SEC * 1000 };
  }
  it("every MTF component bundle deep-equals the single-tf bundle for the same series and clock", () => {
    const series = { macro: wave("4h", 200), context: wave("1h", 300), trigger: wave("15m", 400) };
    const { mtf, parts } = buildMtfAsOf("EQUSDT", series, NOW_SEC * 1000);
    expect(mtf.verdict).not.toBe("UNAVAILABLE");
    for (const p of parts) {
      const role = p.role as keyof typeof series;
      expect(p.timeframe).toBe(MTF_ROLE_TF[role]);
      const single = buildArtifactsFromInput(prepareAnalysisInput("EQUSDT", p.timeframe, series[role], NOW_SEC * 1000), undefined, NOW_SEC * 1000)!.bundle;
      expect(p.bundle).toEqual(single);
      const comp = mtf.components.find((c) => c.role === p.role)!;
      expect(comp.input_fingerprint).toBe(single.provenance.input_fingerprint);
      expect(comp.as_of_t).toBe(single.as_of_t);
    }
  });
});

describe("SVG evidence render: nearby levels stay legible", () => {
  it("labels of annotations 0.01% apart are separated by ≥12px while their lines stay at the exact price", () => {
    const candles = flatSeries(60, 100, 1).candles.map((c, i) => ({ ...c, h: 101 + (i % 5), l: 99 - (i % 3) }));
    const ann = (id: string, price: number) => ({ annotation_id: id, kind: "level" as const, label: id, price, produced_by: { type: "feature" as const, id: "f" }, source_refs: [], detector_version: "1", evidence_kind: "MEASURED" as const });
    const ev = { symbol: "X", timeframe: "1h", strategy_id: "s", setup_id: "S", direction: "long", bar_time: candles[candles.length - 1].t,
      annotations: [ann("a", 100), ann("b", 100.01), ann("c", 100.02)], rules: [], score: null, score_semantics: "x", assumptions: [], lineage_complete: true } as unknown as ChartEvidence;
    const svg = renderEvidenceSvg(ev, candles);
    const ys = [...svg.matchAll(/<text x="14" y="([0-9.]+)"[^>]*>([abc]) /g)].map((m) => Number(m[1])).sort((p, q) => p - q);
    expect(ys.length).toBe(3);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(12);
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(12);
    const lineYs = [...svg.matchAll(/<line [^>]*y1="([0-9.]+)"[^>]*data-annotation-id="([abc])"/g)].map((m) => Number(m[1]));
    expect(Math.max(...lineYs) - Math.min(...lineYs)).toBeLessThan(2);
  });
});
