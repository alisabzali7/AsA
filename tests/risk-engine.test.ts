/**
 * Deterministic risk engine tests + hard-gate semantics.
 */
import { describe, expect, it } from "vitest";
import { evaluateRisk } from "../src/lib/risk/engine";

const base = {
  symbol: "BTCUSDT",
  direction: "long" as const,
  entry: 100_000,
  stop: 99_000, // 1% stop
  equity: 10_000,
  riskPerTradePct: 1,
  maxLeverage: 5,
  venueMaxLeverage: 50,
  maintenanceMarginRate: 0.004,
  takerFeeCoefficient: 0.0004,
};

describe("evaluateRisk", () => {
  it("passes a sane long and computes the sizing numbers", () => {
    const r = evaluateRisk(base);
    expect(r.verdict).toBe("pass");
    expect(r.numbers.risk_notional).toBe(100); // 1% of 10k
    expect(r.numbers.suggested_size_base).toBeCloseTo(0.1, 6); // 100 / 1000 stop distance
    expect(r.numbers.notional).toBeCloseTo(10_000, 2);
    expect(r.numbers.leverage_estimate).toBeCloseTo(1, 3);
    expect(r.numbers.stop_distance_pct).toBeCloseTo(1, 3);
    expect(r.numbers.liq_label).toBe("ESTIMATE"); // never presented as venue fact
    expect(r.numbers.liq_estimate).not.toBeNull();
    expect(r.numbers.liq_estimate!).toBeLessThan(base.entry); // long: liq below entry
  });

  it("blocks when estimated leverage exceeds the AsA cap", () => {
    // leverage is determined by stop width: lev = riskPct * entry / stopAbs
    // (equity cancels out), so we vary the stop, not the equity.
    // exactly at the cap: stopAbs = 0.01*100000/5 = 200 -> stop 99_800
    const atCap = evaluateRisk({ ...base, stop: 99_800 });
    expect(atCap.numbers.leverage_estimate).toBeCloseTo(5, 3);
    expect(atCap.verdict).toBe("pass"); // <= cap passes
    // above the cap: stopAbs 190 -> lev ~5.26x
    const over = evaluateRisk({ ...base, stop: 99_810 });
    expect(over.verdict).toBe("block");
    expect(over.reasons.join(" ")).toContain("AsA cap");
  });

  it("blocks when the stop sits beyond the ESTIMATE liquidation price", () => {
    // high-tier maintenance margin (2%) + 10% risk per trade make the veto the
    // binding constraint: leverage 47.6x is under the 50x cap, but the stop at
    // 99_790 lies beyond the ESTIMATE liquidation (≈99_900 on a 100_000 entry).
    const r = evaluateRisk({ ...base, maintenanceMarginRate: 0.02, riskPerTradePct: 10, stop: 99_790 });
    expect(r.numbers.leverage_estimate).toBeLessThanOrEqual(50);
    expect(r.numbers.liq_estimate).not.toBeNull();
    expect(r.numbers.liq_label).toBe("ESTIMATE"); // never presented as venue fact
    expect(r.verdict).toBe("block");
    expect(r.reasons.join(" ")).toMatch(/ESTIMATED liquidation/);
    expect(r.reasons.join(" ")).toMatch(/estimate, not a venue fact/);
  });

  it("never fabricates a liquidation number when leverage is unknown", () => {
    const r = evaluateRisk({ ...base, maintenanceMarginRate: null });
    expect(r.numbers.liq_estimate).toBeNull();
    expect(r.numbers.liq_label).toBeNull();
  });

  it("labels short-side liquidation above entry", () => {
    const r = evaluateRisk({ ...base, direction: "short" });
    expect(r.numbers.liq_estimate!).toBeGreaterThan(base.entry);
  });

  it("includes fee assumptions from the TTT catalog coefficients", () => {
    const r = evaluateRisk(base);
    expect(r.numbers.fees_roundtrip_pct).toBeCloseTo(0.08, 6); // 0.04% taker x2
  });
});
