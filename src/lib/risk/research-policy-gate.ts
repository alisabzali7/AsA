/**
 * THE ONE definition of "this selected risk policy may back a research /
 * backtest run".
 *
 * Remediation 2026-09-30: the same condition was written out three times —
 * in `backtest/strategy-runner.ts` (which threw), in `backtest/engine.ts`
 * (which returned a structured refusal) and in
 * `app/api/research/backtest/route.ts` (which returned HTTP 409). The three
 * copies had drifted: only the runner also rejected a policy whose
 * `runtime_status` is `DISABLED`, so a disabled policy passed the engine's and
 * the route's validation and then surfaced as an uncaught `Error`/HTTP 500
 * instead of an explained refusal. Three parallel statements of one system
 * truth is exactly the drift this module removes.
 *
 * This module is intentionally dependency-free (type-only import) so every
 * layer — including the pure backtest runner — can share it without pulling in
 * storage or environment access.
 */
import type { ProductionRiskPolicy } from "./policy";

/**
 * Every reason the supplied policy may NOT back a research/backtest run.
 * An empty array means the policy is usable. The reasons are deterministic and
 * ordered so callers can render or join them without re-sorting.
 */
export function researchRiskPolicyBlockers(policy: ProductionRiskPolicy | null | undefined): string[] {
  if (!policy) return ["no risk policy supplied"];
  const blockers: string[] = [];
  if (policy.selection_status !== "SELECTED") {
    blockers.push(`risk policy ${policy.policy_id} is not explicitly selected (${policy.selection_status})`);
  }
  if (policy.source_status !== "SOURCE_VERIFIED") {
    blockers.push(`risk policy ${policy.policy_id} source status is ${policy.source_status}, not SOURCE_VERIFIED`);
  }
  if (!Array.isArray(policy.source_refs) || policy.source_refs.length === 0) {
    blockers.push(`risk policy ${policy.policy_id} carries no exact source references`);
  }
  if (policy.conflict_group_id !== null) {
    blockers.push(`risk policy ${policy.policy_id} is linked to unresolved source conflict ${policy.conflict_group_id}`);
  }
  if (policy.runtime_status === "DISABLED") {
    blockers.push(`risk policy ${policy.policy_id} runtime status is DISABLED`);
  }
  return blockers;
}

/** Convenience predicate; the reasons are always available via the function above. */
export function researchRiskPolicyUsable(policy: ProductionRiskPolicy | null | undefined): boolean {
  return researchRiskPolicyBlockers(policy).length === 0;
}
