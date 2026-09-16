/**
 * STRATEGY PROMOTION GATE — the one deterministic chokepoint that decides
 * whether a strategy may be promoted to live advisory.
 *
 * WHY THIS MODULE EXISTS
 * `executable ≠ validated ≠ promotable ≠ live eligible`. Before this module the
 * codebase had two *different* answers to "is this strategy live?":
 *
 *   - `pipeline/orchestrator.runtimeStatusFor()` mapped a persisted empirical
 *     status straight onto a runtime status, ignoring governance entirely
 *     (critical UNKNOWNs, unresolved conflicts, missing implementation
 *     bindings) and ignoring whether the evidence still described the current
 *     build;
 *   - `api/brain/validation` hard-coded `can_go_live: false`, which would have
 *     been just as wrong in the other direction.
 *
 * Neither was a gate. This module is:
 *
 *   strategy exists
 *   AND strategy executable
 *   AND governance pass (source usable, no critical UNKNOWN, no conflict,
 *       implementation binding present)
 *   AND validation evidence exists
 *   AND evidence provenance valid (real dataset identity, fingerprint match)
 *   AND evidence describes THIS build (versions current, methodology declared)
 *   AND required metrics actually computed
 *   AND the stored verdict is reproducible under the current criteria
 *   AND out-of-sample evidence exists
 *   AND the quality ladder supports it
 *   = promotion eligible
 *
 * EVERY check is deterministic and machine-checkable. A check that cannot be
 * evaluated is `UNKNOWN` and blocks — `UNKNOWN` is NEVER silently upgraded to
 * `PASS` (master-prompt rule: UNKNOWN propagation). Nothing here reads a score
 * and nothing here can be overridden by configuration, the UI, or the AI layer.
 *
 * The module is split into a PURE core (`buildPromotionDecision`, no I/O, used
 * by tests with explicit inputs) and a thin resolution layer at the bottom that
 * feeds it the live stores (`promotionReport`, `promotionReports`).
 */
import type { CriticalSpecField, EmpiricalStatus, RuntimeStatus, SourceRef, SourceStatus, StrategyRecord } from "../brain/types";
import { clampRuntimeStatus, evaluateGate, type GateVerdict } from "../brain/gate";
import {
  VALIDATION_METHODOLOGY, isPromotedStatus, weakestStatus,
  decidePromotion, type PromotionVerdict,
} from "./validation";
import { asBacktestMetrics, getExperiments, type ExperimentEvidence } from "./experiments";
import { getBrain } from "../brain/store";
import { COMPILED_STRATEGIES } from "../strategy/compiled";
import { getRuntimeVariants, listRuntimeStrategies, type RuntimeAvailability } from "../strategy/runtime";
import { DETECTOR_VERSION } from "../features/detectors";
import { buildReleaseIdentity } from "../release";
import type { BacktestMetrics } from "./strategy-runner";

/* ------------------------------------------------------------ check model */

export type PromotionCheckVerdict = "PASS" | "FAIL" | "UNKNOWN";

/**
 * 4-state promotion outcome required by the governance pipeline:
 * - ELIGIBLE: all mandatory governance and empirical quality checks passed
 * - NOT_ELIGIBLE: evidence exists but failed empirical quality ladder (trades/PF/DD/retention)
 * - BLOCKED: blocked by governance rules (conflict, critical unknown in source, missing binding, ceiling)
 * - UNKNOWN: missing required evidence or essential properties are unknown
 */
export type PromotionStatus = "NOT_ELIGIBLE" | "ELIGIBLE" | "BLOCKED" | "UNKNOWN";

export const PROMOTION_CHECK_IDS = [
  "strategy_exists",
  "strategy_executable",
  "implementation_binding",
  "source_status_usable",
  "no_unknown_critical",
  "no_unresolved_conflict",
  "validation_evidence_exists",
  "evidence_dataset_provenance",
  "evidence_versions_current",
  "evidence_methodology_declared",
  "required_metrics_computed",
  "evidence_verdict_reproducible",
  "oos_evidence_exists",
  "evidence_quality_gate",
  "governance_ceiling_allows_live",
] as const;
export type PromotionCheckId = (typeof PROMOTION_CHECK_IDS)[number];

export interface PromotionCheck {
  id: PromotionCheckId;
  label: string;
  verdict: PromotionCheckVerdict;
  detail: string;
}

/** Dataset kinds that may back a promotion decision. */
export const PROMOTABLE_DATASET_KINDS = ["TTT_LIVE_SYNC", "TTT_UDF_REPLAY"] as const;

/** Metrics that must have been COMPUTED (non-null) for the evidence to count. */
export const REQUIRED_METRICS = [
  "trade_count", "wins", "losses", "win_rate", "average_r", "expectancy_r",
  "profit_factor", "max_drawdown_r", "total_r",
] as const;
export type RequiredMetric = (typeof REQUIRED_METRICS)[number];

/** Version set describing the build the evidence must still describe. */
export interface CurrentVersions {
  code_version: string;
  detector_version: string;
  /** every setup version of the strategy's runtime variants */
  strategy_versions: string[];
  /** every rule version of the strategy's runtime variants */
  rule_versions: string[];
}

export interface RuntimeFacts {
  exists: boolean;
  availability: RuntimeAvailability | "MISSING";
  blocked_reason: string | null;
  setup_ids: string[];
  direction_variants: number;
  timeframe: string | null;
  version: string | null;
  rule_ids: string[];
  source_refs: SourceRef[];
  name: string | null;
  family: string | null;
}

export interface GovernanceFacts {
  record_present: boolean;
  source_status: SourceStatus | null;
  unknown_critical: CriticalSpecField[] | string[];
  conflict_group_id: string | null;
  conflict_unresolved: boolean;
  implementation_binding: string | null;
  /** why the governance record could not be read, when that is the case */
  resolve_error: string | null;
}

export interface PromotionGateInput {
  strategy_id: string;
  runtime: RuntimeFacts;
  governance: GovernanceFacts;
  /** newest evidence row per symbol (see ExperimentStore.evidenceFor) */
  evidence: ExperimentEvidence[];
  versions: CurrentVersions;
  decided_at_ms: number;
}

