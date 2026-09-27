import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  riskPolicySaveSelection,
  riskPolicySelectValue,
  UNSELECTED_RISK_POLICY_ID,
  UNSELECTED_RISK_POLICY_OPTION,
} from "../src/lib/risk/selection-ui";
import { buildRiskPolicies } from "../src/lib/brain/policies";
import { riskPolicyEligibility } from "../src/lib/risk/policy";

describe("operator risk-policy settings", () => {
  it("maps the API's no-policy sentinel to the actual UNSELECTED select option", () => {
    expect(riskPolicySelectValue(null, undefined, UNSELECTED_RISK_POLICY_ID)).toBe(UNSELECTED_RISK_POLICY_OPTION);
    expect(riskPolicySelectValue(null, undefined, undefined)).toBe(UNSELECTED_RISK_POLICY_OPTION);
  });

  it("requires COMPLETE identity-bound source material and exact cited excerpts for production eligibility", () => {
    const policies = buildRiskPolicies();
    for (const policy of policies) {
      for (const ref of policy.source_refs) {
        const sourcePath = `knowledge/raw/RAW_${ref.file.replace(/\.txt$/, "")}.txt`;
        const lines = fs.readFileSync(sourcePath, "utf8").split("\n");
        expect(Number.isSafeInteger(ref.start_line), `${policy.policy_id} ${ref.file}`).toBe(true);
        expect(lines.slice(ref.start_line - 1, ref.end_line).join("\n"), `${policy.policy_id} ${ref.file}:${ref.start_line}-${ref.end_line}`).toContain(ref.quote);
      }
    }

    const daily = policies.find((policy) => policy.policy_id === "RISK-DAILY-5PCT")!;
    const dailyEligibility = riskPolicyEligibility(daily);
    expect(dailyEligibility.source_completeness).toEqual({ "4.txt": "TRUNCATED" });
    expect(dailyEligibility.selectable).toBe(false);
    expect(dailyEligibility.reasons.join(" ")).toMatch(/4.txt completeness is TRUNCATED/);

    const onePercent = policies.find((policy) => policy.policy_id === "RISK-1PCT-PER-TRADE")!;
    const onePercentEligibility = riskPolicyEligibility(onePercent);
    expect(onePercentEligibility.source_completeness).toEqual({ "5.txt": "UNKNOWN", "4.txt": "TRUNCATED" });
    expect(onePercentEligibility.selectable).toBe(false);
  });

  it("preserves a stored preference or selected environment policy", () => {
    expect(riskPolicySelectValue(null, "RISK-DAILY-5PCT", "RISK-POLICY-UNSELECTED")).toBe("RISK-DAILY-5PCT");
    expect(riskPolicySelectValue(null, undefined, "RISK-DAILY-5PCT")).toBe("RISK-DAILY-5PCT");
  });

  it("does not resubmit or silently clear a policy when only sizing inputs are saved", () => {
    expect(riskPolicySaveSelection(null, UNSELECTED_RISK_POLICY_OPTION)).toEqual({});
    expect(riskPolicySaveSelection(null, "RISK-DAILY-5PCT")).toEqual({});
  });

  it("persists only an explicit policy change, including explicit clear", () => {
    expect(riskPolicySaveSelection("UNSELECTED", UNSELECTED_RISK_POLICY_OPTION)).toEqual({ policyId: null });
    expect(riskPolicySaveSelection("RISK-DAILY-5PCT", "RISK-DAILY-5PCT")).toEqual({ policyId: "RISK-DAILY-5PCT" });
  });

  it("keeps operator risk values blank in the example environment rather than supplying generic limits", () => {
    const example = fs.readFileSync(".env.example", "utf8");
    expect(example).toMatch(/^ASA_RISK_ACCOUNT_EQUITY=$/m);
    expect(example).toMatch(/^ASA_RISK_PER_TRADE_PCT=$/m);
    expect(example).toMatch(/^ASA_RISK_MAX_LEVERAGE=$/m);
    expect(example).not.toMatch(/^ASA_RISK_(?:ACCOUNT_EQUITY|PER_TRADE_PCT|MAX_LEVERAGE)=\S+/m);
  });
});
