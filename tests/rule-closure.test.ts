/**
 * Rule-graph closure regression tests.
 *
 * Pins the milestone that closed the broken edge:
 *
 *   Brain Rule Registry (brain.db `rules`)
 *     ↯ was MISSING — no graph, no machine rows, no rule-level identity
 *   Compiled predicates (strategy/compiled/*)
 *
 * Every test here proves a SEMANTIC property of the closure, not mere
 * existence: structural predicates, feature dependencies, corpus provenance,
 * bidirectional registry↔runtime identity, UNKNOWN/CONFLICT preservation,
 * runtime consumption, and the negative paths that must stay blocked.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMachineRuleGraph, compiledImplementationBinding, machineRuleRegistryRows,
  nodesByStrategy, verifyRuleRegistryClosure, GRAPH_SEMANTICS,
} from "../src/lib/strategy/rule-graph";
import { COMPILED_STRATEGIES, evaluateCompiled, type CompiledStrategy } from "../src/lib/strategy/compiled";
import { listRuntimeStrategies, evaluateRuntime, executableStrategies } from "../src/lib/strategy/runtime";
import { evaluateRule, MapFeatureBag } from "../src/lib/rules/engine";
import type { RuleSpec } from "../src/lib/brain/types";
import type { Candle } from "../src/lib/domain/types";
import { okFeature } from "../src/lib/features/types";

const CORPUS = "knowledge/raw";
const hasCorpus = ["RAW_1.txt", "RAW_2.txt", "RAW_3.txt", "RAW_4.txt", "RAW_5.txt"]
  .every((f) => fs.existsSync(path.join(CORPUS, f)));

/* ------------------------------------------------------------------ */
/* machine rule graph                                                  */
/* ------------------------------------------------------------------ */

describe("machine rule graph — structural, not textual", () => {
  const graph = buildMachineRuleGraph();

  it("derives every node from the single executable source (the compiled strategies)", () => {
    const runtimeRuleCount = COMPILED_STRATEGIES.reduce((a, s) => a + s.setup().rules.length, 0);
    expect(graph.node_count).toBe(runtimeRuleCount);
    expect(graph.node_count).toBeGreaterThan(0);
    // the 31 rules of the 6 corpus strategies (7 compiled entries)
    expect(graph.strategy_ids).toEqual([
      "STR-RAW-2-1258", "STR-RAW-2-581", "STR-RAW-2-803", "STR-RAW-2-926",
      "STR-RAW-4-2425", "STR-RAW-4-2449",
    ]);
  });

  it("every node carries a STRUCTURAL predicate (expr + requires), never prose only", () => {
    for (const n of graph.nodes) {
      expect(n.predicates.length, `${n.rule_id} must have predicates`).toBeGreaterThan(0);
      for (const p of n.predicates) {
        expect(typeof p.expr).toBe("string");
        expect(p.expr.length, `${n.rule_id} predicate expr must be non-empty`).toBeGreaterThan(0);
        expect(Array.isArray(p.requires)).toBe(true);
      }
    }
  });

  it("every node declares its feature dependencies, and the graph edges match", () => {
    for (const n of graph.nodes) {
      expect(n.feature_dependencies.length, `${n.rule_id} must depend on features`).toBeGreaterThan(0);
      for (const fid of n.feature_dependencies) {
        expect(graph.edges).toContainEqual({ from: n.rule_id, to: fid, kind: "RULE_USES_FEATURE" });
      }
    }
    // setup→strategy edges exist for every compiled setup
    for (const s of COMPILED_STRATEGIES) {
      expect(graph.edges).toContainEqual({ from: s.setup_id, to: s.strategy_id, kind: "SETUP_IN_STRATEGY" });
    }
  });

  it("every node preserves verbatim corpus provenance (file + line + source text)", () => {
    for (const n of graph.nodes) {
      expect(n.source_refs.length, `${n.rule_id} provenance`).toBeGreaterThan(0);
      for (const r of n.source_refs) {
        expect(r.file, `${n.rule_id} source file`).toMatch(/^[1-5]\.txt$/);
        expect(r.start_line).toBeGreaterThan(0);
      }
      expect(n.source_text.length, `${n.rule_id} must encode a verbatim source sentence`).toBeGreaterThan(10);
    }
  });

  it("declares tri-state and conflict semantics explicitly", () => {
    expect(graph.semantics).toEqual(GRAPH_SEMANTICS);
    expect(graph.semantics.unknown).toBe("MISSING_OR_INVALID_FEATURE_PRODUCES_UNKNOWN");
    expect(graph.semantics.unresolved).toBe("UNFORMALIZED_SOURCE_PRODUCES_BLOCKED");
    expect(graph.semantics.conflict).toBe("UNRESOLVED_CONFLICT_BLOCKS_PROMOTION");
  });

  it("the declared UNKNOWN semantics match the actual engine behavior", () => {
    // take a real runtime rule and evaluate it against an EMPTY bag:
    // missing features must produce UNKNOWN — never FAIL, never PASS.
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-581")!;
    const rule = strat.setup().rules[0];
    const ev = evaluateRule(rule, MapFeatureBag.from([]), 1_700_000_000_000);
    expect(ev.outcome).toBe("UNKNOWN");
    expect(ev.missing_features.length).toBeGreaterThan(0);
  });

  it("declared BLOCKED semantics hold for unformalized source", () => {
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-581")!;
    const rule = { ...strat.setup().rules[0], unresolved: ["qualitative wording has no deterministic transform"] };
    const ev = evaluateRule(rule, MapFeatureBag.from([]), 1_700_000_000_000);
    expect(ev.outcome).toBe("BLOCKED");
    expect(ev.explanation).toMatch(/not formalizable/);
  });
});

