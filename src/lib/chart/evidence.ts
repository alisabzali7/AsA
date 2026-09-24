/**
 * Chart evidence lineage (closure §W).
 *
 * Every annotation must be traceable:
 *   annotation_id -> feature/rule -> source_refs -> detector_version
 *
 * Only evidence ACTUALLY USED by the evaluation is rendered. There are no
 * decorative annotations: if a level was not consulted by a rule, it does not
 * appear on the chart.
 */
import type { SourceRef } from "../brain/types";
import type { CompiledEvaluation } from "../strategy/compiled";
import { DETECTOR_VERSION } from "../features/detectors";

export type AnnotationKind =
  | "level" | "entry" | "stop" | "target" | "invalidation"
  | "structure" | "fib" | "pattern" | "zone";

export interface ChartAnnotation {
  annotation_id: string;
  kind: AnnotationKind;
  label: string;
  /** horizontal price line, or a band when `price_to` is present */
  price: number;
  price_to?: number;
  /** the feature or rule that produced this annotation — never decorative */
  produced_by: { type: "feature" | "rule"; id: string };
  source_refs: SourceRef[];
  detector_version: string;
  /** epistemic label the UI must display */
  evidence_kind: "MEASURED" | "DERIVED" | "SOURCE" | "INFERRED";
  note?: string;
}

export interface ChartEvidence {
  symbol: string;
  timeframe: string;
  strategy_id: string;
  setup_id: string;
  direction: "long" | "short";
  bar_time: number | null;
  annotations: ChartAnnotation[];
  /** the exact rules whose outcome the chart depicts */
  rules: { rule_id: string; outcome: string; explanation: string; source_refs: SourceRef[] }[];
  score: number | null;
  score_semantics: string;
  /** engineering quantifications used to derive drawn levels */
  assumptions: string[];
  lineage_complete: boolean;
}

/**
 * Build chart evidence from a strategy evaluation.
 * `lineage_complete` is false when any annotation lacks a producing feature or
 * rule, which the UI must surface rather than silently drawing the line.
 */
export function buildChartEvidence(ev: CompiledEvaluation, score: number | null): ChartEvidence {
  const ann: ChartAnnotation[] = [];
  const mk = (
    kind: AnnotationKind, label: string, price: number,
    producedBy: { type: "feature" | "rule"; id: string },
    refs: SourceRef[], evidence: ChartAnnotation["evidence_kind"], note?: string,
  ) => {
    ann.push({
      annotation_id: `${ev.setup_id}:${kind}:${price}`,
      kind, label, price, produced_by: producedBy, source_refs: refs,
      detector_version: DETECTOR_VERSION, evidence_kind: evidence, note,
    });
  };

  // rules actually evaluated, with their provenance
  const rules = ev.setup.stages.flatMap((s) =>
    s.rules.map((r) => ({
      rule_id: r.rule_id, outcome: r.outcome, explanation: r.explanation, source_refs: r.source_refs,
    })),
  );
  const anyRefs = rules.flatMap((r) => r.source_refs).slice(0, 3);

  // entry / stop / target / invalidation come from the strategy's level model
  if (ev.levels.entry !== null) {
    mk("entry", "Entry", ev.levels.entry, { type: "rule", id: `${ev.setup_id}-LOC` }, anyRefs, "DERIVED");
  }
  if (ev.levels.stop !== null) {
    mk("stop", "Stop loss", ev.levels.stop, { type: "rule", id: `${ev.setup_id}-INVAL` }, anyRefs, "INFERRED",
      "quantified with an ENGINEERING ATR buffer over the source's qualitative wording");
  }
  ev.levels.targets.forEach((t, i) => {
    mk("target", `Target ${i + 1}`, t, { type: "feature", id: "FTR-LEVELS" }, anyRefs, "DERIVED");
  });
  if (ev.levels.invalidation !== null) {
    mk("invalidation", "Invalidation", ev.levels.invalidation, { type: "rule", id: `${ev.setup_id}-INVAL` }, anyRefs, "SOURCE");
  }

  const complete = ann.every((a) => a.produced_by.id.length > 0 && a.detector_version.length > 0);

  return {
    symbol: ev.symbol,
    timeframe: ev.timeframe,
    strategy_id: ev.strategy_id,
    setup_id: ev.setup_id,
    direction: ev.direction,
    bar_time: ev.bar_time,
    annotations: ann,
    rules,
    score,
    score_semantics: "This is a decision score, not a probability.",
    assumptions: ev.levels.level_assumptions,
    lineage_complete: complete,
  };
}

/** True iff chart evidence belongs to the given opportunity identity. */
export function chartEvidenceMatches(
  evidence: ChartEvidence,
  identity: { symbol: string; timeframe: string; direction?: string },
): boolean {
  if (evidence.symbol !== identity.symbol) return false;
  if (evidence.timeframe !== identity.timeframe) return false;
  if (identity.direction && evidence.direction !== identity.direction) return false;
  return true;
}
