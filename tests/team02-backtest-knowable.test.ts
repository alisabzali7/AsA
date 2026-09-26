/**
 * Team 02 absolute-final: BACKTEST evaluation instant = KNOWABLE instant.
 * Every rule evaluation inside runStrategyBacktest is stamped with the CLOSE
 * instant of its decision bar, sees only bars closed by then, and any fill
 * happens no earlier than the next bar's open (= that same instant).
 */
import { describe, expect, it, vi } from "vitest";

const calls: { lastT: number; nowMs: number; n: number }[] = [];
vi.mock("../src/lib/strategy/compiled", async (orig) => {
  const mod = await orig<typeof import("../src/lib/strategy/compiled")>();
  return {
    ...mod,
    evaluateCompiled: (...args: Parameters<typeof mod.evaluateCompiled>) => {
      const [, , window, nowMs] = args;
      calls.push({ lastT: window[window.length - 1].t, nowMs: nowMs as number, n: window.length });
      return mod.evaluateCompiled(...args);
    },
  };
});

import { COMPILED_STRATEGIES } from "../src/lib/strategy/compiled";
import { runStrategyBacktest } from "../src/lib/backtest/strategy-runner";
import { regressionSeries } from "./fixtures/strategy/regression-harness";
import { tfSeconds } from "../src/lib/analysis/input";
import { getProductionRiskPolicy } from "../src/lib/risk/policy";

describe("backtest evaluated_at = knowable instant", () => {
  it("every evaluation is stamped at its decision bar's close; windows hold only bars closed by then", () => {
    const series = Object.values(regressionSeries())[0];
    let checked = 0;
    let positions = 0;
    for (const strat of COMPILED_STRATEGIES.slice(0, 6)) {
      calls.length = 0;
      const step = tfSeconds(strat.timeframe)!;
      // re-time the series onto this strategy's timeframe grid
      const t0 = 1_700_000_000 - (1_700_000_000 % step);
      const candles = series.map((k, i) => ({ ...k, t: t0 + i * step }));
      const res = runStrategyBacktest(strat, "REGUSDT", candles, { equity: 10_000, policy: getProductionRiskPolicy() });
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.nowMs).toBe((c.lastT + step) * 1000); // close instant, not open
        expect(candles[c.n - 1].t).toBe(c.lastT); // window = prefix up to the decision bar
      }
      // every position: signal bar evaluated at its close; entry bar opens at/after that close
      for (const p of res.positions) {
        const ev = calls.find((c) => c.lastT === p.signal_ts);
        expect(ev, `signal ${p.signal_ts} was evaluated`).toBeDefined();
        expect(p.entry_ts * 1000).toBeGreaterThanOrEqual(ev!.nowMs);
        positions++;
      }
      checked += calls.length;
    }
    expect(checked).toBeGreaterThan(100);
    // the fill-causality check is not vacuous (15 fills on this fixture at authoring time)
    expect(positions).toBeGreaterThan(0);
  });
});
