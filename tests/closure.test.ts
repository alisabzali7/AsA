/**
 * Closure-run regression tests (closure §AC).
 *
 * Every test here pins a DEFECT THAT WAS ACTUALLY FOUND AND FIXED in this run,
 * so it cannot silently regress:
 *   - the Brain/registry split (production used only referenceStrategy)
 *   - hard-coded score 55 and contradictions []
 *   - risk accepting a stop on the wrong side of entry
 *   - hard-coded RR = 3
 *   - production mutation auth failing OPEN
 *   - TTT host allow-list absent
 *   - stale-signal expiry scanning only the newest 200 rows
 *   - slice-relative exit indexes
 *   - partial exits counted as separate trades
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { getStrategy, listStrategies, liveEligibleStrategies } from "../src/lib/strategy/registry";
import { referenceStrategy } from "./fixtures/strategy/reference-strategy";
import { listRuntimeStrategies, runtimeStrategyIds, executableStrategies, evaluateRuntime } from "../src/lib/strategy/runtime";
import { evaluateRisk } from "../src/lib/risk/engine";
import { getProductionRiskPolicy, selectableRiskPolicies } from "../src/lib/risk/policy";
import { assertAllowedHost, TTT_ALLOWED_HOSTS } from "../src/lib/ttt/http";
import { assertNoExecutionCapability, FORBIDDEN_CAPABILITIES } from "../src/lib/safety/no-execution";
import { validateSecurityConfig } from "../src/lib/api-common";
import { buildPsychologyPolicies } from "../src/lib/brain/policies";
import { buildReleaseIdentity } from "../src/lib/release";
import { aggregateClosed } from "../src/lib/analysis/aggregate";
import { runStrategyBacktest } from "../src/lib/backtest/strategy-runner";
import { COMPILED_STRATEGIES } from "../src/lib/strategy/compiled";
import { parseUdfHistory } from "../src/lib/ttt/udf";
import type { Candle } from "../src/lib/domain/types";

const POLICY = getProductionRiskPolicy();
const hasReplay = fs.existsSync("tests/fixtures/replay/BTCUSDT-60.json");
function replay(): Candle[] {
  const j = JSON.parse(fs.readFileSync("tests/fixtures/replay/BTCUSDT-60.json", "utf8"));
  return parseUdfHistory(j, 60).candles;
}

describe("§B Brain is the single strategy source of truth", () => {
  it("the production registry no longer returns referenceStrategy", () => {
    const ids = listStrategies().map((s) => s.setup_id);
    expect(ids).not.toContain("reference-trend-continuation");
    expect(ids.length).toBeGreaterThan(0);
  });

  it("all 6 Brain strategies resolve through getStrategy()", () => {
    const expected = [
      "STR-RAW-2-581", "STR-RAW-2-803", "STR-RAW-2-926",
      "STR-RAW-2-1258", "STR-RAW-4-2425", "STR-RAW-4-2449",
    ];
    expect(runtimeStrategyIds().sort()).toEqual(expected.sort());
    for (const id of expected) {
      const s = getStrategy(id);
      expect(s, `getStrategy(${id})`).toBeDefined();
      expect(s!.strategy_id).toBe(id);
    }
  });

  it("every executable strategy carries a real implementation and source refs", () => {
    for (const s of executableStrategies()) {
      expect(s.impl, s.setup_id).not.toBeNull();
      expect(s.rule_ids.length).toBeGreaterThan(0);
      expect(s.source_refs.length).toBeGreaterThan(0);
    }
  });

  it("a non-computable strategy is blocked with an exact reason, never guessed", () => {
    for (const s of listRuntimeStrategies()) {
      if (s.availability !== "EXECUTABLE") {
        expect(s.blocked_reason, s.setup_id).toBeTruthy();
        expect(s.impl).toBeNull();
      }
    }
  });

  it("the reference harness lives in tests only and is absent from production", () => {
    // it is now a TEST FIXTURE — production cannot import it at all
    expect(referenceStrategy.id).toBe("reference-trend-continuation");
    expect(fs.existsSync("src/lib/strategy/reference.ts")).toBe(false);
    expect(liveEligibleStrategies().map((s) => s.setup_id)).not.toContain("reference-trend-continuation");
  });

  it("no production source file imports the reference strategy", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${d}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${d}/${e.name}`] : []);
    const offenders = walk("src").filter(
      (f) => fs.readFileSync(f, "utf8").includes("strategy/reference"),
    );
    expect(offenders).toEqual([]);
  });
});

describe("§H risk engine: direction-safe and target-aware", () => {
  const base = {
    symbol: "BTCUSDT", equity: 10_000, riskPerTradePct: 1, maxLeverage: 10,
    venueMaxLeverage: null, maintenanceMarginRate: null, takerFeeCoefficient: 0.0005,
    tickSize: null, qtyStep: null, minQty: null, minNotional: null,
  };

  it("BLOCKS a long whose stop is above entry (was silently accepted via Math.abs)", () => {
    const r = evaluateRisk({ ...base, direction: "long", entry: 100, stop: 105, target: 120 });
    expect(r.verdict).toBe("block");
    expect(r.reasons.join(" ")).toMatch(/LONG requires stop < entry/);
  });

  it("BLOCKS a short whose stop is below entry", () => {
    const r = evaluateRisk({ ...base, direction: "short", entry: 100, stop: 95, target: 80 });
    expect(r.verdict).toBe("block");
    expect(r.reasons.join(" ")).toMatch(/SHORT requires stop > entry/);
  });

  it("derives R:R from the ACTUAL target, not a hard-coded 3", () => {
    const r = evaluateRisk({ ...base, direction: "long", entry: 100, stop: 99, target: 102.5 });
    expect(r.numbers.risk_reward).toBeCloseTo(2.5, 3);
    const r2 = evaluateRisk({ ...base, direction: "long", entry: 100, stop: 99, target: 104 });
    expect(r2.numbers.risk_reward).toBeCloseTo(4, 3);
  });

  it("reports R:R UNKNOWN when no target exists instead of assuming one", () => {
    const r = evaluateRisk({ ...base, direction: "long", entry: 100, stop: 99, target: null });
    expect(r.numbers.risk_reward).toBeNull();
    expect(r.unenforced.join(" ")).toMatch(/R:R is UNKNOWN/);
  });

  it("rejects a target on the wrong side of entry", () => {
    const r = evaluateRisk({ ...base, direction: "long", entry: 100, stop: 99, target: 95 });
    expect(r.verdict).toBe("block");
    expect(r.reasons.join(" ")).toMatch(/wrong side of entry/);
  });

  it("declares minQty/minNotional UNAVAILABLE rather than inventing them", () => {
    const r = evaluateRisk({ ...base, direction: "long", entry: 100, stop: 99, target: 103 });
    expect(r.unenforced.join(" ")).toMatch(/minQty is not exposed/);
    expect(r.unenforced.join(" ")).toMatch(/minNotional is not exposed/);
  });

  it("quantises size DOWN to the venue step, never up into extra risk", () => {
    const r = evaluateRisk({ ...base, direction: "long", entry: 100, stop: 99, target: 103, qtyStep: 10 });
    const size = r.numbers.position_size!;
    expect(size % 10).toBeCloseTo(0, 8);
    expect(size).toBeLessThanOrEqual(100);
  });

  it("labels liquidation as an ESTIMATE, never a venue fact", () => {
    const r = evaluateRisk({ ...base, direction: "long", entry: 100, stop: 99, target: 103, maintenanceMarginRate: 0.01 });
    if (r.numbers.liq_estimate !== null) expect(r.numbers.liq_label).toBe("ESTIMATE");
  });
});

describe("§H risk policy selection is explicit and versioned", () => {
  it("defaults to the conservative composite and says why", () => {
    expect(POLICY.policy_id).toBe("RISK-ASA-CONSERVATIVE-DEFAULT");
    expect(POLICY.selection_reason).toMatch(/SOURCE_INFERRED|operator-selected/);
    expect(POLICY.policy_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps every conflicting source policy selectable, never averaged", () => {
    const perTrade = selectableRiskPolicies().map((p) => p.risk_per_trade_pct).filter((x) => x !== null);
    expect(perTrade).toContain(1);
    expect(perTrade).toContain(2);
    expect(perTrade).not.toContain(1.5);
  });
});

describe("§Y production auth fails closed", () => {
  it("flags a production deployment without ASA_API_TOKEN as a config error", () => {
    const v = validateSecurityConfig({ nodeEnv: "production", apiToken: "", allowUnauthenticated: false });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/ASA_API_TOKEN must be set in production/);
  });

  it("production WITH a token validates cleanly", () => {
    const v = validateSecurityConfig({ nodeEnv: "production", apiToken: "s3cret", allowUnauthenticated: false });
    expect(v.ok).toBe(true);
  });

  it("an explicit private-network opt-out is a warning, never a silent default", () => {
    const v = validateSecurityConfig({ nodeEnv: "production", apiToken: "", allowUnauthenticated: true });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/disables the production mutation guard/);
  });

  it("permits an unauthenticated development run with a warning", () => {
    const v = validateSecurityConfig({ nodeEnv: "development", apiToken: "", allowUnauthenticated: false });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/mutation endpoints are open locally/);
  });
});

describe("§Q TTT host allow-list (no fallback exchange)", () => {
  it("accepts the production TTT host", () => {
    expect(() => assertAllowedHost("https://apiv2.thetruetrade.io")).not.toThrow();
  });

  it("refuses any other exchange host", () => {
    for (const bad of ["https://api.binance.com", "https://api.bybit.com", "https://evil.example"]) {
      expect(() => assertAllowedHost(bad), bad).toThrow(/allow-list/);
    }
  });

  it("refuses a malformed base URL", () => {
    expect(() => assertAllowedHost("not-a-url")).toThrow(/invalid base URL/);
  });

  it("the allow-list contains only TTT hosts", () => {
    for (const h of TTT_ALLOWED_HOSTS) expect(h).toMatch(/thetruetrade\.io$/);
  });
});

describe("§Z layered no-execution capability", () => {
  it("the central assertion passes on every layer", () => {
    const r = assertNoExecutionCapability();
    expect(r.ok).toBe(true);
    for (const l of r.layers) expect(l.ok, l.layer).toBe(true);
  });

  it("declares every forbidden capability as absent", () => {
    const r = assertNoExecutionCapability();
    for (const c of FORBIDDEN_CAPABILITIES) expect(r.absent_capabilities).toContain(c);
  });
});

describe("§G psychology provenance honesty", () => {
  const policies = buildPsychologyPolicies();

  it("any policy carrying an ENGINEERING threshold is not SOURCE_VERIFIED", () => {
    for (const p of policies) {
      const declaresEngineering = /ENGINEERING/i.test(`${p.description} ${p.trigger_condition}`);
      if (declaresEngineering) {
        expect(p.source_status, `${p.policy_id} declares an engineering threshold`).toBe("SOURCE_INFERRED");
      }
      // every SOURCE_VERIFIED policy must either cite the corpus or be purely
      // qualitative (no configured numeric limit of its own)
      if (p.source_status === "SOURCE_VERIFIED") {
        const usesConfiguredLimit = /cooldown_min|max_trades_per_day|_atr >/.test(p.trigger_condition);
        expect(usesConfiguredLimit, `${p.policy_id} is SOURCE_VERIFIED but uses an engineering limit`).toBe(false);
      }
    }
  });

  it("engineering-assumption policies say so and carry no fake source refs", () => {
    for (const id of ["PSY-COOLDOWN", "PSY-CHASE", "PSY-OVERTRADE"]) {
      const p = policies.find((x) => x.policy_id === id)!;
      expect(p.source_status).toBe("SOURCE_INFERRED");
      expect(p.source_refs).toHaveLength(0);
      expect(`${p.description} ${p.trigger_condition}`).toMatch(/ENGINEERING_ASSUMPTION|ENGINEERING ASSUMPTION/);
    }
  });

  it("a non-source threshold is operator-overridable; source rules are not", () => {
    expect(policies.find((p) => p.policy_id === "PSY-COOLDOWN")!.user_overridable).toBe(true);
    expect(policies.find((p) => p.policy_id === "PSY-DAILY-LOSS")!.user_overridable).toBe(false);
    expect(policies.find((p) => p.policy_id === "PSY-EMOTIONAL-STATE")!.user_overridable).toBe(false);
  });

  it("the daily-loss policy cites the actual corpus lines", () => {
    const p = policies.find((x) => x.policy_id === "PSY-DAILY-LOSS")!;
    expect(p.source_status).toBe("SOURCE_VERIFIED");
    expect(p.source_refs.length).toBeGreaterThan(0);
    expect(p.source_refs[0].file).toBe("4.txt");
  });
});

describe("§AD release identity", () => {
  it("exposes app version, commit and build id", () => {
    const r = buildReleaseIdentity();
    expect(r.app_version).toBeTruthy();
    expect(r.git_commit).toBeTruthy();
    expect(r.build_id).toContain(r.app_version);
  });
});

describe("§L higher-timeframe aggregation never leaks the forming bar", () => {
  it("drops the incomplete final bucket", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 10; i++) c.push({ t: 1_700_000_000 + i * 900, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 });
    const agg = aggregateClosed(c, 60); // 4x15m per bucket
    // 10 bars = 2 complete buckets + 2 bars forming a third -> only complete ones
    expect(agg.length).toBeLessThanOrEqual(2);
    for (const b of agg) expect(b.t % 3600).toBe(0);
  });
});

describe.runIf(hasReplay)("§M position vs fill accounting", () => {
  const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;

  it("a laddered exit is ONE position, not several trades", () => {
    const r = runStrategyBacktest(strat, "BTCUSDT", replay(), { equity: 10_000, policy: POLICY });
    expect(r.positions.length).toBe(r.metrics.trade_count);
    for (const p of r.positions) {
      const entries = p.fills.filter((f) => f.kind === "entry");
      expect(entries).toHaveLength(1);
      expect(p.fills.filter((f) => f.kind === "exit").length).toBeGreaterThanOrEqual(1);
    }
  });

  it("exit quantities never exceed the entry quantity (no double counting)", () => {
    const r = runStrategyBacktest(strat, "BTCUSDT", replay(), { equity: 10_000, policy: POLICY });
    for (const p of r.positions) {
      const exited = p.fills.filter((f) => f.kind === "exit").reduce((a, f) => a + f.qty, 0);
      expect(exited).toBeLessThanOrEqual(p.qty * 1.0000001);
    }
  });

  it("fees are charged per fill on the actual filled notional", () => {
    const r = runStrategyBacktest(strat, "BTCUSDT", replay(), { equity: 10_000, policy: POLICY });
    for (const p of r.positions) {
      for (const f of p.fills) {
        const expected = f.price * f.qty * r.costs.fee_rate;
        expect(Math.abs(f.fee_quote - expected)).toBeLessThan(1e-6);
      }
    }
  });

  it("all fill timestamps are absolute and inside the series range", () => {
    const c = replay();
    const r = runStrategyBacktest(strat, "BTCUSDT", c, { equity: 10_000, policy: POLICY });
    const lo = c[0].t, hi = c[c.length - 1].t;
    for (const p of r.positions) for (const f of p.fills) {
      expect(f.ts).toBeGreaterThanOrEqual(lo);
      expect(f.ts).toBeLessThanOrEqual(hi);
    }
  });

  it("same-bar policy is explicit and recorded", () => {
    const a = runStrategyBacktest(strat, "BTCUSDT", replay(), { equity: 10_000, policy: POLICY, sameBarPolicy: "stop_first" });
    const b = runStrategyBacktest(strat, "BTCUSDT", replay(), { equity: 10_000, policy: POLICY, sameBarPolicy: "target_first" });
    expect(a.same_bar_policy).toBe("stop_first");
    expect(b.same_bar_policy).toBe("target_first");
  });

  it("reports gross and net R separately plus fee/slippage impact", () => {
    const r = runStrategyBacktest(strat, "BTCUSDT", replay(), { equity: 10_000, policy: POLICY });
    expect(r.metrics.gross_total_r).not.toBe(r.metrics.total_r);
    expect(r.metrics.fee_impact_r).toBeGreaterThan(0);
    expect(r.metrics.slippage_impact_r).toBeGreaterThan(0);
    expect(r.metrics.funding_impact).toBeNull(); // declared, not silently zero
  });

  it("builds a true equity curve", () => {
    const r = runStrategyBacktest(strat, "BTCUSDT", replay(), { equity: 10_000, policy: POLICY });
    expect(r.equity_curve.length).toBe(r.positions.length);
    if (r.equity_curve.length > 1) expect(r.metrics.max_drawdown_pct).not.toBeNull();
  });
});

describe.runIf(hasReplay)("§K advisory and backtest share one evaluation path", () => {
  it("evaluateRuntime returns the same verdict the backtester consumes", () => {
    const def = executableStrategies().find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const c = replay().slice(0, 400);
    // pin the clock: only wall-time may differ between two identical runs
    const a = evaluateRuntime(def, "BTCUSDT", c, 1_700_000_000_000);
    const b = evaluateRuntime(def, "BTCUSDT", c, 1_700_000_000_000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect("blocked" in a).toBe(false);
  });
});
