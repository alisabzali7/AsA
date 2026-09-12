/**
 * Production risk-policy selection (closure §H).
 *
 * The corpus states CONFLICTING risk percentages (2% fixed, 1% normal, a 2%
 * ceiling, a 5% tolerance example, plus 5% daily / 11% account / 15% period
 * limits). We never hard-code one of them as universal truth and we never
 * average them.
 *
 * Instead the operator explicitly selects a policy id via `ASA_RISK_POLICY_ID`.
 * The default is the conservative engineering composite, which is clearly
 * labelled SOURCE_INFERRED and carries no source refs so it can never be
 * mistaken for an instructor statement.
 */
import { buildRiskPolicies } from "../brain/policies";
import type { RiskPolicy } from "../brain/types";

export const RISK_POLICY_VERSION = "1.0.0";
export const DEFAULT_RISK_POLICY_ID = "RISK-ASA-CONSERVATIVE-DEFAULT";

/**
 * Resolve the active production risk policy.
 * An unknown id is a configuration error and falls back to the conservative
 * default with a loud reason rather than silently inventing limits.
 */
export function getProductionRiskPolicy(): RiskPolicy & { selection_reason: string; policy_version: string } {
  const all = buildRiskPolicies();
  const requested = process.env.ASA_RISK_POLICY_ID?.trim();
  const chosen = requested ? all.find((p) => p.policy_id === requested) : undefined;
  const fallback = all.find((p) => p.policy_id === DEFAULT_RISK_POLICY_ID)!;

  if (requested && !chosen) {
    return {
      ...fallback,
      selection_reason: `ASA_RISK_POLICY_ID='${requested}' does not match any registered policy — falling back to ${DEFAULT_RISK_POLICY_ID}`,
      policy_version: RISK_POLICY_VERSION,
    };
  }
  if (chosen) {
    return {
      ...chosen,
      selection_reason: `operator-selected via ASA_RISK_POLICY_ID=${chosen.policy_id}`,
      policy_version: RISK_POLICY_VERSION,
    };
  }
  return {
    ...fallback,
    selection_reason: `default conservative composite (SOURCE_INFERRED, not an instructor statement); set ASA_RISK_POLICY_ID to choose a source policy explicitly`,
    policy_version: RISK_POLICY_VERSION,
  };
}

/** All selectable policies, for the settings UI / audit. */
export function selectableRiskPolicies(): RiskPolicy[] {
  return buildRiskPolicies();
}
