/**
 * TASK 09 — Technical Intelligence → Decision-Consumer readiness.
 *
 * One strong integration contract (Analysis → MTF → decision consumer) plus
 * the property / adversarial fixtures that prove a consumer can know, for
 * every technical value: what it means, when it became knowable, which
 * symbol/timeframe/snapshot it belongs to, whether it is valid / unknown /
 * unavailable, and which canonical calculation produced it.
 *
 * All fixtures are synthetic SHAPES (no market claims) with fixed clocks.
 */
import { describe, it, expect } from "vitest";
import type { Candle, CandleSeries } from "../src/lib/domain/types";
import { prepareAnalysisInput, timestampViolation } from "../src/lib/analysis/input";
import { buildBundle, buildBundleArtifacts, buildBundleFromInput, bundleInputFingerprint, type AnalysisBundle } from "../src/lib/analysis/bundle";
import { buildMtf, buildMtfAsOf, MTF_ROLE_TF, type MtfResult } from "../src/lib/analysis/mtf";
import { legMomentum } from "../src/lib/analysis/momentum";
import type { SwingPoint } from "../src/lib/analysis/structure";
import { rsi, ema, atr } from "../src/lib/analysis/indicators";
import { inputErrorClass, insufficientHistory, internalErrorBody } from "../src/lib/analysis/errors";
import { buildChartOverlay } from "../src/lib/chart/technical";
import { heuristicAnalyze, serializeEvidence, bundleSlice, coerceAiResponse, factualEvidence, HEURISTIC_SCORE_BY_VERDICT, type AiEvidence } from "../src/lib/ai";
import type { PsychologySummary } from "../src/lib/psychology/engine";
import {
  detectRSI, detectEMA, detectATR, detectAnatomy, detectPinbar, detectSwings, detectMomentumCandle,
  detectLevels, detectRejectionAt, detectStructureBias, detectVolatilityRegime,
} from "../src/lib/features/detectors";

/* ------------------------------------------------------------ fixtures */
const STEP: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400 };
/** 2026-09-01 16:00:00 UTC */
const T16 = Date.UTC(2026, 8, 1, 16, 0, 0) / 1000;

function candlesFrom(closes: number[], step: number, lastOpen: number): Candle[] {
  const t0 = lastOpen - (closes.length - 1) * step;
  return closes.map((c, i) => {
    const o = i === 0 ? c : (closes[i - 1] + c) / 2;
    const w = Math.abs(c) * 0.002;
    return { t: t0 + i * step, o, h: Math.max(o, c) + w, l: Math.min(o, c) - w, c, v: 100 + (i % 7) * 10 };
  });
}
const uptrend = (n: number) => Array.from({ length: n }, (_, i) => 100 + i * 0.5 + 3 * Math.sin((2 * Math.PI * i) / 11));

/** series as a venue would return it when fetched at `nowSec`: ends with the FORMING bar */
function venueSeries(symbol: string, tf: string, nowSec: number, n = 90, closes?: number[]): CandleSeries {
  const step = STEP[tf];
  const formingOpen = Math.floor(nowSec / step) * step;
  return { symbol, timeframe: tf, candles: candlesFrom(closes ?? uptrend(n), step, formingOpen), native: true, source: "ttt" as CandleSeries["source"], fetched_at_ms: nowSec * 1000 };
}
function mtfSeries(symbol: string, nowSec: number) {
  return { macro: venueSeries(symbol, "4h", nowSec), context: venueSeries(symbol, "1h", nowSec), trigger: venueSeries(symbol, "15m", nowSec) };
}
const psych = { symbol: "BTCUSDT", generated_at_ms: 0, bias: "neutral", bias_reason: "fixture", sections: [], universe_funding: { measured: 0, total: 0, mean: null, max_abs: null, timestamp_ms: null } } as unknown as PsychologySummary;

function evidenceFor(mtf: MtfResult, requestedTf = "1h"): AiEvidence {
  const trig = mtf.trigger!;
  return {
    symbol: mtf.symbol ?? "BTCUSDT", timeframe: requestedTf, mtf, macro: mtf.macro, context: mtf.context, trigger: trig,
    psychology: psych, risk: null, strategy: null, fundamental: null,
    data_timestamp: mtf.oldest_source_ts_ms ?? trig.provenance.source_ts_ms ?? null,
    window: trig.candle_window!,
  };
}

