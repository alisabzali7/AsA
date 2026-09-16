/**
 * STRATEGY PROMOTION GATE — governance + regression tests.
 *
 * These pin the invariant the whole validation phase exists for:
 *
 *     executable ≠ validated ≠ promotable ≠ live eligible
 *
 * Required proofs (master prompt, tests 1–6):
 *   1. an executable strategy with NO validation is NOT_ELIGIBLE
 *   2. validation WITHOUT out-of-sample evidence is NOT_ELIGIBLE
 *   3. OOS evidence with fabricated/missing PROVENANCE is NOT_ELIGIBLE
 *   4. a blocking UNKNOWN in a required condition is NOT_ELIGIBLE (never a PASS)
 *   5. a blocking CONFLICT / governance state is NOT_ELIGIBLE
 *   6. a strategy holding ALL required evidence IS accepted by the gate
 *      (being accepted is NOT the same as being live — the runtime ceiling,
 *      the evidence/version checks and the quality ladder all still apply)
 *
 * Plus: provenance is verifiable, stale versions invalidate evidence, a
 * persisted verdict that cannot be reproduced is refused, live mode cannot be
 * reached without the gate, and the CURRENT repository state still has zero
 * live-eligible strategies.
 *
 * ISOLATION: store paths are set BEFORE any src module is imported, so every
 * store opened by this file lives in a temp dir (same pattern as
 * tests/audit-regressions.test.ts).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ExperimentEvidence, DatasetIdentity, ExperimentSplit,
} from "../src/lib/backtest/experiments";
import type { PromotionGateInput, PromotionDecision, StrategyValidationRecord } from "../src/lib/backtest/promotion";
import type { WalkForwardResult } from "../src/lib/backtest/validation";
import type { BacktestMetrics } from "../src/lib/backtest/strategy-runner";
import type { StrategyRecord } from "../src/lib/brain/types";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-promotion-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
delete process.env.ASA_API_TOKEN;

type PromotionMod = typeof import("../src/lib/backtest/promotion");
type StoreMod = typeof import("../src/lib/backtest/experiments");
type RunnerMod = typeof import("../src/lib/backtest/strategy-runner");
type ValidationMod = typeof import("../src/lib/backtest/validation");
type ScoreMod = typeof import("../src/lib/brain/score");
type BrainMod = typeof import("../src/lib/brain/store");
type IngestMod = typeof import("../src/lib/brain/ingest");
type DetectorsMod = typeof import("../src/lib/features/detectors");
type ReleaseMod = typeof import("../src/lib/release");
type CompiledMod = typeof import("../src/lib/strategy/compiled");

let P: PromotionMod;
let EXP: StoreMod;
let RUN: RunnerMod;
let V: ValidationMod;
let SCORE: ScoreMod;
let BRAIN: BrainMod;
let INGEST: IngestMod;
let DET: DetectorsMod;
let REL: ReleaseMod;
let COMPILED: CompiledMod;

const STRATEGY_ID = "STR-RAW-2-803";
const SETUP_ID = "SET-STR-RAW-2-803";

beforeAll(async () => {
  P = await import("../src/lib/backtest/promotion");
  EXP = await import("../src/lib/backtest/experiments");
  RUN = await import("../src/lib/backtest/strategy-runner");
  V = await import("../src/lib/backtest/validation");
  SCORE = await import("../src/lib/brain/score");
  BRAIN = await import("../src/lib/brain/store");
  INGEST = await import("../src/lib/brain/ingest");
  DET = await import("../src/lib/features/detectors");
  REL = await import("../src/lib/release");
  COMPILED = await import("../src/lib/strategy/compiled");
});

afterAll(() => {
  try { BRAIN.closeBrain(); } catch { /* not opened */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* --------------------------------------------------------------- fixtures */

/** A complete, plausible metric set — every field COMPUTED, none missing. */
function metrics(over: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    ...RUN.computeMetrics([], 10_000),
    trade_count: 100, wins: 55, losses: 45, win_rate: 55,
    average_r: 0.5, expectancy_r: 0.5, profit_factor: 2, max_drawdown_r: 3,
    total_r: 50, sufficient_sample: true,
    ...over,
  };
}