/** One stored experiment, re-evaluated rather than taken on faith. */
export interface EvidenceEvaluation {
  evidence: ExperimentEvidence;
  /** re-derived verdict under the CURRENT criteria; null when not computable */
  rederived: PromotionVerdict | null;
  /** why re-derivation was impossible (null when it succeeded) */
  rederive_error: string | null;
  /** the status the evidence actually supports after re-evaluation */
  effective_status: EmpiricalStatus;
  /** true when the row's own recorded status matches the re-derived one */
  reproducible: boolean;
  /** true when dataset/provenance facts of this row check out */
  provenance_ok: boolean;
  provenance_detail: string;
}

export interface PromotionDecision {
  strategy_id: string;
  decision: "ELIGIBLE" | "NOT_ELIGIBLE";
  promotion_status: PromotionStatus;
  eligible: boolean;
  /** true only when the strategy may contribute to live advisory output */
  live_eligible: boolean;
  checks: PromotionCheck[];
  failed_checks: PromotionCheckId[];
  unknown_checks: PromotionCheckId[];
  failure_reasons: string[];
  unknown_reasons: string[];
  conflict_reasons: string[];
  /** every blocking UNKNOWN, flattened for machine consumption */
  blocking_unknowns: string[];
  /** highest status the EVIDENCE supports (weakest across tested symbols) */
  evidenced_status: EmpiricalStatus;
  /** governance ceiling from `brain/gate.ts` */
  ceiling: RuntimeStatus;
  gate_reasons: string[];
  /** runtime status the strategy may hold right now (never above the ceiling) */
  runtime_status: RuntimeStatus;
  /** the row the decision was made on (weakest evidence) */
  primary_experiment_id: string | null;
  primary_symbol: string | null;
  evidence: EvidenceEvaluation[];
  criteria_source: string;
  methodology: string;
  decided_at_ms: number;
}

/* ---------------------------------------------------------------- helpers */

function check(
  checks: PromotionCheck[],
  id: PromotionCheckId,
  label: string,
  verdict: PromotionCheckVerdict,
  detail: string,
): void {
  checks.push({ id, label, verdict, detail });
}

/**
 * A dataset identity is only valid when it is complete AND self-consistent with
 * the row it belongs to: the fingerprint must be the one the run recomputed,
 * the range must match, and the source must be TTT-derived. Fabricated data is
 * a first-class rejection — a promotion built on it would be a fabricated
 * result.
 */
export function validateDatasetProvenance(
  evidence: ExperimentEvidence,
): { ok: boolean; detail: string; verdict: PromotionCheckVerdict } {
  const id = evidence.dataset_identity;
  if (!id) {
    return {
      ok: false,
      verdict: "UNKNOWN",
      detail: "no dataset identity was recorded — it cannot be shown that this evidence came from TTT (UNKNOWN, not eligible)",
    };
  }
  const missing: string[] = [];
  if (!id.source_ref) missing.push("source_ref");
  if (!id.captured_at) missing.push("captured_at");
  if (!id.retrieved_at) missing.push("retrieved_at");
  if (!/^[0-9a-f]{64}$/.test(id.source_sha256)) missing.push("source_sha256");
  if (missing.length) {
    return {
      ok: false,
      verdict: "UNKNOWN",
      detail: `dataset identity is incomplete (missing ${missing.join(", ")}) — provenance UNKNOWN`,
    };
  }
  if (!PROMOTABLE_DATASET_KINDS.includes(id.source_kind as (typeof PROMOTABLE_DATASET_KINDS)[number])) {
    return {
      ok: false,
      verdict: "FAIL",
      detail: `dataset source_kind '${id.source_kind}' may not back a promotion decision (allowed: ${PROMOTABLE_DATASET_KINDS.join(", ")})`,
    };
  }
  if (!id.fingerprint_recomputed) {
    return {
      ok: false,
      verdict: "UNKNOWN",
      detail: "the fingerprint was copied, not recomputed from the candles actually used — provenance UNKNOWN",
    };
  }
  if (id.fingerprint !== evidence.dataset_fingerprint) {
    return {
      ok: false,
      verdict: "FAIL",
      detail: `dataset identity fingerprint ${id.fingerprint} does not match the experiment fingerprint ${evidence.dataset_fingerprint}`,
    };
  }
  if (id.bars !== evidence.bars || id.from_ts !== evidence.from_ts || id.to_ts !== evidence.to_ts) {
    return {
      ok: false,
      verdict: "FAIL",
      detail: `dataset identity range (${id.bars} bars, ${id.from_ts}→${id.to_ts}) does not match the experiment range (${evidence.bars} bars, ${evidence.from_ts}→${evidence.to_ts})`,
    };
  }
  return {
    ok: true,
    verdict: "PASS",
    detail: `${id.source_kind} · ${id.source_ref} · ${id.bars} bars · sha256 ${id.source_sha256.slice(0, 12)}… · fingerprint recomputed`,
  };
}

/** Which of the required metrics were actually computed on a metrics object. */
export function metricsComputed(m: BacktestMetrics | null): { computed: RequiredMetric[]; missing: RequiredMetric[] } {
  const computed: RequiredMetric[] = [];
  const missing: RequiredMetric[] = [];
  for (const k of REQUIRED_METRICS) {
    const v = m ? (m as unknown as Record<string, unknown>)[k] : null;
    if (typeof v === "number" && Number.isFinite(v)) computed.push(k);
    else missing.push(k);
  }
  return { computed, missing };
}

/** Re-derive the verdict from the row's own raw metrics under current criteria. */
export function evaluateEvidenceRow(row: ExperimentEvidence): EvidenceEvaluation {
  const inSample = asBacktestMetrics(row.in_sample);
  const oos = asBacktestMetrics(row.oos);
  const wf = row.walk_forward; // already shape-validated by the store reader
  const provenance = validateDatasetProvenance(row);

  if (!inSample) {
    return {
      evidence: row,
      rederived: null,
      rederive_error: "in-sample metrics are not readable — the recorded status cannot be re-derived",
      effective_status: "UNTESTED",
      reproducible: false,
      provenance_ok: provenance.ok,
      provenance_detail: provenance.detail,
    };
  }
  const rederived = decidePromotion(inSample, oos, wf);
  return {
    evidence: row,
    rederived,
    rederive_error: null,
    effective_status: rederived.to,
    reproducible: rederived.to === row.empirical_status,
    provenance_ok: provenance.ok,
    provenance_detail: provenance.detail,
  };
}

