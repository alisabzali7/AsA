/**
 * Remediation regression suite — 2026-09-30 repository review.
 *
 * Every block below pins a defect that was REPRODUCED against HEAD
 * (`15f92e6`) before it was fixed. They are deliberately narrow: each one
 * fails loudly if the specific contract violation returns.
 *
 * Shared theme: a declared gate or metric that could not actually be measured
 * must never present itself as satisfied, and a recorded outcome must never
 * contradict the evidence it was derived from.
 */
import { describe, expect, it } from "vitest";
import type { Candle } from "../src/lib/domain/types";
import { evaluateRisk } from "../src/lib/risk/engine";
import {
  computeMetrics,
  runStrategyBacktest,
  type BacktestMetrics,
  type PositionRecord,
} from "../src/lib/backtest/strategy-runner";
import { decidePromotion } from "../src/lib/backtest/validation";
import { researchRiskPolicyBlockers, researchRiskPolicyUsable } from "../src/lib/risk/research-policy-gate";
import {
  explicitResearchRunOptions,
  TEST_ONLY_SOURCE_RISK_MATH_POLICY,
} from "./helpers/research-run-options";
import {
  syntheticBar,
  syntheticFlatBar,
  syntheticLadderStrategy,
} from "./fixtures/strategy/synthetic-ladder-strategy";

/* ------------------------------------------------------------------ D1 */

describe("D1 — promotion ladder never advances on an UNMEASURED criterion", () => {
  const metrics = (over: Partial<BacktestMetrics> = {}): BacktestMetrics => ({
    trade_count: 40, wins: 40, losses: 0, win_rate: 100, average_r: 0.8, expectancy_r: 0.8,
    // profit_factor is null whenever no losing trade exists: grossLoss === 0.
    profit_factor: null, max_drawdown_r: 0, max_drawdown_pct: 0, longest_loss_streak: 0,
    average_hold_bars: 5, total_r: 32, gross_total_r: 33, return_pct: 10,
    fee_impact_r: 0.5, slippage_impact_r: 0.2, funding_impact: null, sufficient_sample: true,
    ...over,
  });

  it("an uncomputed in-sample profit factor stops the ladder instead of passing it", () => {
    const verdict = decidePromotion(metrics(), metrics({ trade_count: 20, total_r: 16 }), null);

    // Before the fix this returned to=OOS_TESTED / promoted=true while the
    // verdict itself said the profit factor had never been computed.
    expect(verdict.to).toBe("BACKTESTED");
    expect(verdict.promoted).toBe(false);
    expect(verdict.unknown_reasons.join(" ")).toMatch(/profit factor is not computed/i);
    expect(verdict.reasons.join(" ")).toMatch(/UNKNOWN is never a pass/i);
  });

  it("records the unmeasured criterion as UNKNOWN, not as FAIL", () => {
    const verdict = decidePromotion(metrics(), null, null);
    const pf = verdict.checks.find((check) => check.id === "in-sample_profit_factor");
    expect(pf?.verdict).toBe("UNKNOWN");
    // UNKNOWN must stay distinguishable from a measured shortfall.
    expect(verdict.failure_reasons).toEqual([]);
  });

  it("a fully measured, sufficient run still advances", () => {
    const measured = metrics({ losses: 10, wins: 30, profit_factor: 2.4 });
    const verdict = decidePromotion(
      measured,
      metrics({ trade_count: 20, losses: 5, wins: 15, profit_factor: 2.1, total_r: 16 }),
      null,
    );
    expect(verdict.to).toBe("OOS_TESTED");
    expect(verdict.promoted).toBe(true);
  });
});

/* ------------------------------------------------------------------ D2 */