function walkForward(over: Partial<WalkForwardResult> = {}): WalkForwardResult {
  const w = metrics({ trade_count: 20, expectancy_r: 0.4, profit_factor: 1.8, max_drawdown_r: 2 });
  return {
    windows: [1, 2, 3, 4].map((n) => ({
      window: n, train_from: 1_000, test_from: 1_000 + n * 100, test_to: 1_000 + n * 100 + 99,
      metrics: w, trades: w.trade_count,
    })),
    profitable_windows: 3,
    total_windows: 4,
    aggregate: metrics({ trade_count: 80, expectancy_r: 0.4, profit_factor: 1.5, max_drawdown_r: 4 }),
    stability: 1.5,
    note: "4 rolling out-of-sample windows",
    ...over,
  };
}

const SHA = createHash("sha256").update("asa-test-artifact").digest("hex");

function identity(over: Partial<DatasetIdentity> = {}): DatasetIdentity {
  return {
    source_kind: "TTT_UDF_REPLAY",
    source_ref: "tests/fixtures/replay/BTCUSDT-60.json",
    source_base: "https://apiv2.thetruetrade.io",
    captured_at: "2026-09-09T11:27:18.651Z",
    retrieved_at: "2026-09-16T00:00:00.000Z",
    fingerprint: "fp-1",
    fingerprint_recomputed: true,
    source_sha256: SHA,
    bars: 1500,
    from_ts: 1_783_504_800,
    to_ts: 1_788_897_600,
    note: "TTT public UDF history captured verbatim",
    ...over,
  };
}

function split(over: Partial<ExperimentSplit> = {}): ExperimentSplit {
  return {
    split_ratio: 0.7,
    split_index: 1050,
    in_sample: { from_ts: 1_783_504_800, to_ts: 1_788_000_000, bars: 1050 },
    out_of_sample: { from_ts: 1_788_000_600, to_ts: 1_788_897_600, bars: 450 },
    walk_forward_windows: [1, 2, 3, 4].map((n) => ({ window: n, test_from: n * 1000, test_to: n * 1000 + 99, trades: 5 })),
    ...over,
  };
}

function evidence(over: Partial<ExperimentEvidence> = {}): ExperimentEvidence {
  const id = identity({ fingerprint: (over.dataset_fingerprint as string) ?? "fp-1" });
  return {
    experiment_id: "exp-1",
    created_ms: 1_788_000_000_000,
    strategy_id: STRATEGY_ID,
    setup_id: SETUP_ID,
    symbol: "BTCUSDT",
    timeframe: "1h",
    dataset_fingerprint: "fp-1",
    bars: 1500,
    from_ts: 1_783_504_800,
    to_ts: 1_788_897_600,
    empirical_status: "ROBUST",
    versions: {
      strategy_version: "v-current",
      detector_version: "1.0.0",
      rule_version: "1.0.0",
      code_version: "abc1234",
      app_version: "6.0.1",
      build_id: "6.0.1+abc1234",
    },
    params: { methodology: V.VALIDATION_METHODOLOGY },
    in_sample: metrics(),
    oos: metrics({ trade_count: 40, expectancy_r: 0.4, profit_factor: 1.8, max_drawdown_r: 5, win_rate: 52 }),
    walk_forward: walkForward(),
    promotion: { to: "ROBUST" },
    dataset_identity: id,
    split: split(),
    methodology: V.VALIDATION_METHODOLOGY,
    parse_notes: [],
    ...over,
  };
}

function brainRecord(over: Partial<StrategyRecord> = {}): StrategyRecord {
  return {
    strategy_id: STRATEGY_ID,
    canonical_name: "پرایس اکشن سطوح نامرئی",
    family: "level-reaction",
    aliases: [],
    type: "strategy",
    description: "",
    source_refs: [{ file: "2.txt", start_line: 10, end_line: 20 }],
    source_status: "SOURCE_VERIFIED",
    empirical_status: "UNTESTED",
    runtime_status: "CANDIDATE",
    unknown_critical: [],
    conflict_group_id: null,
    setup_ids: [SETUP_ID],
    rule_ids: ["R-1"],
    implementation: `compiled:${SETUP_ID}`,
    version: "1.0.0",
    disabled_reason: null,
    ...over,
  };
}