/** every number reachable in `v` is finite (no NaN/Infinity leaks into a contract) */
function nonFinitePaths(v: unknown, path = "$", out: string[] = []): string[] {
  if (typeof v === "number") { if (!Number.isFinite(v)) out.push(path); }
  else if (Array.isArray(v)) v.forEach((x, i) => nonFinitePaths(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) nonFinitePaths(x, `${path}.${k}`, out);
  return out;
}

/* ========================================= 1. integration contract */
describe("Analysis → MTF → decision consumer (integration contract)", () => {
  const nowSec = T16 + 5 * 60; // 16:05:00
  const { mtf, parts } = buildMtfAsOf("BTCUSDT", mtfSeries("BTCUSDT", nowSec), nowSec * 1000);

  it("every component carries identity, as-of, knowable-at and a snapshot fingerprint", () => {
    expect(mtf.symbol).toBe("BTCUSDT");
    expect(mtf.as_of_ms).toBe(nowSec * 1000);
    for (const [i, role] of (["macro", "context", "trigger"] as const).entries()) {
      const b = parts[i].bundle!;
      const c = mtf.components[i];
      expect(b.symbol).toBe("BTCUSDT");
      expect(b.timeframe).toBe(MTF_ROLE_TF[role]);
      expect(c.timeframe).toBe(MTF_ROLE_TF[role]);
      // knowable-at = close instant of the last closed bar = provenance.source_ts_ms
      expect(c.as_of_t).toBe(b.as_of_t);
      expect(c.knowable_at_ms).toBe((b.as_of_t! + STEP[b.timeframe]) * 1000);
      expect(c.knowable_at_ms).toBe(b.provenance.source_ts_ms);
      expect(c.knowable_at_ms!).toBeLessThanOrEqual(mtf.as_of_ms!);
      expect(c.input_fingerprint).toBe(b.provenance.input_fingerprint);
      expect(b.provenance.closed_bars_only).toBe(true);
      expect(b.provenance.stats_basis).toBe("LIVE_VENUE_SNAPSHOT");
      expect(b.provenance.engines.momentum).toBe("1.1.0");
    }
  });

  it("the fixture is a real ALIGNED case (so the consumer path below is exercised)", () => {
    expect(mtf.verdict).toBe("ALIGNED");
    expect(mtf.macro_bias).toBe("long");
  });

  it("chart overlay and decision consumer describe the SAME snapshot", () => {
    const trig = parts[2].bundle!;
    const overlay = buildChartOverlay(trig)!;
    expect(overlay.bundle_fingerprint).toBe(trig.provenance.input_fingerprint);
    expect(overlay.bundle_fingerprint).toBe(mtf.components[2].input_fingerprint);
    expect(overlay.as_of_t).toBe(trig.as_of_t);
    expect(overlay.freshness).toBe(trig.provenance.freshness);
  });

  it("the consumer output is time-truthful and names the analyzed timeframes", () => {
    const ev = evidenceFor(mtf, "1h");
    const r = heuristicAnalyze(ev);
    expect(r.data_timestamp).toBe(mtf.oldest_source_ts_ms);
    expect(r.data_timestamp).toBe(parts[0].bundle!.provenance.source_ts_ms); // 4h is the oldest close
    expect(r.summary).toContain("MTF 4h/1h/15m");
    expect(r.summary).toContain("requested 1h");
    expect(r.direction).toBe("long");
    expect(r.evidence.some((e) => e.includes(`fingerprint=${parts[2].bundle!.provenance.input_fingerprint}`))).toBe(true);
  });

  it("the LLM evidence carries tf / as-of / status / provenance for every technical value", () => {
    const s = serializeEvidence(evidenceFor(mtf)) as Record<string, any>;
    expect(s.requested_timeframe).toBe("1h");
    expect(s.analyzed_timeframes).toEqual({ macro: "4h", context: "1h", trigger: "15m" });
    expect(s.data_timestamp_ms).toBe(mtf.oldest_source_ts_ms);
    expect(s.mtf.as_of_ms).toBe(mtf.as_of_ms);
    expect(s.mtf.components.map((c: any) => c.knowable_at_ms)).toEqual(mtf.components.map((c) => c.knowable_at_ms));
    for (const k of ["macro", "context", "trigger"]) {
      const b = s[k];
      expect(typeof b.timeframe).toBe("string");
      expect(typeof b.as_of_t).toBe("number");
      expect(b.indicator_status.rsi14.state).toBe("OK");
      expect(b.provenance.input_fingerprint).toMatch(/^[0-9a-f]{14}$/);
      expect(b.provenance.closed_bars_only).toBe(true);
      expect(b.stats_basis).toBe("LIVE_VENUE_SNAPSHOT");
      expect(b.momentum.classification).toBe("OPEN_SPECIFICATION");
      expect(b.divergence.spec_status).toBe("PARTIAL");
      expect(b.divergence.note).toMatch(/not a reversal signal/);
      for (const f of b.structure.open_fvgs) expect(f.mitigated_index).toBeNull();
    }
    expect(nonFinitePaths(s)).toEqual([]);
  });

  it("the consumer never mutates the evidence (snapshot immutability at the consumer)", () => {
    const ev = evidenceFor(mtf);
    const before = structuredClone(ev);
    heuristicAnalyze(ev);
    serializeEvidence(ev);
    bundleSlice(ev.trigger);
    buildChartOverlay(ev.trigger);
    expect(ev).toEqual(before);
  });

  it("is deterministic end-to-end (same candles + same instant → identical outputs)", () => {
    const again = buildMtfAsOf("BTCUSDT", mtfSeries("BTCUSDT", nowSec), nowSec * 1000);
    const strip = (m: MtfResult) => JSON.stringify({ ...m, macro: m.macro?.provenance.input_fingerprint, context: m.context?.provenance.input_fingerprint, trigger: m.trigger?.provenance.input_fingerprint });
    expect(strip(again.mtf)).toBe(strip(mtf));
    expect(heuristicAnalyze(evidenceFor(again.mtf))).toEqual(heuristicAnalyze(evidenceFor(mtf)));
  });
});

/* ======================================= 2. HTF close-boundary causality */
describe("HTF close boundary (as-of causality)", () => {
  const at = (nowSec: number, fetchedSec = nowSec) => {
    const s = mtfSeries("BTCUSDT", fetchedSec);
    return buildMtfAsOf("BTCUSDT", s, nowSec * 1000);
  };
  const hhmm = (t: number | null) => (t === null ? null : new Date(t * 1000).toISOString().slice(11, 16));

  it("at 15:59:59 the 1h context is as-of 14:00 and the 15m trigger as-of 15:30", () => {
    const { mtf } = at(T16 - 1);
    const [m, c, t] = mtf.components;
    expect(hhmm(c.as_of_t)).toBe("14:00");
    expect(hhmm(t.as_of_t)).toBe("15:30");
    expect(hhmm(m.as_of_t)).toBe("08:00");
  });

  it("at 16:00:00 the 15:45 15m bar AND the 15:00 1h bar are both closed", () => {
    const { mtf } = at(T16);
    const [m, c, t] = mtf.components;
    expect(hhmm(c.as_of_t)).toBe("15:00");
    expect(hhmm(t.as_of_t)).toBe("15:45");
    expect(hhmm(m.as_of_t)).toBe("12:00");
    for (const x of mtf.components) expect(x.knowable_at_ms).toBe(T16 * 1000);
  });

  it("a series fetched LATER cannot leak into an earlier as-of (no lookahead from stored data)", () => {
    const { mtf } = at(T16 - 1, T16 + 3600); // data observed at 17:00, evaluated at 15:59:59
    expect(hhmm(mtf.components[1].as_of_t)).toBe("14:00");
    expect(hhmm(mtf.components[2].as_of_t)).toBe("15:30");
  });

  it("pre-built bundles knowable only after the evaluation instant are refused (AFTER_AS_OF)", () => {
    const late = at(T16).mtf; // components knowable at 16:00:00
    const m = buildMtf(late.macro, late.context, late.trigger, T16 * 1000 - 1);
    expect(m.verdict).toBe("UNAVAILABLE");
    expect(m.components.every((c) => c.state === "AFTER_AS_OF")).toBe(true);
    expect(m.reason).toMatch(/lookahead refused/);
    // exactly at the close instant they ARE knowable
    expect(buildMtf(late.macro, late.context, late.trigger, T16 * 1000).verdict).toBe("ALIGNED");
  });
});

/* ================================ 3. symbol / timeframe isolation */
describe("symbol / timeframe cross-contamination", () => {
  const nowSec = T16 + 60;
  const btc = buildMtfAsOf("BTCUSDT", mtfSeries("BTCUSDT", nowSec), nowSec * 1000).mtf;
  const eth = buildMtfAsOf("ETHUSDT", mtfSeries("ETHUSDT", nowSec), nowSec * 1000).mtf;

  it("a cross-symbol MTF is UNAVAILABLE and exposes NO bias at all", () => {
    const mixed = buildMtf(btc.macro, btc.context, eth.trigger, nowSec * 1000);
    expect(mixed.verdict).toBe("UNAVAILABLE");
    expect(mixed.symbol).toBeNull();
    expect([mixed.macro_bias, mixed.context_bias, mixed.trigger_bias]).toEqual([null, null, null]);
    // absolute-final: UNAVAILABLE evidence → "unavailable" (was "neutral":
    // unavailable is not a neutral stance); never long/short
    expect(heuristicAnalyze(evidenceFor(mixed)).direction).toBe("unavailable");
  });

  it("a bundle in the wrong role is a MISMATCH, never analysed", () => {
    const m = buildMtf(btc.macro, btc.trigger, btc.trigger, nowSec * 1000);
    expect(m.components[1].state).toBe("MISMATCH");
    expect(m.verdict).toBe("UNAVAILABLE");
  });

  it("a series stored under another identity is refused at the input boundary", () => {
    const s = venueSeries("ETHUSDT", "1h", nowSec);
    const i1 = prepareAnalysisInput("BTCUSDT", "1h", s, nowSec * 1000);
    expect(i1.reason_code).toBe("IDENTITY_MISMATCH");
    expect(buildBundleFromInput(i1)).toBeNull();
    const i2 = prepareAnalysisInput("ETHUSDT", "4h", s, nowSec * 1000);
    expect(i2.reason_code).toBe("IDENTITY_MISMATCH");
    // Task 10: a distinct class (served as HTTP 500), no longer folded into INTERNAL_ERROR
    expect(inputErrorClass(i1, null)).toBe("IDENTITY_MISMATCH");
  });

  it("identical candles under different symbols/timeframes have different fingerprints", () => {
    expect(btc.trigger!.provenance.input_fingerprint).not.toBe(eth.trigger!.provenance.input_fingerprint);
    const c = btc.trigger!;
    const series = venueSeries("BTCUSDT", "15m", nowSec).candles.slice(0, -1);
    expect(bundleInputFingerprint("BTCUSDT", "15m", series, "x")).not.toBe(bundleInputFingerprint("BTCUSDT", "1h", series, "x"));
    // one changed field → different snapshot identity
    const tweaked = series.map((k, i) => (i === 10 ? { ...k, v: k.v + 1 } : k));
    expect(bundleInputFingerprint("BTCUSDT", "15m", tweaked, "x")).not.toBe(bundleInputFingerprint("BTCUSDT", "15m", series, "x"));
    expect(c.provenance.input_fingerprint).toMatch(/^[0-9a-f]{14}$/);
  });

  it("interleaved evaluation leaves no shared state (BTC → ETH → BTC identical)", () => {
    const again = buildMtfAsOf("BTCUSDT", mtfSeries("BTCUSDT", nowSec), nowSec * 1000).mtf;
    expect(again.components).toEqual(btc.components);
    expect(again.trigger!.indicators).toEqual(btc.trigger!.indicators);
  });
});

/* ============================================ 4. adversarial fixtures */
describe("adversarial market data", () => {
  const nowSec = T16 + 60;
  const base = () => venueSeries("BTCUSDT", "1h", nowSec, 90);
  const withCandles = (candles: Candle[]): CandleSeries => ({ ...base(), candles });
  const analyse = (s: CandleSeries) => {
    const input = prepareAnalysisInput("BTCUSDT", "1h", s, nowSec * 1000);
    return { input, bundle: buildBundleFromInput(input, undefined, nowSec * 1000) };
  };
  const closedPart = () => base().candles.slice(0, -1);

  it("duplicate timestamp → INVALID_SERIES, no bundle, INVALID_SOURCE_DATA", () => {
    const c = base().candles;
    c.splice(40, 0, { ...c[40] });
    const { input, bundle } = analyse(withCandles(c));
    expect(input.reason_code).toBe("INVALID_SERIES");
    expect(input.reason).toMatch(/duplicate open time/);
    expect(bundle).toBeNull();
    expect(inputErrorClass(input, null)).toBe("INVALID_SOURCE_DATA");
  });

  it("out-of-order timestamp (a forming bar hidden mid-array) → refused, never analysed", () => {
    const c = base().candles;
    const forming = c[c.length - 1];
    const reordered = [...c.slice(0, 50), forming, ...c.slice(50, -1)];
    const { input, bundle } = analyse(withCandles(reordered));
    expect(input.reason_code).toBe("INVALID_SERIES");
    expect(input.reason).toMatch(/out-of-order/);
    expect(bundle).toBeNull();
  });

  it("non-finite open time → refused", () => {
    const c = base().candles;
    c[20] = { ...c[20], t: Number.NaN };
    expect(timestampViolation(c)).toMatch(/non-finite open time at index 20/);
    expect(analyse(withCandles(c)).input.reason_code).toBe("INVALID_SERIES");
  });

  it.each([
    ["NaN close", (k: Candle) => ({ ...k, c: Number.NaN })],
    ["Infinity high", (k: Candle) => ({ ...k, h: Number.POSITIVE_INFINITY })],
  ])("%s mid-window → refused at the boundary; engine layer still null + UNDEFINED, no non-finite leak", (_n, corrupt) => {
    const c = base().candles;
    c[45] = corrupt(c[45]);
    // Team 02 absolute-final: the canonical input boundary now applies the
    // venue normaliser's bar rules (analysis/input barViolation) → refused.
    const refused = analyse(withCandles(c));
    expect(refused.input.reason_code).toBe("INVALID_SERIES");
    expect(refused.input.reason).toMatch(/non-finite or missing/);
    expect(refused.bundle).toBeNull();
    // defense in depth: the engine itself, fed the corrupt window directly,
    // still degrades to null + UNDEFINED with no non-finite leak.
    const bundle: ReturnType<typeof buildBundleFromInput> = buildBundleArtifacts({ symbol: "BTCUSDT", timeframe: "1h", candles: c.slice(0, -1), nowMs: nowSec * 1000 }).bundle;
    expect(bundle).not.toBeNull();
    expect(bundle!.indicators.rsi14 === null || _n === "Infinity high").toBe(true);
    expect(bundle!.indicators.atr14).toBeNull();
    expect(bundle!.indicator_status.atr14.state).toBe("UNDEFINED");
    expect(nonFinitePaths(bundle)).toEqual([]);
    expect(nonFinitePaths(buildChartOverlay(bundle))).toEqual([]);
  });

  it("detectors report UNAVAILABLE on a non-finite price anywhere in the window (DET-3)", () => {
    const c = closedPart();
    c[45] = { ...c[45], c: Number.NaN };
    const feats = [
      detectRSI(c, "1h"), detectEMA(c, "1h", 20), detectATR(c, "1h"), detectAnatomy(c, "1h"), detectPinbar(c, "1h"),
      detectSwings(c, "1h"), detectMomentumCandle(c, "1h"), detectLevels(c, "1h"), detectRejectionAt(c, "1h", 100, "support"),
      detectStructureBias(c, "1h"), detectVolatilityRegime(c, "1h"),
    ];
    for (const f of feats) {
      expect(f.valid, f.feature_id).toBe(false);
      expect(f.data_quality, f.feature_id).toBe("UNAVAILABLE");
      expect(f.reason, f.feature_id).toMatch(/non-finite/);
    }
    // a LAST-bar NaN used to yield a "valid" anatomy with NaN ratios
    const d = closedPart();
    d[d.length - 1] = { ...d[d.length - 1], o: Number.NaN };
    expect(detectAnatomy(d, "1h").valid).toBe(false);
  });

  it("missing volume: refused at the boundary; engine layer only disables volume fields", () => {
    const c = base().candles.map((k) => ({ ...k, v: Number.NaN }));
    const refused = analyse(withCandles(c));
    expect(refused.input.reason_code).toBe("INVALID_SERIES");
    expect(refused.input.reason).toMatch(/non-finite or missing v/);
    expect(refused.bundle).toBeNull();
    // defense in depth (engine fed directly): price evidence stays valid
    const bundle: ReturnType<typeof buildBundleFromInput> = buildBundleArtifacts({ symbol: "BTCUSDT", timeframe: "1h", candles: c.slice(0, -1), nowMs: nowSec * 1000 }).bundle;
    expect(bundle!.indicators.volume_avg20).toBeNull();
    expect(bundle!.indicator_status.volume_avg20.state).toBe("UNDEFINED");
    expect(bundle!.indicator_status.last_volume_ratio.state).toBe("UNDEFINED");
    expect(bundle!.indicators.rsi14).not.toBeNull();
    expect(detectRSI(c.slice(0, -1), "1h").valid).toBe(true);
    expect(nonFinitePaths(bundle)).toEqual([]);
  });

  it("flat and monotonic series: finite-or-null everywhere, no invented structure", () => {
    for (const closes of [Array(90).fill(100), Array.from({ length: 90 }, (_, i) => 100 + i)]) {
      const { bundle } = analyse(venueSeries("BTCUSDT", "1h", nowSec, 90, closes));
      expect(nonFinitePaths(bundle)).toEqual([]);
      expect(bundle!.structure.swing_points).toEqual([]);
      expect(bundle!.structure.trend).toBe("undetermined");
      expect(bundle!.momentum.last_leg).toBeNull();
    }
  });

  it("spike / crash / gap: no fabricated bars, finite-or-null outputs", () => {
    const spike = uptrend(90).map((c, i) => (i === 60 ? c * 3 : c));
    const crash = uptrend(90).map((c, i) => (i > 60 ? c * 0.4 : c));
    for (const closes of [spike, crash]) expect(nonFinitePaths(analyse(venueSeries("BTCUSDT", "1h", nowSec, 90, closes)).bundle)).toEqual([]);
    const gapped = base().candles.filter((_, i) => i < 30 || i > 40);
    const { input, bundle } = analyse(withCandles(gapped));
    expect(input.reason_code).toBe("OK");
    expect(bundle!.bars).toBe(gapped.length - 1); // forming bar excluded, nothing filled in
  });

  it("short history: warmup is INSUFFICIENT_HISTORY (never a 0/neutral value)", () => {
    const { bundle } = analyse(venueSeries("BTCUSDT", "1h", nowSec, 12));
    expect(bundle!.indicators.rsi14).toBeNull();
    expect(bundle!.indicator_status.rsi14.state).toBe("INSUFFICIENT_HISTORY");
    const warm = insufficientHistory(bundle!);
    expect(warm).toEqual(expect.arrayContaining(["ema20", "ema50", "rsi14", "atr14", "structure"]));
    expect(bundle!.structure.trend).toBe("undetermined");
  });

  it("late response / stale cache: the bar that closed after observation is excluded; a stopped source is STALE", () => {
    // observed at 16:00:30 (1h bar 16:00 forming); evaluated at 17:00:10
    const observed = venueSeries("BTCUSDT", "1h", T16 + 30);
    const input = prepareAnalysisInput("BTCUSDT", "1h", observed, (T16 + 3610) * 1000);
    expect(input.last_closed_open_ts).toBe(T16 - 3600); // 15:00, NOT the mid-bar 16:00 snapshot
    // a series whose last closed bar ended long ago is STALE → MTF STALE → consumer "unavailable"
    // (absolute-final: was "neutral"; stale evidence supports no stance at all)
    const old = T16 - 10 * 3600;
    const s = { macro: venueSeries("BTCUSDT", "4h", T16), context: { ...venueSeries("BTCUSDT", "1h", old), fetched_at_ms: T16 * 1000 }, trigger: venueSeries("BTCUSDT", "15m", T16) };
    const { mtf } = buildMtfAsOf("BTCUSDT", s, T16 * 1000);
    expect(mtf.components[1].freshness).toBe("STALE");
    expect(mtf.verdict).toBe("STALE");
    expect(heuristicAnalyze(evidenceFor(mtf)).direction).toBe("unavailable");
    expect(heuristicAnalyze(evidenceFor(mtf)).score).toBeNull();
  });

  it("detector values are the value AT the decision bar (DET-1 property)", () => {
    const c = closedPart();
    const closes = c.map((k) => k.c);
    expect(detectRSI(c, "1h").value).toBe(rsi(closes, 14)[c.length - 1]);
    expect(detectEMA(c, "1h", 20).value).toBe(ema(closes, 20)[c.length - 1]);
    expect(detectATR(c, "1h").value).toBe(atr(c, 14)[c.length - 1]);
    expect(detectRSI(c, "1h").timestamp).toBe(c[c.length - 1].t);
  });
});

/* ======================================= 5. AI consumer semantics */
describe("AI consumer semantics (no inference beyond the contract)", () => {
  const nowSec = T16 + 60;
  const { mtf } = buildMtfAsOf("BTCUSDT", mtfSeries("BTCUSDT", nowSec), nowSec * 1000);

  it("unavailable / null bias never becomes a direction", () => {
    const forged = { ...mtf, verdict: "ALIGNED", macro_bias: null } as MtfResult;
    expect(heuristicAnalyze(evidenceFor(forged)).direction).toBe("neutral");
    const partial = { ...mtf, verdict: "PARTIAL" } as MtfResult;
    expect(heuristicAnalyze(evidenceFor(partial)).direction).toBe("neutral");
  });

  it("historical (mitigated) FVGs are never presented as current annotations", () => {
    const trig = mtf.trigger!;
    const fvgs = [
      { direction: "up" as const, top: 110, bottom: 109, t: trig.as_of_t! - 900 * 5, index: 1, origin_t: 0, mitigated_index: 3, mitigated_t: 1 },
      { direction: "down" as const, top: 120, bottom: 119, t: trig.as_of_t! - 900 * 2, index: 2, origin_t: 0, mitigated_index: null, mitigated_t: null },
    ];
    const b: AnalysisBundle = { ...trig, structure: { ...trig.structure, fvgs } };
    const r = heuristicAnalyze({ ...evidenceFor(mtf), trigger: b });
    expect(r.annotations.map((a) => a.price)).toEqual([119]);
  });

  it("invalidation is a factual structural reference, not a position-relative claim", () => {
    const trig = mtf.trigger!;
    const choch = { kind: "CHOCH" as const, direction: "down" as const, price: 123.45, index: 5, t: trig.as_of_t! - 900 * 3, close: 123, broken_swing_index: 2, broken_swing_t: 0, prior_trend: "up" as const };
    const b: AnalysisBundle = { ...trig, structure: { ...trig.structure, last_choch: choch } };
    const r = heuristicAnalyze({ ...evidenceFor(mtf), trigger: b });
    expect(r.invalidation).toMatch(/structural reference: last 15m CHoCH down broke 123\.45/);
    expect(r.invalidation).toMatch(/not a position-relative stop/);
    expect(r.invalidation).not.toMatch(/against position/);
  });

  it("an LLM reply is stamped with the evidence time, never the reply time", () => {
    const r = coerceAiResponse({ direction: "neutral", summary: "s" }, "openai", "m", 5, "neutral", 1_234_000);
    expect(r!.data_timestamp).toBe(1_234_000);
    expect(coerceAiResponse({ summary: "s" }, "openai", "m", 5, "neutral")!.data_timestamp).toBeNull();
  });

  it("score provenance: heuristic constants are ENGINEERING_DEFINED; unscored verdicts are null, never 0; no fake confidence (release-gate)", () => {
    const aligned = heuristicAnalyze(evidenceFor({ ...mtf, verdict: "ALIGNED" } as MtfResult));
    expect(aligned.score).toBe(HEURISTIC_SCORE_BY_VERDICT.ALIGNED);
    expect(aligned.semantics.score_provenance).toBe("ENGINEERING_DEFINED_UNCALIBRATED");
    expect(aligned.confidence).toBeNull();
    expect(aligned.semantics.confidence_provenance).toBe("NOT_PRODUCED");
    for (const v of ["INSUFFICIENT", "STALE", "UNAVAILABLE"] as const) {
      const r = heuristicAnalyze(evidenceFor({ ...mtf, verdict: v } as MtfResult));
      expect(r.score).toBeNull();
      expect(r.semantics.score_provenance).toBe("NOT_PRODUCED");
      expect(r.semantics.score_basis).toContain(v);
      expect(r.setup_quality).toBe("none");
    }
  });

  it("an LLM that omits score/confidence gets null — never a substituted 50, never score←confidence (release-gate)", () => {
    const r = coerceAiResponse({ direction: "long", summary: "s", confidence: 80 }, "openai", "m", 5, "neutral")!;
    expect(r.score).toBeNull();
    expect(r.confidence).toBe(80);
    expect(r.semantics.score_provenance).toBe("NOT_PRODUCED");
    expect(r.semantics.confidence_provenance).toBe("PROVIDER_SELF_REPORTED_UNCALIBRATED");
    expect(r.missing_data.some((m) => m.includes("score not provided"))).toBe(true);
    const bare = coerceAiResponse({ summary: "s", score: "n/a" }, "openai", "m", 5, "neutral")!;
    expect(bare.score).toBeNull();
    expect(bare.confidence).toBeNull();
  });

  it("FACTUAL evidence is engine-generated and provider-independent; provider text is labelled interpretation (release-gate)", () => {
    const ev = evidenceFor(mtf);
    const h = heuristicAnalyze(ev);
    expect(h.factual_evidence).toEqual(factualEvidence(ev));
    expect(h.semantics.evidence_origin).toBe("ENGINE");
    const llm = coerceAiResponse({ summary: "s", evidence: ["the model says RSI is 99"] }, "openai", "m", 5, "neutral")!;
    expect(llm.semantics.evidence_origin).toBe("PROVIDER_INTERPRETATION");
    expect(llm.factual_evidence).toEqual([]); // filled only by runAi from the engine, never from the provider
    expect(llm.semantics.interpretation_fields).toContain("evidence");
    expect(llm.semantics.factual_fields).toContain("factual_evidence");
    expect(factualEvidence(ev).some((e) => e.includes(`fingerprint=${mtf.trigger!.provenance.input_fingerprint}`))).toBe(true);
  });
});

/* ================================== 6. momentum semantics (source) */
describe("momentum: last-leg slope AND step size, no invented classification", () => {
  const sw = (index: number, price: number, kind: "high" | "low"): SwingPoint => ({ index, t: index * 60, price, kind, confirmed_index: index + 2, confirmed_t: (index + 2) * 60 });
  const candles = Array.from({ length: 40 }, (_, i) => ({ t: i * 60, o: 100, h: 101, l: 99, c: 100, v: 1 }));

  it("size ratios compare |change| of the last leg with the previous and prior same-direction legs", () => {
    // legs: 0→10 up +10 (10 bars), 10→20 down −4, 20→25 up +12 (5 bars)
    const swings = [sw(0, 100, "low"), sw(10, 110, "high"), sw(20, 106, "low"), sw(25, 118, "high")];
    const m = legMomentum(candles, swings, candles.map(() => 1));
    expect(m.last_leg!.change).toBe(12);
    expect(m.last_vs_previous_size_ratio).toBe(12 / 4);
    expect(m.last_vs_prior_same_direction_size_ratio).toBe(12 / 10);
    expect(m.last_vs_prior_same_direction_slope_ratio).toBe((12 / 5) / (10 / 10));
    expect(m.classification).toBe("OPEN_SPECIFICATION");
    expect(Object.keys(m)).not.toContain("strength");
  });

  it("fewer than 3 legs → prior same-direction ratios are null (never 0/1 sentinels)", () => {
    const m = legMomentum(candles, [sw(0, 100, "low"), sw(10, 110, "high"), sw(20, 106, "low")], candles.map(() => 1));
    expect(m.last_vs_prior_same_direction_size_ratio).toBeNull();
    expect(m.last_vs_previous_size_ratio).toBe(4 / 10);
  });
});

/* ======================================= 7. API error semantics */
describe("API error classes", () => {
  const nowSec = T16 + 60;
  it("maps every input reason code to one machine-readable class", () => {
    const ok = prepareAnalysisInput("BTCUSDT", "1h", venueSeries("BTCUSDT", "1h", nowSec), nowSec * 1000);
    expect(ok.reason_code).toBe("OK");
    expect(inputErrorClass(ok, null)).toBeNull();
    expect(inputErrorClass(ok, "HTTP 503")).toBe("UPSTREAM_FAILURE");
    const none = prepareAnalysisInput("BTCUSDT", "1h", null, nowSec * 1000);
    expect([none.reason_code, inputErrorClass(none, null)]).toEqual(["SERIES_UNAVAILABLE", "NO_DATA"]);
    const bad = prepareAnalysisInput("BTCUSDT", "7x", { ...venueSeries("BTCUSDT", "1h", nowSec), timeframe: "7x" }, nowSec * 1000);
    expect([bad.reason_code, inputErrorClass(bad, null)]).toEqual(["UNSUPPORTED_TIMEFRAME", "INVALID_REQUEST"]);
    const formingOnly = { ...venueSeries("BTCUSDT", "1h", nowSec), candles: venueSeries("BTCUSDT", "1h", nowSec).candles.slice(-1) };
    const nc = prepareAnalysisInput("BTCUSDT", "1h", formingOnly, nowSec * 1000);
    expect([nc.reason_code, inputErrorClass(nc, null)]).toEqual(["NO_CLOSED_BARS", "NO_DATA"]);
  });
  it("internal errors are typed and leak no stack", () => {
    const b = internalErrorBody(new Error("boom"));
    expect(b).toEqual({ ok: false, error_class: "INTERNAL_ERROR", error: "boom" });
  });
  it("a bundle built without the input contract still has provenance identity but UNAVAILABLE freshness", () => {
    const b = buildBundle({ symbol: "BTCUSDT", timeframe: "1h", candles: venueSeries("BTCUSDT", "1h", nowSec).candles.slice(0, -1), nowMs: 0 });
    expect(b.provenance.freshness).toBe("UNAVAILABLE");
    expect(b.provenance.closed_bars_only).toBe(false);
    expect(b.provenance.input_fingerprint).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe("AI evidence text keeps price precision", () => {
  it("sub-cent prices are never rendered as 0.00", () => {
    const nowSec = T16 + 60;
    const closes = uptrend(90).map((c) => c * 1e-6);
    const s = { macro: venueSeries("PEPEUSDT", "4h", nowSec, 90, closes), context: venueSeries("PEPEUSDT", "1h", nowSec, 90, closes), trigger: venueSeries("PEPEUSDT", "15m", nowSec, 90, closes) };
    const { mtf } = buildMtfAsOf("PEPEUSDT", s, nowSec * 1000);
    const r = heuristicAnalyze(evidenceFor(mtf));
    const line = r.evidence.find((e) => e.startsWith("rsi14="))!;
    expect(line).not.toMatch(/ema20=0\.00\b/);
    expect(line).toMatch(/ema20=0\.000\d+/);
  });
});

describe("chart evidence image keeps price precision (Telegram / charts consumer)", () => {
  it("a sub-cent annotation price is printed with significant digits, never 0.0000", async () => {
    const { renderEvidenceSvg } = await import("../src/lib/chart/render");
    const candles = candlesFrom(uptrend(40).map((c) => c * 1e-7), 3600, T16);
    const price = candles[30].c;
    const svg = renderEvidenceSvg({
      symbol: "PEPEUSDT", timeframe: "1h", strategy_id: "S", setup_id: "X", direction: "long", bar_time: candles[39].t,
      annotations: [{ annotation_id: "a", kind: "level" as never, label: "L", price, produced_by: { type: "feature", id: "FTR-LEVELS" }, source_refs: [], detector_version: "1.1.0", evidence_kind: "DERIVED" }],
      rules: [], score: null, score_semantics: "", assumptions: [], lineage_complete: true,
    }, candles);
    expect(svg).not.toMatch(/L 0\.0000 \[/);
    expect(svg).toContain(`L ${String(Number(price.toPrecision(6)))} [DERIVED]`);
  });
});