const RUNTIME_ORDER: RuntimeStatus[] = ["DISABLED", "CANDIDATE", "PAPER", "LIVE_ADVISORY_ONLY"];

/** Governance-safe clamp: never above `ceiling`. */
function clampTo(status: RuntimeStatus, ceiling: RuntimeStatus): RuntimeStatus {
  return RUNTIME_ORDER.indexOf(status) <= RUNTIME_ORDER.indexOf(ceiling) ? status : ceiling;
}

function statusForEvidence(status: EmpiricalStatus): RuntimeStatus {
  if (status === "ROBUST" || status === "WALK_FORWARD") return "LIVE_ADVISORY_ONLY";
  if (status === "OOS_TESTED") return "PAPER";
  if (status === "BACKTESTED") return "CANDIDATE";
  return "DISABLED";
}

/** Weakest-evidence row first (ties broken by recency) — the cited evidence. */
function primaryOf(evals: EvidenceEvaluation[]): EvidenceEvaluation | null {
  if (evals.length === 0) return null;
  return evals.reduce((worst, e) => {
    const a = e.effective_status;
    const b = worst.effective_status;
    if (a === b) return e.evidence.created_ms >= worst.evidence.created_ms ? e : worst;
    return weakestStatus(a, b) === a ? e : worst;
  }, evals[0]);
}

export function derivePromotionStatus(
  eligibleOrDecision: boolean | PromotionDecision,
  failedChecks?: PromotionCheckId[],
  unknownChecks?: PromotionCheckId[],
  conflictReasons?: string[],
): PromotionStatus {
  if (typeof eligibleOrDecision === "object" && eligibleOrDecision !== null) {
    const d = eligibleOrDecision as PromotionDecision;
    return derivePromotionStatus(d.eligible, d.failed_checks, d.unknown_checks, d.conflict_reasons);
  }
  const eligible = Boolean(eligibleOrDecision);
  if (eligible) return "ELIGIBLE";
  const failed = failedChecks ?? [];
  const unknowns = unknownChecks ?? [];
  const conflicts = conflictReasons ?? [];
  const govFailed = failed.some((c) =>
    ["implementation_binding", "source_status_usable", "no_unknown_critical", "no_unresolved_conflict", "governance_ceiling_allows_live"].includes(c),
  );
  if (govFailed || conflicts.length > 0) return "BLOCKED";
  if (unknowns.length > 0) return "UNKNOWN";
  return "NOT_ELIGIBLE";
}

/* ------------------------------------------------------------- the gate */