function gateInput(over: {
  evidence?: ExperimentEvidence[];
  governance?: Partial<PromotionGateInput["governance"]>;
  versions?: Partial<PromotionGateInput["versions"]>;
  runtime?: Partial<PromotionGateInput["runtime"]>;
  strategy_id?: string;
} = {}): PromotionGateInput {
  const rec = brainRecord();
  return {
    strategy_id: over.strategy_id ?? STRATEGY_ID,
    runtime: {
      exists: true,
      availability: "EXECUTABLE",
      blocked_reason: null,
      setup_ids: [SETUP_ID],
      direction_variants: 1,
      timeframe: "1h",
      version: "v-current",
      rule_ids: rec.rule_ids,
      source_refs: rec.source_refs,
      name: rec.canonical_name,
      family: rec.family,
      ...over.runtime,
    },
    governance: {
      record_present: true,
      source_status: rec.source_status,
      unknown_critical: rec.unknown_critical,
      conflict_group_id: null,
      conflict_unresolved: false,
      implementation_binding: rec.implementation,
      resolve_error: null,
      ...over.governance,
    },
    evidence: over.evidence ?? [evidence()],
    versions: {
      code_version: "abc1234",
      detector_version: "1.0.0",
      strategy_versions: ["v-current"],
      rule_versions: ["1.0.0"],
      ...over.versions,
    },
    decided_at_ms: 1_788_000_500_000,
  };
}

function decide(over: Parameters<typeof gateInput>[0] = {}): PromotionDecision {
  return P.buildPromotionDecision(gateInput(over));
}

function record(over: Parameters<typeof gateInput>[0] = {}): StrategyValidationRecord {
  const input = gateInput(over);
  return P.buildValidationRecord(P.buildPromotionDecision(input), input);
}

const checkOf = (d: PromotionDecision, id: string) => d.checks.find((c) => c.id === id)!;

/* ------------------------------------------------------------------ tests */

describe("Test 6 — the gate accepts a strategy that holds every required evidence", () => {
  it("all mandatory checks PASS for a fully-evidenced, governance-clean strategy", () => {
    const d = decide();
    const failing = d.checks.filter((c) => c.verdict !== "PASS");
    expect(failing.map((c) => `${c.id}:${c.verdict}:${c.detail}`)).toEqual([]);
    expect(d.eligible).toBe(true);
    expect(d.decision).toBe("ELIGIBLE");
    expect(d.runtime_status).toBe("LIVE_ADVISORY_ONLY");
    expect(d.evidenced_status).toBe("ROBUST");
  });

  it("the record separates the A→F states instead of collapsing them", () => {
    const r = record();
    expect(r.strategy_state).toEqual({
      exists: true, executable: true, has_validation_evidence: true, has_oos_evidence: true,
      promotion_eligible: true, live_eligible: true, stage: "F_LIVE_ELIGIBLE",
    });
    expect(r.validation_status).toBe("ROBUST");
    expect(r.validation.experiment_id).toBe("exp-1");
    expect(r.validation.dataset?.source_kind).toBe("TTT_UDF_REPLAY");
    expect(r.validation.in_sample_period?.bars).toBe(1050);
    expect(r.validation.out_of_sample_period?.bars).toBe(450);
    expect(r.validation.metrics_missing).toEqual([]);
    expect(r.failure_reasons).toEqual([]);
    expect(r.unknown_reasons).toEqual([]);
    expect(r.blocking).toEqual([]);
  });
});

describe("Test 1 — executable without validation is NOT_ELIGIBLE", () => {
  it("an executable strategy with no experiments is refused, not assumed", () => {
    const d = decide({ evidence: [] });
    expect(d.eligible).toBe(false);
    expect(d.decision).toBe("NOT_ELIGIBLE");
    expect(checkOf(d, "evidence_dataset_provenance").verdict).toBe("UNKNOWN");
    expect(checkOf(d, "oos_evidence_exists").verdict).toBe("UNKNOWN");
    expect(checkOf(d, "evidence_quality_gate").verdict).toBe("UNKNOWN");
    expect(d.unknown_checks).toContain("validation_evidence_exists");
    expect(d.blocking_unknowns.length).toBeGreaterThan(0);
  });

  it("executability alone never reaches live eligibility", () => {
    const d = decide({ evidence: [] });
    expect(d.runtime_status).not.toBe("LIVE_ADVISORY_ONLY");
    expect(d.live_eligible).toBe(false);
  });
});

