/**
 * Canonical conflict-state contract — the ONE deterministic interpretation of
 * "is this conflict unresolved?" used by every governance consumer.
 *
 * WHY THIS MODULE EXISTS
 * `promotion.ts` and `gate.ts` used to answer that question by testing the
 * PRESENCE of a `conflict_group_id`:
 *
 *     conflict_unresolved = record.conflict_group_id != null
 *
 * That equation is wrong. A conflict group is a durable record of competing
 * source variants; its `resolution` field says whether the competition is
 * still open. Presence of the group is orthogonal to its resolution:
 *
 *   - no conflict group                      → NOT unresolved (nothing to resolve)
 *   - group + UNRESOLVED                     → unresolved (blocks promotion)
 *   - group + OPERATOR_CHOSEN                → NOT unresolved (adjudicated by the operator)
 *   - group + EMPIRICALLY_RESOLVED           → NOT unresolved (adjudicated by evidence)
 *
 * Fixing this equation is NOT the same as lifting governance: a record whose
 * `source_status` is still CONFLICT (or that carries any other ceiling) keeps
 * being blocked by those checks. This module only answers the narrow question
 * "is the linked conflict group itself still unresolved?".
 *
 * FAIL-CLOSED RULE (UNKNOWN != PASS)
 * A linked group whose resolution cannot be established — group id present
 * but the group row is missing, the group list is unavailable, the resolution
 * value is absent/unknown, or a RESOLVED marker lacks its `chosen_variant` —
 * reports state UNKNOWN, and `isConflictUnresolved` returns TRUE for it. An
 * uncertain conflict must block, exactly like an unresolved one; it must never
 * silently pass.
 *
 * This module is pure and deterministic: no I/O, no side effects, no LLM, no
 * UI. It never deletes or rewrites conflict data — it only interprets it.
 */
import type { ConflictGroup } from "./types";

/** The only resolutions the Brain conflict registry may hold. */
export const CONFLICT_RESOLUTIONS = [
  "UNRESOLVED",
  "OPERATOR_CHOSEN",
  "EMPIRICALLY_RESOLVED",
] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

/**
 * Canonical conflict state of ONE linked record:
 * - NONE:       the record links no conflict group — nothing to resolve.
 * - UNRESOLVED: the linked group is still open — blocks promotion.
 * - RESOLVED:   the linked group was adjudicated (operator or empirical).
 * - UNKNOWN:    the linked group's resolution cannot be established from the
 *               data at hand — fail closed (blocks, like UNRESOLVED).
 */
export type ConflictState = "NONE" | "UNRESOLVED" | "RESOLVED" | "UNKNOWN";

export function isKnownResolution(v: unknown): v is ConflictResolution {
  return (
    v === "UNRESOLVED" || v === "OPERATOR_CHOSEN" || v === "EMPIRICALLY_RESOLVED"
  );
}

function hasGroupId(conflictGroupId: string | null | undefined): boolean {
  return (
    typeof conflictGroupId === "string" && conflictGroupId.trim().length > 0
  );
}

/**
 * Canonical state from a group link + its resolution value.
 *
 * Pure truth table (see module header). Any resolution that is not one of the
 * three known values — including null/undefined/"" — yields UNKNOWN when a
 * group is linked, because an unreadable resolution is not a resolved one.
 */
export function resolveConflictState(
  conflictGroupId: string | null | undefined,
  resolution: unknown,
): ConflictState {
  if (!hasGroupId(conflictGroupId)) return "NONE";
  if (resolution === "UNRESOLVED") return "UNRESOLVED";
  if (resolution === "OPERATOR_CHOSEN" || resolution === "EMPIRICALLY_RESOLVED") {
    return "RESOLVED";
  }
  return "UNKNOWN";
}

/**
 * Canonical "does this block on conflict grounds?" predicate.
 *
 * Fail-closed: UNKNOWN counts as unresolved. Callers that need to distinguish
 * "still open" from "cannot be established" should read `resolveConflictState`
 * (or `conflictStateForRecord`) directly and surface UNKNOWN as an UNKNOWN
 * verdict rather than a FAIL.
 */
export function isConflictUnresolved(
  conflictGroupId: string | null | undefined,
  resolution: unknown,
): boolean {
  const state = resolveConflictState(conflictGroupId, resolution);
  return state === "UNRESOLVED" || state === "UNKNOWN";
}

export interface RecordConflictState {
  /** canonical state (see `ConflictState`) */
  state: ConflictState;
  /** the linked group's resolution as read back, or null when unreadable */
  resolution: string | null;
  /** fail-closed predicate: true for UNRESOLVED and UNKNOWN */
  unresolved: boolean;
  /** machine-readable explanation of how the state was derived */
  detail: string;
}

/**
 * Canonical state for a record that links `conflictGroupId`, resolved against
 * the supplied conflict-group rows.
 *
 * - `groups` null/undefined with a linked id → UNKNOWN (the registry could
 *   not be read, so the resolution cannot be established).
 * - linked id absent from `groups` → UNKNOWN (dangling link, fail closed).
 * - group present but `resolution` unknown → UNKNOWN.
 * - group RESOLVED but `chosen_variant` missing → UNKNOWN: a resolution
 *   marker without its adjudication record is incomplete data, not evidence
 *   of adjudication. (UNRESOLVED groups legitimately carry no chosen variant.)
 */
export function conflictStateForRecord(
  conflictGroupId: string | null | undefined,
  groups: ConflictGroup[] | null | undefined,
): RecordConflictState {
  if (!hasGroupId(conflictGroupId)) {
    return {
      state: "NONE",
      resolution: null,
      unresolved: false,
      detail: "record links no conflict group",
    };
  }
  const id = (conflictGroupId as string).trim();
  if (!groups) {
    return {
      state: "UNKNOWN",
      resolution: null,
      unresolved: true,
      detail: `conflict group ${id} is linked but the conflict registry could not be read — resolution UNKNOWN (fail closed)`,
    };
  }
  const group = groups.find((g) => g.conflict_group_id === id);
  if (!group) {
    return {
      state: "UNKNOWN",
      resolution: null,
      unresolved: true,
      detail: `conflict group ${id} is linked but absent from the conflict registry — dangling link, resolution UNKNOWN (fail closed)`,
    };
  }
  if (!isKnownResolution(group.resolution)) {
    return {
      state: "UNKNOWN",
      resolution:
        typeof group.resolution === "string" ? group.resolution : null,
      unresolved: true,
      detail: `conflict group ${id} carries an unrecognized resolution value — resolution UNKNOWN (fail closed)`,
    };
  }
  if (
    (group.resolution === "OPERATOR_CHOSEN" ||
      group.resolution === "EMPIRICALLY_RESOLVED") &&
    (group.chosen_variant === null ||
      group.chosen_variant === undefined ||
      String(group.chosen_variant).trim().length === 0)
  ) {
    return {
      state: "UNKNOWN",
      resolution: group.resolution,
      unresolved: true,
      detail: `conflict group ${id} is marked ${group.resolution} but records no chosen_variant — incomplete adjudication data, resolution UNKNOWN (fail closed)`,
    };
  }
  if (group.resolution === "UNRESOLVED") {
    return {
      state: "UNRESOLVED",
      resolution: group.resolution,
      unresolved: true,
      detail: `conflict group ${id} is UNRESOLVED — competing source variants must be adjudicated, never averaged`,
    };
  }
  return {
    state: "RESOLVED",
    resolution: group.resolution,
    unresolved: false,
    detail: `conflict group ${id} resolved via ${group.resolution} (chosen: ${String(group.chosen_variant)})`,
  };
}
