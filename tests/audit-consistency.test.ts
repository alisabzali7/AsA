/**
 * AUDIT ARTIFACT CONSISTENCY — forensic regression tests (governance closure).
 *
 * `MACHINE_READABLE_STATUS.json` carries TWO empirical views that once looked
 * contradictory: `empirical_validation` (all 104 strategies UNTESTED) next to
 * `phase2.empirical_by_strategy` (two strategies BACKTESTED). They are two
 * deliberate views of different sources of truth:
 *
 *   - `empirical_validation` → view `strategy_registry`
 *     (source: `strategies.empirical_status` — GOVERNED registry state)
 *   - `phase2` → view `experiment_store`
 *     (source: `experiments.empirical_status` — OBSERVED per-run verdicts)
 *
 * The generator (`scripts/brain-audit.mjs`) must state that contract in a
 * machine-readable way (`empirical_semantics`), and these tests pin it:
 *
 *   1. the artifact parses and both views declare distinct view/source pairs;
 *   2. the semantic contract names both views, their sources and the
 *      invariants (SOURCE_VERIFIED != EMPIRICALLY_VALIDATED,
 *      BACKTESTED != OOS_TESTED != WALK_FORWARD != ROBUST, UNKNOWN != PASS);
 *   3. empirical counts are internally consistent with the strategy registry;
 *   4. conflict resolution and promotion conflict state agree (a RESOLVED
 *      group is never re-marked unresolved for carrying a group id);
 *   5. zero live eligibility is preserved (no strategy went live by accident);
 *   6. `docs/brain/AUDIT.md` carries the same two-view meaning as the JSON.
 *
 * These tests read the COMMITTED artifact — the generator output that ships
 * with the repo — so a hand-edited or stale artifact fails loudly instead of
 * drifting silently.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { conflictStateForRecord } from "../src/lib/brain/conflicts";
import { gateStrategy } from "../src/lib/brain/gate";
import type {
  ConflictGroup,
  EmpiricalStatus,
  StrategyRecord,
} from "../src/lib/brain/types";

const ROOT = process.cwd();
const STATUS_PATH = path.join(ROOT, "MACHINE_READABLE_STATUS.json");
const AUDIT_MD_PATH = path.join(ROOT, "docs/brain/AUDIT.md");

interface StatusArtifact {
  generated_at: string;
  counts: { strategies: number; conflicts: number; [k: string]: unknown };
  strategies: {
    by_runtime: Record<string, number>;
    by_empirical_status: Record<string, number>;
    live_count: number;
    [k: string]: unknown;
  };
  empirical_validation: {
    view: string;
    source: { table: string; column: string; [k: string]: unknown };
    backtested: number;
    oos: number;
    walk_forward: number;
    robust: number;
    rejected: number;
    untested: number;
    total: number;
    semantics: string;
    relationship_to_phase2: string;
    [k: string]: unknown;
  };
  empirical_semantics: {
    contract_version: string;
    views: Record<string, string>;
    sources_of_truth: Record<
      string,
      { table: string; column: string; [k: string]: unknown }
    >;
    invariants: string[];
    interpretation: Record<string, string>;
    consistent_by_design: boolean;
    [k: string]: unknown;
  };
  conflicts: {
    id: string;
    topic: string;
    resolution: string;
    variants: number;
    chosen: string | null;
  }[];
  safety_invariants: { live_strategies: number; [k: string]: unknown };
  phase2: {
    view: string;
    source: { table: string; column: string; [k: string]: unknown };
    experiments: number;
    empirical_by_strategy: Record<
      string,
      { status: string; symbols: string[] }
    >;
    promoted_to_live: number;
    semantics: string;
    relationship_to_empirical_validation: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function readStatus(): StatusArtifact {
  const raw = fs.readFileSync(STATUS_PATH, "utf8");
  return JSON.parse(raw) as StatusArtifact;
}

const VALID_EMPIRICAL: EmpiricalStatus[] = [
  "UNTESTED",
  "BACKTESTED",
  "OOS_TESTED",
  "WALK_FORWARD",
  "ROBUST",
  "REJECTED",
];

describe("audit artifact parses and declares two distinct empirical views", () => {
  it("MACHINE_READABLE_STATUS.json is valid JSON with a timestamp", () => {
    const s = readStatus();
    expect(typeof s.generated_at).toBe("string");
    expect(Number.isNaN(Date.parse(s.generated_at))).toBe(false);
  });

  it("empirical_validation declares the strategy_registry view and source", () => {
    const s = readStatus();
    expect(s.empirical_validation.view).toBe("strategy_registry");
    expect(s.empirical_validation.source.table).toBe("strategies");
    expect(s.empirical_validation.source.column).toBe("empirical_status");
    expect(s.empirical_validation.semantics).toContain("GOVERNED");
    expect(s.empirical_validation.relationship_to_phase2).toContain("phase2");
  });

  it("phase2 declares the experiment_store view and source", () => {
    const s = readStatus();
    expect(s.phase2.view).toBe("experiment_store");
    expect(s.phase2.source.table).toBe("experiments");
    expect(s.phase2.source.column).toBe("empirical_status");
    expect(s.phase2.semantics).toContain("OBSERVED");
    expect(s.phase2.relationship_to_empirical_validation).toContain(
      "empirical_validation",
    );
  });

  it("the two views are explicitly different — ambiguity is impossible", () => {
    const s = readStatus();
    expect(s.phase2.view).not.toBe(s.empirical_validation.view);
    expect(s.phase2.source.table).not.toBe(
      s.empirical_validation.source.table,
    );
  });
});

describe("empirical semantic contract is machine-checkable", () => {
  it("empirical_semantics names both views and their sources of truth", () => {
    const s = readStatus();
    const c = s.empirical_semantics;
    expect(c.contract_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(c.views.empirical_validation).toBe(s.empirical_validation.view);
    expect(c.views.phase2).toBe(s.phase2.view);
    expect(c.sources_of_truth.strategy_registry.table).toBe("strategies");
    expect(c.sources_of_truth.strategy_registry.column).toBe(
      "empirical_status",
    );
    expect(c.sources_of_truth.experiment_store.table).toBe("experiments");
    expect(c.sources_of_truth.experiment_store.column).toBe("empirical_status");
    expect(c.consistent_by_design).toBe(true);
  });

  it("the contract pins the non-negotiable empirical invariants", () => {
    const s = readStatus();
    const joined = s.empirical_semantics.invariants.join("\n");
    expect(joined).toContain("SOURCE_VERIFIED != EMPIRICALLY_VALIDATED");
    expect(joined).toContain("BACKTESTED");
    expect(joined).toContain("OOS_TESTED");
    expect(joined).toContain("WALK_FORWARD");
    expect(joined).toContain("ROBUST");
    expect(joined).toContain("UNKNOWN != PASS");
    expect(joined).toMatch(/NEVER auto-promote/i);
  });

  it("the contract explains the registry-UNTESTED / experiments-BACKTESTED divergence", () => {
    const s = readStatus();
    const interp = Object.values(s.empirical_semantics.interpretation).join("\n");
    expect(interp).toMatch(/EXPECTED divergence/i);
    expect(interp).toMatch(/not a contradiction/i);
  });
});

describe("empirical counts are consistent with the strategy registry", () => {
  it("empirical_validation counts sum to the registry total", () => {
    const s = readStatus();
    const v = s.empirical_validation;
    const sum =
      v.backtested + v.oos + v.walk_forward + v.robust + v.rejected + v.untested;
    expect(v.total).toBe(s.counts.strategies);
    expect(sum).toBe(v.total);
  });

  it("by_empirical_status agrees with the empirical_validation breakdown", () => {
    const s = readStatus();
    const by = s.strategies.by_empirical_status;
    const v = s.empirical_validation;
    expect(by.BACKTESTED ?? 0).toBe(v.backtested);
    expect(by.OOS_TESTED ?? 0).toBe(v.oos);
    expect(by.WALK_FORWARD ?? 0).toBe(v.walk_forward);
    expect(by.ROBUST ?? 0).toBe(v.robust);
    expect(by.REJECTED ?? 0).toBe(v.rejected);
    expect(by.UNTESTED ?? 0).toBe(v.untested);
  });

  it("phase2 per-strategy entries are well-formed empirical statuses", () => {
    const s = readStatus();
    for (const [sid, entry] of Object.entries(s.phase2.empirical_by_strategy)) {
      expect(VALID_EMPIRICAL, sid).toContain(entry.status);
      expect(Array.isArray(entry.symbols), sid).toBe(true);
      expect(entry.symbols.length, sid).toBeGreaterThan(0);
    }
  });
});

describe("artifact conflicts agree with canonical promotion conflict state", () => {
  function artifactGroups(): ConflictGroup[] {
    const s = readStatus();
    // The artifact carries the governance-relevant projection of each group;
    // variant BODIES live in the Brain DB, but resolution/chosen are here.
    return s.conflicts.map((c) => ({
      conflict_group_id: c.id,
      topic: c.topic,
      variants: [],
      resolution: c.resolution as ConflictGroup["resolution"],
      chosen_variant: c.chosen,
      resolved_by: null,
      resolved_at_ms: null,
    }));
  }

  function linkedRecord(groupId: string): StrategyRecord {
    return {
      strategy_id: "STR-CONSISTENCY-PROBE",
      canonical_name: "consistency probe",
      family: "level-reaction",
      aliases: [],
      type: "strategy",
      description: "",
      source_refs: [{ file: "2.txt", start_line: 1, end_line: 2 }],
      source_status: "SOURCE_VERIFIED",
      empirical_status: "UNTESTED",
      runtime_status: "CANDIDATE",
      unknown_critical: [],
      conflict_group_id: groupId,
      setup_ids: [],
      rule_ids: [],
      implementation: "compiled:probe",
      version: "1.0.0",
      disabled_reason: null,
    };
  }

  it("every artifact UNRESOLVED group is unresolved under the canonical contract", () => {
    const groups = artifactGroups();
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups.filter((x) => x.resolution === "UNRESOLVED")) {
      const st = conflictStateForRecord(g.conflict_group_id, groups);
      expect(st.state, g.conflict_group_id).toBe("UNRESOLVED");
      expect(st.unresolved, g.conflict_group_id).toBe(true);
      const v = gateStrategy(linkedRecord(g.conflict_group_id), groups);
      expect(v.allowed, g.conflict_group_id).toBe("DISABLED");
    }
  });

  it("a resolved group is never re-marked unresolved for carrying a group id", () => {
    const groups = artifactGroups();
    expect(groups.length).toBeGreaterThan(0);
    const first = groups[0];
    for (const resolution of [
      "OPERATOR_CHOSEN",
      "EMPIRICALLY_RESOLVED",
    ] as const) {
      const resolved: ConflictGroup[] = groups.map((g) =>
        g.conflict_group_id === first.conflict_group_id
          ? { ...g, resolution, chosen_variant: "artifact-variant" }
          : g,
      );
      const st = conflictStateForRecord(first.conflict_group_id, resolved);
      expect(st.state, resolution).toBe("RESOLVED");
      expect(st.unresolved, resolution).toBe(false);
      const v = gateStrategy(linkedRecord(first.conflict_group_id), resolved);
      // UNTESTED empirical cap only — the conflict question itself is clear.
      expect(v.allowed, resolution).toBe("CANDIDATE");
      expect(v.reasons.join(" "), resolution).not.toMatch(/CONFLICT/i);
    }
  });
});

describe("zero live eligibility is preserved", () => {
  it("no strategy holds live status anywhere in the artifact", () => {
    const s = readStatus();
    expect(s.strategies.live_count).toBe(0);
    expect(s.strategies.by_runtime.LIVE_ADVISORY_ONLY ?? 0).toBe(0);
    expect(s.safety_invariants.live_strategies).toBe(0);
    expect(s.phase2.promoted_to_live).toBe(0);
  });
});

describe("docs/brain/AUDIT.md carries the same two-view meaning", () => {
  it("the Markdown audit names both views and the contract", () => {
    const md = fs.readFileSync(AUDIT_MD_PATH, "utf8");
    expect(md).toContain("strategy_registry");
    expect(md).toContain("experiment_store");
    expect(md).toContain("empirical_semantics");
    expect(md).toMatch(/two deliberate views/i);
    expect(md).toContain("SOURCE_VERIFIED != EMPIRICALLY_VALIDATED");
    expect(md).toContain("BACKTESTED != OOS_TESTED != WALK_FORWARD != ROBUST");
  });

  it("the Markdown audit reports the same live-zero as the JSON", () => {
    const md = fs.readFileSync(AUDIT_MD_PATH, "utf8");
    const s = readStatus();
    expect(md).toContain(`promoted to live (derived from registry): ${s.phase2.promoted_to_live}`);
  });
});