describe("Test 2 — validation without OOS evidence is NOT_ELIGIBLE", () => {
  const noOos = () => evidence({ oos: null, walk_forward: null, empirical_status: "BACKTESTED" });

  it("an in-sample-only run cannot be promoted", () => {
    const d = decide({ evidence: [noOos()] });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "oos_evidence_exists").verdict).toBe("UNKNOWN");
    expect(checkOf(d, "evidence_quality_gate").verdict).toBe("UNKNOWN");
    expect(d.evidenced_status).toBe("BACKTESTED");
    expect(d.runtime_status).toBe("CANDIDATE");
  });

  it("the record reports IN_SAMPLE_ONLY with the OOS gap as the blocking reason", () => {
    const r = record({ evidence: [noOos()] });
    expect(r.validation_status).toBe("IN_SAMPLE_ONLY");
    expect(r.strategy_state.stage).toBe("C_VALIDATION_EVIDENCE");
    expect(r.strategy_state.has_oos_evidence).toBe(false);
    expect(r.unknown_reasons.join(" ")).toMatch(/out-of-sample/);
  });

  it("an OOS split that produced zero trades is a FAIL, not a missing result", () => {
    const d = decide({ evidence: [evidence({ oos: metrics({ trade_count: 0, win_rate: null, expectancy_r: null, profit_factor: null }) })] });
    expect(checkOf(d, "oos_evidence_exists").verdict).toBe("FAIL");
    expect(d.eligible).toBe(false);
  });
});

describe("Test 3 — fabricated or provenance-less evidence is NOT_ELIGIBLE", () => {
  it("an experiment with no dataset identity is UNKNOWN, never promotable", () => {
    const d = decide({ evidence: [evidence({ dataset_identity: null })] });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "evidence_dataset_provenance").verdict).toBe("UNKNOWN");
    expect(checkOf(d, "evidence_dataset_provenance").detail).toMatch(/TTT/);
  });

  it("synthetic fixture candles can never back a promotion", () => {
    const d = decide({
      evidence: [evidence({ dataset_identity: identity({ source_kind: "FIXTURE_SYNTHETIC" }) })],
    });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "evidence_dataset_provenance").verdict).toBe("FAIL");
    expect(checkOf(d, "evidence_dataset_provenance").detail).toMatch(/may not back a promotion/);
  });

  it("a fingerprint that was copied rather than recomputed is UNKNOWN", () => {
    const d = decide({ evidence: [evidence({ dataset_identity: identity({ fingerprint_recomputed: false }) })] });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "evidence_dataset_provenance").verdict).toBe("UNKNOWN");
  });

  it("a dataset identity whose fingerprint does not match the experiment is refused", () => {
    const d = decide({ evidence: [evidence({ dataset_identity: identity({ fingerprint: "different" }) })] });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "evidence_dataset_provenance").verdict).toBe("FAIL");
  });

  it("a dataset identity whose range does not match the experiment is refused", () => {
    const d = decide({ evidence: [evidence({ dataset_identity: identity({ bars: 999 }) })] });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "evidence_dataset_provenance").verdict).toBe("FAIL");
  });

  it("an incomplete identity (no sha, no capture time) is refused", () => {
    for (const broken of [{ source_sha256: "" }, { captured_at: "" }, { source_ref: "" }]) {
      const d = decide({ evidence: [evidence({ dataset_identity: identity(broken) })] });
      expect(d.eligible, JSON.stringify(broken)).toBe(false);
      expect(checkOf(d, "evidence_dataset_provenance").verdict).toBe("UNKNOWN");
    }
  });
});

describe("Test 4 — a blocking UNKNOWN in a required condition is NOT_ELIGIBLE", () => {
  it("null metrics are UNKNOWN and never upgraded to PASS", () => {
    const partial = metrics({ expectancy_r: null, profit_factor: null });
    const d = decide({
      evidence: [evidence({ in_sample: partial, empirical_status: "BACKTESTED", oos: null, walk_forward: null })],
    });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "required_metrics_computed").verdict).toBe("UNKNOWN");
    expect(checkOf(d, "required_metrics_computed").detail).toMatch(/expectancy_r/);
    expect(d.blocking_unknowns.join(" ")).toMatch(/expectancy_r/);
  });

  it("an absent Brain record leaves the governance state UNKNOWN", () => {
    const d = decide({
      governance: {
        record_present: false, source_status: null, unknown_critical: [],
        conflict_group_id: null, conflict_unresolved: false, implementation_binding: null,
        resolve_error: "the brain has no record for this id",
      },
    });
    expect(d.eligible).toBe(false);
    for (const id of ["implementation_binding", "source_status_usable", "no_unknown_critical", "no_unresolved_conflict", "governance_ceiling_allows_live"]) {
      expect(checkOf(d, id).verdict, id).toBe("UNKNOWN");
    }
  });

  it("an unreadable in-sample row cannot be re-derived and is UNKNOWN", () => {
    const d = decide({ evidence: [evidence({ in_sample: null as unknown as BacktestMetrics })] });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "required_metrics_computed").verdict).toBe("UNKNOWN");
    expect(checkOf(d, "evidence_verdict_reproducible").verdict).toBe("UNKNOWN");
    expect(checkOf(d, "evidence_quality_gate").verdict).toBe("UNKNOWN");
  });

  it("no evidence whatsoever keeps every evidence check UNKNOWN (never PASS)", () => {
    const d = decide({ evidence: [] });
    for (const id of ["validation_evidence_exists", "evidence_dataset_provenance", "evidence_versions_current", "evidence_methodology_declared", "required_metrics_computed", "evidence_verdict_reproducible", "oos_evidence_exists", "evidence_quality_gate"]) {
      expect(checkOf(d, id).verdict, id).toBe("UNKNOWN");
    }
  });
});