export function buildPromotionDecision(input: PromotionGateInput): PromotionDecision {
  const checks: PromotionCheck[] = [];
  const rt = input.runtime;
  const gov = input.governance;
  const evals = input.evidence.map(evaluateEvidenceRow);
  const primary = primaryOf(evals);
  const evidencedStatus: EmpiricalStatus = evals.length
    ? evals.reduce<EmpiricalStatus>((acc, e) => weakestStatus(acc, e.effective_status), "ROBUST")
    : "UNTESTED";

  /* ---- 1. existence + executability ------------------------------- */
  if (rt.exists) {
    check(checks, "strategy_exists", "strategy exists", "PASS",
      `registry knows ${input.strategy_id} (${rt.setup_ids.join(", ") || "no setup id"})`);
  } else {
    check(checks, "strategy_exists", "strategy exists", "FAIL",
      `${input.strategy_id} is not present in the runtime strategy registry`);
  }

  if (rt.exists && rt.availability === "EXECUTABLE") {
    check(checks, "strategy_executable", "strategy executable", "PASS",
      `${rt.direction_variants} executable variant(s), timeframe ${rt.timeframe}, version ${rt.version}`);
  } else if (rt.exists) {
    check(checks, "strategy_executable", "strategy executable", "FAIL",
      `availability is ${rt.availability}${rt.blocked_reason ? ` — ${rt.blocked_reason}` : ""}`);
  } else {
    check(checks, "strategy_executable", "strategy executable", "UNKNOWN",
      "strategy is not in the registry, so executability cannot be established");
  }

  /* ---- 2. governance (source truth) ------------------------------- */
  if (!gov.record_present) {
    const why = gov.resolve_error ? ` (${gov.resolve_error})` : "";
    check(checks, "implementation_binding", "implementation binding", "UNKNOWN",
      `no Brain StrategyRecord for ${input.strategy_id}${why} — the runtime binding cannot be verified`);
    check(checks, "source_status_usable", "source status usable", "UNKNOWN",
      `source status is UNKNOWN${why} — a strategy without a usable source statement cannot be promoted`);
    check(checks, "no_unknown_critical", "no critical UNKNOWN", "UNKNOWN",
      `critical spec fields cannot be checked${why}`);
    check(checks, "no_unresolved_conflict", "no unresolved conflict", "UNKNOWN",
      `conflict state cannot be checked${why}`);
  } else {
    if (gov.implementation_binding) {
      check(checks, "implementation_binding", "implementation binding", "PASS",
        `bound to ${gov.implementation_binding}`);
    } else {
      check(checks, "implementation_binding", "implementation binding", "FAIL",
        "the Brain record carries no executable implementation binding");
    }
    if (gov.source_status === "SOURCE_VERIFIED" || gov.source_status === "SOURCE_INFERRED") {
      check(checks, "source_status_usable", "source status usable", "PASS", `source_status=${gov.source_status}`);
    } else {
      check(checks, "source_status_usable", "source status usable", "FAIL",
        `source_status=${gov.source_status} — only SOURCE_VERIFIED / SOURCE_INFERRED may be promoted (a CLAIM or CONFLICT is not evidence)`);
    }
    const unknownCritical = gov.unknown_critical as string[];
    if (unknownCritical.length === 0) {
      check(checks, "no_unknown_critical", "no critical UNKNOWN", "PASS",
        "entry/stop/target/timeframe/invalidation are all specified in the source");
    } else {
      check(checks, "no_unknown_critical", "no critical UNKNOWN", "FAIL",
        `critical spec fields UNKNOWN in source: ${unknownCritical.join(", ")}`);
    }
    if (gov.conflict_unresolved) {
      check(checks, "no_unresolved_conflict", "no unresolved conflict", "FAIL",
        `unresolved conflict group ${gov.conflict_group_id ?? "(unnamed)"} — competing source variants must be adjudicated, never averaged`);
    } else {
      check(checks, "no_unresolved_conflict", "no unresolved conflict", "PASS", "no unresolved conflict group");
    }
  }

  /* ---- 3. validation evidence exists ------------------------------ */
  if (evals.length === 0) {
    check(checks, "validation_evidence_exists", "validation evidence exists", "UNKNOWN",
      "no experiment has ever been run for this strategy — validation status is NOT_VALIDATED/UNKNOWN, never assumed");
  } else {
    check(checks, "validation_evidence_exists", "validation evidence exists", "PASS",
      `${evals.length} symbol(s) with persisted evidence: ${evals.map((e) => e.evidence.symbol).join(", ")}`);
  }

  /* ---- 4. provenance of the deciding row -------------------------- */
  if (!primary) {
    check(checks, "evidence_dataset_provenance", "evidence dataset provenance", "UNKNOWN",
      "no evidence row exists, so dataset provenance cannot be established");
  } else {
    const p = validateDatasetProvenance(primary.evidence);
    check(checks, "evidence_dataset_provenance", "evidence dataset provenance", p.verdict,
      `${primary.evidence.symbol}: ${p.detail}`);
  }

  /* ---- 5. evidence describes THIS build --------------------------- */
  const versionProblems: string[] = [];
  const versionUnknowns: string[] = [];
  if (primary) {
    const v = primary.evidence.versions;
    if (!v.code_version) versionUnknowns.push("code_version is empty");
    else if (v.code_version !== input.versions.code_version) {
      versionProblems.push(`code_version ${v.code_version} ≠ current ${input.versions.code_version}`);
    }
    if (!v.detector_version) versionUnknowns.push("detector_version is empty");
    else if (v.detector_version !== input.versions.detector_version) {
      versionProblems.push(`detector_version ${v.detector_version} ≠ current ${input.versions.detector_version}`);
    }
    if (!v.strategy_version) versionUnknowns.push("strategy_version is empty");
    else if (!input.versions.strategy_versions.includes(v.strategy_version)) {
      versionProblems.push(`strategy_version ${v.strategy_version} ∉ current [${input.versions.strategy_versions.join(", ")}]`);
    }
    if (!v.rule_version) versionUnknowns.push("rule_version is empty");
    else {
      // a strategy may combine rules of several versions ("1.0.0+1.1.0")
      const parts = v.rule_version.split("+").map((p) => p.trim()).filter(Boolean);
      const unknownParts = parts.filter((p) => !input.versions.rule_versions.includes(p));
      if (parts.length === 0 || unknownParts.length) {
        versionProblems.push(`rule_version ${v.rule_version} ∉ current [${input.versions.rule_versions.join(", ")}]`);
      }
    }
  }
  if (!primary) {
    check(checks, "evidence_versions_current", "evidence describes this build", "UNKNOWN", "no evidence row to compare");
  } else if (versionProblems.length) {
    check(checks, "evidence_versions_current", "evidence describes this build", "FAIL",
      `evidence is stale — ${versionProblems.join("; ")} (re-run the validation pipeline on the current build)`);
  } else if (versionUnknowns.length) {
    check(checks, "evidence_versions_current", "evidence describes this build", "UNKNOWN",
      `version lineage incomplete: ${versionUnknowns.join("; ")}`);
  } else {
    check(checks, "evidence_versions_current", "evidence describes this build", "PASS",
      `code ${input.versions.code_version} · detector ${input.versions.detector_version} · strategy ${input.versions.strategy_versions.join("/")} · rule ${input.versions.rule_versions.join("/")}`);
  }

  /* ---- 6. methodology is declared and current --------------------- */
  if (!primary) {
    check(checks, "evidence_methodology_declared", "methodology declared", "UNKNOWN", "no evidence row to read");
  } else if (primary.evidence.methodology === null) {
    check(checks, "evidence_methodology_declared", "methodology declared", "UNKNOWN",
      "the stored evidence does not state which validation methodology produced it");
  } else if (primary.evidence.methodology !== VALIDATION_METHODOLOGY) {
    check(checks, "evidence_methodology_declared", "methodology declared", "FAIL",
      `evidence was produced by methodology '${primary.evidence.methodology}', current is '${VALIDATION_METHODOLOGY}'`);
  } else {
    check(checks, "evidence_methodology_declared", "methodology declared", "PASS", VALIDATION_METHODOLOGY);
  }

  /* ---- 7. required metrics actually computed ---------------------- */
  const metrics = primary?.evidence.in_sample ?? null;
  const { computed, missing } = metricsComputed(metrics);
  if (!primary) {
    check(checks, "required_metrics_computed", "required metrics computed", "UNKNOWN", "no evidence row to read");
  } else if (metrics === null) {
    check(checks, "required_metrics_computed", "required metrics computed", "UNKNOWN",
      `${primary.evidence.symbol}: in-sample metrics could not be read back — nothing is treated as measured`);
  } else if (metrics.trade_count === 0) {
    check(checks, "required_metrics_computed", "required metrics computed", "FAIL",
      `${primary.evidence.symbol}: the run produced 0 trades, so no metric describes behaviour`);
  } else if (missing.length) {
    check(checks, "required_metrics_computed", "required metrics computed", "UNKNOWN",
      `${primary.evidence.symbol}: metrics not computed (null): ${missing.join(", ")} — UNKNOWN, never a pass`);
  } else {
    check(checks, "required_metrics_computed", "required metrics computed", "PASS",
      `${computed.length}/${REQUIRED_METRICS.length} metrics measured over ${metrics.trade_count} trades`);
  }

  /* ---- 8. the stored verdict is reproducible ---------------------- */
  if (!primary) {
    check(checks, "evidence_verdict_reproducible", "stored verdict reproducible", "UNKNOWN", "no evidence row to re-derive");
  } else if (primary.rederive_error) {
    check(checks, "evidence_verdict_reproducible", "stored verdict reproducible", "UNKNOWN",
      `${primary.evidence.symbol}: ${primary.rederive_error}`);
  } else if (!primary.reproducible) {
    check(checks, "evidence_verdict_reproducible", "stored verdict reproducible", "FAIL",
      `${primary.evidence.symbol}: stored status ${primary.evidence.empirical_status} is NOT reproducible under the current criteria (re-derived ${primary.effective_status})`);
  } else {
    check(checks, "evidence_verdict_reproducible", "stored verdict reproducible", "PASS",
      `${primary.evidence.symbol}: ${primary.evidence.empirical_status} reproduces under the current criteria`);
  }

  /* ---- 9. out-of-sample evidence ---------------------------------- */
  const oos = primary?.evidence.oos ?? null;
  if (!primary) {
    check(checks, "oos_evidence_exists", "out-of-sample evidence exists", "UNKNOWN", "no evidence row to read");
  } else if (!oos) {
    check(checks, "oos_evidence_exists", "out-of-sample evidence exists", "UNKNOWN",
      `${primary.evidence.symbol}: no out-of-sample run is stored — OOS evidence is UNKNOWN`);
  } else if (oos.trade_count === 0) {
    check(checks, "oos_evidence_exists", "out-of-sample evidence exists", "FAIL",
      `${primary.evidence.symbol}: the out-of-sample split produced 0 trades — nothing was tested out of sample`);
  } else {
    check(checks, "oos_evidence_exists", "out-of-sample evidence exists", "PASS",
      `${primary.evidence.symbol}: ${oos.trade_count} out-of-sample trades, expectancy ${oos.expectancy_r}R`);
  }

  /* ---- 10. the quality ladder supports it ------------------------- */
  if (!primary) {
    check(checks, "evidence_quality_gate", "evidence quality ladder", "UNKNOWN", "no evidence row to evaluate");
  } else if (isPromotedStatus(evidencedStatus)) {
    check(checks, "evidence_quality_gate", "evidence quality ladder", "PASS",
      `weakest status across ${evals.length} symbol(s) is ${evidencedStatus} (${primary.evidence.symbol} is weakest)`);
  } else if (primary.rederived === null) {
    check(checks, "evidence_quality_gate", "evidence quality ladder", "UNKNOWN",
      `${primary.evidence.symbol}: ${primary.rederive_error ?? "the recorded verdict could not be re-derived"}`);
  } else {
    const unknownReasons = primary.rederived.unknown_reasons;
    const failureReasons = primary.rederived.failure_reasons;
    const detail =
      `${primary.evidence.symbol} (weakest of ${evals.length} symbol(s)) reaches only ${evidencedStatus}` +
      (failureReasons.length ? `; measured shortfalls: ${failureReasons.join("; ")}` : "") +
      (unknownReasons.length ? `; unknowns: ${unknownReasons.join("; ")}` : "");
    check(
      checks, "evidence_quality_gate", "evidence quality ladder",
      unknownReasons.length > 0 && failureReasons.length === 0 ? "UNKNOWN" : "FAIL",
      detail,
    );
  }

  /* ---- 11. governance ceiling allows live -------------------------- */
  const gate: GateVerdict = evaluateGate({
    source_status: gov.source_status ?? "UNKNOWN",
    // The evidenced status, NOT the brain row's stored status: the row is
    // written by ingestion and can never be raised by hypothesis.
    empirical_status: evidencedStatus,
    unknown_critical: (gov.unknown_critical as CriticalSpecField[]),
    conflict_unresolved: gov.conflict_unresolved,
    has_implementation: gov.implementation_binding !== null,
  });
  if (!gov.record_present) {
    check(checks, "governance_ceiling_allows_live", "governance ceiling allows live", "UNKNOWN",
      `governance state is UNKNOWN — the live ceiling cannot be cleared (required ceiling: LIVE_ADVISORY_ONLY, got ${gate.allowed})`);
  } else if (gate.allowed === "LIVE_ADVISORY_ONLY") {
    check(checks, "governance_ceiling_allows_live", "governance ceiling allows live", "PASS", "ceiling LIVE_ADVISORY_ONLY");
  } else {
    check(checks, "governance_ceiling_allows_live", "governance ceiling allows live", "FAIL",
      `ceiling is ${gate.allowed}: ${gate.reasons.join("; ")}`);
  }

  /* ---- compose ---------------------------------------------------- */
  const failed = checks.filter((c) => c.verdict === "FAIL");
  const unknowns = checks.filter((c) => c.verdict === "UNKNOWN");
  const eligible = checks.every((c) => c.verdict === "PASS");

  // LIVE_ADVISORY_ONLY is reachable ONLY through a fully satisfied gate. Every
  // other outcome is additionally capped at PAPER, so a strong-but-stale (or
  // provenance-less, or unreproducible) evidence set can never leak a live
  // runtime status — the old status→status mapping had exactly that hole.
  const governanceClamped = clampRuntimeStatus(statusForEvidence(evidencedStatus), gate);
  const runtimeStatus: RuntimeStatus = eligible ? "LIVE_ADVISORY_ONLY" : clampTo(governanceClamped, "PAPER");

  const blockingUnknowns = [
    ...unknowns.map((c) => `${c.id}: ${c.detail}`),
    ...(gov.record_present ? [] : [`governance: Brain record for ${input.strategy_id} is unavailable`]),
    ...(gov.unknown_critical as string[]).map((f) => `critical_spec_field: ${f}`),
    ...(missing.length && primary ? [`metrics: ${primary.evidence.symbol} has null ${missing.join(", ")}`] : []),
  ];

  const conflictReasons = checks
    .filter((c) => c.id === "no_unresolved_conflict" && c.verdict !== "PASS")
    .map((c) => c.detail);

  const promotionStatus = derivePromotionStatus(eligible, failed.map((c) => c.id), unknowns.map((c) => c.id), conflictReasons);

  return {
    strategy_id: input.strategy_id,
    decision: eligible ? "ELIGIBLE" : "NOT_ELIGIBLE",
    promotion_status: promotionStatus,
    eligible,
    live_eligible: eligible,
    checks,
    failed_checks: failed.map((c) => c.id),
    unknown_checks: unknowns.map((c) => c.id),
    failure_reasons: failed.map((c) => `${c.id}: ${c.detail}`),
    unknown_reasons: unknowns.map((c) => `${c.id}: ${c.detail}`),
    conflict_reasons: conflictReasons,
    blocking_unknowns: eligible ? [] : blockingUnknowns,
    evidenced_status: evidencedStatus,
    ceiling: gate.allowed,
    gate_reasons: gate.reasons,
    runtime_status: runtimeStatus,
    primary_experiment_id: primary?.evidence.experiment_id ?? null,
    primary_symbol: primary?.evidence.symbol ?? null,
    evidence: evals,
    criteria_source: "ENGINEERING CRITERIA — the corpus states no statistical thresholds",
    methodology: VALIDATION_METHODOLOGY,
    decided_at_ms: input.decided_at_ms,
  };
}

