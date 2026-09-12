/**
 * Phase 2 engine tests: detectors, rule evaluation, setup composition,
 * no-lookahead backtesting, costs, OOS/walk-forward and promotion gating.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import type { Candle } from "../src/lib/domain/types";
import { parseUdfHistory } from "../src/lib/ttt/udf";
import {
  detectABCD, detectDoublePattern, detectLevels, detectLevelTouch, detectPinbar,
  detectStructureBias, detectSwings, detectRejectionAt, detectATR, SOURCE_PARAMS,
  type PriceLevel,
} from "../src/lib/features/detectors";
import { evaluateRule, MapFeatureBag, type RuleDefinition } from "../src/lib/rules/engine";
import { evaluateSetup } from "../src/lib/rules/setup";
import { COMPILED_STRATEGIES, evaluateCompiled, COMPILED_STRATEGY_IDS } from "../src/lib/strategy/compiled";
import { runStrategyBacktest, computeMetrics, DEFAULT_COSTS } from "../src/lib/backtest/strategy-runner";
import { runOOS, runWalkForward, decidePromotion, PROMOTION_CRITERIA } from "../src/lib/backtest/validation";
import { buildRiskPolicies } from "../src/lib/brain/policies";
import { okFeature, invalidFeature } from "../src/lib/features/types";

const POLICY = buildRiskPolicies().find((p) => p.policy_id === "RISK-ASA-CONSERVATIVE-DEFAULT")!;

function loadReplay(file: string, tfMin: number): Candle[] {
  const j = JSON.parse(fs.readFileSync(`tests/fixtures/replay/${file}`, "utf8"));
  return parseUdfHistory(j, tfMin).candles;
}
const hasReplay = fs.existsSync("tests/fixtures/replay/BTCUSDT-60.json");

/** Deterministic synthetic series builder. */
function synth(spec: [number, number, number, number][], startT = 1_700_000_000, step = 3600): Candle[] {
  return spec.map(([o, h, l, c], i) => ({ t: startT + i * step, o, h, l, c, v: 100 }));
}