describe("D2 — the liquidation ESTIMATE gate always states its own state", () => {
  const base = {
    symbol: "BTCUSDT",
    direction: "long" as const,
    entry: 100_000,
    // a 10% stop keeps estimated leverage well under 1x, so the ESTIMATE
    // formula yields no usable liquidation price
    stop: 90_000,
    target: 120_000,
    equity: 10_000,
    riskPerTradePct: 1,
    maxLeverage: 5,
    venueMaxLeverage: 50,
    maintenanceMarginRate: 0.004,
    takerFeeCoefficient: 0.0004,
  };

  it("reports NOT_APPLICABLE (with a reason) instead of saying nothing at all", () => {
    const result = evaluateRisk(base);
    expect(result.verdict).toBe("pass");
    expect(result.numbers.liq_estimate).toBeNull();
    expect(result.numbers.liq_label).toBeNull();
    // Before the fix this branch produced NO statement anywhere: the caller
    // was told "risk checks passed" and a declared gate had silently produced
    // nothing.
    expect(result.liquidation_gate.state).toBe("NOT_APPLICABLE");
    expect(result.liquidation_gate.reason).toMatch(/price zero/i);
  });

  it("a non-applicable gate is NOT reported as a missing venue constraint", () => {
    // `risk/live.ts` converts every `unenforced` entry into a hard live block.
    // Sub-1x leverage is a mathematical non-applicability, not missing data,
    // so it must not travel through that channel.
    const result = evaluateRisk(base);
    expect(result.unenforced.join(" ")).not.toMatch(/liquidation/i);
  });

  it("still enforces the gate when the estimate IS computable", () => {
    const result = evaluateRisk({ ...base, stop: 99_800 });
    expect(result.numbers.liq_estimate).not.toBeNull();
    expect(result.numbers.liq_label).toBe("ESTIMATE");
    expect(result.liquidation_gate.state).toBe("ENFORCED");
  });

  it("missing maintenance margin stays UNENFORCEABLE and keeps failing closed for live", () => {
    const result = evaluateRisk({ ...base, maintenanceMarginRate: null });
    expect(result.liquidation_gate.state).toBe("UNENFORCEABLE");
    expect(result.unenforced.join(" ")).toMatch(/maintenance margin rate/i);
  });

  it("every evaluation carries a liquidation-gate state and a non-empty reason", () => {
    const cases = [
      base,
      { ...base, maintenanceMarginRate: null },
      { ...base, stop: 99_800 },
      { ...base, direction: "short" as const, entry: 100_000, stop: 100_200, target: 90_000 },
      { ...base, equity: null },
    ];
    for (const input of cases) {
      const result = evaluateRisk(input);
      expect(["ENFORCED", "NOT_APPLICABLE", "UNENFORCEABLE"]).toContain(result.liquidation_gate.state);
      expect(result.liquidation_gate.reason.length).toBeGreaterThan(10);
      // an estimate exists if and only if the gate actually ran
      expect(result.numbers.liq_estimate !== null).toBe(result.liquidation_gate.state === "ENFORCED");
    }
  });
});

/* ------------------------------------------------------------------ D3 */

describe("D3 — equity drawdown includes the account's starting equity", () => {
  const position = (r: number, pnl: number, ts: number): PositionRecord => ({
    position_id: `p${ts}`, strategy_id: "S", setup_id: "SU", symbol: "BTCUSDT", direction: "long",
    signal_ts: ts, entry_ts: ts, entry_price: 100, stop: 99, targets: [102], qty: 1, fills: [],
    exit_ts: ts, avg_exit_price: 101, outcome: "target", bars_held: 1, risk_amount: 100,
    r_multiple: r, gross_r: r, fees_r: 0, slippage_r: 0, pnl_quote: pnl, score: 50,
  });

  it("a first losing trade is a real drawdown, not 0%", () => {
    const curve = [{ ts: 1, equity: 8_000 }, { ts: 2, equity: 10_000 }];
    const m = computeMetrics([position(-1, -2_000, 1), position(1, 2_000, 2)], 10_000, curve);
    // Before the fix the peak was seeded from the post-first-trade equity,
    // so this 20% peak-to-trough decline was reported as 0.
    expect(m.max_drawdown_pct).toBeCloseTo(20, 6);
  });

  it("a monotonically rising curve still reports zero drawdown", () => {
    const curve = [{ ts: 1, equity: 11_000 }, { ts: 2, equity: 12_000 }];
    const m = computeMetrics([position(1, 1_000, 1), position(1, 1_000, 2)], 10_000, curve);
    expect(m.max_drawdown_pct).toBe(0);
  });

  it("an absent curve stays UNKNOWN rather than reporting a zero drawdown", () => {
    expect(computeMetrics([position(1, 1_000, 1)], 10_000, []).max_drawdown_pct).toBeNull();
    expect(computeMetrics([], 10_000).max_drawdown_pct).toBeNull();
  });
});

/* ------------------------------------------------------------------ D4 */