/* ------------------------------------------- machine-readable record (§5) */

/**
 * The A→F states. They are CUMULATIVE and never collapsed into one boolean:
 * A strategy may be executable (B) with no validation (not C); it may have
 * in-sample validation (C) with no out-of-sample evidence (not D); and it may
 * be promotable (E) without being live (F) once an operator step exists —
 * today E and F are the same condition and the separation is kept explicit.
 */
export type ValidationStage =
  | "A_EXISTS"
  | "B_EXECUTABLE"
  | "C_VALIDATION_EVIDENCE"
  | "D_OOS_EVIDENCE"
  | "E_PROMOTION_ELIGIBLE"
  | "F_LIVE_ELIGIBLE";

export type ValidationStatusLabel =
  | "NOT_VALIDATED"
  | "IN_SAMPLE_ONLY"
  | "OUT_OF_SAMPLE"
  | "WALK_FORWARD"
  | "ROBUST"
  | "UNKNOWN";

export interface StrategyValidationRecord {
  strategy_id: string;
  setup_ids: string[];
  name: string | null;
  family: string | null;
  timeframe: string | null;
  strategy_state: {
    exists: boolean;
    executable: boolean;
    has_validation_evidence: boolean;
    has_oos_evidence: boolean;
    promotion_eligible: boolean;
    live_eligible: boolean;
    stage: ValidationStage;
  };
  validation_status: ValidationStatusLabel;
  promotion_status: PromotionStatus;
  validation: {
    experiment_id: string | null;
    symbol: string | null;
    universe: string[];
    timeframe: string | null;
    sample_period: { from_ts: number; to_ts: number; bars: number } | null;
    in_sample_period: { from_ts: number; to_ts: number; bars: number } | null;
    out_of_sample_period: { from_ts: number; to_ts: number; bars: number } | null;
    walk_forward_periods: { window: number; test_from: number; test_to: number; trades: number }[];
    methodology: string | null;
    trade_count: number | null;
    metrics_computed: RequiredMetric[];
    metrics_missing: RequiredMetric[];
    metrics: BacktestMetrics | null;
    oos: BacktestMetrics | null;
    walk_forward: { windows: number; profitable_windows: number; stability: number | null } | null;
    dataset: {
      source_kind: string;
      source_ref: string;
      source_base: string;
      captured_at: string;
      retrieved_at: string;
      source_sha256: string;
      fingerprint: string;
      fingerprint_recomputed: boolean;
      bars: number;
      from_ts: number;
      to_ts: number;
    } | null;
    provenance_refs: SourceRef[];
  };
  promotion: PromotionDecision;
  /** flat machine-readable lists for gates/UI/agents */
  failure_reasons: string[];
  unknown_reasons: string[];
  conflict_reasons: string[];
  blocking: string[];
  /** full auditable provenance graph */
  provenance_chain?: ProvenanceChain;
}

