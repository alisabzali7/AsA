/**
 * Backtest determinism + anti-lookahead tests over deterministic fixtures:
 *  - aggregation of higher TFs never emits the forming (incomplete) bucket
 *  - two identical runs produce identical trades (no hidden randomness)
 *  - warmup/insufficient data handled explicitly, not silently
 *  - lineage documents assumptions (funding not modeled, same-bar policy)
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BacktestInput } from "../src/lib/backtest/engine";
import { getRepo } from "../src/db/sqlite";

vi.hoisted(() => {
  process.env.ASA_DB_PATH = ":memory:";
  process.env.ASA_HISTORY_DB_PATH = ":memory:";
  process.env.ASA_BRAIN_DB_PATH = ":memory:";
});
import { runBacktest } from "../src/lib/backtest/engine";
import { aggregateClosed } from "../src/lib/analysis/aggregate";
import { COMPILED_STRATEGIES } from "../src/lib/strategy/compiled";
import type { Candle } from "../src/lib/domain/types";

vi.mock("../src/lib/risk/policy", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/risk/policy")>();
  const source = mod.selectableRiskPolicies().find((policy) => policy.policy_id === "RISK-DAILY-5PCT")!;
  const testOnlyPolicy = {
    ...source,
    selection_status: "SELECTED" as const,
    selected_by: "operator_pref" as const,
    selection_reason: "TEST ONLY: production source-completeness gate bypassed for deterministic backtest math",
    policy_version: mod.RISK_POLICY_VERSION,
    source_completeness: mod.riskPolicyEligibility(source).source_completeness,
  };
  return { ...mod, getProductionRiskPolicy: () => testOnlyPolicy };
});

/** Deterministic synthetic 15m candles: trend + sine + deterministic wobble. */
function synthCandles(bars: number, startT: number, seed = 7): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  let state = seed;
  const rnd = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = 0; i < bars; i++) {
    const t = startT + i * 900;
    const trend = Math.sin(i / 60) * 0.08;
    const o = price;
    const c = o + trend + (rnd() - 0.5) * 0.12;
    const h = Math.max(o, c) + rnd() * 0.05;
    const l = Math.min(o, c) - rnd() * 0.05;
    price = c;
    out.push({ t, o: round(o), h: round(h), l: round(l), c: round(c), v: 100 + rnd() * 60 });
  }
  return out;
}
const round = (v: number) => Math.round(v * 1000) / 1000;

const BASE = 1_699_999_200; // 15m/hour/4h grid-aligned start (mult of 3600)

describe("aggregateClosed (no lookahead)", () => {
  it("emits complete 1h/4h buckets only — never the forming bucket", () => {
    const candles = synthCandles(150, BASE, 3);
    const h1 = aggregateClosed(candles, 60);
    const lastH1 = h1[h1.length - 1];
    const haveAll = new Set(candles.map((c) => c.t));
    // emitted bucket is complete: its final 15m candle exists in the input
    expect(haveAll.has(lastH1.t + 3600 - 900)).toBe(true);
    // ... and the series cannot end more than two hours after its start
    expect(candles[candles.length - 1].t - lastH1.t).toBeLessThan(7200);
    const h4 = aggregateClosed(candles, 240);
    const have = new Set(candles.map((c) => c.t));
    // every emitted 4h bucket must contain its closing 15m candle in the input
    for (const b of h4) {
      expect(have.has(b.t + 14400 - 900)).toBe(true);
    }
    if (h4.length > 0) {
      const lastH4 = h4[h4.length - 1];
      // the bucket after the last emitted one must be incomplete:
      // its closing sub-candle (start + 2*step - srcStep) is absent
      expect(have.has(lastH4.t + 28800 - 900)).toBe(false);
    }
    // aggregation is monotonic & OHLC-correct
    for (const arr of [h1, h4]) {
      for (let i = 1; i < arr.length; i++) expect(arr[i].t).toBeGreaterThan(arr[i - 1].t);
      for (const c of arr) {
        expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
        expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
      }
    }
  });

  it("never includes the current partial day/4h bucket", () => {
    // build exactly 3h+ of 15m bars starting at an 4h boundary + 1 extra forming bar
    const start = Math.floor(BASE / 14400) * 14400;
    const candles = synthCandles(13, start, 5); // 13*15m = 3h15m: 3h complete in first bucket? start of bucket needs 16 bars for 4h
    const h4 = aggregateClosed(candles, 240);
    expect(h4.length).toBe(0); // partial 4h bucket must NOT appear
    const h1 = aggregateClosed(candles, 60);
    expect(h1.length).toBe(3); // three complete hours only; forming 4th hour absent
  });
});

