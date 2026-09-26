/**
 * TASK 10 — final Team 02 chain proofs.
 *
 *   E2E-1  Market Truth (venue series incl. forming bar) → input contract →
 *          indicators/structure/momentum/divergence → MTF → bundle JSON →
 *          decision consumer (AI evidence) — one snapshot identity end to end.
 *   E2E-2  Bundle → chart overlay → JSON (as the API sends it) → frontend
 *          adapter → lightweight-charts render input. Asserts VALUES, not a
 *          snapshot string.
 *
 * Plus: structure/bundle single-calculation equivalence, bundle JSON
 * round-trip, adaptive precision, poll race guard, decision snapshot identity
 * for opportunities/ChartEvidence, decision-window rendering, detector
 * labelling fixes. Synthetic SHAPES only (no market claims), fixed clocks.
 */
import { describe, it, expect } from "vitest";
import type { Candle, CandleSeries } from "../src/lib/domain/types";
import { prepareAnalysisInput } from "../src/lib/analysis/input";
import { buildArtifactsFromInput, buildBundle, buildBundleArtifacts, type AnalysisBundle } from "../src/lib/analysis/bundle";
import { analyzeStructure, findSwings, STRUCTURE_PARAMS } from "../src/lib/analysis/structure";
import { ema, atr } from "../src/lib/analysis/indicators";
import { buildMtfAsOf } from "../src/lib/analysis/mtf";
import { inputErrorClass } from "../src/lib/analysis/errors";
import { buildChartOverlay, type ChartOverlay } from "../src/lib/chart/technical";
import {
  decimalsFor, gateAnalysis, mergeBars, overlayToRender, priceFormatFor, toCandleData, toVolumeData, analysisStatus, utcLabel,
} from "../src/lib/chart/adapter";
import { createSequenceGuard } from "../src/lib/poll-sequence";
import { decisionSnapshot, verifyDecisionSnapshot, decisionWindow, type ChartEvidence } from "../src/lib/chart/evidence";
import { renderEvidenceSvg } from "../src/lib/chart/render";
import { detectDoublePattern, detectABCD } from "../src/lib/features/detectors";
import { heuristicAnalyze, serializeEvidence, type AiEvidence } from "../src/lib/ai";
import type { PsychologySummary } from "../src/lib/psychology/engine";
import { readFileSync } from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------ fixtures */
const STEP: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400 };
const T16 = Date.UTC(2026, 8, 1, 16, 0, 0) / 1000;

function candlesFrom(closes: number[], step: number, lastOpen: number): Candle[] {
  const t0 = lastOpen - (closes.length - 1) * step;
  return closes.map((c, i) => {
    const o = i === 0 ? c : (closes[i - 1] + c) / 2;
    const w = Math.abs(c) * 0.002;
    return { t: t0 + i * step, o, h: Math.max(o, c) + w, l: Math.min(o, c) - w, c, v: 100 + (i % 7) * 10 };
  });
}
const wave = (n: number, base = 100, drift = 0.35) =>
  Array.from({ length: n }, (_, i) => base + i * drift * base / 100 + 4 * base / 100 * Math.sin((2 * Math.PI * i) / 11) + 2 * base / 100 * Math.sin((2 * Math.PI * i) / 29));
