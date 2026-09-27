/**
 * Stage 3 — compile brain StrategyRecords into EXECUTABLE setups.
 *
 * A record only becomes executable when the corpus itself supplied every
 * critical field. We never synthesize a missing entry/stop/target: if the
 * source said UNKNOWN, the strategy stays DISABLED and says exactly why.
 *
 * Field-level source labels are preserved: `[VERIFIED]` vs `[INFERRED]` on a
 * given line (e.g. PRZ Bounce has VERIFIED entry but INFERRED stop/target) is
 * carried into `field_status` so the UI can show that the stop model came from
 * an inference in the transcript rather than an explicit instruction.
 */
import type { SetupSpec, SourceRef, StrategyFamily, StrategyRecord } from "./types";
import type { ParsedStrategyBlock } from "./classify";

export type FieldSourceLabel = "VERIFIED" | "INFERRED" | "SOURCE_NAMED" | "UNKNOWN" | "CONFLICT" | "CLAIM";
export type SourceCompleteness = "COMPLETE" | "PARTIAL" | "UNKNOWN" | "CONFLICTING" | "NOT_PRESENT";

export interface CompiledSpec {
  strategy_id: string;
  canonical_name: string;
  family: StrategyFamily;
  timeframe: string | null;
  entry_long: string | null;
  entry_short: string | null;
  /** A generic source entry is retained verbatim and never mapped to either side. */
  generic_entry: string | null;
  prerequisites: string | null;
  confirmation: string | null;
  stop: string | null;
  target: string | null;
  exit: string | null;
  filters: string | null;
  exclusions: string | null;
  /** per-field provenance label taken from the source line's own marker */
  field_status: Record<string, FieldSourceLabel>;
  field_lines: Record<string, number>;
  /** all repeated field occurrences with exact source line and epistemic label */
  field_occurrences: Record<string, { value: string; line: number; status: FieldSourceLabel }[]>;
  source_completeness: SourceCompleteness;
  formalization_status: "SOURCE_SPEC_ONLY";
  source_refs: SourceRef[];
  executable: boolean;
  blocked_because: string[];
  /**
   * Direction anomalies detected in the SOURCE itself (closure §A5).
   * The corpus contains at least one block (STR-RAW-4-2425) whose `entry_long`
   * field describes a SELL action. We surface that rather than silently
   * trusting the field label.
   */
  direction_anomalies: string[];
  /** the direction the SOURCE ACTION implies, when it can be determined */
  implied_direction: "long" | "short" | "ambiguous" | "unknown";
}

/**
 * Compare a field's LABEL with the ACTION its text describes.
 * A "شرایط ورود Long" label wrapping "ورود به معامله سل" is a real corpus
 * defect and must never be executed as a long entry.
 */
export function auditFieldDirection(fields: { field: string; value: string }[]): {
  anomalies: string[]; implied: "long" | "short" | "ambiguous" | "unknown";
} {
  const anomalies: string[] = [];
  const SHORT = /ورود به معامله\s*سل|معامله\s*سل|\bSELL\b|فروشندگان/i;
  const LONG = /ورود به معامله\s*بای|معامله\s*خرید|\bBUY\b|خریداران/i;
  let sawShort = false, sawLong = false;

  for (const f of fields) {
    if (f.field !== "entry_long" && f.field !== "entry_short" && f.field !== "entry") continue;
    const isShortAction = SHORT.test(f.value);
    const isLongAction = LONG.test(f.value);
    if (f.field === "entry_long" && isShortAction) {
      anomalies.push(`field 'entry_long' describes a SELL action: "${f.value.slice(0, 70)}"`);
      sawShort = true;
    } else if (f.field === "entry_short" && isLongAction) {
      anomalies.push(`field 'entry_short' describes a BUY action: "${f.value.slice(0, 70)}"`);
      sawLong = true;
    } else if (f.field === "entry") {
      // A GENERIC "شرایط ورود" field carries no directional label, so the
      // ACTION text is the only signal. If it states a side, record it; the
      // runtime must then declare that side explicitly.
      if (isShortAction) { sawShort = true; anomalies.push(`generic 'entry' field states a SELL action with no directional label: "${f.value.slice(0, 70)}" — direction must be declared explicitly, never inferred from the field name`); }
      if (isLongAction) { sawLong = true; anomalies.push(`generic 'entry' field states a BUY action with no directional label: "${f.value.slice(0, 70)}" — direction must be declared explicitly, never inferred from the field name`); }
    } else {
      if (f.field === "entry_long" || isLongAction) sawLong = true;
      if (f.field === "entry_short" || isShortAction) sawShort = true;
    }
  }
  const implied = sawShort && sawLong ? "ambiguous" : sawShort ? "short" : sawLong ? "long" : "unknown";
  return { anomalies, implied };
}