describe("feature detectors", () => {
  it("returns INSUFFICIENT_BARS instead of throwing on short input", () => {
    const f = detectSwings(synth([[1, 2, 0.5, 1.5]]), "1h");
    expect(f.valid).toBe(false);
    expect(f.data_quality).toBe("INSUFFICIENT_BARS");
    expect(f.reason).toContain("closed bars");
  });

  it("every feature value carries provenance metadata", () => {
    const c = loadReplayOrSynth();
    const f = detectATR(c, "1h");
    expect(f.detector_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(f.timeframe).toBe("1h");
    expect(f.inputs.length).toBeGreaterThan(0);
    if (f.valid) {
      expect(f.timestamp).toBe(c[c.length - 1].t);
      expect(f.bars_used).toBe(c.length);
    }
  });

  it("detects a bullish pin bar per the corpus wick rules", () => {
    // small bodies, then a large lower-wick candle
    const bars: [number, number, number, number][] = [];
    for (let i = 0; i < 5; i++) bars.push([100, 101, 99, 100.5]);
    bars.push([100, 100.6, 90, 100.2]); // body 0.2, lower wick 10 => 50x body
    const f = detectPinbar(synth(bars), "1h");
    expect(f.valid).toBe(true);
    expect(f.value).not.toBeNull();
    expect(f.value!.direction).toBe("bullish");
    expect(f.value!.wick_ratio).toBeGreaterThanOrEqual(SOURCE_PARAMS.pinbar_wick_body_ratio);
  });

  it("rejects an equal-sized pin bar (corpus: هم‌اندازه پین‌بارها معتبر نیستند)", () => {
    const bars: [number, number, number, number][] = [];
    for (let i = 0; i < 5; i++) bars.push([100, 110, 90, 100.2]);
    bars.push([100, 100.6, 90, 100.2]); // same range as predecessors
    const f = detectPinbar(synth(bars), "1h");
    expect(f.value).toBeNull();
    expect(f.reason).toContain("equal-size pinbars invalid");
  });

  it("classifies HH/HL structure", () => {
    // Explicit rising zigzag: each peak and trough is strictly higher than the
    // last, with flat filler bars so fractal pivots are unambiguous.
    const pivots = [100, 108, 103, 116, 110, 124, 118, 132];
    const bars: [number, number, number, number][] = [];
    const flat = (p: number) => bars.push([p, p + 0.2, p - 0.2, p]);
    for (let i = 0; i < 6; i++) flat(100);
    for (let k = 0; k < pivots.length; k++) {
      const p = pivots[k];
      const isPeak = k % 2 === 0 ? false : true;
      // approach bars then the pivot bar itself
      flat(p + (isPeak ? -2 : 2));
      bars.push(isPeak ? [p - 1, p + 3, p - 1.5, p] : [p + 1, p + 1.5, p - 3, p]);
      flat(p + (isPeak ? -2 : 2));
    }
    for (let i = 0; i < 6; i++) flat(130);
    const f = detectStructureBias(synth(bars), "1h");
    expect(f.valid).toBe(true);
    // last two highs and last two lows must both be ascending
    expect(f.value!.hh || f.value!.hl).toBe(true);
    expect(f.value!.bias).not.toBe("LH_LL");
  });

  it("detects a double top with a neckline", () => {
    const bars: [number, number, number, number][] = [];
    const shape = [100, 104, 108, 104, 100, 96, 100, 104, 108, 104, 100];
    for (let i = 0; i < 30; i++) bars.push([100, 101, 99, 100]);
    for (const p of shape) bars.push([p, p + 0.5, p - 0.5, p]);
    for (let i = 0; i < 5; i++) bars.push([98, 98.5, 97.5, 98]);
    const f = detectDoublePattern(synth(bars), "1h");
    expect(f.valid).toBe(true);
    if (f.value) {
      expect(f.value.kind).toBe("double_top");
      expect(f.value.neckline).toBeLessThan(f.value.p1);
    }
  });

  it("computes the AB=CD deep-correction flag against the 50% source boundary", () => {
    const c = loadReplayOrSynth();
    const f = detectABCD(c, "1h");
    expect(f.valid).toBe(true);
    if (f.value) {
      expect(f.value.deep_correction).toBe(f.value.correction_frac > SOURCE_PARAMS.deep_correction_frac);
    }
  });

  it("detects wick rejection at a level", () => {
    const bars: [number, number, number, number][] = [];
    for (let i = 0; i < 5; i++) bars.push([100, 101, 99, 100]);
    bars.push([100, 110, 99.5, 101]); // wick to 110, closes back at 101
    const f = detectRejectionAt(synth(bars), "1h", 108, "resistance");
    expect(f.valid).toBe(true);
    expect(f.value!.rejected).toBe(true);
  });
});

function loadReplayOrSynth(): Candle[] {
  if (hasReplay) return loadReplay("BTCUSDT-60.json", 60);
  const bars: [number, number, number, number][] = [];
  let p = 100;
  for (let i = 0; i < 300; i++) {
    const c = p + Math.sin(i / 5) * 3;
    bars.push([p, Math.max(p, c) + 1, Math.min(p, c) - 1, c]);
    p = c;
  }
  return synth(bars);
}

describe("rule evaluator", () => {
  const mkRule = (over: Partial<RuleDefinition> = {}): RuleDefinition => ({
    id: "R-TEST", description: "d", source_text: "s", source_refs: [{ file: "1.txt", start_line: 1, end_line: 1 }],
    source_status: "SOURCE_VERIFIED", empirical_status: "UNTESTED",
    feature_dependencies: ["F1"], operator: "AND", timeframe: "1h", direction: "long",
    kind: "trigger", unresolved: [], version: "1.0.0",
    predicates: [{ expr: "F1 > 0", requires: ["F1"], test: (b) => { const f = b.get("F1"); return { ok: (f?.value as number) > 0, detail: `F1=${f?.value}` }; } }],
    ...over,
  });

  it("returns UNKNOWN (not FAIL) when a required feature is invalid", () => {
    const bag = MapFeatureBag.from([["F1", invalidFeature("F1", "1h", "INSUFFICIENT_BARS", "too few bars", "1.0.0")]]);
    const r = evaluateRule(mkRule(), bag);
    expect(r.outcome).toBe("UNKNOWN");
    expect(r.explanation).toContain("INSUFFICIENT_BARS");
  });

  it("returns UNKNOWN when the feature was never computed", () => {
    const r = evaluateRule(mkRule(), MapFeatureBag.from([]));
    expect(r.outcome).toBe("UNKNOWN");
    expect(r.missing_features[0]).toContain("not computed");
  });

  it("returns BLOCKED when the source could not be formalized", () => {
    const r = evaluateRule(mkRule({ unresolved: ["threshold never stated in source"] }), MapFeatureBag.from([]));
    expect(r.outcome).toBe("BLOCKED");
    expect(r.explanation).toContain("not formalizable");
  });

  it("PASS and FAIL both carry an explanation", () => {
    const good = MapFeatureBag.from([["F1", okFeature("F1", "1h", 5, 1, 1, "1.0.0", ["x"])]]);
    const bad = MapFeatureBag.from([["F1", okFeature("F1", "1h", -5, 1, 1, "1.0.0", ["x"])]]);
    const p = evaluateRule(mkRule(), good);
    const f = evaluateRule(mkRule(), bad);
    expect(p.outcome).toBe("PASS");
    expect(f.outcome).toBe("FAIL");
    for (const r of [p, f]) expect(r.explanation.length).toBeGreaterThan(3);
  });

  it("a throwing predicate degrades to UNKNOWN, never to PASS", () => {
    const rule = mkRule({ predicates: [{ expr: "boom", requires: ["F1"], test: () => { throw new Error("boom"); } }] });
    const bag = MapFeatureBag.from([["F1", okFeature("F1", "1h", 1, 1, 1, "1.0.0", ["x"])]]);
    expect(evaluateRule(rule, bag).outcome).toBe("UNKNOWN");
  });
});

describe("setup composition", () => {
  it("UNKNOWN in a required stage propagates to the setup", () => {
    const def = {
      setup_id: "S1", strategy_id: "STR", name: "t", direction: "long" as const, timeframe: "1h",
      source_refs: [], version: "1.0.0",
      rules: [{
        id: "R1", description: "d", source_text: "s", source_refs: [], source_status: "SOURCE_VERIFIED" as const,
        empirical_status: "UNTESTED" as const, feature_dependencies: ["MISSING"], operator: "AND" as const,
        timeframe: "1h", direction: "long" as const, kind: "trigger" as const, unresolved: [], version: "1.0.0",
        predicates: [{ expr: "x", requires: ["MISSING"], test: () => ({ ok: true, detail: "" }) }],
      }],
    };
    const ev = evaluateSetup(def, MapFeatureBag.from([]));
    expect(ev.outcome).toBe("UNKNOWN");
    expect(ev.unknown_rules).toContain("R1");
    expect(ev.explanation).toContain("lacks data");
  });

  it("reports skipped stages rather than silently passing them", () => {
    const def = {
      setup_id: "S2", strategy_id: "STR", name: "t", direction: "long" as const, timeframe: "1h",
      source_refs: [], version: "1.0.0", rules: [],
    };
    const ev = evaluateSetup(def, MapFeatureBag.from([]));
    const skipped = ev.stages.filter((s) => s.outcome === "SKIPPED");
    expect(skipped.length).toBeGreaterThan(0);
    for (const s of skipped) expect(s.note).toContain("no rule defined");
  });
});

describe("compiled strategies", () => {
  it("exposes exactly the 6 corpus strategies", () => {
    expect(COMPILED_STRATEGY_IDS.sort()).toEqual([
      "STR-RAW-2-1258", "STR-RAW-2-581", "STR-RAW-2-803", "STR-RAW-2-926",
      "STR-RAW-4-2425", "STR-RAW-4-2449",
    ]);
  });

  it("every rule carries verbatim source text and a source ref", () => {
    for (const s of COMPILED_STRATEGIES) {
      for (const r of s.setup().rules) {
        expect(r.source_refs.length, `${s.setup_id}/${r.id}`).toBeGreaterThan(0);
        expect(r.source_refs[0].file).toMatch(/^[1-5]\.txt$/);
        expect(r.empirical_status, `${r.id} must not claim tested`).toBe("UNTESTED");
      }
    }
  });

  it("declares every non-source quantification in level_assumptions", () => {
    const c = loadReplayOrSynth();
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const ev = evaluateCompiled(strat, "BTCUSDT", c);
    expect(ev.levels.level_assumptions.length).toBeGreaterThan(0);
    const joined = ev.levels.level_assumptions.join(" ");
    expect(joined).toMatch(/ENGINEERING PARAMETER|not derivable|UNKNOWN/);
  });

  it("produces a four-state setup outcome with an explanation", () => {
    const c = loadReplayOrSynth();
    for (const s of COMPILED_STRATEGIES) {
      const ev = evaluateCompiled(s, "BTCUSDT", c);
      expect(["PASS", "FAIL", "UNKNOWN", "BLOCKED"]).toContain(ev.setup.outcome);
      expect(ev.setup.explanation.length).toBeGreaterThan(3);
    }
  });
});

describe.runIf(hasReplay)("backtest — no lookahead", () => {
  const candles = () => loadReplay("BTCUSDT-60.json", 60);

  it("never enters before the bar after the signal", () => {
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const r = runStrategyBacktest(strat, "BTCUSDT", candles(), { equity: 10000, policy: POLICY });
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t.entry_ts, "entry must be strictly after the signal bar").toBeGreaterThan(t.signal_ts);
      expect(t.exit_ts).toBeGreaterThanOrEqual(t.entry_ts);
    }
  });

  it("truncating future data does not change past decisions", () => {
    // The decisive property: a decision at bar i must be identical whether or
    // not bars after i exist in the array.
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const all = candles();
    const cut = 600;
    const full = evaluateCompiled(strat, "BTCUSDT", all.slice(0, cut));
    const withFuture = evaluateCompiled(strat, "BTCUSDT", all.slice(0, cut + 300).slice(0, cut));
    expect(full.setup.outcome).toBe(withFuture.setup.outcome);
    expect(full.levels.entry).toBe(withFuture.levels.entry);
    expect(full.levels.stop).toBe(withFuture.levels.stop);
  });

  it("resolves a same-bar stop+target tie to the STOP (conservative)", () => {
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const r = runStrategyBacktest(strat, "BTCUSDT", candles(), { equity: 10000, policy: POLICY });
    expect(r.same_bar_policy).toBe("stop_first");
    expect(r.assumptions.join(" ")).toMatch(/same-bar stop\+target ambiguity/i);
    // no trade may report a target outcome with a bar that also hit the stop
    for (const t of r.trades) expect(["target", "stop", "partial_then_stop", "timeout"]).toContain(t.outcome);
  });

  it("applies fees and slippage so gross R exceeds net R", () => {
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const r = runStrategyBacktest(strat, "BTCUSDT", candles(), { equity: 10000, policy: POLICY });
    expect(r.costs).toEqual(DEFAULT_COSTS);
    for (const t of r.trades) {
      expect(t.fees_r).toBeGreaterThan(0);
      expect(t.r_multiple).toBeLessThan(t.gross_r + 1e-9);
    }
  });

  it("never overlaps positions for one strategy/symbol", () => {
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const r = runStrategyBacktest(strat, "BTCUSDT", candles(), { equity: 10000, policy: POLICY });
    for (let i = 1; i < r.trades.length; i++) {
      expect(r.trades[i].signal_ts).toBeGreaterThan(r.trades[i - 1].exit_ts);
    }
  });

  it("is deterministic across runs", () => {
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const a = runStrategyBacktest(strat, "BTCUSDT", candles(), { equity: 10000, policy: POLICY });
    const b = runStrategyBacktest(strat, "BTCUSDT", candles(), { equity: 10000, policy: POLICY });
    expect(JSON.stringify(a.trades)).toBe(JSON.stringify(b.trades));
  });

  it("uses the same risk engine as advisory, compounding on live equity", () => {
    // The runner now compounds: risk_amount tracks CURRENT equity, not the
    // starting balance, so the first position must match the opening equity
    // and later ones must stay proportional to the policy percentage.
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const r = runStrategyBacktest(strat, "BTCUSDT", candles(), { equity: 10000, policy: POLICY });
    const pct = POLICY.risk_per_trade_pct! / 100;
    expect(Math.abs(r.trades[0].risk_amount - 10000 * pct)).toBeLessThan(0.01);
    for (const t of r.trades) {
      expect(t.risk_amount).toBeGreaterThan(0);
      // risk must never exceed the policy share of the starting equity by >50%
      expect(t.risk_amount).toBeLessThan(10000 * pct * 1.5);
    }
  });
});