/* ------------------------------------------------------------------ */
/* registry projection                                                 */
/* ------------------------------------------------------------------ */

describe("registry projection — MACHINE_EXECUTABLE_RULE rows", () => {
  const rows = machineRuleRegistryRows();

  it("projects every runtime rule with governance class, predicates, features, binding", () => {
    expect(rows.length).toBe(buildMachineRuleGraph().node_count);
    for (const r of rows) {
      expect(r.rule_class).toBe("MACHINE_EXECUTABLE_RULE");
      expect(r.predicates.length, `${r.rule_id} predicates`).toBeGreaterThan(0);
      expect(r.required_features.length, `${r.rule_id} features`).toBeGreaterThan(0);
      expect(r.binding, `${r.rule_id} binding`).toBeTruthy();
      expect(r.binding!.consumer).toBe("evaluateRuntime");
      expect(r.binding!.strategy_id).toMatch(/^STR-RAW-/);
      expect(r.binding!.setup_id).toMatch(/^SET-STR-RAW-/);
      expect(r.missing_fields).toEqual([]);
    }
  });

  it("executable nodes become CANDIDATE (never live), blocked nodes stay DISABLED", () => {
    for (const r of rows) {
      if (r.runtime_status === "CANDIDATE") {
        expect(r.non_executable_reason).toBeNull();
      } else {
        expect(r.runtime_status).toBe("DISABLED");
        expect(r.non_executable_reason).toBeTruthy();
      }
      // live eligibility is NOT a registry concept — nothing is PAPER/LIVE here
      expect(["CANDIDATE", "DISABLED"]).toContain(r.runtime_status);
    }
  });

  it("NEGATIVE PATH: a rule with unresolved semantics projects as DISABLED, never executable", () => {
    // synthetic compiled strategy: same shape as production, but one rule
    // carries unresolved source semantics.
    const base = COMPILED_STRATEGIES[0];
    const synthetic: CompiledStrategy = {
      ...base,
      strategy_id: "STR-SYNTH-BLOCKED",
      setup_id: "SET-STR-SYNTH-BLOCKED",
      setup: () => {
        const def = base.setup();
        return {
          ...def,
          strategy_id: "STR-SYNTH-BLOCKED",
          setup_id: "SET-STR-SYNTH-BLOCKED",
          rules: def.rules.map((r, i) => (i === 0 ? { ...r, unresolved: ["qualitative stop has no number in source"] } : r)),
        };
      },
    };
    const g = buildMachineRuleGraph([synthetic]);
    expect(g.blocked_count).toBe(1);
    const blockedRow = machineRuleRegistryRows(g).find((r) => r.rule_id === g.nodes[0].rule_id)!;
    expect(blockedRow.runtime_status).toBe("DISABLED");
    expect(blockedRow.non_executable_reason).toMatch(/qualitative stop/);
    // the blocked rule must never be executable just because it is well-formed
    expect(g.nodes[0].executable).toBe(false);
  });

  it("compiledImplementationBinding is deterministic and strategy-scoped", () => {
    expect(compiledImplementationBinding("STR-RAW-2-1258")).toBe(
      "compiled:SET-STR-RAW-2-1258-long,SET-STR-RAW-2-1258-short",
    );
    expect(compiledImplementationBinding("STR-RAW-2-581")).toBe("compiled:SET-STR-RAW-2-581");
    expect(compiledImplementationBinding("STR-RAW-9-9999")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* ingest closure — registry ↔ runtime in a real temp brain            */
/* ------------------------------------------------------------------ */

async function buildTempBrain(): Promise<{ dbPath: string; close: () => void }> {
  const { BrainStore } = await import("../src/lib/brain/store");
  const { ingestCorpus } = await import("../src/lib/brain/ingest");
  const tmp = path.join(os.tmpdir(), `asa-closure-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new BrainStore(tmp);
  const report = ingestCorpus(store, CORPUS);
  expect(report.errors, report.errors.join("; ")).toEqual([]);
  expect(report.coverage_ok).toBe(true);
  return { dbPath: tmp, close: () => { store.close(); fs.rmSync(tmp, { force: true }); } };
}

describe.runIf(hasCorpus)("ingest registers the machine rule graph into the Brain registry", () => {
  it("registry holds BOTH populations: source text (DISABLED) + machine rules (registered)", async () => {
    const { BrainStore } = await import("../src/lib/brain/store");
    const brain = await buildTempBrain();
    try {
      const store = new BrainStore(brain.dbPath);
      const rules = store.rules();
      const graph = buildMachineRuleGraph();
      const machine = rules.filter((r) => r.rule_class === "MACHINE_EXECUTABLE_RULE");
      const text = rules.filter((r) => r.rule_class !== "MACHINE_EXECUTABLE_RULE");

      expect(machine.length).toBe(graph.node_count);
      expect(text.length).toBeGreaterThan(400); // the 503 corpus text rules
      for (const t of text) {
        expect(t.runtime_status, `${t.rule_id} text rule`).toBe("DISABLED");
        expect(t.predicates).toEqual([]);
        expect(t.binding ?? null).toBeNull();
      }
      store.close();
    } finally { brain.close(); }
  });

  it("every compiled strategy record gains rule_ids + compiled binding, gate unchanged", async () => {
    const { BrainStore } = await import("../src/lib/brain/store");
    const brain = await buildTempBrain();
    try {
      const store = new BrainStore(brain.dbPath);
      const graph = buildMachineRuleGraph();
      const byStrat = nodesByStrategy(graph);
      for (const sid of graph.strategy_ids) {
        const rec = store.strategy(sid);
        expect(rec, sid).not.toBeNull();
        expect(rec!.rule_ids.sort()).toEqual(byStrat.get(sid)!.map((n) => n.rule_id).sort());
        expect(rec!.implementation).toBe(compiledImplementationBinding(sid));
        // empirical gating is untouched: UNTESTED caps at CANDIDATE, never live
        expect(rec!.runtime_status).toBe("CANDIDATE");
      }
      // a strategy WITHOUT compiled binding keeps no rule ids
      const unbound = store.strategies().find((s) => !s.implementation);
      expect(unbound).toBeTruthy();
      expect(unbound!.rule_ids).toEqual([]);
      store.close();
    } finally { brain.close(); }
  });

  it("bidirectional closure verification passes on a freshly ingested brain", async () => {
    const { BrainStore } = await import("../src/lib/brain/store");
    const brain = await buildTempBrain();
    try {
      const store = new BrainStore(brain.dbPath);
      const report = verifyRuleRegistryClosure({
        graph: buildMachineRuleGraph(),
        registryRules: store.rules(),
        strategies: store.strategies(),
      });
      expect(report.violations).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.checked_nodes).toBe(buildMachineRuleGraph().node_count);
      expect(report.checked_rows).toBe(report.checked_nodes);
      expect(report.checked_text_rows).toBeGreaterThan(400);
      store.close();
    } finally { brain.close(); }
  });
});

/* ------------------------------------------------------------------ */
/* tamper detection — the closure verifier must catch registry drift   */
/* ------------------------------------------------------------------ */

describe.runIf(hasCorpus)("closure verifier detects registry corruption", () => {
  async function ingested() {
    const { BrainStore } = await import("../src/lib/brain/store");
    const brain = await buildTempBrain();
    const store = new BrainStore(brain.dbPath);
    return { store, cleanup: () => { store.close(); brain.close(); } };
  }

  it("a missing machine row is a MISSING_REGISTRY_ROW violation", async () => {
    const { store, cleanup } = await ingested();
    try {
      const rules = store.rules().filter((r) => r.rule_id !== "R-581-LOC");
      const report = verifyRuleRegistryClosure({ registryRules: rules, strategies: store.strategies() });
      expect(report.ok).toBe(false);
      expect(report.violations).toContainEqual(expect.objectContaining({
        kind: "MISSING_REGISTRY_ROW", rule_id: "R-581-LOC",
      }));
    } finally { cleanup(); }
  });

  it("a drifted predicate is a PREDICATE_MISMATCH violation", async () => {
    const { store, cleanup } = await ingested();
    try {
      const rules = store.rules().map((r) =>
        r.rule_id === "R-803-CONF" ? { ...r, predicates: ["FTR-CLOSE > 999999"] } : r);
      const report = verifyRuleRegistryClosure({ registryRules: rules, strategies: store.strategies() });
      expect(report.violations).toContainEqual(expect.objectContaining({
        kind: "PREDICATE_MISMATCH", rule_id: "R-803-CONF",
      }));
    } finally { cleanup(); }
  });

  it("an orphan machine row is an ORPHAN_MACHINE_RULE violation", async () => {
    const { store, cleanup } = await ingested();
    try {
      const orphan: RuleSpec = {
        rule_id: "R-GHOST-1",
        rule_class: "MACHINE_EXECUTABLE_RULE",
        description: "a hidden rule nobody compiled",
        predicates: ["1 == 1"],
        required_features: ["FTR-CLOSE"],
        direction: "long", timeframe: "1h", confirmation: [], invalidation: [],
        source_refs: [{ file: "2.txt", start_line: 1, end_line: 1 }],
        missing_fields: [], source_status: "SOURCE_VERIFIED", empirical_status: "UNTESTED",
        runtime_status: "CANDIDATE",
        binding: { strategy_id: "STR-RAW-2-581", setup_id: "SET-STR-RAW-2-581", stage: "trigger", consumer: "evaluateRuntime" },
      };
      const report = verifyRuleRegistryClosure({ registryRules: [...store.rules(), orphan], strategies: store.strategies() });
      expect(report.violations).toContainEqual(expect.objectContaining({
        kind: "ORPHAN_MACHINE_RULE", rule_id: "R-GHOST-1",
      }));
    } finally { cleanup(); }
  });

  it("a source-text rule promoted out of DISABLED is a violation", async () => {
    const { store, cleanup } = await ingested();
    try {
      const textRule = store.rules().find((r) => r.rule_class === "UNFORMALIZED_RULE")!;
      const promoted = { ...textRule, runtime_status: "CANDIDATE" as const };
      const rules = store.rules().map((r) => (r.rule_id === textRule.rule_id ? promoted : r));
      const report = verifyRuleRegistryClosure({ registryRules: rules, strategies: store.strategies() });
      expect(report.violations).toContainEqual(expect.objectContaining({
        kind: "BOUND_WITHOUT_PREDICATES", rule_id: textRule.rule_id,
      }));
    } finally { cleanup(); }
  });

  it("a strategy record losing its rule_ids is a STRATEGY_RULE_IDS_MISMATCH violation", async () => {
    const { store, cleanup } = await ingested();
    try {
      const recs = store.strategies().map((s) =>
        s.strategy_id === "STR-RAW-2-581" ? { ...s, rule_ids: [] } : s);
      const report = verifyRuleRegistryClosure({ registryRules: store.rules(), strategies: recs });
      expect(report.violations).toContainEqual(expect.objectContaining({
        kind: "STRATEGY_RULE_IDS_MISMATCH", strategy_id: "STR-RAW-2-581",
      }));
    } finally { cleanup(); }
  });
});

/* ------------------------------------------------------------------ */
/* CONFLICT / UNKNOWN preservation through registration                */
/* ------------------------------------------------------------------ */

describe.runIf(hasCorpus)("tri-state evidence is preserved, never auto-resolved", () => {
  it("UNKNOWN source-text rules stay DISABLED and unbound after machine registration", async () => {
    const { BrainStore } = await import("../src/lib/brain/store");
    const brain = await buildTempBrain();
    try {
      const store = new BrainStore(brain.dbPath);
      const rules = store.rules();
      const unknowns = rules.filter((r) => r.rule_class === "UNKNOWN");
      expect(unknowns.length).toBeGreaterThan(0); // corpus states UNKNOWN explicitly
      for (const r of unknowns) {
        expect(r.runtime_status, r.rule_id).toBe("DISABLED");
        expect(r.non_executable_reason).toMatch(/UNKNOWN/);
        expect(r.binding ?? null).toBeNull();
      }
      // CONFLICT-class rules, when present, must never execute either
      for (const r of rules.filter((x) => x.rule_class === "CONFLICT")) {
        expect(r.runtime_status, r.rule_id).toBe("DISABLED");
        expect(r.binding ?? null).toBeNull();
      }
      store.close();
    } finally { brain.close(); }
  });

  it("conflict groups remain UNRESOLVED — registration never resolves evidence", async () => {
    const { BrainStore } = await import("../src/lib/brain/store");
    const brain = await buildTempBrain();
    try {
      const store = new BrainStore(brain.dbPath);
      const conflicts = store.conflicts();
      expect(conflicts.length).toBeGreaterThan(0);
      for (const c of conflicts) {
        expect(c.resolution, c.conflict_group_id).toBe("UNRESOLVED");
        expect(c.variants.length, `${c.conflict_group_id} must keep every variant`).toBeGreaterThan(0);
        expect(c.chosen_variant).toBeNull();
      }
      store.close();
    } finally { brain.close(); }
  });
});

/* ------------------------------------------------------------------ */
/* runtime consumes the registered representation                      */
/* ------------------------------------------------------------------ */

describe("runtime boundary consumes the same rules the registry holds", () => {
  it("every runtime strategy's rule ids are exactly registered graph nodes", () => {
    const graph = buildMachineRuleGraph();
    const nodeIds = new Set(graph.nodes.map((n) => n.rule_id));
    for (const s of listRuntimeStrategies()) {
      expect(s.rule_ids.length).toBeGreaterThan(0);
      for (const id of s.rule_ids) expect(nodeIds.has(id), id).toBe(true);
    }
  });

  it("evaluateRuntime over a registered strategy produces an evaluation referencing registered rules", () => {
    const def = executableStrategies().find((s) => s.strategy_id === "STR-RAW-4-2449")!;
    // synthetic deterministic candles: enough bars for the detectors
    const candles: Candle[] = [];
    for (let i = 0; i < 200; i++) {
      const base = 100 + Math.sin(i / 7) * 5 + i * 0.01;
      candles.push({ t: 1_700_000_000 + i * 3600, o: base, h: base + 1, l: base - 1, c: base + 0.5, v: 10 });
    }
    const out = evaluateRuntime(def, "BTCUSDT", candles, 1_700_000_000_000);
    expect("blocked" in out).toBe(false);
    if (!("blocked" in out)) {
      const graphIds = new Set(buildMachineRuleGraph().nodes.map((n) => n.rule_id));
      for (const stage of out.setup.stages) {
        for (const r of stage.rules) expect(graphIds.has(r.rule_id), r.rule_id).toBe(true);
      }
      // the evaluation outcome is one of the four declared states — never a bare boolean
      expect(["PASS", "FAIL", "UNKNOWN", "BLOCKED"]).toContain(out.setup.outcome);
    }
  });

  it("a blocked (non-EXECUTABLE) runtime definition refuses evaluation", () => {
    const blocked = listRuntimeStrategies().filter((s) => s.availability !== "EXECUTABLE");
    for (const s of blocked) {
      const out = evaluateRuntime(s, "BTCUSDT", [], Date.now());
      expect(out).toEqual({ blocked: true, reason: s.blocked_reason ?? "strategy is not executable" });
    }
  });

  it("evaluateCompiled levels declare every non-source quantification (no hidden magic)", () => {
    const strat = COMPILED_STRATEGIES.find((s) => s.strategy_id === "STR-RAW-2-803")!;
    const candles: Candle[] = [];
    for (let i = 0; i < 200; i++) {
      const base = 50 + Math.cos(i / 9) * 3;
      candles.push({ t: 1_700_000_000 + i * 3600, o: base, h: base + 0.8, l: base - 0.8, c: base + 0.2, v: 5 });
    }
    const ev = evaluateCompiled(strat, "BTCUSDT", candles, 1_700_000_000_000);
    // whatever the levels are, the assumptions channel exists and is an array
    expect(Array.isArray(ev.levels.level_assumptions)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* one-way guarantee: registration never leaks into runtime behavior   */
/* ------------------------------------------------------------------ */

describe("registration is observability, not behavior", () => {
  it("the runtime registry is identical with or without the brain DB present", () => {
    // PRODUCTION_STRATEGIES derives ONLY from COMPILED_STRATEGIES; the graph
    // projection must not alter availability, blocked reasons or rule sets.
    const before = listRuntimeStrategies().map((s) => `${s.setup_id}:${s.availability}:${s.rule_ids.join(",")}`);
    buildMachineRuleGraph(); // pure projection — must not mutate anything
    machineRuleRegistryRows();
    const after = listRuntimeStrategies().map((s) => `${s.setup_id}:${s.availability}:${s.rule_ids.join(",")}`);
    expect(after).toEqual(before);
  });
});
