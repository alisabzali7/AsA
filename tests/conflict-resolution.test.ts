/**
 * CONFLICT RESOLUTION SEMANTICS — forensic regression tests (governance closure).
 *
 * The defect: `resolvePromotionInput()` and `gateStrategy()` treated the mere
 * PRESENCE of a `conflict_group_id` as "unresolved":
 *
 *     conflict_unresolved = record.conflict_group_id != null
 *
 * That equation is wrong. A conflict group is a durable record of competing
 * source variants; its `resolution` says whether the competition is still
 * open. The canonical contract (`src/lib/brain/conflicts.ts`) is the only
 * interpretation every governance consumer may use:
 *
 *   Scenario A: no conflict group                                   → NOT unresolved
 *   Scenario B: group + UNRESOLVED                                  → unresolved, promotion blocked
 *   Scenario C: group + OPERATOR_CHOSEN                             → NOT conflict-unresolved,
 *               but a `source_status = CONFLICT` ceiling still blocks promotion
 *   Scenario D: group + EMPIRICALLY_RESOLVED                        → NOT unresolved on ANY path
 *   Scenario E: incomplete/invalid conflict data                    → UNKNOWN, fail closed, never PASS
 *
 * Fixing the equation is NOT lifting governance: source CONFLICT, critical
 * UNKNOWNs, missing bindings and every other ceiling keep blocking exactly
 * as before. These tests pin both halves: the conflict question is answered
 * canonically, and the safety ceilings are untouched.
 *
 * ISOLATION: store paths are set BEFORE any src module is imported, so every
 * store opened by this file lives in a temp dir (same pattern as
 * tests/strategy-promotion.test.ts).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ExperimentEvidence,
  DatasetIdentity,
  ExperimentSplit,
} from "../src/lib/backtest/experiments";
import type {
  PromotionGateInput,
  PromotionDecision,
} from "../src/lib/backtest/promotion";
import type { WalkForwardResult } from "../src/lib/backtest/validation";
import type { BacktestMetrics } from "../src/lib/backtest/strategy-runner";
import type {
  ConflictGroup,
  StrategyRecord,
} from "../src/lib/brain/types";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-conflict-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
delete process.env.ASA_API_TOKEN;

type PromotionMod = typeof import("../src/lib/backtest/promotion");
type RunnerMod = typeof import("../src/lib/backtest/strategy-runner");
type ValidationMod = typeof import("../src/lib/backtest/validation");
type ConflictsMod = typeof import("../src/lib/brain/conflicts");
type GateMod = typeof import("../src/lib/brain/gate");
type BrainMod = typeof import("../src/lib/brain/store");
type IngestMod = typeof import("../src/lib/brain/ingest");

let P: PromotionMod;
let RUN: RunnerMod;
let V: ValidationMod;
let C: ConflictsMod;
let GATE: GateMod;
let BRAIN: BrainMod;
let INGEST: IngestMod;

const STRATEGY_ID = "STR-RAW-2-803";
const SETUP_ID = "SET-STR-RAW-2-803";
const GROUP_ID = "CG-TEST-1";

beforeAll(async () => {
  P = await import("../src/lib/backtest/promotion");
  RUN = await import("../src/lib/backtest/strategy-runner");
  V = await import("../src/lib/backtest/validation");
  C = await import("../src/lib/brain/conflicts");
  GATE = await import("../src/lib/brain/gate");
  BRAIN = await import("../src/lib/brain/store");
  INGEST = await import("../src/lib/brain/ingest");
});

afterAll(() => {
  try {
    BRAIN.closeBrain();
  } catch {
    /* not opened */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* --------------------------------------------------------------- fixtures */

function metrics(over: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    ...RUN.computeMetrics([], 10_000),
    trade_count: 100,
    wins: 55,
    losses: 45,
    win_rate: 55,
    average_r: 0.5,
    expectancy_r: 0.5,
    profit_factor: 2,
    max_drawdown_r: 3,
    total_r: 50,
    sufficient_sample: true,
    ...over,
  };
}