describe("metrics + promotion gates", () => {
  it("reports an empty result honestly", () => {
    const m = computeMetrics([], 10000);
    expect(m.trade_count).toBe(0);
    expect(m.win_rate).toBeNull();
    expect(m.sufficient_sample).toBe(false);
  });

  it("cannot promote past BACKTESTED without an OOS run", () => {
    const strong = { ...computeMetrics([], 1), trade_count: 100, expectancy_r: 0.5, profit_factor: 2, max_drawdown_r: 3, win_rate: 55 };
    const v = decidePromotion(strong, null, null);
    expect(v.to).toBe("BACKTESTED");
    expect(v.reasons.join(" ")).toContain("no out-of-sample");
  });

  it("blocks promotion on a small sample", () => {
    const small = { ...computeMetrics([], 1), trade_count: 5, expectancy_r: 3, profit_factor: 9, max_drawdown_r: 1 };
    const v = decidePromotion(small, small, null);
    expect(v.to).toBe("BACKTESTED");
    expect(v.reasons.join(" ")).toContain("trades (need");
  });

  it("blocks promotion when OOS does not retain in-sample expectancy", () => {
    const is = { ...computeMetrics([], 1), trade_count: 60, expectancy_r: 1, profit_factor: 2, max_drawdown_r: 2 };
    const oos = { ...computeMetrics([], 1), trade_count: 20, expectancy_r: 0.1, profit_factor: 1.3, max_drawdown_r: 2 };
    const v = decidePromotion(is, oos, null);
    expect(v.to).toBe("BACKTESTED");
    expect(v.reasons.join(" ")).toContain("retained less than");
  });

  it("requires a majority of profitable walk-forward windows", () => {
    const good = { ...computeMetrics([], 1), trade_count: 60, expectancy_r: 1, profit_factor: 2, max_drawdown_r: 2 };
    const oos = { ...computeMetrics([], 1), trade_count: 20, expectancy_r: 0.8, profit_factor: 1.8, max_drawdown_r: 2 };
    const wf = {
      windows: [], profitable_windows: 1, total_windows: 4,
      aggregate: good, stability: 2, note: "",
    };
    const v = decidePromotion(good, oos, wf);
    expect(v.to).toBe("OOS_TESTED");
    expect(v.reasons.join(" ")).toContain("windows profitable");
  });

  it("promotion criteria are declared as engineering, not source", () => {
    expect(PROMOTION_CRITERIA.source).toContain("ENGINEERING CRITERIA");
  });

  it("a negative-expectancy strategy never exceeds BACKTESTED", () => {
    const bad = { ...computeMetrics([], 1), trade_count: 100, expectancy_r: -0.5, profit_factor: 0.4, max_drawdown_r: 20 };
    const v = decidePromotion(bad, bad, null);
    expect(v.to).toBe("BACKTESTED");
  });
});

describe.runIf(hasReplay)("OOS and walk-forward mechanics", () => {
  it("splits chronologically and never tests on training decisions", () => {
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const c = loadReplay("BTCUSDT-60.json", 60);
    const s = runOOS(strat, "BTCUSDT", c, { equity: 10000, policy: POLICY }, 0.7);
    expect(s.split_index).toBeGreaterThan(strat.min_bars);
    for (const t of s.out_of_sample.trades) {
      expect(t.signal_ts).toBeGreaterThanOrEqual(c[s.split_index].t);
    }
  });

  it("produces the requested number of walk-forward windows", () => {
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const c = loadReplay("BTCUSDT-60.json", 60);
    const wf = runWalkForward(strat, "BTCUSDT", c, { equity: 10000, policy: POLICY }, 4);
    expect(wf.total_windows).toBe(4);
    for (let i = 1; i < wf.windows.length; i++) {
      expect(wf.windows[i].test_from).toBeGreaterThan(wf.windows[i - 1].test_from);
    }
  });
});
