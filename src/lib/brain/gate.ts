/**
 * Runtime status gate — the single chokepoint that decides whether a knowledge
 * object may influence live advisory output.
 *
 * This module exists so the "disabled strategies cannot become live" invariant
 * is enforced by ONE tested function rather than scattered `if` statements.
 * Nothing else in the codebase may set runtime_status directly.
 */
import type {
  CriticalSpecField,
  EmpiricalStatus,
  RuntimeStatus,
  SourceStatus,
  StrategyRecord,
} from "./types";

export interface GateInput {
  source_status: SourceStatus;
  empirical_status: EmpiricalStatus;
  unknown_critical: CriticalSpecField[];
  /** an unresolved conflict group blocks live promotion */
  conflict_unresolved: boolean;
  /** a formal executable binding must exist */
  has_implementation: boolean;
}

export interface GateVerdict {
  allowed: RuntimeStatus;
  reasons: string[];
  /** the highest status this object could ever reach given current evidence */
  ceiling: RuntimeStatus;
}

const ORDER: RuntimeStatus[] = ["DISABLED", "CANDIDATE", "PAPER", "LIVE_ADVISORY_ONLY"];

function minStatus(a: RuntimeStatus, b: RuntimeStatus): RuntimeStatus {
  return ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b;
}

/**
 * Compute the maximum runtime status an object may hold.
 *
 * Hard blocks (can never be overridden by config, AI, or the UI):
 *  - any unresolved critical UNKNOWN (entry/stop/target/timeframe/invalidation)
 *  - SourceStatus UNKNOWN or CONFLICT (unresolved)
 *  - a CLAIM that has not been empirically tested
 *  - no executable implementation binding
 *
 * Empirical gating (governance: never infer empirical from source):
 *  - UNTESTED  -> at most CANDIDATE
 *  - BACKTESTED -> at most PAPER  (in-sample only is not enough for advisory)
 *  - OOS_TESTED / WALK_FORWARD / ROBUST -> may reach LIVE_ADVISORY_ONLY
 *  - REJECTED  -> DISABLED
 */
export function evaluateGate(input: GateInput): GateVerdict {
  const reasons: string[] = [];
  let ceiling: RuntimeStatus = "LIVE_ADVISORY_ONLY";

  if (input.unknown_critical.length > 0) {
    ceiling = "DISABLED";
    reasons.push(
      `critical spec fields are UNKNOWN in source: ${input.unknown_critical.join(", ")} — the corpus never states them and AsA must not invent them`,
    );
  }

  if (input.source_status === "UNKNOWN") {
    ceiling = minStatus(ceiling, "DISABLED");
    reasons.push("source_status=UNKNOWN — no usable source statement");
  }

  if (input.source_status === "CONFLICT" || input.conflict_unresolved) {
    ceiling = minStatus(ceiling, "DISABLED");
    reasons.push("unresolved CONFLICT — competing source variants must be adjudicated by the operator, never averaged");
  }

  if (input.source_status === "CLAIM" && input.empirical_status === "UNTESTED") {
    ceiling = minStatus(ceiling, "DISABLED");
    reasons.push("instructor CLAIM with no empirical test — a claim is not evidence");
  }

  if (!input.has_implementation) {
    ceiling = minStatus(ceiling, "CANDIDATE");
    reasons.push("no executable implementation binding — cannot be evaluated deterministically");
  }

  switch (input.empirical_status) {
    case "REJECTED":
      ceiling = "DISABLED";
      reasons.push("empirical_status=REJECTED");
      break;
    case "UNTESTED":
      ceiling = minStatus(ceiling, "CANDIDATE");
      reasons.push("empirical_status=UNTESTED — never promoted on source strength alone");
      break;
    case "BACKTESTED":
      ceiling = minStatus(ceiling, "PAPER");
      reasons.push("in-sample BACKTESTED only — needs OOS/walk-forward for advisory");
      break;
    case "OOS_TESTED":
    case "WALK_FORWARD":
    case "ROBUST":
      break;
  }

  if (reasons.length === 0) reasons.push("all gates passed");
  return { allowed: ceiling, ceiling, reasons };
}

/** Convenience wrapper for a full strategy record. */
export function gateStrategy(s: StrategyRecord, conflictUnresolved = false): GateVerdict {
  return evaluateGate({
    source_status: s.source_status,
    empirical_status: s.empirical_status,
    unknown_critical: s.unknown_critical,
    conflict_unresolved: conflictUnresolved || s.conflict_group_id !== null,
    has_implementation: s.implementation !== null,
  });
}

/** True only when the object may contribute to live advisory signals. */
export function canGoLive(v: GateVerdict): boolean {
  return v.allowed === "LIVE_ADVISORY_ONLY";
}

/**
 * Clamp a REQUESTED runtime status to what the evidence permits. Any caller
 * attempting to raise status beyond the ceiling is silently (and loudly, via
 * the returned reasons) clamped down.
 */
export function clampRuntimeStatus(requested: RuntimeStatus, verdict: GateVerdict): RuntimeStatus {
  return minStatus(requested, verdict.ceiling);
}