describe("Test 5 — blocking CONFLICT / governance state is NOT_ELIGIBLE", () => {
  it("an unresolved conflict group blocks promotion", () => {
    const d = decide({ governance: { conflict_unresolved: true, conflict_group_id: "CG-1" } });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "no_unresolved_conflict").verdict).toBe("FAIL");
    expect(checkOf(d, "governance_ceiling_allows_live").verdict).toBe("FAIL");
    expect(d.conflict_reasons.join(" ")).toMatch(/CG-1/);
  });

  it("a critical UNKNOWN spec field blocks promotion even with ROBUST evidence", () => {
    const d = decide({ governance: { unknown_critical: ["stop"] } });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "no_unknown_critical").verdict).toBe("FAIL");
    expect(d.runtime_status).toBe("DISABLED");
  });

  it("a source CLAIM is not evidence and blocks promotion", () => {
    const d = decide({ governance: { source_status: "CLAIM" } });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "source_status_usable").verdict).toBe("FAIL");
  });

  it("a missing implementation binding blocks promotion", () => {
    const d = decide({ governance: { implementation_binding: null } });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "implementation_binding").verdict).toBe("FAIL");
  });
});

describe("evidence must describe the CURRENT build", () => {
  it("a stale code version invalidates the evidence", () => {
    const d = decide({ evidence: [evidence({ versions: { ...evidence().versions, code_version: "deadbee" } })] });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "evidence_versions_current").verdict).toBe("FAIL");
    expect(checkOf(d, "evidence_versions_current").detail).toMatch(/stale/);
  });

  it("a detector, strategy or rule version drift invalidates the evidence", () => {
    for (const over of [{ detector_version: "0.9.0" }, { strategy_version: "v-old" }, { rule_version: "0.9.9" }]) {
      const d = decide({ evidence: [evidence({ versions: { ...evidence().versions, ...over } })] });
      expect(d.eligible, JSON.stringify(over)).toBe(false);
      expect(checkOf(d, "evidence_versions_current").verdict).toBe("FAIL");
    }
  });

  it("a combined rule version string is accepted only when every part is current", () => {
    const ok = decide({ evidence: [evidence({ versions: { ...evidence().versions, rule_version: "1.0.0" } })] });
    expect(ok.eligible).toBe(true);
    const bad = decide({ evidence: [evidence({ versions: { ...evidence().versions, rule_version: "1.0.0+0.9.0" } })] });
    expect(bad.eligible).toBe(false);
  });

  it("an undeclared methodology is UNKNOWN, a different one is a FAIL", () => {
    const undeclared = decide({ evidence: [evidence({ methodology: null, params: {} })] });
    expect(undeclared.eligible).toBe(false);
    expect(checkOf(undeclared, "evidence_methodology_declared").verdict).toBe("UNKNOWN");
    const other = decide({ evidence: [evidence({ methodology: "some-old-methodology" })] });
    expect(other.eligible).toBe(false);
    expect(checkOf(other, "evidence_methodology_declared").verdict).toBe("FAIL");
  });
});

