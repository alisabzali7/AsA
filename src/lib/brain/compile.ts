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

export type FieldSourceLabel = "VERIFIED" | "INFERRED" | "UNKNOWN" | "PLAIN";

export interface CompiledSpec {
  strategy_id: string;
  canonical_name: string;
  family: StrategyFamily;
  timeframe: string | null;
  entry_long: string | null;
  entry_short: string | null;
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
  if (v.startsWith("UNKNOWN") || v === "N/A") return "UNKNOWN";
  if (v.includes("[INFERRED]") || v.includes("INFERRED")) return "INFERRED";
  if (v.includes("[VERIFIED]") || v.includes("VERIFIED")) return "VERIFIED";
  return "PLAIN";
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
  const byField = new Map<string, { value: string; line: number }>();
  for (const f of block.fields) {
    if (!byField.has(f.field)) byField.set(f.field, { value: f.value, line: f.line });
  }
  const raw = (k: string): string | undefined => byField.get(k)?.value;
  const field_status: Record<string, FieldSourceLabel> = {};
  const field_lines: Record<string, number> = {};
  for (const [k, v] of byField) {
    field_status[k] = labelOf(v.value);
    field_lines[k] = v.line;
  }

  const spec: CompiledSpec = {
    strategy_id: rec.strategy_id,
    canonical_name: rec.canonical_name,
    family: rec.family,
    timeframe: clean(raw("timeframe")),
    entry_long: clean(raw("entry_long")) ?? clean(raw("entry")),
    entry_short: clean(raw("entry_short")),
    prerequisites: clean(raw("prerequisites")),
    confirmation: clean(raw("confirmation")),
    stop: clean(raw("stop")),
    target: clean(raw("target")),
    exit: clean(raw("exit")),
    filters: clean(raw("filters")),
    exclusions: clean(raw("exclusions")),
    field_status,
    field_lines,
    source_refs: [{ file: block.file, start_line: block.start_line, end_line: block.end_line }],
    executable: false,
    blocked_because: [],
    direction_anomalies: [],
    implied_direction: "unknown",
  };

  const dir = auditFieldDirection(block.fields.map((f) => ({ field: f.field, value: f.value })));
  spec.direction_anomalies = dir.anomalies;
  spec.implied_direction = dir.implied;

  const blocked: string[] = [];
  if (!spec.timeframe) blocked.push("timeframe UNKNOWN in source");
  if (!spec.entry_long && !spec.entry_short) blocked.push("no entry condition stated in source");
  if (!spec.stop) blocked.push("stop UNKNOWN in source");
  if (!spec.target) blocked.push("target UNKNOWN in source");
  if (!spec.exit && !spec.exclusions) blocked.push("no exit/invalidation stated in source");
  // A direction anomaly is recorded on the spec (so nobody can claim the field
  // label was trustworthy) but does NOT by itself block compilation: the
  // compiled strategy must resolve it EXPLICITLY, and the runtime
  // auditDirection() guard re-verifies that resolution on every build.
  // Resolutions are documented in docs/brain/DIRECTION_RESOLUTIONS.md.
  spec.blocked_because = blocked;
  spec.executable = blocked.length === 0;
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
    invalidation: [spec.exit, spec.exclusions].filter((x): x is string => x !== null),
    entry_model: spec.entry_long ?? spec.entry_short,
    stop_model: spec.stop,
    target_model: spec.target,
    scoring_weights: {},
    source_refs: spec.source_refs,
  };
}
