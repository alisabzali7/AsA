/**
 * Brain-lineage governance for COMPILED_STRATEGIES (audit mandate B8).
 *
 * The runtime adapter claims `strategy_id` is "identical to the Brain
 * StrategyRecord id" — but until now NOTHING verified that claim. A compiled
 * strategy with a typo'd id, a stale corpus binding, or a family drift would
 * still execute while presenting corpus `source_refs` as if it were
 * brain-governed.
 *
 * This module makes the binding EXPLICIT and machine-checkable:
 *
 *   compiled strategy  --strategy_id-->  Brain StrategyRecord
 *                        --family------>  same corpus family
 *                        --source_refs->  overlapping file + line range
 *
 * It is a PURE function over records (no I/O) so tests can feed it an ingested
 * temp brain, and the API can feed it the live brain store.
 */
import { COMPILED_STRATEGIES } from "./compiled";
import type { StrategyRecord } from "../brain/types";
import type { SourceRef } from "../brain/types";

export type LineageViolationKind =
  | "MISSING_BRAIN_RECORD"
  | "FAMILY_MISMATCH"
  | "NO_SOURCE_OVERLAP";

export interface LineageViolation {
  strategy_id: string;
  setup_id: string;
  kind: LineageViolationKind;
  detail: string;
}

export interface LineageReport {
  /** number of compiled strategy entries checked (direction variants included) */
  checked: number;
  /** distinct brain strategy ids covered */
  brain_strategy_ids: string[];
  violations: LineageViolation[];
  ok: boolean;
}

function refsOverlap(a: SourceRef[], b: SourceRef[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x.file !== y.file) continue;
      const xs = x.start_line ?? 0;
      const xe = x.end_line ?? xs;
      const ys = y.start_line ?? 0;
      const ye = y.end_line ?? ys;
      if (xs <= ye && ys <= xe) return true;
    }
  }
  return false;
}

/**
 * Verify every COMPILED_STRATEGIES entry is governed by a Brain
 * StrategyRecord: the record exists, the family matches, and the compiled
 * setup's source references overlap the record's provenance in the same
 * corpus file.
 */
export function verifyCompiledLineage(records: StrategyRecord[]): LineageReport {
  const byId = new Map(records.map((r) => [r.strategy_id, r]));
  const violations: LineageViolation[] = [];
  const ids = new Set<string>();

  for (const c of COMPILED_STRATEGIES) {
    ids.add(c.strategy_id);
    const rec = byId.get(c.strategy_id);
    if (!rec) {
      violations.push({
        strategy_id: c.strategy_id,
        setup_id: c.setup_id,
        kind: "MISSING_BRAIN_RECORD",
        detail: `no Brain StrategyRecord with id '${c.strategy_id}' — the compiled strategy has NO brain lineage and must not present corpus source_refs`,
      });
      continue;
    }
    if (rec.family !== c.family) {
      violations.push({
        strategy_id: c.strategy_id,
        setup_id: c.setup_id,
        kind: "FAMILY_MISMATCH",
        detail: `compiled family '${c.family}' != brain family '${rec.family}'`,
      });
    }
    const setupRefs = c.setup().source_refs;
    if (!refsOverlap(setupRefs, rec.source_refs)) {
      violations.push({
        strategy_id: c.strategy_id,
        setup_id: c.setup_id,
        kind: "NO_SOURCE_OVERLAP",
        detail: `compiled setup cites [${setupRefs.map((r) => `${r.file}:${r.start_line}-${r.end_line}`).join(", ")}] but the brain record cites [${rec.source_refs.map((r) => `${r.file}:${r.start_line}-${r.end_line}`).join(", ")}] — no overlap`,
      });
    }
  }

  return {
    checked: COMPILED_STRATEGIES.length,
    brain_strategy_ids: [...ids],
    violations,
    ok: violations.length === 0,
  };
}
