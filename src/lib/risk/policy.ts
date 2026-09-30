/**
 * Source-bound production risk-policy selection. Explicit selection is
 * necessary but not sufficient: unresolved conflicts, inferred values, absent
 * provenance, incomplete source documents, and invalid source bindings remain
 * blocked.
 */
import fs from "node:fs";
import path from "node:path";
import { getRepo } from "@/db/sqlite";
import { buildRiskPolicies } from "../brain/policies";
import type { RiskPolicy } from "../brain/types";
import { sourceContractDocumentIdentity } from "../strategy/compiled/source-contract";

export const RISK_POLICY_VERSION = "4.0.0";
export type RiskPolicySelectionStatus = "SELECTED" | "UNSELECTED" | "BLOCKED";
export type RiskPolicySelectionSource = "operator_pref" | "environment" | "none";
export type RiskPolicySourceCompleteness = "COMPLETE" | "TRUNCATED" | "UNKNOWN" | "INVALID" | "NOT_PRESENT";
export type RiskPolicySourceInventory = Record<string, RiskPolicySourceCompleteness>;

export type ProductionRiskPolicy = RiskPolicy & {
  selection_status: RiskPolicySelectionStatus;
  selected_by: RiskPolicySelectionSource;
  selection_reason: string;
  policy_version: string;
  /** Exact completeness status for every cited source file. */
  source_completeness: RiskPolicySourceInventory;
};

export interface RiskPolicyEligibility {
  selectable: boolean;
  status: RiskPolicy["source_status"] | "DISABLED";
  reasons: string[];
  source_completeness: RiskPolicySourceInventory;
}

const SOURCE_LINES = new Map<string, string[] | null>();

function linesForSource(relativePath: string): string[] | null {
  if (SOURCE_LINES.has(relativePath)) return SOURCE_LINES.get(relativePath) ?? null;
  const root = path.resolve(/*turbopackIgnore: true*/ process.cwd());
  const full = path.resolve(/*turbopackIgnore: true*/ root, relativePath);
  if (!full.startsWith(`${root}${path.sep}`)) {
    SOURCE_LINES.set(relativePath, null);
    return null;
  }
  try {
    const lines = fs.readFileSync(full, "utf8").split("\n");
    SOURCE_LINES.set(relativePath, lines);
    return lines;
  } catch {
    SOURCE_LINES.set(relativePath, null);
    return null;
  }
}

function inspectPolicySources(policy: RiskPolicy): { statuses: RiskPolicySourceInventory; reasons: string[] } {
  const identity = sourceContractDocumentIdentity();
  const statuses: RiskPolicySourceInventory = {};
  const reasons: string[] = [];
  if (identity.status !== "VALID") {
    for (const ref of policy.source_refs) statuses[ref.file] = "INVALID";
    if (policy.source_refs.length > 0) reasons.push("source-contract identity is INVALID; cited source completeness cannot be trusted");
    return { statuses, reasons };
  }

  const byId = new Map(identity.source_bindings.map((binding) => [binding.file_id, binding]));
  for (const ref of policy.source_refs) {
    const binding = byId.get(ref.file);
    if (!binding) {
      statuses[ref.file] = "NOT_PRESENT";
      reasons.push(`source ${ref.file} has no exact identity binding`);
      continue;
    }

    statuses[ref.file] = binding.completeness;
    if (binding.completeness !== "COMPLETE") {
      reasons.push(`source ${ref.file} completeness is ${binding.completeness}; production policy selection requires COMPLETE source material`);
    }
    if (!Number.isSafeInteger(ref.start_line) || !Number.isSafeInteger(ref.end_line) || ref.start_line < 1 || ref.end_line < ref.start_line || ref.end_line > binding.lines) {
      reasons.push(`source reference ${ref.file}:${ref.start_line}-${ref.end_line} is outside its identity-bound source lines`);
      continue;
    }
    if (typeof ref.quote !== "string" || ref.quote.length === 0) {
      reasons.push(`source reference ${ref.file}:${ref.start_line}-${ref.end_line} has no exact quoted evidence`);
      continue;
    }
    const sourceLines = linesForSource(binding.path);
    if (!sourceLines) {
      statuses[ref.file] = "INVALID";
      reasons.push(`identity-bound source bytes are unavailable for ${ref.file}`);
      continue;
    }
    const excerpt = sourceLines.slice(ref.start_line - 1, ref.end_line).join("\n");
    if (!excerpt.includes(ref.quote)) {
      reasons.push(`quoted evidence does not match ${ref.file}:${ref.start_line}-${ref.end_line}`);
    }
  }
  return { statuses, reasons };
}