function stageOf(state: {
  exists: boolean; executable: boolean; has_validation_evidence: boolean;
  has_oos_evidence: boolean; promotion_eligible: boolean; live_eligible: boolean;
}): ValidationStage {
  if (state.live_eligible) return "F_LIVE_ELIGIBLE";
  if (state.promotion_eligible) return "E_PROMOTION_ELIGIBLE";
  if (state.has_oos_evidence) return "D_OOS_EVIDENCE";
  if (state.has_validation_evidence) return "C_VALIDATION_EVIDENCE";
  if (state.executable) return "B_EXECUTABLE";
  return "A_EXISTS";
}

function labelOf(status: EmpiricalStatus, hasEvidence: boolean): ValidationStatusLabel {
  if (!hasEvidence) return "NOT_VALIDATED";
  switch (status) {
    case "ROBUST": return "ROBUST";
    case "WALK_FORWARD": return "WALK_FORWARD";
    case "OOS_TESTED": return "OUT_OF_SAMPLE";
    case "BACKTESTED": return "IN_SAMPLE_ONLY";
    case "REJECTED": return "NOT_VALIDATED";
    default: return "UNKNOWN";
  }
}

export interface ProvenanceChain {
  strategy: {
    id: string;
    canonical_name: string | null;
    family: string | null;
    version: string | null;
    source_status: SourceStatus | null;
    has_executable_spec: boolean;
  };
  rules: {
    rule_id: string;
    stage: string;
    direction: string;
    version: string;
    source_status: string;
    predicates: { expr: string; requires: string[] }[];
    feature_dependencies: string[];
  }[];
  compiled_predicate: {
    setup_ids: string[];
    timeframe: string | null;
    availability: RuntimeAvailability | "MISSING";
    rule_ids: string[];
  };
  validation_run: {
    experiment_id: string | null;
    created_ms: number | null;
    methodology: string | null;
    symbol: string | null;
    timeframe: string | null;
  };
  dataset: {
    source_kind: string | null;
    source_ref: string | null;
    source_base: string | null;
    captured_at: string | null;
    retrieved_at: string | null;
    source_sha256: string | null;
    fingerprint: string | null;
    fingerprint_recomputed: boolean;
    bars: number | null;
    range: { from_ts: number; to_ts: number } | null;
  } | null;
  backtest: {
    trade_count: number | null;
    expectancy_r: number | null;
    profit_factor: number | null;
    win_rate: number | null;
    max_drawdown_r: number | null;
    total_r: number | null;
  };
  evidence: {
    oos_trades: number | null;
    oos_expectancy_r: number | null;
    oos_profit_factor: number | null;
    walk_forward: {
      total_windows: number;
      profitable_windows: number;
      stability: number | null;
      status: "COMPLETED" | "NOT_AVAILABLE";
      note: string;
    } | null;
    empirical_status: EmpiricalStatus;
  };
  governance: {
    source_status: SourceStatus | null;
    unknown_critical: string[];
    conflict_group_id: string | null;
    implementation_binding: string | null;
    ceiling: RuntimeStatus;
  };
  promotion_decision: {
    decision: "ELIGIBLE" | "NOT_ELIGIBLE";
    promotion_status: PromotionStatus;
    stage: ValidationStage;
    live_eligible: boolean;
    runtime_status: RuntimeStatus;
    checks_passed: number;
    checks_total: number;
    blocking: string[];
  };
}

