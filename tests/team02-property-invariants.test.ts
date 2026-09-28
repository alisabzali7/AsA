/**
 * Team 02 absolute-final: PROPERTY INVARIANTS 1–17 over a deterministic
 * family of generated series (seeded LCG in the TEST only — production code
 * has no randomness). Each property is checked on every generated case.
 *
 *  1 no NaN/Infinity anywhere in bundle / series / overlay / MTF / AI output
 *  2 no future bars: every bar used closed at or before the evaluation instant
 *  3 deterministic: same input + same instant ⇒ identical bundle + fingerprint
 *  4 identity: a different symbol / timeframe / bar / engine set ⇒ a different fingerprint
 *  5 fingerprint mismatch ⇒ no render (adapter gate + snapshot check + Telegram policy)
 *  6 UNKNOWN ≠ valid: a feature that is not valid never lets a rule PASS or FAIL
 *  7 UNAVAILABLE ≠ neutral: unavailable MTF evidence has null biases, null score, direction "unavailable"
 *  8 forming ≠ closed: the forming bar never enters the closed window
 *  9 historical ≠ active: every overlay zone is HISTORICAL_ONLY; the adapter refuses anything else
 * 10 no frontend analysis (structural proof: tests/team02-import-topology.test.ts)
 * 11 serialization round-trip preserves the bundle and its fingerprint
 * 12 knowable-at ordering: source_ts_ms = (as_of_t + period)·1000 ≤ evaluation instant
 * 13 an MTF component is never newer than the evaluation instant
 * 14 a cross-symbol MTF fails closed (UNAVAILABLE, no bias)
 * 15 a wrong-timeframe MTF role fails closed
 * 16 price precision: sub-cent prices keep significant digits in chart format + labels
 * 17 AI score provenance is explicit: never "calibrated"
 */
import { describe, expect, it } from "vitest";
import type { Candle, CandleSeries } from "../src/lib/domain/types";
import { prepareAnalysisInput } from "../src/lib/analysis/input";
import { buildArtifactsFromInput, bundleInputFingerprint } from "../src/lib/analysis/bundle";
import { buildMtf, buildMtfAsOf, type MtfResult } from "../src/lib/analysis/mtf";
import { buildChartOverlay, type ChartOverlay } from "../src/lib/chart/technical";
import { gateAnalysis, overlayToRender, decimalsFor, priceFormatFor } from "../src/lib/chart/adapter";
import { verifyDecisionSnapshot, decisionSnapshot } from "../src/lib/chart/evidence";
import { evaluateRule, type RuleDefinition } from "../src/lib/rules/engine";
import { invalidFeature, okFeature } from "../src/lib/features/types";
import { heuristicAnalyze, serializeEvidence, type AiEvidence } from "../src/lib/ai/index";
import { formatPrice } from "../src/components/hooks";
import type { PsychologySummary } from "../src/lib/psychology/engine";

const PERIOD: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400 };
const NOW_SEC = 1_790_006_400 + 7 * 60; // 7 min into a 15m/1h/4h bar

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** venue-shaped series ending with the forming bar; prices a function of the open time */
function gen(seed: number, symbol: string, tf: string, n: number, scale = 100): CandleSeries {
  const rnd = lcg(seed);
  const step = PERIOD[tf];
  const formingOpen = Math.floor(NOW_SEC / step) * step;
  const shape = Math.floor(rnd() * 4);
  const candles: Candle[] = [];
  let prev = scale;
  for (let i = 0; i <= n; i++) {
    const t = formingOpen - (n - i) * step;
    const drift = shape === 0 ? 0 : shape === 1 ? 0.002 : shape === 2 ? -0.002 : 0.01 * Math.sin(i / 7);
    const c = Math.max(scale * 0.01, prev * (1 + drift + (rnd() - 0.5) * 0.02));
    const o = prev;
    candles.push({ t, o, h: Math.max(o, c) * (1 + rnd() * 0.004), l: Math.min(o, c) * (1 - rnd() * 0.004), c, v: Math.floor(rnd() * 1000) });
    prev = c;
  }
  return { symbol, timeframe: tf, candles, native: true, source: "ttt" as CandleSeries["source"], fetched_at_ms: NOW_SEC * 1000 };
}