describe("a persisted verdict is never taken on faith", () => {
  it("a stored OOS_TESTED that the metrics do not support is refused", () => {
    const weak = metrics({ trade_count: 60, expectancy_r: 1, profit_factor: 2, max_drawdown_r: 2 });
    const weakOos = metrics({ trade_count: 20, expectancy_r: 0.1, profit_factor: 1.3, max_drawdown_r: 2 });
    const d = decide({
      evidence: [evidence({ in_sample: weak, oos: weakOos, walk_forward: null, empirical_status: "OOS_TESTED" })],
    });
    expect(d.eligible).toBe(false);
    expect(checkOf(d, "evidence_verdict_reproducible").verdict).toBe("FAIL");
    expect(checkOf(d, "evidence_verdict_reproducible").detail).toMatch(/not reproducible|NOT reproducible/i);
  });

  it("the weakest symbol decides — one weak pair blocks the whole strategy", () => {
    const strong = evidence({ symbol: "BTCUSDT" });
    const weak = evidence({
      symbol: "ADAUSDT", experiment_id: "exp-2", dataset_fingerprint: "fp-2",
      dataset_identity: identity({ fingerprint: "fp-2" }),
      empirical_status: "BACKTESTED", oos: null, walk_forward: null,
      in_sample: metrics({ trade_count: 3, expectancy_r: -0.5, profit_factor: 0.2, max_drawdown_r: 20 }),
    });
    const d = decide({ evidence: [strong, weak] });
    expect(d.eligible).toBe(false);
    expect(d.primary_symbol).toBe("ADAUSDT");
    expect(d.evidenced_status).toBe("BACKTESTED");
    expect(checkOf(d, "evidence_quality_gate").verdict).toBe("FAIL");
  });
});