function walkForward(over: Partial<WalkForwardResult> = {}): WalkForwardResult {
  const w = metrics({
    trade_count: 20,
    expectancy_r: 0.4,
    profit_factor: 1.8,
    max_drawdown_r: 2,
  });
  return {
    windows: [1, 2, 3, 4].map((n) => ({
      window: n,
      train_from: 1_000,
      test_from: 1_000 + n * 100,
      test_to: 1_000 + n * 100 + 99,
      metrics: w,
      trades: w.trade_count,
    })),
    profitable_windows: 3,
    total_windows: 4,
    aggregate: metrics({
      trade_count: 80,
      expectancy_r: 0.4,
      profit_factor: 1.5,
      max_drawdown_r: 4,
    }),
    stability: 1.5,
    note: "4 rolling out-of-sample windows",
    ...over,
  };
}

const SHA = createHash("sha256").update("asa-conflict-test").digest("hex");

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
    walk_forward_windows: [1, 2, 3, 4].map((n) => ({
      window: n,
      test_from: n * 1000,
      test_to: n * 1000 + 99,
      trades: 5,
    })),
    ...over,
  };
}

/** Fully valid evidence: strong metrics, provenance, current versions. */
function evidence(over: Partial<ExperimentEvidence> = {}): ExperimentEvidence {
  return {
    experiment_id: "exp-conflict-1",
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
    oos: metrics({
      trade_count: 40,
      expectancy_r: 0.4,
      profit_factor: 1.8,
      max_drawdown_r: 5,
      win_rate: 52,
    }),
    walk_forward: walkForward(),
    promotion: { to: "ROBUST" },
    dataset_identity: identity(),
    split: split(),
    methodology: V.VALIDATION_METHODOLOGY,
    parse_notes: [],
    ...over,
  };
}

function group(over: Partial<ConflictGroup> = {}): ConflictGroup {
  return {
    conflict_group_id: GROUP_ID,
    topic: "test conflict",
    variants: [
      {
        label: "variant-a",
        statement: "first competing variant",
        source_refs: [{ file: "2.txt", start_line: 1, end_line: 2 }],
      },
      {
        label: "variant-b",
        statement: "second competing variant",
        source_refs: [{ file: "2.txt", start_line: 3, end_line: 4 }],
      },
    ],
    resolution: "UNRESOLVED",
    chosen_variant: null,
    resolved_by: null,
    resolved_at_ms: null,
    ...over,
  };
}