function venueSeries(symbol: string, tf: string, nowSec: number, closes: number[]): CandleSeries {
  const step = STEP[tf];
  const formingOpen = Math.floor(nowSec / step) * step;
  return { symbol, timeframe: tf, candles: candlesFrom(closes, step, formingOpen), native: true, source: "ttt" as CandleSeries["source"], fetched_at_ms: nowSec * 1000 };
}
function nonFinitePaths(v: unknown, p = "$", out: string[] = []): string[] {
  if (typeof v === "number") { if (!Number.isFinite(v)) out.push(p); }
  else if (v === undefined) out.push(`${p}=undefined`);
  else if (Array.isArray(v)) v.forEach((x, i) => nonFinitePaths(x, `${p}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (x !== undefined) nonFinitePaths(x, `${p}.${k}`, out); }
  return out;
}
const psych = { symbol: "BTCUSDT", generated_at_ms: 0, bias: "neutral", bias_reason: "fixture", sections: [], universe_funding: { measured: 0, total: 0, mean: null, max_abs: null, timestamp_ms: null } } as unknown as PsychologySummary;

/* ------------------------------------------------ single calculation */
describe("structure/bundle single calculation (Task 10 dedupe)", () => {
  const c = candlesFrom(wave(400), 3600, T16);
  it("analyzeStructure with the bundle's precomputed series equals the self-computed result", () => {
    const closes = c.map((x) => x.c);
    const pre = analyzeStructure(c, { atr14: atr(c, 14), ema20: ema(closes, 20), ema50: ema(closes, 50), swings: findSwings(c, STRUCTURE_PARAMS.swing_left, STRUCTURE_PARAMS.swing_right) });
    const self = analyzeStructure(c, { atr14: atr(c, 14) });
    expect(pre).toEqual(self);
    expect(JSON.stringify(pre)).toBe(JSON.stringify(self));
  });
  it("misaligned precomputed series are ignored (never trusted blindly)", () => {
    const bad = analyzeStructure(c, { ema20: [1, 2, 3], ema50: [4] });
    expect(bad).toEqual(analyzeStructure(c));
  });
  it("bundle series are the SAME arrays whose last values the bundle reports", () => {
    const { bundle, series } = buildBundleArtifacts({ symbol: "X", timeframe: "1h", candles: c, nowMs: 0 });
    expect(series.t.length).toBe(bundle.bars);
    expect(series.ema20[series.ema20.length - 1]).toBe(bundle.indicators.ema20);
    expect(series.ema50[series.ema50.length - 1]).toBe(bundle.indicators.ema50);
    expect(series.ema20.slice(0, 19).every((v) => v === null)).toBe(true); // warmup is null, never 0
    expect(buildBundle({ symbol: "X", timeframe: "1h", candles: c, nowMs: 0 })).toEqual(bundle);
  });
});

/* ------------------------------------------------ bundle serialization */
describe("bundle JSON round-trip loses nothing", () => {
  for (const [name, closes] of [["wave", wave(300)], ["short", wave(12)], ["subcent", wave(300, 0.00000123)]] as const) {
    it(`${name}: parse(stringify(bundle)) deep-equals the bundle; no NaN/Infinity/undefined`, () => {
      const nowSec = T16 + 1800;
      const input = prepareAnalysisInput("X", "1h", venueSeries("X", "1h", nowSec, closes as number[]), nowSec * 1000);
      const art = buildArtifactsFromInput(input, undefined, nowSec * 1000)!;
      const overlay = buildChartOverlay(art.bundle, art.series)!;
      for (const obj of [art.bundle, overlay] as unknown[]) {
        expect(nonFinitePaths(obj)).toEqual([]);
        const rt = JSON.parse(JSON.stringify(obj));
        expect(rt).toEqual(obj);
        expect(JSON.stringify(rt)).toBe(JSON.stringify(obj)); // byte-stable
      }
    });
  }
});

/* ------------------------------------------------------------ E2E-1 */
describe("E2E-1: Market Truth → calc → structure → MTF → bundle → decision consumer", () => {
  const nowSec = T16 + 7 * 60; // 7 min into the 16:00 15m bar (forming)
  const series = {
    macro: venueSeries("BTCUSDT", "4h", nowSec, wave(260)),
    context: venueSeries("BTCUSDT", "1h", nowSec, wave(260, 100, 0.2)),
    trigger: venueSeries("BTCUSDT", "15m", nowSec, wave(260, 100, 0.1)),
  };
  const { mtf, parts } = buildMtfAsOf("BTCUSDT", series, nowSec * 1000);

  it("every role excludes its forming bar and is knowable no later than now", () => {
    for (const p of parts) {
      expect(p.input.forming_bar_excluded).toBe(true);
      const src = series[p.role].candles;
      expect(p.bundle!.as_of_t).toBe(src[src.length - 2].t);
      expect(p.input.source_ts_ms!).toBeLessThanOrEqual(nowSec * 1000);
    }
  });
  it("MTF components carry exactly the fingerprints of the bundles computed from those inputs", () => {
    for (const p of parts) {
      const comp = mtf.components.find((c) => c.role === p.role)!;
      expect(comp.input_fingerprint).toBe(p.bundle!.provenance.input_fingerprint);
      expect(comp.as_of_t).toBe(p.bundle!.as_of_t);
    }
  });
  it("the decision consumer receives the same snapshot, finite and JSON-safe", () => {
    const trig = mtf.trigger!;
    const ev: AiEvidence = {
      symbol: "BTCUSDT", timeframe: "15m", mtf, macro: mtf.macro, context: mtf.context, trigger: trig,
      psychology: psych, risk: null, strategy: null, fundamental: null,
      data_timestamp: mtf.oldest_source_ts_ms ?? trig.provenance.source_ts_ms ?? null, window: trig.candle_window!,
    };
    const s = JSON.parse(JSON.stringify(serializeEvidence(ev)));
    expect(JSON.stringify(s)).toContain(trig.provenance.input_fingerprint);
    const r = heuristicAnalyze(ev);
    expect(nonFinitePaths(r)).toEqual([]);
  });
  it("a cross-symbol series is refused with the typed IDENTITY_MISMATCH class", () => {
    const i = prepareAnalysisInput("BTCUSDT", "1h", venueSeries("ETHUSDT", "1h", nowSec, wave(80)), nowSec * 1000);
    expect(inputErrorClass(i, null)).toBe("IDENTITY_MISMATCH");
  });
});

/* ------------------------------------------------------------ E2E-2 */
describe("E2E-2: bundle → chart contract → JSON → adapter → render input", () => {
  const nowSec = T16 + 1800;
  const venue = venueSeries("ETHUSDT", "1h", nowSec, wave(400, 2500));
  const input = prepareAnalysisInput("ETHUSDT", "1h", venue, nowSec * 1000);
  const art = buildArtifactsFromInput(input, undefined, nowSec * 1000)!;
  // exactly what the API route sends and the browser parses
  const wire = JSON.parse(JSON.stringify({ ok: true, available: true, bundle: art.bundle, overlay: buildChartOverlay(art.bundle, art.series) }));
  const candlesWire = JSON.parse(JSON.stringify({ symbol: "ETHUSDT", timeframe: "1h", candles: venue.candles, last_bar_forming: input.forming_bar_excluded }));

  const gated = gateAnalysis(wire, "ETHUSDT", "1h");
  const merged = mergeBars([], candlesWire.candles, candlesWire.last_bar_forming);
  const barTimes = new Set(merged.bars.map((b) => b.t));
  const render = overlayToRender(gated.overlay, barTimes);

  it("identity gate passes only the matching snapshot", () => {
    expect(gated.bundleGate).toBe("OK");
    expect(gated.overlayGate).toBe("OK");
    expect(gateAnalysis(wire, "BTCUSDT", "1h").overlay).toBeNull();
    expect(gateAnalysis(wire, "ETHUSDT", "4h").bundle).toBeNull();
    const tampered = { ...wire, overlay: { ...wire.overlay, bundle_fingerprint: "00000000000000" } };
    expect(gateAnalysis(tampered, "ETHUSDT", "1h").overlayGate).toBe("FINGERPRINT_MISMATCH");
    const oldAsOf = { ...wire, overlay: { ...wire.overlay, as_of_t: wire.overlay.as_of_t - 3600 } };
    expect(gateAnalysis(oldAsOf, "ETHUSDT", "1h").overlay).toBeNull();
  });
  it("forming bar: drawn distinct on the chart, absent from every analysis object", () => {
    const formingT = venue.candles[venue.candles.length - 1].t;
    expect(merged.formingT).toBe(formingT);
    const cd = toCandleData(merged.bars, merged.formingT);
    const last = cd[cd.length - 1];
    expect(last.time).toBe(formingT);
    expect(last.color).toMatch(/55$/); // translucent
    expect(last.borderColor).toBeDefined();
    expect(cd.slice(0, -1).every((d) => d.color === undefined)).toBe(true);
    expect(gated.bundle!.as_of_t).toBe(formingT - 3600);
    for (const s of render.lineSeries) expect(s.data.every((p) => p.time < formingT)).toBe(true);
    for (const m of render.markers) expect(m.time).toBeLessThanOrEqual(gated.bundle!.as_of_t!);
  });
  it("EMA lines are the bundle's series; last point equals bundle.indicators", () => {
    const e20 = render.lineSeries.find((s) => s.id === "ema20")!;
    const e50 = render.lineSeries.find((s) => s.id === "ema50")!;
    expect(e20.data[e20.data.length - 1].value).toBe(art.bundle.indicators.ema20);
    expect(e50.data[e50.data.length - 1].value).toBe(art.bundle.indicators.ema50);
    expect(e20.data.length).toBe(art.bundle.bars - 19); // warmup omitted, not zero-filled
    expect(e20.data.every((p) => Number.isFinite(p.value) && p.value > 0)).toBe(true);
  });
  it("price lines / markers come only from the overlay, all times aligned to drawn bars", () => {
    const o = gated.overlay as ChartOverlay;
    // zones are time-bounded line series now (release-gate), not price lines
    expect(render.priceLines.length).toBe(o.lines.length);
    const placedZones = o.zones.length - (render.unplaced.find((u) => u.kind === "ZONE")?.count ?? 0);
    expect(render.markers.length + (render.unplaced.find((u) => u.kind === "MARKER")?.count ?? 0)).toBe(o.markers.length + placedZones + (o.lines.some((l) => l.kind === "FIB") && !render.unplaced.some((u) => u.kind === "FIB_ORIGIN") ? 1 : 0));
    for (const m of render.markers) expect(barTimes.has(m.time)).toBe(true);
    for (let i = 1; i < render.markers.length; i++) expect(render.markers[i].time).toBeGreaterThanOrEqual(render.markers[i - 1].time);
    expect(o.markers.length + o.lines.length).toBeGreaterThan(0);
  });
  it("FVG/OB zones are segments from from_t to as_of_t — never before the zone existed, never into the forming bar", () => {
    const o = gated.overlay as ChartOverlay;
    expect(o.zones.length).toBeGreaterThan(0);
    for (const z of o.zones) {
      for (const edge of ["top", "bot"] as const) {
        const s = render.lineSeries.find((x) => x.id === `${z.id}:${edge}`)!;
        expect(s).toBeDefined();
        expect(s.data[0].time).toBe(z.from_t);
        expect(s.data[s.data.length - 1].time).toBe(o.as_of_t);
        expect(s.data.every((p) => p.value === (edge === "top" ? z.top : z.bottom))).toBe(true);
      }
      const label = render.markers.find((m) => m.time === z.from_t && m.text === z.label);
      expect(label?.shape).toBe("square");
    }
  });
  it("fib grid states when it became knowable (leg-end confirmation), marked on that bar", () => {
    const o = gated.overlay as ChartOverlay;
    const fibs = o.lines.filter((l) => l.kind === "FIB");
    expect(fibs.length).toBeGreaterThan(0);
    const leg = art.bundle.structure.fib_leg!;
    for (const f of fibs) expect(f.knowable_t).toBe(leg.confirmed_t);
    expect(leg.confirmed_t).toBeGreaterThanOrEqual(leg.to.t);
    expect(leg.confirmed_t).toBeLessThanOrEqual(o.as_of_t!);
    expect(render.markers.some((m) => m.time === leg.confirmed_t && m.text === "fib leg confirmed")).toBe(true);
    for (const l of o.lines.filter((x) => x.kind !== "FIB")) expect(l.knowable_t).toBeUndefined();
  });
  it("overlay declares spec-missing layers instead of silently omitting them", () => {
    const o = gated.overlay as ChartOverlay;
    const byLayer = Object.fromEntries(o.unavailable_layers.map((u) => [u.layer, u.state]));
    expect(byLayer).toEqual({
      TRENDLINES: "TRENDLINES_SPEC_LOCKED", MACD: "PARAMETERS_UNSPECIFIED", ICHIMOKU: "PARAMETERS_UNSPECIFIED",
      ADX: "PARAMETERS_UNSPECIFIED", LIQUIDITY: "LIQUIDITY_SPEC_UNKNOWN", MOMENTUM_STRENGTH: "MOMENTUM_STRENGTH_THRESHOLD_UNKNOWN",
    });
    // nothing drawn claims to be one of them
    const kinds = new Set([...o.lines.map((l) => l.kind), ...o.zones.map((z) => z.kind), ...o.markers.map((m) => m.kind), ...o.series.map((x) => x.kind)]);
    for (const k of ["TRENDLINE", "MACD", "ICHIMOKU", "ADX", "LIQUIDITY"]) expect(kinds.has(k as never)).toBe(false);
  });
  it("volume = venue v per bar; bars without finite v are omitted, never 0", () => {
    const bars = [...merged.bars.slice(0, 3), { ...merged.bars[3], v: Number.NaN }, { ...merged.bars[4], v: undefined }];
    const vol = toVolumeData(bars, null);
    expect(vol.data.map((d) => d.value)).toEqual(merged.bars.slice(0, 3).map((b) => b.v));
    expect(vol.missing).toBe(2);
  });
  it("a late response for a previous symbol cannot be drawn (overlay/bundle null → chart cleared)", () => {
    const g = gateAnalysis(wire, "SOLUSDT", "1h");
    expect(g.bundle).toBeNull();
    expect(overlayToRender(g.overlay, barTimes)).toEqual({ priceLines: [], markers: [], lineSeries: [], unplaced: [] });
  });
  it("freshness shown as the server said it; failed refresh is flagged LAST GOOD", () => {
    expect(analysisStatus(gated.bundle, null)!.label).toBe(art.bundle.provenance.freshness);
    expect(analysisStatus(gated.bundle, "HTTP 502")!.label).toMatch(/LAST GOOD/);
    expect(analysisStatus(null, "HTTP 503")!.label).toBe("UNAVAILABLE");
    expect(analysisStatus(null, null)).toBeNull();
    expect(utcLabel(gated.bundle!.as_of_t, "s")).toMatch(/UTC$/);
    expect(utcLabel(gated.bundle!.provenance!.source_ts_ms, "ms")).toBe(utcLabel(gated.bundle!.as_of_t! + 3600, "s"));
  });
});

/* ------------------------------------------------------------ precision */
describe("adaptive price precision", () => {
  it("keeps significant digits across magnitudes", () => {
    expect(decimalsFor(65000)).toBe(2);
    expect(decimalsFor(1.2345)).toBe(4);
    expect(decimalsFor(0.012345)).toBe(6);
    expect(decimalsFor(0.0000012345)).toBe(10);
    expect(decimalsFor(0)).toBe(2);
    expect(decimalsFor(Number.NaN)).toBe(2);
  });
  it("priceFormat for a sub-cent series resolves distinct prices (default 2 decimals would collapse them)", () => {
    const c = candlesFrom(wave(100, 0.00000123), 60, T16);
    const pf = priceFormatFor(c);
    expect(pf.precision).toBe(10);
    expect(pf.minMove).toBe(1e-10);
    const labels = new Set(c.slice(-20).map((x) => x.c.toFixed(pf.precision)));
    expect(labels.size).toBeGreaterThan(10);
    expect(new Set(c.slice(-20).map((x) => x.c.toFixed(2))).size).toBe(1);
  });
});

/* ------------------------------------------------------------ race */
describe("poll sequence guard: a late response never overwrites newer state", () => {
  it("out-of-order resolution drops the older response", () => {
    const g = createSequenceGuard();
    const a = g.issue(), b = g.issue();
    expect(g.accept(b)).toBe(true);
    expect(g.accept(a)).toBe(false);
    const c = g.issue();
    expect(g.accept(c)).toBe(true);
  });
  it("in-order resolution applies every response", () => {
    const g = createSequenceGuard();
    const t = [g.issue(), g.issue(), g.issue()];
    expect(t.map((x) => g.accept(x))).toEqual([true, true, true]);
  });
  it("usePoll uses the guard for both data and error paths", () => {
    const hooks = readFileSync(path.resolve(__dirname, "../src/components/hooks.tsx"), "utf8");
    expect(hooks.match(/!dead && seq\.accept\(ticket\)/g)?.length).toBe(2);
  });
  it("the adapter imports no analysis engine (the frontend never recomputes)", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/lib/chart/adapter.ts"), "utf8");
    const runtime = [...src.matchAll(/^import\s+(type\s+)?[^;]*from\s+"([^"]+)"/gm)].filter((m) => !m[1]).map((m) => m[2]);
    expect(runtime).toEqual([]);
  });
});

/* ------------------------------------------------ decision snapshot */
describe("opportunity / ChartEvidence snapshot identity + decision window", () => {
  const all = candlesFrom(wave(300), 3600, T16);
  const decisionIdx = 250;
  const window = all.slice(50, decisionIdx + 1);
  const knowable = (all[decisionIdx].t + 3600) * 1000;
  const snap = decisionSnapshot("BTCUSDT", "1h", window, knowable, "strategy:S@1|detectors:1.1.0")!;
  const evidence = {
    symbol: "BTCUSDT", timeframe: "1h", strategy_id: "S", setup_id: "SET", direction: "long", bar_time: all[decisionIdx].t,
    annotations: [{ annotation_id: "a", kind: "entry", label: "Entry", price: window[window.length - 1].c, produced_by: { type: "rule", id: "R" }, source_refs: [], detector_version: "1.1.0", evidence_kind: "DERIVED" }],
    rules: [], score: null, score_semantics: "", assumptions: [], lineage_complete: true, snapshot: snap,
  } as ChartEvidence;

  it("snapshot records the exact window; re-fetched unchanged history VERIFIES", () => {
    expect(snap.closed_bars).toBe(window.length);
    expect(snap.as_of_t).toBe(all[decisionIdx].t);
    expect(verifyDecisionSnapshot(evidence, all).state).toBe("VERIFIED");
  });
  it("a revised bar inside the window is a MISMATCH (reported, not repaired)", () => {
    const revised = all.map((c, i) => (i === 120 ? { ...c, c: c.c + 1e-9 } : c));
    expect(verifyDecisionSnapshot(evidence, revised).state).toBe("MISMATCH");
  });
  it("history that no longer holds the window is UNVERIFIABLE; legacy evidence is UNVERIFIABLE_LEGACY_RECORD", () => {
    expect(verifyDecisionSnapshot(evidence, all.slice(100)).state).toBe("UNVERIFIABLE");
    expect(verifyDecisionSnapshot(evidence, all.slice(0, 200)).state).toBe("UNVERIFIABLE");
    expect(verifyDecisionSnapshot({ ...evidence, snapshot: undefined }, all).state).toBe("UNVERIFIABLE_LEGACY_RECORD");
  });
  it("renderers never draw bars after the decision bar", () => {
    expect(decisionWindow(evidence, all).length).toBe(decisionIdx + 1);
    const svg = renderEvidenceSvg(evidence, all, { bars: 1000, snapshotState: "VERIFIED" });
    expect(svg.match(/<rect x=/g)!.length).toBe(decisionIdx + 1);
    expect(svg).toContain(`fp ${snap.input_fingerprint}`);
    expect(svg).toContain("snapshot VERIFIED");
  });
  it("orchestrator stores ONE snapshot object in provenance.data and chart_evidence", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/lib/pipeline/orchestrator.ts"), "utf8");
    expect(src).toMatch(/const snapshot = decisionSnapshot\(symbol, tf, candles, anchorCloseMs,/);
    expect(src).toMatch(/buildChartEvidence\(ev, score\.score, snapshot\)/);
    expect(src).toMatch(/trigger: candles\.length },\s*snapshot,/);
  });
});

/* ------------------------------------------------ detector labelling */
describe("detector backlog fixes", () => {
  it("DoublePattern: no confirmed swing between peaks → neckline UNKNOWN (null), never a peak and never a non-canonical fallback", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const mid = 88 + 1.5 * Math.sin((2 * Math.PI * i) / 11);
      c.push({ t: i * 60, o: mid - 0.3, h: mid + 1, l: mid - 1, c: mid + 0.3, v: 1 });
    }
    const hl: [number, number][] = [[95, 93], [97, 95], [100, 97], [98, 96], [97, 94], [97.5, 94], [99, 96], [100.2, 98], [98, 96], [97, 95]];
    hl.forEach(([h, l], k) => c.push({ t: (30 + k) * 60, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 1 }));
    const f = detectDoublePattern(c, "1m");
    expect(f.valid).toBe(true);
    const v = f.value!;
    expect(v.kind).toBe("double_top");
    // Absolute-final contract: Task 10 labelled the raw bar extreme (94)
    // BAR_EXTREME; that second, non-canonical computation is removed →
    // UNKNOWN. Pre-Task-10 bug (neckline = min(p1,p2) = 100, at the peak)
    // stays impossible: there is no value at all.
    expect(v.neckline_source).toBe("UNKNOWN");
    expect(v.neckline).toBeNull();
    expect(v.neckline).not.toBe(Math.min(v.p1, v.p2));
  });
  it("ABCD: slope_bc is measured, slope_cd is null (CD not formed at C)", () => {
    const c = candlesFrom(wave(200), 3600, T16);
    const f = detectABCD(c, "1h");
    expect(f.valid && f.value !== null).toBe(true);
    if (f.value) {
      expect(f.value.slope_cd).toBeNull();
      expect(Number.isFinite(f.value.slope_bc)).toBe(true);
      expect(f.value.cd).toBe(f.value.ab); // projection by construction
    }
    const src = readFileSync(path.resolve(__dirname, "../src/lib/strategy/compiled/harmonic-abcd.ts"), "utf8");
    expect(src).not.toMatch(/p\.slope_cd\b/);
  });
});

export type { AnalysisBundle };
