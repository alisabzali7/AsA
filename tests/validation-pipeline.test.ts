/**
 * VALIDATION PIPELINE & PROMOTION ENGINE (PHASE 2) TEST SUITE.
 *
 * Verifies:
 * - End-to-end typed validation pipeline (`runValidationPipeline`)
 * - Market regime classification (`classifySeriesRegime`)
 * - Experiment store queries (`getById`, `evidenceById`)
 * - Provenance chain building (`buildProvenanceChain`)
 * - Deterministic promotion status derivation (`derivePromotionStatus`)
 * - Scenarios A through H (A: No evidence, B: IS only, C: Bad provenance,
 *   D: UNKNOWN propagation, E: Governance conflict, F: Fully evidenced,
 *   G: Stale code/version drift, H: TTT replay pipeline run)
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ExperimentEvidence, DatasetIdentity, ExperimentSplit,
} from "../src/lib/backtest/experiments";
import type { PromotionGateInput } from "../src/lib/backtest/promotion";
import type { BacktestMetrics } from "../src/lib/backtest/strategy-runner";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-val-pipe-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
delete process.env.ASA_API_TOKEN;

type PromotionMod = typeof import("../src/lib/backtest/promotion");
type StoreMod = typeof import("../src/lib/backtest/experiments");
type RunnerMod = typeof import("../src/lib/backtest/strategy-runner");
type ValidationMod = typeof import("../src/lib/backtest/validation");
type PipeMod = typeof import("../src/lib/backtest/validation-pipeline");
type CompiledMod = typeof import("../src/lib/strategy/compiled");

let P: PromotionMod;
let EXP: StoreMod;
let RUN: RunnerMod;
let V: ValidationMod;
let PIPE: PipeMod;
let COMPILED: CompiledMod;

const STRATEGY_ID = "STR-RAW-2-803";
const SETUP_ID = "SET-STR-RAW-2-803";
const SHA = createHash("sha256").update("pipe-test-artifact").digest("hex");

beforeAll(async () => {
  P = await import("../src/lib/backtest/promotion");
  EXP = await import("../src/lib/backtest/experiments");
  RUN = await import("../src/lib/backtest/strategy-runner");
  V = await import("../src/lib/backtest/validation");
  PIPE = await import("../src/lib/backtest/validation-pipeline");
  COMPILED = await import("../src/lib/strategy/compiled");
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function mockMetrics(over: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    ...RUN.computeMetrics([], 10_000),
    trade_count: 80, wins: 45, losses: 35, win_rate: 56.25,
    average_r: 0.45, expectancy_r: 0.45, profit_factor: 1.8, max_drawdown_r: 3.5,
    total_r: 36, sufficient_sample: true,
    ...over,
  };
}

function mockIdentity(over: Partial<DatasetIdentity> = {}): DatasetIdentity {
  return {
    source_kind: "TTT_UDF_REPLAY",
    source_ref: "tests/fixtures/replay/BTCUSDT-60.json",
    source_base: "https://apiv2.thetruetrade.io",
    captured_at: "2026-09-09T11:27:18.651Z",
    retrieved_at: "2026-09-16T00:00:00.000Z",
    fingerprint: "fp-test-1",
    fingerprint_recomputed: true,
    source_sha256: SHA,
    bars: 1200,
    from_ts: 1_783_504_800,
    to_ts: 1_788_897_600,
    note: "TTT public replay fixture",
    ...over,
  };
}

function mockEvidence(over: Partial<ExperimentEvidence> = {}): ExperimentEvidence {
  const ident = mockIdentity({ fingerprint: (over.dataset_fingerprint as string) ?? "fp-test-1" });
  return {
    experiment_id: "exp-pipe-1",
    created_ms: 1_788_000_000_000,
    strategy_id: STRATEGY_ID,
    setup_id: SETUP_ID,
    symbol: "BTCUSDT",
    timeframe: "1h",
    dataset_fingerprint: "fp-test-1",
    bars: 1200,
    from_ts: 1_783_504_800,
    to_ts: 1_788_897_600,
    empirical_status: "ROBUST",
    versions: {
      strategy_version: "v-curr",
      detector_version: "1.0.0",
      rule_version: "1.0.0",
      code_version: "pipe1234",
      app_version: "6.0.1",
      build_id: "6.0.1+pipe1234",
    },
    params: { methodology: V.VALIDATION_METHODOLOGY },
    in_sample: mockMetrics(),
    oos: mockMetrics({ trade_count: 35, expectancy_r: 0.4, profit_factor: 1.7, max_drawdown_r: 4 }),
    walk_forward: {
      windows: [1, 2, 3, 4].map((n) => ({
        window: n, train_from: 100, test_from: 100 + n * 50, test_to: 100 + n * 50 + 49,
        metrics: mockMetrics({ trade_count: 10 }), trades: 10,
      })),
      profitable_windows: 3,
      total_windows: 4,
      aggregate: mockMetrics({ trade_count: 40 }),
      stability: 1.4,
      note: "4 rolling test windows",
    },
    promotion: { to: "ROBUST" },
    dataset_identity: ident,
    split: {
      split_ratio: 0.7,
      split_index: 840,
      in_sample: { from_ts: 1_783_504_800, to_ts: 1_787_000_000, bars: 840 },
      out_of_sample: { from_ts: 1_787_000_060, to_ts: 1_788_897_600, bars: 360 },
      walk_forward_windows: [],
    },
    methodology: V.VALIDATION_METHODOLOGY,
    parse_notes: [],
    ...over,
  };
}

function mockGateInput(over: {
  evidence?: ExperimentEvidence[];
  governance?: Partial<PromotionGateInput["governance"]>;
  versions?: Partial<PromotionGateInput["versions"]>;
  runtime?: Partial<PromotionGateInput["runtime"]>;
} = {}): PromotionGateInput {
  return {
    strategy_id: STRATEGY_ID,
    runtime: {
      exists: true,
      availability: "EXECUTABLE",
      blocked_reason: null,
      setup_ids: [SETUP_ID],
      direction_variants: 1,
      timeframe: "1h",
      version: "v-curr",
      rule_ids: ["R-1"],
      source_refs: [{ file: "2.txt", start_line: 1, end_line: 10 }],
      name: "Test Strategy",
      family: "level-reaction",
      ...over.runtime,
    },
    governance: {
      record_present: true,
      source_status: "SOURCE_VERIFIED",
      unknown_critical: [],
      conflict_group_id: null,
      conflict_unresolved: false,
      implementation_binding: `compiled:${SETUP_ID}`,
      resolve_error: null,
      ...over.governance,
    },
    evidence: over.evidence ?? [mockEvidence()],
    versions: {
      code_version: "pipe1234",
      detector_version: "1.0.0",
      strategy_versions: ["v-curr"],
      rule_versions: ["1.0.0"],
      ...over.versions,
    },
    decided_at_ms: 1_788_000_500_000,
  };
}

describe("Market Regime Classification", () => {
  it("classifies candles into volatility and structure regime without failing", () => {
    const candles = Array.from({ length: 100 }, (_, i) => ({
      t: 1000 + i * 3600,
      o: 100 + i * 0.1,
      h: 102 + i * 0.1,
      l: 99 + i * 0.1,
      c: 101 + i * 0.1,
      v: 1000,
    }));
    const regime = PIPE.classifySeriesRegime(candles, "1h");
    expect(typeof regime.volatility).toBe("string");
    expect(typeof regime.structure).toBe("string");
  });

  it("handles empty or insufficient candles gracefully by returning UNKNOWN", () => {
    const regime = PIPE.classifySeriesRegime([], "1h");
    expect(regime.volatility).toBe("UNKNOWN");
    expect(regime.structure).toBe("UNKNOWN");
  });
});

describe("ExperimentStore deep lookups (getById & evidenceById)", () => {
  it("stores an experiment and retrieves it verbatim via getById and evidenceById", () => {
    const p = path.join(TMP, "exp-lookup.db");
    const store = new EXP.ExperimentStore(p);
    const ev = mockEvidence({ experiment_id: "exp-find-me-123" });

    store.insert({
      experiment_id: ev.experiment_id,
      created_ms: ev.created_ms,
      strategy_id: ev.strategy_id,
      setup_id: ev.setup_id,
      symbol: ev.symbol,
      timeframe: ev.timeframe,
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
      promotion: ev.promotion,
      empirical_status: ev.empirical_status,
      code_version: ev.versions.code_version,
      dataset_identity: ev.dataset_identity,
      split: ev.split,
    });

    const raw = store.getById("exp-find-me-123");
    expect(raw).not.toBeNull();
    expect(raw?.strategy_id).toBe(STRATEGY_ID);

    const parsed = store.evidenceById("exp-find-me-123");
    expect(parsed).not.toBeNull();
    expect(parsed?.experiment_id).toBe("exp-find-me-123");
    expect(parsed?.dataset_identity?.source_sha256).toBe(SHA);
    expect(parsed?.split?.in_sample.bars).toBe(840);

    const missing = store.getById("non-existent");
    expect(missing).toBeNull();
    const missingEvidence = store.evidenceById("non-existent");
    expect(missingEvidence).toBeNull();

    store.close();
  });
});

describe("Deterministic Promotion Status Derivation (derivePromotionStatus)", () => {
  it("derives ELIGIBLE when decision is ELIGIBLE and no blocking gaps exist", () => {
    const input = mockGateInput();
    const decision = P.buildPromotionDecision(input);
    const status = P.derivePromotionStatus(decision);
    expect(status).toBe("ELIGIBLE");
  });

  it("derives BLOCKED when blocking failures exist", () => {
    const input = mockGateInput({ governance: { conflict_unresolved: true } });
    const decision = P.buildPromotionDecision(input);
    const status = P.derivePromotionStatus(decision);
    expect(status).toBe("BLOCKED");
  });

  it("derives UNKNOWN when non-blocking unknowns exist without failure", () => {
    const status = P.derivePromotionStatus(false, [], ["validation_evidence_exists"], []);
    expect(status).toBe("UNKNOWN");
  });

  it("derives NOT_ELIGIBLE when quality criteria fail without governance block", () => {
    const status = P.derivePromotionStatus(false, ["evidence_quality_gate"], [], []);
    expect(status).toBe("NOT_ELIGIBLE");
  });
});

describe("Provenance Chain Construction (buildProvenanceChain)", () => {
  it("builds a complete traceable provenance chain linking strategy to rule, compiled setup, dataset and gate decision", () => {
    const input = mockGateInput();
    const decision = P.buildPromotionDecision(input);
    const chain = P.buildProvenanceChain(STRATEGY_ID, { input, decision });

    expect(chain.strategy.id).toBe(STRATEGY_ID);
    expect(chain.compiled_predicate.setup_ids).toContain(SETUP_ID);
    expect(chain.validation_run.experiment_id).toBe("exp-pipe-1");
    expect(chain.dataset?.source_kind).toBe("TTT_UDF_REPLAY");
    expect(chain.dataset?.source_sha256).toBe(SHA);
    expect(chain.dataset?.fingerprint_recomputed).toBe(true);
    expect(chain.backtest.trade_count).toBe(80);
    expect(chain.promotion_decision.decision).toBe("ELIGIBLE");
    expect(chain.promotion_decision.runtime_status).toBe("LIVE_ADVISORY_ONLY");
  });
});

describe("Scenarios A through H (Promotion & Lifecycle Invariants)", () => {
  it("Scenario A: Executable strategy without validation evidence is NOT_ELIGIBLE (Stage B_EXECUTABLE)", () => {
    const input = mockGateInput({ evidence: [] });
    const decision = P.buildPromotionDecision(input);
    const rec = P.buildValidationRecord(decision, input);

    expect(decision.eligible).toBe(false);
    expect(decision.decision).toBe("NOT_ELIGIBLE");
    expect(rec.strategy_state.stage).toBe("B_EXECUTABLE");
    expect(rec.strategy_state.has_validation_evidence).toBe(false);
    expect(rec.strategy_state.live_eligible).toBe(false);
  });

  it("Scenario B: Strategy with In-Sample only evidence is NOT_ELIGIBLE (Stage C_VALIDATION_EVIDENCE)", () => {
    const isOnly = mockEvidence({ oos: null, walk_forward: null, empirical_status: "BACKTESTED" });
    const input = mockGateInput({ evidence: [isOnly] });
    const decision = P.buildPromotionDecision(input);
    const rec = P.buildValidationRecord(decision, input);

    expect(decision.eligible).toBe(false);
    expect(rec.strategy_state.stage).toBe("C_VALIDATION_EVIDENCE");
    expect(rec.strategy_state.has_oos_evidence).toBe(false);
    expect(rec.unknown_reasons.some((r) => r.toLowerCase().includes("out-of-sample"))).toBe(true);
  });

  it("Scenario C: Strategy with invalid dataset provenance is NOT_ELIGIBLE", () => {
    const fakeProv = mockEvidence({
      dataset_identity: mockIdentity({ source_kind: "FIXTURE_SYNTHETIC" }),
    });
    const input = mockGateInput({ evidence: [fakeProv] });
    const decision = P.buildPromotionDecision(input);

    expect(decision.eligible).toBe(false);
    const provCheck = decision.checks.find((c) => c.id === "evidence_dataset_provenance");
    expect(provCheck?.verdict).toBe("FAIL");
    expect(provCheck?.detail).toMatch(/may not back a promotion/i);
  });

  it("Scenario D: UNKNOWN in required condition remains UNKNOWN and prevents promotion", () => {
    const missingExpectancy = mockMetrics({ expectancy_r: null });
    const ev = mockEvidence({ in_sample: missingExpectancy });
    const input = mockGateInput({ evidence: [ev] });
    const decision = P.buildPromotionDecision(input);

    expect(decision.eligible).toBe(false);
    const metricCheck = decision.checks.find((c) => c.id === "required_metrics_computed");
    expect(metricCheck?.verdict).toBe("UNKNOWN");
    expect(decision.blocking_unknowns.length).toBeGreaterThan(0);
  });

  it("Scenario E: Blocking CONFLICT / governance state prevents promotion and disables runtime", () => {
    const input = mockGateInput({ governance: { unknown_critical: ["stop_loss_spec"] } });
    const decision = P.buildPromotionDecision(input);

    expect(decision.eligible).toBe(false);
    const critCheck = decision.checks.find((c) => c.id === "no_unknown_critical");
    expect(critCheck?.verdict).toBe("FAIL");
    expect(decision.runtime_status).toBe("DISABLED");
  });

  it("Scenario F: Fully evidenced strategy with current versions and reproducible metrics passes all checks", () => {
    const input = mockGateInput();
    const decision = P.buildPromotionDecision(input);
    const rec = P.buildValidationRecord(decision, input);

    expect(decision.eligible).toBe(true);
    expect(decision.decision).toBe("ELIGIBLE");
    expect(decision.runtime_status).toBe("LIVE_ADVISORY_ONLY");
    expect(rec.strategy_state.stage).toBe("F_LIVE_ELIGIBLE");
    expect(rec.strategy_state.live_eligible).toBe(true);
  });

  it("Scenario G: Stale code version or detector drift blocks promotion", () => {
    const staleEv = mockEvidence({
      versions: {
        ...mockEvidence().versions,
        code_version: "outdated-git-hash",
      },
    });
    const input = mockGateInput({ evidence: [staleEv] });
    const decision = P.buildPromotionDecision(input);

    expect(decision.eligible).toBe(false);
    const versionCheck = decision.checks.find((c) => c.id === "evidence_versions_current");
    expect(versionCheck?.verdict).toBe("FAIL");
    expect(decision.runtime_status).not.toBe("LIVE_ADVISORY_ONLY");
  });

  it("Scenario H: Validation Pipeline execution over TTT replay fixture generates typed outputs", () => {
    // Run pipeline for STR-RAW-2-803 over BTCUSDT replay fixture
    const summary = PIPE.runValidationPipeline({
      strategyId: "STR-RAW-2-803",
      sourceKind: "TTT_UDF_REPLAY",
      symbols: ["BTCUSDT"],
      persist: false,
    });

    expect(summary.ok).toBe(true);
    expect(summary.source_kind).toBe("TTT_UDF_REPLAY");
    expect(summary.results.length).toBeGreaterThanOrEqual(1);

    const first = summary.results[0];
    expect(first.strategy_id).toBe("STR-RAW-2-803");
    expect(first.symbol).toBe("BTCUSDT");
    expect(first.dataset_identity.source_kind).toBe("TTT_UDF_REPLAY");
    expect(first.dataset_identity.source_base).toContain("thetruetrade.io");
    expect(first.split.split_ratio).toBe(0.7);
    expect(typeof first.in_sample.trade_count).toBe("number");
    expect(first.status).toBe("COMPLETED");
  });
});