describe("runBacktest determinism & lineage (Brain-backed engine)", () => {
  // Use a real compiled strategy id; the engine resolves it from the Brain
  // runtime, which is the same path advisory uses.
  const SETUP = COMPILED_STRATEGIES.find((x) => x.strategy_id === "STR-RAW-2-803")!.setup_id;
  const candles = synthCandles(900, 1_700_000_000);
  const backtestInput = (over: Partial<BacktestInput> = {}): BacktestInput => ({
    strategyId: SETUP,
    symbol: "BTCUSDT",
    candles,
    feeRoundTripPct: 0.08,
    slippagePct: 0.02,
    sameBarPolicy: "stop_first",
    dataMode: "fixture",
    maxHoldBars: 120,
    accountEquity: 10_000,
    riskPerTradePct: 1,
    maxLeverage: 5,
    ...over,
  });

  beforeAll(() => {
    // The test-only module seam selects the real daily policy's shape while
    // bypassing production source-completeness eligibility; no account-limit
    // claim is inferred from the 11% test-account observation.
    getRepo().configSet("pref.risk.policyId", "RISK-DAILY-5PCT");
  });

  it("is deterministic: identical input -> identical positions", () => {
    const a = runBacktest(backtestInput());
    const b = runBacktest(backtestInput());
    expect(a.ok).toBe(true);
    expect(JSON.stringify(a.positions)).toBe(JSON.stringify(b.positions));
    expect(JSON.stringify(a.metrics)).toBe(JSON.stringify(b.metrics));
  });

  it("entry never uses the signal bar (fills at the NEXT bar)", () => {
    const r = runBacktest(backtestInput());
    for (const p of r.positions) expect(p.entry_ts).toBeGreaterThan(p.signal_ts);
  });

  it("exit timestamps are absolute, never slice-relative indexes", () => {
    const r = runBacktest(backtestInput());
    const first = candles[0].t, last = candles[candles.length - 1].t;
    for (const p of r.positions) {
      expect(p.exit_ts).toBeGreaterThanOrEqual(first);
      expect(p.exit_ts).toBeLessThanOrEqual(last);
      for (const f of p.fills) {
        expect(f.ts).toBeGreaterThanOrEqual(first);
        expect(f.ts).toBeLessThanOrEqual(last);
      }
    }
  });

  it("declares funding as not modelled and records the same-bar policy", () => {
    const r = runBacktest(backtestInput({ sameBarPolicy: "stop_first" }));
    expect(r.warnings.join(" ")).toMatch(/funding is NOT modelled/i);
    expect(r.same_bar_policy).toBe("stop_first");
    expect(r.assumptions.join(" ")).toMatch(/same-bar/i);
  });

  it("carries full reproducibility lineage", () => {
    const r = runBacktest(backtestInput());
    for (const k of ["dataset_fingerprint", "strategy_version", "risk_policy_id", "app_version", "git_commit", "build_id", "date_range"]) {
      expect(r.lineage[k], k).toBeDefined();
    }
  });

  it("uses the strategy's OWN timeframe, not a hard-coded 15m", () => {
    const r = runBacktest(backtestInput());
    const strat = COMPILED_STRATEGIES.find((x) => x.setup_id === SETUP)!;
    expect(r.timeframe).toBe(strat.timeframe);
  });

  it("reports insufficient data explicitly instead of fake results", () => {
    const r = runBacktest(backtestInput({ candles: candles.slice(0, 40) }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/insufficient/i);
    expect(r.positions).toEqual([]);
  });

  it("rejects an unknown strategy id rather than silently defaulting", () => {
    const r = runBacktest(backtestInput({ strategyId: "does-not-exist" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown strategy/i);
  });
});