export function buildProvenanceChain(
  strategyIdOrDecision: string | PromotionDecision,
  optsOrInput?: PromotionGateInput | {
    input?: PromotionGateInput;
    decision?: PromotionDecision;
    record?: StrategyValidationRecord;
  },
): ProvenanceChain {
  let strategyId: string;
  let input: PromotionGateInput;
  let decision: PromotionDecision;
  let rec: StrategyValidationRecord;

  if (typeof strategyIdOrDecision === "string") {
    strategyId = strategyIdOrDecision;
    const opts = (optsOrInput && "runtime" in optsOrInput ? { input: optsOrInput } : optsOrInput) ?? {};
    input = opts.input ?? resolvePromotionInput(strategyId);
    decision = opts.decision ?? buildPromotionDecision(input);
    rec = opts.record ?? buildValidationRecord(decision, input);
  } else {
    decision = strategyIdOrDecision;
    strategyId = decision.strategy_id;
    input = (optsOrInput && "runtime" in optsOrInput ? optsOrInput : (optsOrInput as { input?: PromotionGateInput })?.input) ?? resolvePromotionInput(strategyId);
    rec = (optsOrInput && !( "runtime" in optsOrInput ) ? (optsOrInput as { record?: StrategyValidationRecord })?.record : undefined) ?? buildValidationRecord(decision, input);
  }

  const compiledVariants = COMPILED_STRATEGIES.filter(
    (c) => c.strategy_id === strategyId || c.setup_id === strategyId,
  );
  const rules = compiledVariants.flatMap((c) => {
    const setup = c.setup();
    return setup.rules.map((r) => ({
      rule_id: r.id,
      stage: r.kind,
      direction: r.direction,
      version: r.version,
      source_status: r.source_status,
      predicates: r.predicates.map((p) => ({ expr: p.expr, requires: p.requires })),
      feature_dependencies: r.feature_dependencies,
    }));
  });

  const row = rec.validation;
  const isMetrics = row.metrics;
  const oosMetrics = row.oos;
  const wf = row.walk_forward;

  return {
    strategy: {
      id: strategyId,
      canonical_name: input.runtime.name,
      family: input.runtime.family,
      version: input.runtime.version,
      source_status: input.governance.source_status,
      has_executable_spec: input.governance.implementation_binding !== null,
    },
    rules,
    compiled_predicate: {
      setup_ids: input.runtime.setup_ids,
      timeframe: input.runtime.timeframe,
      availability: input.runtime.availability,
      rule_ids: input.runtime.rule_ids,
    },
    validation_run: {
      experiment_id: row.experiment_id,
      created_ms: decision.evidence[0]?.evidence.created_ms ?? null,
      methodology: row.methodology,
      symbol: row.symbol,
      timeframe: row.timeframe,
    },
    dataset: row.dataset
      ? {
          source_kind: row.dataset.source_kind,
          source_ref: row.dataset.source_ref,
          source_base: row.dataset.source_base,
          captured_at: row.dataset.captured_at,
          retrieved_at: row.dataset.retrieved_at,
          source_sha256: row.dataset.source_sha256,
          fingerprint: row.dataset.fingerprint,
          fingerprint_recomputed: row.dataset.fingerprint_recomputed,
          bars: row.dataset.bars,
          range: { from_ts: row.dataset.from_ts, to_ts: row.dataset.to_ts },
        }
      : null,
    backtest: {
      trade_count: isMetrics?.trade_count ?? null,
      expectancy_r: isMetrics?.expectancy_r ?? null,
      profit_factor: isMetrics?.profit_factor ?? null,
      win_rate: isMetrics?.win_rate ?? null,
      max_drawdown_r: isMetrics?.max_drawdown_r ?? null,
      total_r: isMetrics?.total_r ?? null,
    },
    evidence: {
      oos_trades: oosMetrics?.trade_count ?? null,
      oos_expectancy_r: oosMetrics?.expectancy_r ?? null,
      oos_profit_factor: oosMetrics?.profit_factor ?? null,
      walk_forward: wf
        ? {
            total_windows: wf.windows,
            profitable_windows: wf.profitable_windows,
            stability: wf.stability,
            status: wf.windows >= 3 ? "COMPLETED" : "NOT_AVAILABLE",
            note: `${wf.profitable_windows}/${wf.windows} profitable windows`,
          }
        : null,
      empirical_status: decision.evidenced_status,
    },
    governance: {
      source_status: input.governance.source_status,
      unknown_critical: input.governance.unknown_critical as string[],
      conflict_group_id: input.governance.conflict_group_id,
      implementation_binding: input.governance.implementation_binding,
      ceiling: decision.ceiling,
    },
    promotion_decision: {
      decision: decision.decision,
      promotion_status: decision.promotion_status,
      stage: rec.strategy_state.stage,
      live_eligible: decision.live_eligible,
      runtime_status: decision.runtime_status,
      checks_passed: decision.checks.filter((c) => c.verdict === "PASS").length,
      checks_total: decision.checks.length,
      blocking: rec.blocking,
    },
  };
}

