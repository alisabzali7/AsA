/**
 * Strategy registry — BRAIN-BACKED (closure §B).
 *
 * The production strategy source of truth is now the Brain runtime adapter
 * (`strategy/runtime.ts`). This module remains as the historical entry point
 * so existing callers keep working, but it no longer owns any strategy
 * definitions of its own.
 *
 * The former reference/test harness has been REMOVED from the production build
 * graph entirely (remediation P1). It now lives under the tests fixtures tree
 * and is importable only by tests, so no production module can depend on a
 * test fixture.
 */
import {
  executableStrategies, getRuntimeStrategy, listRuntimeStrategies,
  type StrategyRuntimeDefinition,
} from "./runtime";

/** Brain-backed production strategies. */
export function listStrategies(): StrategyRuntimeDefinition[] {
  return listRuntimeStrategies();
}

/** Resolve a production strategy by setup_id or Brain strategy_id. */
export function getStrategy(id: string): StrategyRuntimeDefinition | undefined {
  return getRuntimeStrategy(id);
}

/**
 * AUDIT FIX (P1-9, mandate B9): renamed from `liveEligibleStrategies()`.
 *
 * The old name lied: deterministic EXECUTABILITY is necessary but NOT
 * sufficient for live advisory. Empirical promotion (OOS/walk-forward
 * evidence, enforced by the Brain gate via `runtimeStatusFor`) is what makes a
 * strategy live-eligible, and no compiled strategy currently holds it. The
 * misleading name could have let an API expose executable-but-unvalidated
 * strategies as "live".
 *
 * Returns the EXECUTABLE CANDIDATES only. Callers that surface anything as
 * live-eligible MUST additionally consult the runtime status gate.
 */
export function executableStrategyCandidates(): StrategyRuntimeDefinition[] {
  return executableStrategies();
}

export type { StrategyRuntimeDefinition };