describe("store round-trip: provenance is verifiable, not decorative", () => {
  it("a stored row reads back with its dataset identity, split and methodology", () => {
    const p = path.join(TMP, "exp-roundtrip.db");
    const store = new EXP.ExperimentStore(p);
    const ev = evidence();
    store.insert({
      experiment_id: "exp-roundtrip",
      created_ms: 1,
      strategy_id: STRATEGY_ID,
      setup_id: SETUP_ID,
      symbol: "BTCUSDT",
      timeframe: "1h",
      dataset_fingerprint: ev.dataset_fingerprint,
      bars: ev.bars,
      from_ts: ev.from_ts,
      to_ts: ev.to_ts,
      strategy_version: ev.versions.strategy_version,
      detector_version: ev.versions.detector_version,
      rule_version: ev.versions.rule_version,
      risk_policy_id: "RISK-ASA-CONSERVATIVE-DEFAULT",
      psychology_policy_set: "P1",
      costs: {},
      params: ev.params,
      in_sample: ev.in_sample,
      oos: ev.oos,
      walk_forward: ev.walk_forward,
      promotion: { to: "ROBUST" },
      empirical_status: "ROBUST",
      code_version: ev.versions.code_version,
      dataset_identity: ev.dataset_identity,
      split: ev.split,
    });
    const [read] = store.evidenceFor(STRATEGY_ID);
    expect(read.parse_notes).toEqual([]);
    expect(read.dataset_identity?.source_sha256).toBe(SHA);
    expect(read.split?.out_of_sample.bars).toBe(450);
    expect(read.methodology).toBe(V.VALIDATION_METHODOLOGY);
    expect(P.validateDatasetProvenance(read).ok).toBe(true);
    store.close();
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(p + s, { force: true });
  });

  it("a pre-provenance (legacy) row reads as UNKNOWN and can never be promoted", () => {
    const p = path.join(TMP, "exp-legacy.db");
    const store = new EXP.ExperimentStore(p);
    store.insert({
      experiment_id: "exp-legacy",
      created_ms: 1, strategy_id: STRATEGY_ID, setup_id: SETUP_ID, symbol: "BTCUSDT", timeframe: "1h",
      dataset_fingerprint: "fp-1", bars: 10, from_ts: 1, to_ts: 2,
      strategy_version: "v-current", detector_version: "1.0.0", rule_version: "1.0.0",
      risk_policy_id: "R", psychology_policy_set: "P", costs: {}, params: {},
      in_sample: metrics(), oos: null, walk_forward: null, promotion: {},
      empirical_status: "BACKTESTED", code_version: "abc1234",
    });
    const [read] = store.evidenceFor(STRATEGY_ID);
    expect(read.dataset_identity).toBeNull();
    expect(read.split).toBeNull();
    expect(read.parse_notes.join(" ")).toMatch(/dataset_identity: absent/);
    const prov = P.validateDatasetProvenance(read);
    expect(prov.ok).toBe(false);
    expect(prov.verdict).toBe("UNKNOWN");
    store.close();
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(p + s, { force: true });
  });

  it("an OLD experiments table is migrated additively — no historical row is rewritten", async () => {
    const Database = (await import("better-sqlite3")).default;
    const p = path.join(TMP, "exp-legacy-schema.db");
    // The schema as it existed BEFORE the promotion phase (no provenance cols).
    const legacy = new Database(p);
    legacy.exec(`
      CREATE TABLE experiments (
        experiment_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, strategy_id TEXT NOT NULL,
        setup_id TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
        dataset_fingerprint TEXT NOT NULL, bars INTEGER NOT NULL, from_ts INTEGER NOT NULL, to_ts INTEGER NOT NULL,
        strategy_version TEXT NOT NULL, detector_version TEXT NOT NULL, rule_version TEXT NOT NULL,
        risk_policy_id TEXT NOT NULL, psychology_policy_set TEXT NOT NULL, costs_json TEXT NOT NULL,
        params_json TEXT NOT NULL, in_sample_json TEXT NOT NULL, oos_json TEXT, walk_forward_json TEXT,
        promotion_json TEXT NOT NULL, empirical_status TEXT NOT NULL, code_version TEXT NOT NULL
      );`);
    legacy.prepare(
      `INSERT INTO experiments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "legacy-1", 1, STRATEGY_ID, SETUP_ID, "BTCUSDT", "1h", "fp-old", 10, 1, 2,
      "v-current", "1.0.0", "1.0.0", "R", "P", "{}", "{}", JSON.stringify(metrics()), null, null,
      "{}", "BACKTESTED", "abc1234",
    );
    legacy.close();

    const store = new EXP.ExperimentStore(p); // migrate() must add the new columns
    const rows = store.allFor(STRATEGY_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].dataset_identity_json ?? null).toBeNull();
    const [read] = store.evidenceFor(STRATEGY_ID);
    expect(read.parse_notes.join(" ")).toMatch(/dataset_identity: absent/);
    expect(store.statusByStrategy()[STRATEGY_ID].status).toBe("BACKTESTED");
    store.close();
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(p + s, { force: true });
  });

  it("the real validation runner records provenance that recomputes to the artifact", () => {
    const file = path.resolve("tests/fixtures/replay/BTCUSDT-60.json");
    const bytes = fs.readFileSync(file, "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const parsed = JSON.parse(bytes) as { s: string; t: number[]; o: number[]; h: number[]; l: number[]; c: number[] };
    expect(Array.isArray(parsed.t)).toBe(true);
    // the fixture is TTT-derived UDF history, and the manifest declares the venue
    const manifest = JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/replay/MANIFEST.json"), "utf8")) as {
      base: string; captured_at_utc: string; endpoint: string;
    };
    expect(manifest.base).toContain("thetruetrade");
    expect(manifest.endpoint).toContain("/futures/udf/history");
    expect(new Date(manifest.captured_at_utc).getTime()).toBeGreaterThan(0);
  });
});

describe("live eligibility is unreachable without the gate", () => {
  it("admission refuses a non-live runtime status in live mode", () => {
    const base = {
      score: 95, threshold: 85, data_quality_ok: true, stale: false,
      risk_verdict: "pass" as const, portfolio_verdict: "pass" as const,
      psychology_verdict: "pass" as const,
      unresolved_contradiction: false, unknown_required_fields: [] as string[],
      requires_live_eligibility: true,
    };
    for (const status of ["CANDIDATE", "PAPER", "DISABLED"]) {
      const r = SCORE.admitOpportunity({ ...base, strategy_runtime_status: status });
      expect(r.admitted, status).toBe(false);
      expect(r.reasons.join(" | ")).toMatch(/promotion-eligible/);
    }
    const live = SCORE.admitOpportunity({ ...base, strategy_runtime_status: "LIVE_ADVISORY_ONLY" });
    expect(live.admitted).toBe(true);
  });

  it("research mode keeps working without the live gate", () => {
    const r = SCORE.admitOpportunity({
      score: 95, threshold: 85, data_quality_ok: true, stale: false,
      risk_verdict: "pass", portfolio_verdict: "pass", psychology_verdict: "pass",
      strategy_runtime_status: "CANDIDATE", unresolved_contradiction: false, unknown_required_fields: [],
    });
    expect(r.admitted).toBe(true);
  });
});

describe("the CURRENT repository state cannot promote anything", () => {
  it("the fixture manifest's venue is TTT-only (no third-party market data)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/replay/MANIFEST.json"), "utf8")) as {
      base: string; note: string;
    };
    for (const banned of ["binance", "tradingview", "coingecko", "yahoo"]) {
      expect(manifest.base.toLowerCase()).not.toContain(banned);
      expect(manifest.note.toLowerCase()).not.toContain(banned);
    }
  });

  it("with an ingested brain but historical evidence, every compiled strategy is NOT_ELIGIBLE", () => {
    const store = new BRAIN.BrainStore(process.env.ASA_BRAIN_DB_PATH!);
    INGEST.ingestCorpus(store, path.resolve("knowledge/raw"));
    const releases = REL.buildReleaseIdentity();

    // Evidence recorded by an earlier build: the versions no longer match.
    const historical = evidence({
      versions: {
        strategy_version: "1.1.0", detector_version: DET.DETECTOR_VERSION, rule_version: "1.0.0",
        code_version: `${releases.git_commit}-older`, app_version: "6.0.1", build_id: "old",
      },
    });

    const ids = COMPILED.COMPILED_STRATEGY_IDS;
    expect(ids.length).toBeGreaterThan(0);
    let eligible = 0;
    for (const id of ids) {
      const input = P.resolvePromotionInput(id, {
        evidence: [historical],
        brainRecord: store.strategy(id),
        versions: P.currentVersionsFor(id),
      });
      const d = P.buildPromotionDecision(input);
      expect(d.decision, id).toBe("NOT_ELIGIBLE");
      expect(d.failed_checks, id).toContain("evidence_versions_current");
      expect(d.runtime_status, id).not.toBe("LIVE_ADVISORY_ONLY");
      if (d.eligible) eligible++;
    }
    expect(eligible).toBe(0);
    store.close();
  });

  it("every compiled strategy is executable-or-explainable, and none is live eligible", async () => {
    const { listStrategiesSummary } = await import("../src/lib/pipeline/orchestrator");
    const summary = listStrategiesSummary();
    expect(summary.length).toBeGreaterThan(0);
    for (const s of summary) {
      expect(s.executable).toBe(true);
      expect(s.live_eligible).toBe(false);
    }
  });

  it("the gate is the only source of runtime status (no hand-rolled mapping remains)", () => {
    const src = fs.readFileSync("src/lib/pipeline/orchestrator.ts", "utf8");
    expect(src).toMatch(/promotedRuntimeStatus/);
    expect(src).not.toMatch(/if \(st === "ROBUST" \|\| st === "WALK_FORWARD"\)/);
  });

  it("strong-but-stale evidence yields at most PAPER, never a live runtime status", () => {
    const stale = evidence({ versions: { ...evidence().versions, code_version: "deadbee" } });
    const d = decide({ evidence: [stale] });
    expect(d.eligible).toBe(false);
    // the metrics themselves would qualify (ROBUST), yet the build moved on
    expect(d.evidenced_status).toBe("ROBUST");
    expect(d.runtime_status).toBe("PAPER");
    expect(d.runtime_status).not.toBe("LIVE_ADVISORY_ONLY");
  });

  it("GET /api/brain/validation computes can_go_live instead of hard-coding it", async () => {
    const { GET } = await import("../src/app/api/brain/validation/route");
    const res = await GET(new Request("http://localhost/api/brain/validation"));
    const body = (await res.json()) as {
      ok: boolean;
      counts: Record<string, number>;
      methodology: string;
      promotion_gate: { checks: string[] };
      strategies: { strategy_id: string; can_go_live: boolean; promotion_decision: string; blocking: string[]; stage: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.methodology).toBe(V.VALIDATION_METHODOLOGY);
    expect(body.promotion_gate.checks.length).toBeGreaterThan(10);
    expect(body.counts.live_eligible).toBe(0);
    expect(body.counts.promotion_eligible).toBe(0);
    expect(body.strategies.length).toBeGreaterThan(0);
    for (const s of body.strategies) {
      expect(s.can_go_live, s.strategy_id).toBe(s.promotion_decision === "ELIGIBLE");
      expect(s.can_go_live, s.strategy_id).toBe(false);
      expect(Array.isArray(s.blocking), s.strategy_id).toBe(true);
    }
  });

  it("GET /api/brain/validation?strategy=… returns the full record next to the raw audit", async () => {
    const { GET } = await import("../src/app/api/brain/validation/route");
    const res = await GET(new Request(`http://localhost/api/brain/validation?strategy=${STRATEGY_ID}`));
    const body = (await res.json()) as {
      ok: boolean;
      experiment_count: number;
      promotion: { strategy_state: { exists: boolean; stage: string }; promotion: { decision: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.promotion.strategy_state.exists).toBe(true);
    expect(body.promotion.promotion.decision).toBe("NOT_ELIGIBLE");
  });
});