function strategyRecord(over: Partial<StrategyRecord> = {}): StrategyRecord {
  return {
    strategy_id: STRATEGY_ID,
    canonical_name: "conflict fixture strategy",
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
      version: "v-current",
      rule_ids: ["R-1"],
      source_refs: [{ file: "2.txt", start_line: 10, end_line: 20 }],
      name: "conflict fixture strategy",
      family: "level-reaction",
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

const checkOf = (d: PromotionDecision, id: string) =>
  d.checks.find((c) => c.id === id)!;

/* ------------------------------------------------------------------ tests */

describe("canonical conflict contract — pure truth table", () => {
  it("resolveConflictState implements the documented truth table", () => {
    expect(C.resolveConflictState(null, null)).toBe("NONE");
    expect(C.resolveConflictState(undefined, "UNRESOLVED")).toBe("NONE");
    expect(C.resolveConflictState("", "UNRESOLVED")).toBe("NONE");
    expect(C.resolveConflictState("   ", "OPERATOR_CHOSEN")).toBe("NONE");
    expect(C.resolveConflictState(GROUP_ID, "UNRESOLVED")).toBe("UNRESOLVED");
    expect(C.resolveConflictState(GROUP_ID, "OPERATOR_CHOSEN")).toBe("RESOLVED");
    expect(C.resolveConflictState(GROUP_ID, "EMPIRICALLY_RESOLVED")).toBe(
      "RESOLVED",
    );
  });

  it("an unreadable resolution with a linked group is UNKNOWN, never NONE", () => {
    for (const bad of [null, undefined, "", "  ", "GARBAGE", "resolved", 0, {}, []]) {
      expect(C.resolveConflictState(GROUP_ID, bad), JSON.stringify(bad)).toBe(
        "UNKNOWN",
      );
    }
  });

  it("isConflictUnresolved fails closed: UNKNOWN counts as unresolved", () => {
    expect(C.isConflictUnresolved(null, null)).toBe(false);
    expect(C.isConflictUnresolved(undefined, "UNRESOLVED")).toBe(false);
    expect(C.isConflictUnresolved(GROUP_ID, "UNRESOLVED")).toBe(true);
    expect(C.isConflictUnresolved(GROUP_ID, "OPERATOR_CHOSEN")).toBe(false);
    expect(C.isConflictUnresolved(GROUP_ID, "EMPIRICALLY_RESOLVED")).toBe(false);
    expect(C.isConflictUnresolved(GROUP_ID, null)).toBe(true);
    expect(C.isConflictUnresolved(GROUP_ID, "GARBAGE")).toBe(true);
  });

  it("conflictStateForRecord resolves a linked id against the registry rows", () => {
    const groups = [group()];
    expect(C.conflictStateForRecord(null, groups).state).toBe("NONE");
    expect(C.conflictStateForRecord(GROUP_ID, groups)).toMatchObject({
      state: "UNRESOLVED",
      resolution: "UNRESOLVED",
      unresolved: true,
    });
    const op = C.conflictStateForRecord(GROUP_ID, [
      group({ resolution: "OPERATOR_CHOSEN", chosen_variant: "variant-a" }),
    ]);
    expect(op).toMatchObject({
      state: "RESOLVED",
      resolution: "OPERATOR_CHOSEN",
      unresolved: false,
    });
    const emp = C.conflictStateForRecord(GROUP_ID, [
      group({ resolution: "EMPIRICALLY_RESOLVED", chosen_variant: "variant-b" }),
    ]);
    expect(emp).toMatchObject({
      state: "RESOLVED",
      resolution: "EMPIRICALLY_RESOLVED",
      unresolved: false,
    });
  });

  it("conflictStateForRecord fails closed on incomplete/invalid registry data", () => {
    // registry unreadable
    expect(C.conflictStateForRecord(GROUP_ID, null)).toMatchObject({
      state: "UNKNOWN",
      unresolved: true,
    });
    expect(C.conflictStateForRecord(GROUP_ID, undefined)).toMatchObject({
      state: "UNKNOWN",
      unresolved: true,
    });
    // dangling link
    expect(C.conflictStateForRecord(GROUP_ID, [])).toMatchObject({
      state: "UNKNOWN",
      unresolved: true,
    });
    expect(
      C.conflictStateForRecord(GROUP_ID, [group({ conflict_group_id: "OTHER" })]),
    ).toMatchObject({ state: "UNKNOWN", unresolved: true });
    // unrecognized resolution value
    expect(
      C.conflictStateForRecord(GROUP_ID, [
        group({ resolution: "BOGUS" as never }),
      ]),
    ).toMatchObject({ state: "UNKNOWN", unresolved: true });
    // RESOLVED marker without its adjudication record is incomplete data
    for (const r of ["OPERATOR_CHOSEN", "EMPIRICALLY_RESOLVED"] as const) {
      expect(
        C.conflictStateForRecord(GROUP_ID, [
          group({ resolution: r, chosen_variant: null }),
        ]),
        r,
      ).toMatchObject({ state: "UNKNOWN", unresolved: true });
      expect(
        C.conflictStateForRecord(GROUP_ID, [
          group({ resolution: r, chosen_variant: "  " }),
        ]),
        `${r} blank`,
      ).toMatchObject({ state: "UNKNOWN", unresolved: true });
    }
  });

  it("is pure and deterministic: same inputs, same outputs, inputs untouched", () => {
    const groups = [group({ resolution: "OPERATOR_CHOSEN", chosen_variant: "variant-a" })];
    const before = JSON.parse(JSON.stringify(groups));
    const a = C.conflictStateForRecord(GROUP_ID, groups);
    const b = C.conflictStateForRecord(GROUP_ID, groups);
    expect(a).toEqual(b);
    expect(groups).toEqual(before);
    expect(C.isConflictUnresolved(GROUP_ID, "UNRESOLVED")).toBe(
      C.isConflictUnresolved(GROUP_ID, "UNRESOLVED"),
    );
  });

  it("depends on nothing but types: no LLM, no UI, no env, no I/O", () => {
    const src = fs.readFileSync("src/lib/brain/conflicts.ts", "utf8");
    for (const banned of [
      "process.env",
      "fetch(",
      "window",
      "document",
      "better-sqlite3",
      "@/lib/ai",
      "../ai/",
      "localStorage",
    ]) {
      expect(src, `must not reference ${banned}`).not.toContain(banned);
    }
    expect(src).toMatch(/export function isConflictUnresolved/);
    expect(src).toMatch(/export function conflictStateForRecord/);
    expect(src).toMatch(/export function resolveConflictState/);
  });
});

describe("Scenario A — strategy without a conflict group", () => {
  it("canonical state is NONE and conflict_unresolved is false", () => {
    expect(C.isConflictUnresolved(null, null)).toBe(false);
    expect(
      C.conflictStateForRecord(null, [group()]),
    ).toMatchObject({ state: "NONE", unresolved: false });
  });

  it("gateStrategy does not conflict-block a group-free record", () => {
    const v = GATE.gateStrategy(strategyRecord(), [group()]);
    expect(v.allowed).toBe("CANDIDATE"); // UNTESTED empirical cap only
    expect(v.reasons.join(" ")).not.toMatch(/CONFLICT/i);
  });

  it("promotion reports conflict_unresolved=false and passes the conflict check", () => {
    const input = P.resolvePromotionInput(STRATEGY_ID, {
      evidence: [evidence()],
      brainRecord: strategyRecord(),
      conflicts: [group()],
      versions: {
        code_version: "abc1234",
        detector_version: "1.0.0",
        strategy_versions: ["v-current"],
        rule_versions: ["1.0.0"],
      },
    });
    expect(input.governance.conflict_group_id).toBeNull();
    expect(input.governance.conflict_unresolved).toBe(false);
    expect(input.governance.conflict_state).toBe("NONE");
    const d = P.buildPromotionDecision(input);
    expect(checkOf(d, "no_unresolved_conflict").verdict).toBe("PASS");
    expect(d.conflict_reasons).toEqual([]);
  });
});

describe("Scenario B — UNRESOLVED group blocks promotion", () => {
  it("canonical state is UNRESOLVED and conflict_unresolved is true", () => {
    expect(C.isConflictUnresolved(GROUP_ID, "UNRESOLVED")).toBe(true);
    expect(C.conflictStateForRecord(GROUP_ID, [group()])).toMatchObject({
      state: "UNRESOLVED",
      unresolved: true,
    });
  });

  it("resolvePromotionInput derives UNRESOLVED from the group resolution", () => {
    const input = P.resolvePromotionInput(STRATEGY_ID, {
      evidence: [],
      brainRecord: strategyRecord({ conflict_group_id: GROUP_ID }),
      conflicts: [group()],
    });
    expect(input.governance.conflict_state).toBe("UNRESOLVED");
    expect(input.governance.conflict_unresolved).toBe(true);
    expect(input.governance.conflict_resolution).toBe("UNRESOLVED");
  });

  it("promotion fails the conflict check and the ceiling, and stays NOT_ELIGIBLE", () => {
    const d = P.buildPromotionDecision(
      gateInput({
        governance: {
          conflict_group_id: GROUP_ID,
          conflict_unresolved: true,
          conflict_state: "UNRESOLVED",
          conflict_resolution: "UNRESOLVED",
        },
      }),
    );
    expect(d.eligible).toBe(false);
    expect(d.decision).toBe("NOT_ELIGIBLE");
    expect(d.live_eligible).toBe(false);
    expect(checkOf(d, "no_unresolved_conflict").verdict).toBe("FAIL");
    expect(checkOf(d, "governance_ceiling_allows_live").verdict).toBe("FAIL");
    expect(d.promotion_status).toBe("BLOCKED");
    expect(d.conflict_reasons.join(" ")).toContain(GROUP_ID);
  });

  it("gateStrategy with the live-style registry blocks on the UNRESOLVED group", () => {
    const v = GATE.gateStrategy(
      strategyRecord({
        conflict_group_id: GROUP_ID,
        empirical_status: "ROBUST",
      }),
      [group()],
    );
    expect(v.allowed).toBe("DISABLED");
    expect(v.reasons.join(" ")).toMatch(/CONFLICT/i);
  });
});

describe("Scenario C — OPERATOR_CHOSEN clears the conflict question, not the ceiling", () => {
  it("canonical state is RESOLVED and conflict_unresolved is false", () => {
    expect(C.isConflictUnresolved(GROUP_ID, "OPERATOR_CHOSEN")).toBe(false);
    expect(
      C.conflictStateForRecord(GROUP_ID, [
        group({ resolution: "OPERATOR_CHOSEN", chosen_variant: "variant-a" }),
      ]),
    ).toMatchObject({ state: "RESOLVED", unresolved: false });
  });

  it("resolvePromotionInput honors the operator adjudication", () => {
    const input = P.resolvePromotionInput(STRATEGY_ID, {
      evidence: [],
      brainRecord: strategyRecord({ conflict_group_id: GROUP_ID }),
      conflicts: [
        group({ resolution: "OPERATOR_CHOSEN", chosen_variant: "variant-a" }),
      ],
    });
    expect(input.governance.conflict_state).toBe("RESOLVED");
    expect(input.governance.conflict_unresolved).toBe(false);
    expect(input.governance.conflict_resolution).toBe("OPERATOR_CHOSEN");
  });

  it("the conflict check passes yet source_status=CONFLICT still blocks promotion", () => {
    const d = P.buildPromotionDecision(
      gateInput({
        governance: {
          source_status: "CONFLICT",
          conflict_group_id: GROUP_ID,
          conflict_unresolved: false,
          conflict_state: "RESOLVED",
          conflict_resolution: "OPERATOR_CHOSEN",
        },
      }),
    );
    // The conflict QUESTION is resolved …
    expect(checkOf(d, "no_unresolved_conflict").verdict).toBe("PASS");
    expect(d.conflict_reasons).toEqual([]);
    // … but governance safety is untouched: CONFLICT source still blocks.
    expect(checkOf(d, "source_status_usable").verdict).toBe("FAIL");
    expect(checkOf(d, "governance_ceiling_allows_live").verdict).toBe("FAIL");
    expect(d.eligible).toBe(false);
    expect(d.decision).toBe("NOT_ELIGIBLE");
    expect(d.live_eligible).toBe(false);
    expect(d.promotion_status).toBe("BLOCKED");
    expect(d.runtime_status).toBe("DISABLED");
  });
});

describe("Scenario D — EMPIRICALLY_RESOLVED is never unresolved-by-presence", () => {
  const resolved = () =>
    group({ resolution: "EMPIRICALLY_RESOLVED", chosen_variant: "variant-b" });

  it("every canonical entry point reports NOT unresolved", () => {
    expect(C.isConflictUnresolved(GROUP_ID, "EMPIRICALLY_RESOLVED")).toBe(false);
    expect(C.resolveConflictState(GROUP_ID, "EMPIRICALLY_RESOLVED")).toBe(
      "RESOLVED",
    );
    expect(C.conflictStateForRecord(GROUP_ID, [resolved()])).toMatchObject({
      state: "RESOLVED",
      unresolved: false,
    });
  });

  it("gateStrategy does not conflict-block despite the linked group id", () => {
    const v = GATE.gateStrategy(
      strategyRecord({ conflict_group_id: GROUP_ID }),
      [resolved()],
    );
    expect(v.allowed).toBe("CANDIDATE"); // UNTESTED empirical cap only
    expect(v.reasons.join(" ")).not.toMatch(/CONFLICT/i);
  });

  it("no promotion code path re-marks it unresolved for carrying a group id", () => {
    const input = P.resolvePromotionInput(STRATEGY_ID, {
      evidence: [evidence()],
      brainRecord: strategyRecord({ conflict_group_id: GROUP_ID }),
      conflicts: [resolved()],
      versions: {
        code_version: "abc1234",
        detector_version: "1.0.0",
        strategy_versions: ["v-current"],
        rule_versions: ["1.0.0"],
      },
    });
    expect(input.governance.conflict_state).toBe("RESOLVED");
    expect(input.governance.conflict_unresolved).toBe(false);
    const d = P.buildPromotionDecision(input);
    expect(checkOf(d, "no_unresolved_conflict").verdict).toBe("PASS");
    expect(d.conflict_reasons).toEqual([]);
    // Identical conflict posture to a group-free record …
    const plain = P.buildPromotionDecision(
      gateInput({ governance: { conflict_state: "NONE" } }),
    );
    expect(checkOf(d, "no_unresolved_conflict").verdict).toBe(
      checkOf(plain, "no_unresolved_conflict").verdict,
    );
    // … and the group id never appears in a blocking-conflict reason.
    expect(
      [...d.failure_reasons, ...d.unknown_reasons, ...d.conflict_reasons].join(
        " ",
      ),
    ).not.toContain(GROUP_ID);
  });
});

describe("Scenario E — incomplete/invalid conflict data fails closed, never PASS", () => {
  const cases: { name: string; groups: ConflictGroup[] | null }[] = [
    { name: "registry unreadable (null)", groups: null },
    { name: "dangling link (group absent)", groups: [] },
    {
      name: "unrecognized resolution value",
      groups: [group({ resolution: "BOGUS" as never })],
    },
    {
      name: "OPERATOR_CHOSEN without chosen_variant",
      groups: [group({ resolution: "OPERATOR_CHOSEN", chosen_variant: null })],
    },
    {
      name: "EMPIRICALLY_RESOLVED without chosen_variant",
      groups: [
        group({ resolution: "EMPIRICALLY_RESOLVED", chosen_variant: null }),
      ],
    },
  ];

  it.each(cases)("canonical state is UNKNOWN ($name)", ({ groups }) => {
    const s = C.conflictStateForRecord(GROUP_ID, groups);
    expect(s.state).toBe("UNKNOWN");
    expect(s.unresolved).toBe(true);
    expect(s.detail).toMatch(/UNKNOWN|fail closed/i);
  });

  it.each(cases)(
    "promotion reports UNKNOWN — never PASS, never silently eligible ($name)",
    ({ groups }) => {
      const input = P.resolvePromotionInput(STRATEGY_ID, {
        evidence: [],
        brainRecord: strategyRecord({ conflict_group_id: GROUP_ID }),
        conflicts: groups,
      });
      expect(input.governance.conflict_state).toBe("UNKNOWN");
      expect(input.governance.conflict_unresolved).toBe(true);
      const d = P.buildPromotionDecision(input);
      const verdict = checkOf(d, "no_unresolved_conflict").verdict;
      expect(verdict).toBe("UNKNOWN");
      expect(verdict).not.toBe("PASS");
      expect(d.eligible).toBe(false);
      expect(d.live_eligible).toBe(false);
      expect(d.decision).toBe("NOT_ELIGIBLE");
      // The governance ceiling fails closed as well (unresolved → DISABLED).
      expect(checkOf(d, "governance_ceiling_allows_live").verdict).toBe("FAIL");
    },
  );

  it("gateStrategy without a registry fails closed on a linked group", () => {
    // Legacy call shape (no registry rows): presence without a readable
    // resolution is UNKNOWN, and UNKNOWN is never a pass.
    const v = GATE.gateStrategy(strategyRecord({ conflict_group_id: GROUP_ID }));
    expect(v.allowed).toBe("DISABLED");
    expect(v.reasons.join(" ")).toMatch(/CONFLICT/i);
  });
});

describe("live registry integration — resolution is read, not assumed", () => {
  const CORPUS_DIR = path.resolve("knowledge/raw");

  it("reads the linked group's live resolution from the Brain store", () => {
    const store = new BRAIN.BrainStore(process.env.ASA_BRAIN_DB_PATH!);
    try {
      INGEST.ingestCorpus(store, CORPUS_DIR);
      const live = store.conflicts();
      expect(live.length).toBeGreaterThan(0);
      for (const g of live) expect(g.resolution).toBe("UNRESOLVED");

      // A record linked to a live UNRESOLVED group resolves via the store.
      const linked = P.resolvePromotionInput("STR-LINKED-LIVE", {
        evidence: [],
        brainRecord: strategyRecord({
          strategy_id: "STR-LINKED-LIVE",
          conflict_group_id: live[0].conflict_group_id,
        }),
        // NOTE: no `conflicts` opt — the live store must be consulted.
      });
      expect(linked.governance.conflict_state).toBe("UNRESOLVED");
      expect(linked.governance.conflict_unresolved).toBe(true);

      // A group-free record never touches the question.
      const free = P.resolvePromotionInput(STRATEGY_ID, {
        evidence: [],
        brainRecord: strategyRecord(),
      });
      expect(free.governance.conflict_state).toBe("NONE");
      expect(free.governance.conflict_unresolved).toBe(false);
    } finally {
      store.close();
    }
  });

  it("honors a live OPERATOR_CHOSEN adjudication recorded in the store", () => {
    const store = new BRAIN.BrainStore(process.env.ASA_BRAIN_DB_PATH!);
    try {
      INGEST.ingestCorpus(store, CORPUS_DIR);
      const live = store.conflicts();
      const target = live[0];
      // Simulate the operator adjudication path: resolution + chosen variant.
      store.putConflicts(
        live.map((g) =>
          g.conflict_group_id === target.conflict_group_id
            ? {
                ...g,
                resolution: "OPERATOR_CHOSEN" as const,
                chosen_variant: g.variants[0]?.label ?? "v",
                resolved_by: "operator:test",
                resolved_at_ms: Date.now(),
              }
            : g,
        ),
      );

      const input = P.resolvePromotionInput("STR-ADJUDICATED", {
        evidence: [],
        brainRecord: strategyRecord({
          strategy_id: "STR-ADJUDICATED",
          conflict_group_id: target.conflict_group_id,
        }),
        // NOTE: no `conflicts` opt — the live store must be consulted.
      });
      expect(input.governance.conflict_state).toBe("RESOLVED");
      expect(input.governance.conflict_unresolved).toBe(false);
      expect(input.governance.conflict_resolution).toBe("OPERATOR_CHOSEN");

      const d = P.buildPromotionDecision(input);
      expect(checkOf(d, "no_unresolved_conflict").verdict).toBe("PASS");
    } finally {
      store.close();
    }
  });
});
