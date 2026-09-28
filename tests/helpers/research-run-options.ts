import { buildRiskPolicies } from "../../src/lib/brain/policies";
import { RISK_POLICY_VERSION, riskPolicyEligibility, type ProductionRiskPolicy } from "../../src/lib/risk/policy";
import type { RiskPolicy } from "../../src/lib/brain/types";
import type { RunOptions } from "../../src/lib/backtest/strategy-runner";

/**
 * Test-only selection that bypasses production source-completeness eligibility
 * so the deterministic risk/backtest math can be exercised. It carries the
 * real (currently incomplete) source status and is never used as a product
 * fallback or as evidence that a production policy is eligible.
 */
type TestOnlyRiskDimensionOverrides = Partial<Pick<RiskPolicy,
  | "risk_per_trade_pct"
  | "daily_loss_limit_pct"
  | "max_account_risk_pct"
  | "period_loss_limit_pct"
  | "max_leverage"
  | "max_concurrent_positions"
>>;

export function testOnlySourceRiskPolicy(
  policyId: string,
  overrides: TestOnlyRiskDimensionOverrides = {},
): ProductionRiskPolicy {
  const sourcePolicy = buildRiskPolicies().find((candidate) => candidate.policy_id === policyId);
  if (!sourcePolicy || sourcePolicy.source_status !== "SOURCE_VERIFIED" || sourcePolicy.source_refs.length === 0) {
    throw new Error(`test fixture requires source-verified policy ${policyId}`);
  }
  return {
    ...sourcePolicy,
    selection_status: "SELECTED",
    selected_by: "operator_pref",
    selection_reason: `TEST ONLY: ${policyId}; production completeness eligibility is bypassed for deterministic math coverage`,
    policy_version: RISK_POLICY_VERSION,
    source_completeness: riskPolicyEligibility(sourcePolicy).source_completeness,
    ...overrides,
  };
}

// Test-only variant for sizing/fill calculations: the real source-completeness
// metadata is retained, but the daily-loss dimension is omitted because the
// historical runner does not reconstruct daily account-currency loss. This is
// not production eligibility or a source claim. The 11% observation is never a
// maximum, and the test policy adds no account/period/concurrency limits.
export const TEST_ONLY_SOURCE_RISK_MATH_POLICY = testOnlySourceRiskPolicy("RISK-DAILY-5PCT", {
  daily_loss_limit_pct: null,
});
export const TEST_ONLY_SOURCE_DAILY_RISK_POLICY = testOnlySourceRiskPolicy("RISK-DAILY-5PCT");

export function explicitResearchRunOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    equity: 10_000,
    policy: TEST_ONLY_SOURCE_RISK_MATH_POLICY,
    riskPerTradePct: 1,
    maxLeverage: 5,
    costs: { fee_rate: 0.0002, slippage_rate: 0.0001 },
    sameBarPolicy: "stop_first",
    max_hold_bars: 120,
    ...overrides,
  };
}