function nonFinitePaths(v: unknown, p = "$", out: string[] = []): string[] {
  if (typeof v === "number") { if (!Number.isFinite(v)) out.push(p); }
  else if (Array.isArray(v)) v.forEach((x, i) => nonFinitePaths(x, `${p}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) nonFinitePaths(x, `${p}.${k}`, out);
  return out;
}

const psych = { symbol: "PROPUSDT", generated_at_ms: 0, bias: "neutral", bias_reason: "fixture", sections: [], universe_funding: { measured: 0, total: 0, mean: null, max_abs: null, timestamp_ms: null } } as unknown as PsychologySummary;
function aiEvidence(mtf: MtfResult): AiEvidence {
  return {
    symbol: mtf.symbol ?? "PROPUSDT", timeframe: "1h", mtf, macro: mtf.macro, context: mtf.context, trigger: mtf.trigger,
    psychology: psych, risk: null, strategy: null, fundamental: null, data_timestamp: mtf.oldest_source_ts_ms ?? null,
    window: mtf.trigger?.candle_window ?? { t_min: 0, t_max: 0, price_min: 0, price_max: 0 },
  };
}

const CASES = Array.from({ length: 24 }, (_, k) => ({
  seed: 1000 + k,
  tf: (["15m", "1h", "4h"] as const)[k % 3],
  n: [1, 5, 30, 60, 120, 250, 400, 90][k % 8],
  scale: [100, 0.000123, 65000, 1.2345][k % 4],
}));

describe.each(CASES)("generated case seed=$seed tf=$tf n=$n scale=$scale", ({ seed, tf, n, scale }) => {
  const s = gen(seed, "PROPUSDT", tf, n, scale);
  const nowMs = NOW_SEC * 1000;
  const input = prepareAnalysisInput("PROPUSDT", tf, s, nowMs);
  const art = buildArtifactsFromInput(input, undefined, nowMs);
  const step = PERIOD[tf];

  it("P1 finite everywhere · P8 forming excluded · P2/P12 causal ordering", () => {
    expect(input.reason_code).toBe("OK");
    expect(art).not.toBeNull();
    const overlay = buildChartOverlay(art!.bundle, art!.series);
    expect(nonFinitePaths(art!.bundle)).toEqual([]);
    expect(nonFinitePaths(art!.series)).toEqual([]);
    expect(nonFinitePaths(overlay)).toEqual([]);
    // P8
    expect(input.forming_bar_excluded).toBe(true);
    expect(input.candles.some((k) => k.t === s.candles[s.candles.length - 1].t)).toBe(false);
    // P2
    for (const k of input.candles) expect((k.t + step) * 1000).toBeLessThanOrEqual(nowMs);
    // P12
    expect(art!.bundle.provenance.source_ts_ms).toBe((art!.bundle.as_of_t! + step) * 1000);
    expect(art!.bundle.provenance.source_ts_ms!).toBeLessThanOrEqual(nowMs);
  });

  it("P3 determinism · P11 round-trip", () => {
    const again = buildArtifactsFromInput(prepareAnalysisInput("PROPUSDT", tf, gen(seed, "PROPUSDT", tf, n, scale), nowMs), undefined, nowMs)!;
    expect(again.bundle).toEqual(art!.bundle);
    const rt = JSON.parse(JSON.stringify(art!.bundle));
    expect(rt).toEqual(art!.bundle);
    const eng = Object.values(art!.bundle.provenance.engines).join("/");
    expect(bundleInputFingerprint(rt.symbol, rt.timeframe, input.candles, eng)).toBe(rt.provenance.input_fingerprint);
  });

  it("P4 identity differences change the fingerprint", () => {
    const eng = Object.values(art!.bundle.provenance.engines).join("/");
    const fp = art!.bundle.provenance.input_fingerprint;
    expect(bundleInputFingerprint("OTHERUSDT", tf, input.candles, eng)).not.toBe(fp);
    expect(bundleInputFingerprint("PROPUSDT", tf === "1h" ? "4h" : "1h", input.candles, eng)).not.toBe(fp);
    expect(bundleInputFingerprint("PROPUSDT", tf, input.candles, `${eng}+1`)).not.toBe(fp);
    const revised = input.candles.map((k, i) => (i === input.candles.length - 1 ? { ...k, c: k.c * (1 + 1e-9) } : k));
    expect(bundleInputFingerprint("PROPUSDT", tf, revised, eng)).not.toBe(fp);
  });

  it("P5 mismatch ⇒ no render · P9 zones historical only", () => {
    const overlay = buildChartOverlay(art!.bundle, art!.series)!;
    // adapter gate: a foreign fingerprint is dropped, never drawn
    const forged = { ...overlay, bundle_fingerprint: "ffffffffffffff" };
    expect(gateAnalysis({ bundle: art!.bundle, overlay: forged }, "PROPUSDT", tf).overlay).toBeNull();
    expect(gateAnalysis({ bundle: art!.bundle, overlay: forged }, "PROPUSDT", tf).overlayGate).toBe("FINGERPRINT_MISMATCH");
    expect(gateAnalysis({ bundle: art!.bundle, overlay }, "OTHERUSDT", tf).bundle).toBeNull();
    // P9
    for (const z of overlay.zones) expect(z.status).toBe("HISTORICAL_ONLY");
    const times = new Set(input.candles.map((k) => k.t));
    const claimed = { ...overlay, zones: overlay.zones.map((z) => ({ ...z, status: "ACTIVE" as never })) } as ChartOverlay;
    const r = overlayToRender(claimed, times);
    expect(r.lineSeries.some((l) => l.id.startsWith("fvg:") || l.id.startsWith("ob:"))).toBe(false);
    if (overlay.zones.length) expect(r.unplaced.some((u) => /not HISTORICAL_ONLY/.test(u.reason))).toBe(true);
  });
});

describe("P5 snapshot verification: a revised bar is MISMATCH (never rendered as the decision window)", () => {
  it("decision snapshot verifies; one revised bar → MISMATCH; missing → UNVERIFIABLE; none → LEGACY", () => {
    const s = gen(7, "PROPUSDT", "1h", 120);
    const closed = s.candles.slice(0, -1);
    const snap = decisionSnapshot("PROPUSDT", "1h", closed, (closed[closed.length - 1].t + 3600) * 1000, "e/1")!;
    const ev = { symbol: "PROPUSDT", timeframe: "1h", snapshot: snap };
    expect(verifyDecisionSnapshot(ev, s.candles).state).toBe("VERIFIED");
    const revised = s.candles.map((k, i) => (i === 50 ? { ...k, c: k.c * 1.0001, h: Math.max(k.h, k.c * 1.0001) } : k));
    expect(verifyDecisionSnapshot(ev, revised).state).toBe("MISMATCH");
    expect(verifyDecisionSnapshot(ev, s.candles.slice(0, 60)).state).toBe("UNVERIFIABLE");
    expect(verifyDecisionSnapshot({ ...ev, snapshot: undefined as never }, s.candles).state).toBe("UNVERIFIABLE_LEGACY_RECORD");
  });
});

describe("P6 UNKNOWN ≠ valid (feature states → rule outcomes)", () => {
  const rule: RuleDefinition = {
    id: "PROP-RULE", description: "x", source_text: "", source_refs: [], source_status: "SOURCE_VERIFIED" as never, empirical_status: "UNTESTED" as never,
    feature_dependencies: ["F"], operator: "AND", timeframe: "1h", direction: "both", kind: "trigger", unresolved: [], version: "t",
    predicates: [{ expr: "F != null", requires: ["F"], test: (bag) => ({ ok: bag.get("F")!.value !== null, detail: "" }) }],
  };
  const run = (f: ReturnType<typeof okFeature>) => evaluateRule(rule, new Map([["F", f]]) as never, 0).outcome;
  it("UNDEFINED_ON_DATA and UNAVAILABLE → UNKNOWN; ABSENT → a real FAIL; VALUE → PASS", () => {
    const undef = invalidFeature<number>("F", "1h", "OK", "zero-range candle", "t");
    const unav = invalidFeature<number>("F", "1h", "INSUFFICIENT_BARS", "warmup", "t");
    const absent = okFeature<number | null>("F", "1h", null, 1, 1, "t", []);
    const value = okFeature<number | null>("F", "1h", 5, 1, 1, "t", []);
    expect([undef.state, unav.state, absent.state, value.state]).toEqual(["UNDEFINED_ON_DATA", "UNAVAILABLE", "ABSENT", "VALUE"]);
    expect(run(undef as never)).toBe("UNKNOWN");
    expect(run(unav as never)).toBe("UNKNOWN");
    expect(run(absent as never)).toBe("FAIL");
    expect(run(value as never)).toBe("PASS");
  });
});

describe("MTF properties", () => {
  const nowMs = NOW_SEC * 1000;
  const mtfOf = (sym: string, seed: number) => buildMtfAsOf(sym, { macro: gen(seed, sym, "4h", 120), context: gen(seed + 1, sym, "1h", 120), trigger: gen(seed + 2, sym, "15m", 120) }, nowMs).mtf;

  it("P13 no component newer than the evaluation instant (every generated case)", () => {
    for (let k = 0; k < 12; k++) {
      const m = mtfOf("PROPUSDT", 50 + k * 3);
      for (const c of m.components) if (c.knowable_at_ms !== null) expect(c.knowable_at_ms).toBeLessThanOrEqual(nowMs);
      expect(nonFinitePaths(m)).toEqual([]);
      expect(nonFinitePaths(heuristicAnalyze(aiEvidence(m)))).toEqual([]);
      expect(nonFinitePaths(serializeEvidence(aiEvidence(m)))).toEqual([]);
    }
  });

  it("P14 cross-symbol MTF fails closed · P7 unavailable is not neutral", () => {
    const a = mtfOf("PROPUSDT", 11), b = mtfOf("OTHERUSDT", 11);
    const mixed = buildMtf(a.macro, a.context, b.trigger, nowMs);
    expect(mixed.verdict).toBe("UNAVAILABLE");
    expect([mixed.macro_bias, mixed.context_bias, mixed.trigger_bias]).toEqual([null, null, null]);
    const ai = heuristicAnalyze(aiEvidence({ ...mixed, trigger: a.trigger }));
    expect(ai.direction).toBe("unavailable");
    expect(ai.score).toBeNull();
    expect(ai.semantics.calibration).toBe("NOT_APPLICABLE");
  });

  it("P15 a wrong-timeframe bundle in a role fails closed", () => {
    const a = mtfOf("PROPUSDT", 21);
    const wrong = buildMtf(a.context, a.context, a.trigger, nowMs); // 1h bundle as 4h macro
    expect(wrong.verdict).toBe("UNAVAILABLE");
    expect(wrong.components[0].state).toBe("MISMATCH");
  });

  it("P17 a produced score is CALIBRATION_UNVERIFIED, never calibrated", () => {
    for (let k = 0; k < 12; k++) {
      const ai = heuristicAnalyze(aiEvidence(mtfOf("PROPUSDT", 90 + k)));
      if (ai.score !== null) {
        expect(ai.semantics.calibration).toBe("CALIBRATION_UNVERIFIED");
        expect(ai.semantics.score_provenance).toBe("ENGINEERING_DEFINED_UNCALIBRATED");
      } else expect(ai.semantics.calibration).toBe("NOT_APPLICABLE");
      expect(JSON.stringify(ai.semantics)).not.toMatch(/"CALIBRATED"/);
    }
  });
});

describe("P16 price precision never collapses", () => {
  for (const p of [0.000000123, 0.0000123, 0.000123, 0.00456, 0.0789, 1.2345, 12.345, 65000.5]) {
    it(`${p}`, () => {
      const d = decimalsFor(p);
      // at least 4 significant digits survive the chart price format
      expect(Number(p.toFixed(d))).toBeCloseTo(p, Math.max(0, -Math.floor(Math.log10(p)) + 3));
      expect(Number(p.toFixed(d))).not.toBe(0);
      expect(formatPrice(p)).not.toMatch(/^0(\.0+)?$/);
      const fmt = priceFormatFor([{ t: 0, o: p, h: p, l: p, c: p, v: 1 }] as never);
      expect(fmt.minMove).toBeLessThanOrEqual(p / 1000);
    });
  }
});
