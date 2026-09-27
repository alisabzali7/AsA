/** Pure helpers for the operator risk-policy control; safe to import in the browser. */
export const UNSELECTED_RISK_POLICY_OPTION = "UNSELECTED";
export const UNSELECTED_RISK_POLICY_ID = "RISK-POLICY-UNSELECTED";

/**
 * Map the API's explicit no-policy record to the UI's real select option.
 * A DB preference, including a blocked one, remains visible until the operator
 * changes it; an unchanged control never rewrites the persisted selection.
 */
export function riskPolicySelectValue(
  draft: string | null,
  preference: string | undefined,
  resolvedPolicyId: string | undefined,
): string {
  if (draft !== null) return draft;
  if (preference !== undefined) return preference;
  if (!resolvedPolicyId || resolvedPolicyId === UNSELECTED_RISK_POLICY_ID) {
    return UNSELECTED_RISK_POLICY_OPTION;
  }
  return resolvedPolicyId;
}

/** Only an explicit UI change is allowed to mutate policy selection. */
export function riskPolicySaveSelection(
  draft: string | null,
  selectedValue: string,
): { policyId?: string | null } {
  if (draft === null) return {};
  return {
    policyId: selectedValue === UNSELECTED_RISK_POLICY_OPTION ? null : selectedValue,
  };
}