export function labelOf(value: string): FieldSourceLabel {
  const v = value.toUpperCase();
  if (/\bCONFLICT\b|\[CONFLICT\]/.test(v)) return "CONFLICT";
  if (/\bCLAIM\b|\[CLAIM\]/.test(v)) return "CLAIM";
  if (v.startsWith("UNKNOWN") || v === "N/A" || /\bUNKNOWN\b/.test(v)) return "UNKNOWN";
  if (v.includes("[INFERRED]") || /\bINFERRED\b/.test(v)) return "INFERRED";
  if (v.includes("[VERIFIED]") || /\bVERIFIED\b/.test(v)) return "VERIFIED";
  return "SOURCE_NAMED";
}

function clean(v: string | undefined): string | null {
  if (v === undefined) return null;
  const stripped = v.replace(/\[(VERIFIED|INFERRED|CLAIM|CONFLICT)\]/g, "").trim();
  if (!stripped || stripped.toUpperCase().startsWith("UNKNOWN")) return null;
  return stripped;
}

/**
 * Turn a parsed block into a compiled spec + executability verdict.
 * `executable` requires: a timeframe, at least one entry side, a stop, a
 * target, and an exit/invalidation — all present in the SOURCE.
 */
export function compileBlock(rec: StrategyRecord, block: ParsedStrategyBlock): CompiledSpec {
  const byField = new Map<string, { value: string; line: number; status: FieldSourceLabel }[]>();
  for (const f of block.fields) {
    const occurrences = byField.get(f.field) ?? [];
    occurrences.push({ value: f.value, line: f.line, status: labelOf(f.value) });
    byField.set(f.field, occurrences);
  }
  const raw = (k: string): string | undefined => byField.get(k)?.[0]?.value;
  const field_status: Record<string, FieldSourceLabel> = {};
  const field_lines: Record<string, number> = {};
  const field_occurrences: CompiledSpec["field_occurrences"] = {};
  const restrictive: FieldSourceLabel[] = ["CONFLICT", "UNKNOWN", "CLAIM", "INFERRED", "SOURCE_NAMED", "VERIFIED"];
  for (const [k, rows] of byField) {
    const distinctValues = new Set(rows.map((r) => clean(r.value) ?? r.value.trim()));
    const labels = new Set(rows.map((r) => r.status));
    field_status[k] = distinctValues.size > 1 || labels.has("CONFLICT")
      ? "CONFLICT"
      : restrictive.find((status) => labels.has(status)) ?? "SOURCE_NAMED";
    field_lines[k] = rows[0].line;
    field_occurrences[k] = rows.map((r) => ({ ...r }));
  }

  const spec: CompiledSpec = {
    strategy_id: rec.strategy_id,
    canonical_name: rec.canonical_name,
    family: rec.family,
    timeframe: clean(raw("timeframe")),
    entry_long: clean(raw("entry_long")),
    entry_short: clean(raw("entry_short")),
    generic_entry: clean(raw("entry")),
    prerequisites: clean(raw("prerequisites")),
    confirmation: clean(raw("confirmation")),
    stop: clean(raw("stop")),
    target: clean(raw("target")),
    exit: clean(raw("exit")),
    filters: clean(raw("filters")),
    exclusions: clean(raw("exclusions")),
    field_status,
    field_lines,
    field_occurrences,
    source_completeness: "NOT_PRESENT",
    formalization_status: "SOURCE_SPEC_ONLY",
    source_refs: [{ file: block.file, start_line: block.start_line, end_line: block.end_line }],
    // A text-derived spec is not an executable implementation. Runtime binding,
    // semantic parity, and version-bound validation are separate required steps.
    executable: false,
    blocked_because: [],
    direction_anomalies: [],
    implied_direction: "unknown",
  };

  const dir = auditFieldDirection(block.fields.map((f) => ({ field: f.field, value: f.value })));
  spec.direction_anomalies = dir.anomalies;
  spec.implied_direction = dir.implied;

  const blocked: string[] = [];
  const groups: { label: string; fields: string[] }[] = [
    { label: "timeframe", fields: ["timeframe"] },
    { label: "entry", fields: ["entry_long", "entry_short", "entry"] },
    { label: "stop", fields: ["stop"] },
    { label: "target", fields: ["target"] },
    { label: "exit", fields: ["exit"] },
  ];
  const groupRows = (fields: string[]) => fields.flatMap((field) => byField.get(field) ?? []);
  const missing = groups.filter((group) => groupRows(group.fields).length === 0).map((group) => group.label);
  const unknown = groups.filter((group) => {
    const rows = groupRows(group.fields);
    return rows.length > 0 && rows.every((row) => row.status === "UNKNOWN");
  }).map((group) => group.label);
  if (missing.length) blocked.push(`critical source fields NOT_PRESENT: ${missing.join(", ")}`);
  if (unknown.length) blocked.push(`critical source fields explicitly UNKNOWN: ${unknown.join(", ")}`);

  // Include every present occurrence, even when clean() returns null for an
  // explicit UNKNOWN. This preserves UNKNOWN as a completeness state rather
  // than accidentally omitting the field from this audit.
  const criticalStatuses = groups.flatMap((group) => {
    const rows = groupRows(group.fields);
    if (rows.length === 0) return [];
    const aggregate = group.fields.map((field) => field_status[field]).filter(Boolean);
    return aggregate.length ? aggregate : rows.map((row) => row.status);
  });
  if (criticalStatuses.includes("CONFLICT")) {
    spec.source_completeness = "CONFLICTING";
    blocked.push("one or more critical source fields conflict or repeat with differing values");
  } else if (criticalStatuses.includes("UNKNOWN")) {
    spec.source_completeness = "UNKNOWN";
    blocked.push("one or more critical source fields are explicitly UNKNOWN");
  } else if (missing.length > 0 || criticalStatuses.some((status) => status !== "VERIFIED")) {
    spec.source_completeness = criticalStatuses.length === 0 ? "NOT_PRESENT" : "PARTIAL";
    if (criticalStatuses.some((status) => status !== "VERIFIED")) {
      blocked.push("critical source fields include inferred, named-only, claimed, or unmarked evidence");
    }
  } else {
    spec.source_completeness = "COMPLETE";
  }

  // A formalized spec remains source-only even when its fields are complete:
  // no implementation parity or empirical validation is implied.
  blocked.push("SOURCE_SPEC_ONLY: no exact compiled implementation binding or version-bound validation");
  spec.blocked_because = blocked;
  spec.executable = false;
  return spec;
}

/** Derive a SetupSpec from a compiled spec (only meaningful when executable). */
export function setupFromSpec(spec: CompiledSpec): SetupSpec {
  return {
    setup_id: `SET-${spec.strategy_id}`,
    family: spec.family,
    prerequisites: spec.prerequisites ? [spec.prerequisites] : [],
    trigger: [spec.entry_long, spec.entry_short].filter((x): x is string => x !== null),
    confirmation: spec.confirmation ? [spec.confirmation] : [],
    // Exclusions constrain entry; they are not an exit/invalidation.
    invalidation: spec.exit ? [spec.exit] : [],
    entry_model: spec.entry_long ?? spec.entry_short ?? spec.generic_entry,
    stop_model: spec.stop,
    target_model: spec.target,
    scoring_weights: {},
    source_refs: spec.source_refs,
  };
}
