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
import type { Candle } from "../domain/types";
import { bundleInputFingerprint } from "../analysis/bundle";

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

/**
 * DECISION SNAPSHOT IDENTITY (Task 10). The exact closed-bar window the
 * decision was evaluated on, using the SAME fingerprint function as the
 * analysis bundle (`bundleInputFingerprint`), not a second provenance system.
 * A renderer that re-fetches candles later can prove (or fail to prove) that
 * it is drawing the decision's window.
 */
export interface DecisionSnapshot {
  symbol: string;
  timeframe: string;
  /** number of closed bars in the evaluated window */
  closed_bars: number;
  /** open time (unix s) of the first / last closed bar of the window */
  first_t: number;
  as_of_t: number;
  /** close of the last bar (ms) — the earliest moment the decision was knowable */
  knowable_at_ms: number;
  /** engines string folded into the fingerprint */
  engines: string;
  input_fingerprint: string;
}

export function decisionSnapshot(symbol: string, timeframe: string, candles: Candle[], knowableAtMs: number, engines: string): DecisionSnapshot | null {
  if (candles.length === 0 || !Number.isFinite(knowableAtMs)) return null;
  return {
    symbol, timeframe, closed_bars: candles.length,
    first_t: candles[0].t, as_of_t: candles[candles.length - 1].t,
    knowable_at_ms: knowableAtMs, engines,
    input_fingerprint: bundleInputFingerprint(symbol, timeframe, candles, engines),
  };
}

export type SnapshotCheck =
  | { state: "VERIFIED"; reason: string }
  | { state: "MISMATCH"; reason: string }
  | { state: "UNVERIFIABLE"; reason: string }
  /** the stored record predates snapshot capture: there is nothing to verify against — never fabricated */
  | { state: "UNVERIFIABLE_LEGACY_RECORD"; reason: string };
export type SnapshotCheckState = SnapshotCheck["state"];

/**
 * Re-derive the decision window from candles fetched NOW and compare its
 * fingerprint with the stored one. Never "repairs": a mismatch (venue revised
 * a bar, window not retained) is reported, not hidden.
 */
export function verifyDecisionSnapshot(evidence: Pick<ChartEvidence, "symbol" | "timeframe" | "snapshot">, candles: Candle[]): SnapshotCheck {
  const snap = evidence.snapshot;
  if (!snap) return { state: "UNVERIFIABLE_LEGACY_RECORD", reason: "evidence predates snapshot capture (no input_fingerprint stored)" };
  if (snap.symbol !== evidence.symbol || snap.timeframe !== evidence.timeframe) return { state: "MISMATCH", reason: "snapshot identity differs from evidence identity" };
  const end = candles.findIndex((c) => c.t === snap.as_of_t);
  if (end < 0) return { state: "UNVERIFIABLE", reason: `decision bar ${snap.as_of_t} not in the fetched history` };
  const start = end - snap.closed_bars + 1;
  if (start < 0) return { state: "UNVERIFIABLE", reason: `fetched history holds ${end + 1} of the ${snap.closed_bars} decision bars` };
  const win = candles.slice(start, end + 1);
  if (win[0].t !== snap.first_t) return { state: "MISMATCH", reason: "window start differs (gap or revised history)" };
  const fp = bundleInputFingerprint(snap.symbol, snap.timeframe, win, snap.engines);
  return fp === snap.input_fingerprint
    ? { state: "VERIFIED", reason: `re-fetched window fingerprint ${fp} equals the decision fingerprint` }
    : { state: "MISMATCH", reason: `re-fetched window fingerprint ${fp} ≠ decision fingerprint ${snap.input_fingerprint} (venue revised a bar?)` };
}

/**
 * Candles a decision chart may draw: nothing after the decision bar. A
 * rendering fetched later must not show bars the decision could not see
 * (or the forming bar) as if they were part of it.
 */
export function decisionWindow(evidence: Pick<ChartEvidence, "bar_time" | "snapshot">, candles: Candle[]): Candle[] {
  const cut = evidence.snapshot?.as_of_t ?? evidence.bar_time;
  if (cut === null || cut === undefined) return candles;
  return candles.filter((c) => c.t <= cut);
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
  /** decision window identity (Task 10); absent on evidence stored before it */
  snapshot?: DecisionSnapshot | null;
}

/**
 * Build chart evidence from a strategy evaluation.
 * `lineage_complete` is false when any annotation lacks a producing feature or
 * rule, which the UI must surface rather than silently drawing the line.
 */
export function buildChartEvidence(ev: CompiledEvaluation, score: number | null, snapshot: DecisionSnapshot | null = null): ChartEvidence {
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
    // identity must agree with the evaluation or it is not attached
    snapshot: snapshot && snapshot.symbol === ev.symbol && snapshot.timeframe === ev.timeframe && snapshot.as_of_t === ev.bar_time ? snapshot : null,
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