export function buildValidationRecord(decision: PromotionDecision, input: PromotionGateInput): StrategyValidationRecord {
  const primary = primaryOf(decision.evidence);
  const row = primary?.evidence ?? null;
  const { computed, missing } = metricsComputed(row?.in_sample ?? null);
  const hasEvidence = decision.evidence.length > 0;
  // D means out-of-sample evidence exists for EVERY symbol the strategy was
  // tested on — a strategy with OOS evidence on one pair and none on another
  // has not been tested out of sample as a strategy.
  const hasOos = hasEvidence && decision.evidence.every((e) => e.evidence.oos !== null);

  const state = {
    exists: input.runtime.exists,
    executable: input.runtime.availability === "EXECUTABLE",
    has_validation_evidence: hasEvidence,
    has_oos_evidence: hasOos,
    promotion_eligible: decision.eligible,
    live_eligible: decision.live_eligible,
  };

  const wf = row?.walk_forward ?? null;
  const split = row?.split ?? null;

  return {
    strategy_id: decision.strategy_id,
    setup_ids: input.runtime.setup_ids,
    name: input.runtime.name,
    family: input.runtime.family,
    timeframe: input.runtime.timeframe,
    strategy_state: { ...state, stage: stageOf(state) },
    validation_status: labelOf(decision.evidenced_status, hasEvidence),
    promotion_status: decision.promotion_status,
    validation: {
      experiment_id: row?.experiment_id ?? null,
      symbol: row?.symbol ?? null,
      universe: decision.evidence.map((e) => e.evidence.symbol),
      timeframe: row?.timeframe ?? null,
      sample_period: row ? { from_ts: row.from_ts, to_ts: row.to_ts, bars: row.bars } : null,
      in_sample_period: split ? split.in_sample : null,
      out_of_sample_period: split ? split.out_of_sample : null,
      walk_forward_periods: split ? split.walk_forward_windows : [],
      methodology: row?.methodology ?? null,
      trade_count: row?.in_sample?.trade_count ?? null,
      metrics_computed: computed,
      metrics_missing: missing,
      metrics: row?.in_sample ?? null,
      oos: row?.oos ?? null,
      walk_forward: wf
        ? { windows: wf.total_windows, profitable_windows: wf.profitable_windows, stability: wf.stability }
        : null,
      dataset: row?.dataset_identity
        ? {
            source_kind: row.dataset_identity.source_kind,
            source_ref: row.dataset_identity.source_ref,
            source_base: row.dataset_identity.source_base,
            captured_at: row.dataset_identity.captured_at,
            retrieved_at: row.dataset_identity.retrieved_at,
            source_sha256: row.dataset_identity.source_sha256,
            fingerprint: row.dataset_identity.fingerprint,
            fingerprint_recomputed: row.dataset_identity.fingerprint_recomputed,
            bars: row.dataset_identity.bars,
            from_ts: row.dataset_identity.from_ts,
            to_ts: row.dataset_identity.to_ts,
          }
        : null,
      provenance_refs: input.runtime.source_refs,
    },
    promotion: decision,
    failure_reasons: decision.failure_reasons,
    unknown_reasons: decision.unknown_reasons,
    conflict_reasons: decision.conflict_reasons,
    blocking: decision.eligible ? [] : [...decision.failure_reasons, ...decision.unknown_reasons, ...decision.conflict_reasons],
  };
}

/* ------------------------------------------------------- live resolution */

/**
 * Version set the evidence must still describe, derived from the CURRENT
 * repository — never from a persisted copy, so a code change invalidates its
 * own evidence automatically.
 */
export function currentVersionsFor(strategyId: string): CurrentVersions {
  const strategyVersions = new Set<string>();
  const ruleVersions = new Set<string>();
  for (const c of COMPILED_STRATEGIES) {
    if (c.strategy_id !== strategyId) continue;
    const def = c.setup();
    strategyVersions.add(def.version);
    for (const r of def.rules) ruleVersions.add(r.version);
  }
  const release = buildReleaseIdentity();
  return {
    code_version: release.git_commit,
    detector_version: DETECTOR_VERSION,
    strategy_versions: [...strategyVersions],
    rule_versions: [...ruleVersions],
  };
}

/** Runtime + governance facts for one strategy id, read from the live stores. */
export function resolvePromotionInput(
  strategyId: string,
  opts: {
    evidence?: ExperimentEvidence[];
    versions?: CurrentVersions;
    brainRecord?: StrategyRecord | null;
    brainError?: string | null;
    now?: number;
  } = {},
): PromotionGateInput {
  const variants = getRuntimeVariants(strategyId);
  const runtime: RuntimeFacts = variants.length
    ? {
        exists: true,
        availability: variants.some((v) => v.availability === "EXECUTABLE") ? "EXECUTABLE" : variants[0].availability,
        blocked_reason: variants.find((v) => v.blocked_reason)?.blocked_reason ?? null,
        setup_ids: variants.map((v) => v.setup_id),
        direction_variants: variants.length,
        timeframe: variants[0].timeframe,
        version: variants[0].version,
        rule_ids: [...new Set(variants.flatMap((v) => v.rule_ids))],
        source_refs: variants[0].source_refs,
        name: variants[0].name,
        family: variants[0].family,
      }
    : {
        exists: false, availability: "MISSING", blocked_reason: null, setup_ids: [],
        direction_variants: 0, timeframe: null, version: null, rule_ids: [], source_refs: [],
        name: null, family: null,
      };

  let record: StrategyRecord | null = opts.brainRecord ?? null;
  let resolveError: string | null = opts.brainError ?? null;
  if (opts.brainRecord === undefined) {
    try {
      record = getBrain().strategy(strategyId);
      if (!record) resolveError = "the brain has no record for this id (run `npm run brain:ingest`)";
    } catch (err) {
      record = null;
      resolveError = `brain store unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  let evidence = opts.evidence;
  if (!evidence) {
    try {
      evidence = getExperiments().evidenceFor(strategyId);
    } catch (err) {
      evidence = [];
      resolveError = resolveError ?? `experiments store unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    strategy_id: strategyId,
    runtime,
    governance: {
      record_present: record !== null,
      source_status: record?.source_status ?? null,
      unknown_critical: record?.unknown_critical ?? [],
      conflict_group_id: record?.conflict_group_id ?? null,
      conflict_unresolved: record?.conflict_group_id !== null && record?.conflict_group_id !== undefined,
      implementation_binding: record?.implementation ?? null,
      resolve_error: resolveError,
    },
    evidence,
    versions: opts.versions ?? currentVersionsFor(strategyId),
    decided_at_ms: opts.now ?? Date.now(),
  };
}

/** Full promotion report for one strategy id (live stores, no fabrication). */
export function promotionReport(strategyId: string): StrategyValidationRecord {
  const input = resolvePromotionInput(strategyId);
  return buildValidationRecord(buildPromotionDecision(input), input);
}

/** Promotion report for every compiled strategy (weakest-evidence ordering). */
export function promotionReports(): StrategyValidationRecord[] {
  const ids = [...new Set(listRuntimeStrategies().map((s) => s.strategy_id))];
  return ids.map((id) => promotionReport(id));
}

/**
 * Runtime status for live gating. `LIVE_ADVISORY_ONLY` is reachable ONLY
 * through a fully satisfied promotion gate — every other case is the
 * evidence-derived status CLAMPED by the governance ceiling, and any error
 * fails CLOSED.
 */
export function promotedRuntimeStatus(strategyId: string): RuntimeStatus {
  try {
    const input = resolvePromotionInput(strategyId);
    return buildPromotionDecision(input).runtime_status;
  } catch {
    return "DISABLED";
  }
}