export function riskPolicyEligibility(policy: RiskPolicy): RiskPolicyEligibility {
  const reasons: string[] = [];
  if (policy.source_status !== "SOURCE_VERIFIED") reasons.push(`source status is ${policy.source_status}, not SOURCE_VERIFIED`);
  if (policy.source_refs.length === 0) reasons.push("no exact source references");
  if (policy.conflict_group_id !== null) reasons.push(`linked to unresolved source conflict ${policy.conflict_group_id}`);
  if (policy.runtime_status === "DISABLED") reasons.push("runtime status is DISABLED");
  const sourceAudit = inspectPolicySources(policy);
  reasons.push(...sourceAudit.reasons);
  return {
    selectable: reasons.length === 0,
    status: policy.runtime_status === "DISABLED" ? "DISABLED" : policy.source_status,
    reasons: [...new Set(reasons)],
    source_completeness: sourceAudit.statuses,
  };
}

function unselected(status: "UNSELECTED" | "BLOCKED", reason: string, selectedBy: RiskPolicySelectionSource): ProductionRiskPolicy {
  return {
    policy_id: "RISK-POLICY-UNSELECTED",
    canonical_name: "No production risk policy selected",
    risk_per_trade_pct: null,
    daily_loss_limit_pct: null,
    max_account_risk_pct: null,
    period_loss_limit_pct: null,
    max_leverage: null,
    max_concurrent_positions: null,
    source_refs: [],
    source_status: "UNKNOWN",
    conflict_group_id: null,
    runtime_status: "DISABLED",
    notes: "No policy was selected; no risk defaults are substituted.",
    selection_status: status,
    selected_by: selectedBy,
    selection_reason: reason,
    policy_version: RISK_POLICY_VERSION,
    source_completeness: {},
  };
}

/** Resolve one explicit operator/environment selection; never choose a fallback. */
export function getProductionRiskPolicy(): ProductionRiskPolicy {
  const all = buildRiskPolicies();
  let dbSelection: string | null = null;
  try { dbSelection = getRepo().configGet("pref.risk.policyId"); } catch { /* explicit environment setting may still resolve */ }

  const envSelection = process.env.ASA_RISK_POLICY_ID?.trim() ?? "";
  const selectedBy: RiskPolicySelectionSource = dbSelection !== null ? "operator_pref" : envSelection ? "environment" : "none";
  const requested = dbSelection !== null ? (dbSelection.trim() === "UNSELECTED" ? "" : dbSelection.trim()) : envSelection;
  if (!requested) return unselected("UNSELECTED", "no risk policy selected; configure one explicitly before risk evaluation", selectedBy);

  const chosen = all.find((policy) => policy.policy_id === requested);
  if (!chosen) return unselected("BLOCKED", `selected risk policy '${requested}' is not registered; refusing fallback`, selectedBy);
  const eligibility = riskPolicyEligibility(chosen);
  if (!eligibility.selectable) {
    return {
      ...chosen,
      selection_status: "BLOCKED",
      selected_by: selectedBy,
      selection_reason: `selected policy ${requested} is blocked: ${eligibility.reasons.join("; ")}`,
      policy_version: RISK_POLICY_VERSION,
      source_completeness: eligibility.source_completeness,
    };
  }
  return {
    ...chosen,
    selection_status: "SELECTED",
    selected_by: selectedBy,
    selection_reason: `explicitly selected ${requested} via ${selectedBy}; source policy is unchanged`,
    policy_version: RISK_POLICY_VERSION,
    source_completeness: eligibility.source_completeness,
  };
}

/** Full catalog is for audit only; callers must use riskPolicyEligibility before selection. */
export function selectableRiskPolicies(): RiskPolicy[] {
  return buildRiskPolicies();
}
