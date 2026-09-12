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
 * Strategies eligible to influence live advisory output.
 *
 * Deterministic executability is necessary but NOT sufficient: empirical
 * promotion (OOS/walk-forward evidence) is enforced separately by the Brain
 * gate. This function therefore returns executable candidates only; the caller
 * must still consult the runtime status before surfacing anything live.
 */
export function liveEligibleStrategies(): StrategyRuntimeDefinition[] {
  return executableStrategies();
}

export type { StrategyRuntimeDefinition };