describe("D4 — a position's outcome label cannot contradict its own fills", () => {
  const runOptions = (over = {}) => explicitResearchRunOptions({
    costs: { fee_rate: 0, slippage_rate: 0 },
    max_hold_bars: 3,
    start_index: 3,
    ...over,
  });

  const flat = (from: number, to: number) => {
    const out = [];
    for (let i = from; i <= to; i += 1) out.push(syntheticFlatBar(i));
    return out;
  };

  it("a partial fill closed by the hold horizon is partial_then_timeout, not partial_then_stop", () => {
    const strategy = syntheticLadderStrategy({
      entry: 100, stop: 90, targets: [105, 220], invalidation: 90, level_assumptions: [],
    });
    const candles = [
      ...flat(0, 4),
      syntheticBar(5, 100, 106, 99, 100), // target 1 fills here
      ...flat(6, 8),
    ];
    const result = runStrategyBacktest(strategy, "BTCUSDT", candles, runOptions());

    expect(result.positions).toHaveLength(1);
    const position = result.positions[0];
    expect(position.fills.map((fill) => fill.reason)).toEqual([
      "entry at next bar open", "target 1", "timeout",
    ]);
    // Before the fix this asserted a stop-out that never happened.
    expect(position.outcome).toBe("partial_then_timeout");
  });

  it("a partial fill closed by the stop is still partial_then_stop", () => {
    const strategy = syntheticLadderStrategy({
      entry: 100, stop: 90, targets: [105, 220], invalidation: 90, level_assumptions: [],
    });
    const candles = [
      ...flat(0, 4),
      syntheticBar(5, 100, 106, 99, 100), // target 1
      syntheticBar(6, 100, 101, 89, 90), // stop
      ...flat(7, 8),
    ];
    const result = runStrategyBacktest(strategy, "BTCUSDT", candles, runOptions());
    // The early stop frees the book, so the runner may open a second position
    // from the remaining bars; only the first one is under test here.
    expect(result.positions.length).toBeGreaterThanOrEqual(1);
    expect(result.positions[0].outcome).toBe("partial_then_stop");
    expect(result.positions[0].fills.at(-1)?.reason).toBe("stop after partial target(s)");
  });

  it("no ladder fill at all stays a plain timeout", () => {
    const strategy = syntheticLadderStrategy({
      entry: 100, stop: 90, targets: [210, 220], invalidation: 90, level_assumptions: [],
    });
    const result = runStrategyBacktest(strategy, "BTCUSDT", flat(0, 8), runOptions());
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].outcome).toBe("timeout");
  });

  it("the outcome label of every produced position agrees with its final exit fill", () => {
    const scenarios = [
      [...flat(0, 4), syntheticBar(5, 100, 106, 99, 100), ...flat(6, 8)],
      [...flat(0, 4), syntheticBar(5, 100, 106, 99, 100), syntheticBar(6, 100, 101, 89, 90), ...flat(7, 8)],
      [...flat(0, 4), syntheticBar(5, 100, 101, 89, 90), ...flat(6, 8)],
      flat(0, 8),
    ];
    const expectedByReason: Record<string, PositionRecord["outcome"][]> = {
      "stop": ["stop"],
      "stop after partial target(s)": ["partial_then_stop"],
      "timeout": ["timeout", "partial_then_timeout"],
      "ladder exhausted": ["target"],
    };
    for (const candles of scenarios) {
      const strategy = syntheticLadderStrategy({
        entry: 100, stop: 90, targets: [105, 220], invalidation: 90, level_assumptions: [],
      });
      const result = runStrategyBacktest(strategy, "BTCUSDT", candles, runOptions());
      for (const position of result.positions) {
        const last = position.fills.at(-1);
        expect(last).toBeDefined();
        const allowed = expectedByReason[last!.reason] ?? ["target"];
        expect(allowed, `${last!.reason} -> ${position.outcome}`).toContain(position.outcome);
      }
    }
  });
});

/* ------------------------------------------------------------------ D5 */

describe("D5 — one shared definition of a research-usable risk policy", () => {
  const usable = TEST_ONLY_SOURCE_RISK_MATH_POLICY;

  it("accepts the explicitly selected, source-verified, conflict-free policy", () => {
    expect(researchRiskPolicyBlockers(usable)).toEqual([]);
    expect(researchRiskPolicyUsable(usable)).toBe(true);
  });

  it("rejects a DISABLED runtime status — the dimension the engine copy used to omit", () => {
    const disabled = { ...usable, runtime_status: "DISABLED" as const };
    expect(researchRiskPolicyBlockers(disabled).join(" ")).toMatch(/runtime status is DISABLED/);
    expect(researchRiskPolicyUsable(disabled)).toBe(false);
  });

  it("rejects every other missing prerequisite with its own named reason", () => {
    const cases: [Partial<typeof usable>, RegExp][] = [
      [{ selection_status: "UNSELECTED" }, /not explicitly selected/],
      [{ selection_status: "BLOCKED" }, /not explicitly selected/],
      [{ source_status: "UNKNOWN" }, /not SOURCE_VERIFIED/],
      [{ source_refs: [] }, /no exact source references/],
      [{ conflict_group_id: "CONFLICT-1" }, /unresolved source conflict/],
    ];
    for (const [patch, pattern] of cases) {
      const blockers = researchRiskPolicyBlockers({ ...usable, ...patch });
      expect(blockers.join(" "), JSON.stringify(patch)).toMatch(pattern);
    }
  });

  it("refuses a missing policy instead of throwing", () => {
    expect(researchRiskPolicyBlockers(null)).toEqual(["no risk policy supplied"]);
    expect(researchRiskPolicyBlockers(undefined)).toEqual(["no risk policy supplied"]);
  });

  it("the backtest runner refuses the same policies this predicate rejects", () => {
    const strategy = syntheticLadderStrategy({
      entry: 100, stop: 90, targets: [105, 220], invalidation: 90, level_assumptions: [],
    });
    const candles: Candle[] = [];
    for (let i = 0; i <= 8; i += 1) candles.push(syntheticFlatBar(i));
    const disabled = { ...usable, runtime_status: "DISABLED" as const };
    expect(researchRiskPolicyUsable(disabled)).toBe(false);
    expect(() => runStrategyBacktest(strategy, "BTCUSDT", candles, explicitResearchRunOptions({
      policy: disabled, costs: { fee_rate: 0, slippage_rate: 0 }, max_hold_bars: 3, start_index: 3,
    }))).toThrow(/runtime status is DISABLED/);
  });
});
