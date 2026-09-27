/**
 * Machine Rule Graph — the explicit, auditable intermediate between the
 * compiled runtime rules and the Brain Rule Registry (rule-graph closure).
 *
 * BEFORE this module the chain was broken at exactly one edge:
 *
 *   Brain Rule Registry (brain.db `rules`, source text, DISABLED)
 *     ↯  NO edge — no graph, no registration, no rule-level identity check
 *   Compiled predicates (hand-authored RuleDefinitions in strategy/compiled/*)
 *
 * The compiled rules carried source provenance, but NOTHING in the Brain
 * registry represented them: the `rules` table held zero machine predicates,
 * the `MACHINE_EXECUTABLE_RULE` governance class was declared but never
 * written, every StrategyRecord carried `rule_ids: []`, and the lineage
 * verifier only checked strategy-level identity.
 *
 * This module derives ONE graph from the single executable source
 * (`COMPILED_STRATEGIES`) and provides:
 *   1. `buildMachineRuleGraph()`  — nodes (rules) + edges (rule→feature,
 *      rule→setup-stage, setup→strategy) with stable identity, predicate
 *      structure, lineage, status and explicit UNKNOWN/CONFLICT semantics.
 *   2. `machineRuleRegistryRows()` — the projection of the graph into Brain
 *      `rules` rows (rule_class MACHINE_EXECUTABLE_RULE), registered by
 *      `ingestCorpus` so the registry is complete.
 *   3. `verifyRuleRegistryClosure()` — a bidirectional machine check:
 *      every executable rule has a faithful registry row, and every machine
 *      registry row resolves to a live runtime rule. No orphans, no drift.
 *
 * The graph is a PURE projection (no I/O): tests feed it in-memory brains and
 * the API feeds it the live brain store. It adds NO second source of truth —
 * the compiled strategies remain the only executable representation; this
 * module only makes their structure inspectable and their registry binding
 * machine-checkable.
 */
import { COMPILED_STRATEGIES, type CompiledStrategy } from "./compiled";
import type { RuleDefinition, RulePredicate } from "../rules/engine";
import type { RuleBinding, RuleSpec, SourceRef, StrategyRecord } from "../brain/types";

/** How a node's predicates combine (mirrors rules/engine.ts evaluateRule). */
export type PredicateOperator = "AND" | "OR";

export interface PredicateNode {
  /** short machine-readable expression, e.g. "FTR-LEVEL-TOUCH != null" */
  expr: string;
  /** feature ids this predicate reads */
  requires: string[];
  /** present when the predicate measures a stand-in for the source quantity */
  proxy?: RulePredicate["proxy"];
}

export interface MachineRuleNode {
  /** stable identity — identical to the runtime RuleDefinition id */
  rule_id: string;
  strategy_id: string;
  setup_id: string;
  /** pipeline stage inside the setup (context/location/.../filter) */
  stage: string;
  description: string;
  /** verbatim source sentence the rule encodes */
  source_text: string;
  source_refs: SourceRef[];
  source_status: RuleSpec["source_status"];
  empirical_status: RuleSpec["empirical_status"];
  /** structural predicate representation — never free prose */
  predicates: PredicateNode[];
  operator: PredicateOperator;
  feature_dependencies: string[];
  direction: RuleSpec["direction"];
  timeframe: string;
  /** source semantics that could not be formalized; non-empty ⇒ blocked */
  unresolved: string[];
  /** derived: deterministic AND formalized ⇒ executable */
  executable: boolean;
  version: string;
}

export interface MachineRuleEdge {
  from: string;
  to: string;
  kind: "RULE_USES_FEATURE" | "RULE_IN_STAGE" | "SETUP_IN_STRATEGY";
}

/**
 * Tri-state / conflict semantics declared by the graph and enforced by the
 * rule engine (rules/engine.ts) — recorded structurally so an auditor can
 * verify behavior against the declaration instead of trusting prose.
 */
export interface GraphSemantics {
  /** a required feature missing/invalid ⇒ rule UNKNOWN, never FAIL or PASS */
  unknown: "MISSING_OR_INVALID_FEATURE_PRODUCES_UNKNOWN";
  /** unresolved source semantics ⇒ rule BLOCKED, never guessed */
  unresolved: "UNFORMALIZED_SOURCE_PRODUCES_BLOCKED";
  /** conflicting source evidence is never auto-resolved (gate.ts DISABLED) */
  conflict: "UNRESOLVED_CONFLICT_BLOCKS_PROMOTION";
  /** predicate combination inside one rule */
  combination: "AND_REQUIRES_ALL_TRUE;OR_REQUIRES_ANY_TRUE";
}

export const GRAPH_SEMANTICS: GraphSemantics = {
  unknown: "MISSING_OR_INVALID_FEATURE_PRODUCES_UNKNOWN",
  unresolved: "UNFORMALIZED_SOURCE_PRODUCES_BLOCKED",
  conflict: "UNRESOLVED_CONFLICT_BLOCKS_PROMOTION",
  combination: "AND_REQUIRES_ALL_TRUE;OR_REQUIRES_ANY_TRUE",
};

export interface MachineRuleGraph {
  nodes: MachineRuleNode[];
  edges: MachineRuleEdge[];
  semantics: GraphSemantics;
  /** feature ids referenced by at least one rule */
  feature_ids: string[];
  /** distinct Brain strategy ids with executable rules */
  strategy_ids: string[];
  node_count: number;
  executable_count: number;
  blocked_count: number;
}

function nodeFor(
  strat: CompiledStrategy,
  rule: RuleDefinition,
): MachineRuleNode {
  return {
    rule_id: rule.id,
    strategy_id: strat.strategy_id,
    setup_id: strat.setup_id,
    stage: rule.kind,
    description: rule.description,
    source_text: rule.source_text,
    source_refs: rule.source_refs,
    source_status: rule.source_status,
    empirical_status: rule.empirical_status,
    predicates: rule.predicates.map((p) => ({ expr: p.expr, requires: [...p.requires], ...(p.proxy ? { proxy: { ...p.proxy } } : {}) })),
    operator: rule.operator,
    feature_dependencies: [...rule.feature_dependencies],
    direction: rule.direction,
    timeframe: rule.timeframe,
    unresolved: [...rule.unresolved],
    executable: rule.unresolved.length === 0 && rule.predicates.length > 0,
    version: rule.version,
  };
}

/**
 * Derive the machine rule graph from the compiled strategies — the ONLY
 * executable source. Deterministic: the same code always yields the same
 * graph, so registry rows are reproducible across ingests.
 */
export function buildMachineRuleGraph(strategies: CompiledStrategy[] = COMPILED_STRATEGIES): MachineRuleGraph {
  const nodes: MachineRuleNode[] = [];
  const edges: MachineRuleEdge[] = [];
  const featureIds = new Set<string>();
  const strategyIds = new Set<string>();

  for (const strat of strategies) {
    strategyIds.add(strat.strategy_id);
    edges.push({ from: strat.setup_id, to: strat.strategy_id, kind: "SETUP_IN_STRATEGY" });
    for (const rule of strat.setup().rules) {
      const node = nodeFor(strat, rule);
      nodes.push(node);
      edges.push({ from: node.rule_id, to: strat.setup_id, kind: "RULE_IN_STAGE" });
      for (const fid of node.feature_dependencies) {
        featureIds.add(fid);
        edges.push({ from: node.rule_id, to: fid, kind: "RULE_USES_FEATURE" });
      }
    }
  }

  return {
    nodes,
    edges,
    semantics: GRAPH_SEMANTICS,
    feature_ids: [...featureIds].sort(),
    strategy_ids: [...strategyIds].sort(),
    node_count: nodes.length,
    executable_count: nodes.filter((n) => n.executable).length,
    blocked_count: nodes.filter((n) => !n.executable).length,
  };
}

/** Graph nodes grouped by Brain strategy id. */
export function nodesByStrategy(graph: MachineRuleGraph): Map<string, MachineRuleNode[]> {
  const m = new Map<string, MachineRuleNode[]>();
  for (const n of graph.nodes) {
    const list = m.get(n.strategy_id) ?? [];
    list.push(n);
    m.set(n.strategy_id, list);
  }
  return m;
}

/**
 * Project the graph into Brain Rule Registry rows. Executable nodes become
 * CANDIDATE MACHINE_EXECUTABLE_RULE rows (UNTESTED caps at CANDIDATE — they
 * are evaluable but never live-eligible without empirical promotion); a
 * blocked node stays DISABLED with its exact reason. Source-text rules are
 * never touched by this projection.
 */
export function machineRuleRegistryRows(graph: MachineRuleGraph = buildMachineRuleGraph()): RuleSpec[] {
  return graph.nodes.map((n) => {
    const binding: RuleBinding = {
      strategy_id: n.strategy_id,
      setup_id: n.setup_id,
      stage: n.stage,
      consumer: "evaluateRuntime",
    };
    return {
      rule_id: n.rule_id,
      rule_class: "MACHINE_EXECUTABLE_RULE",
      non_executable_reason: n.executable
        ? null
        : `source semantics not formalized: ${n.unresolved.join("; ") || "no predicates"}`,
      binding,
      description: n.description,
      predicates: n.predicates.map((p) => p.expr),
      required_features: n.feature_dependencies,
      direction: n.direction,
      timeframe: n.timeframe,
      confirmation: [],
      invalidation: [],
      source_refs: n.source_refs,
      missing_fields: [],
      source_status: n.source_status,
      empirical_status: n.empirical_status,
      runtime_status: n.executable ? "CANDIDATE" : "DISABLED",
    };
  });
}

/** `implementation` binding value for a StrategyRecord with compiled rules. */
export function compiledImplementationBinding(strategyId: string, graph: MachineRuleGraph = buildMachineRuleGraph()): string | null {
  const setups = [...new Set(graph.nodes.filter((n) => n.strategy_id === strategyId).map((n) => n.setup_id))].sort();
  return setups.length ? `compiled:${setups.join(",")}` : null;
}

/* ------------------------------------------------------------------ */
/* bidirectional closure verification                                  */
/* ------------------------------------------------------------------ */

export type RuleClosureViolationKind =
  | "MISSING_REGISTRY_ROW"
  | "ORPHAN_MACHINE_RULE"
  | "PREDICATE_MISMATCH"
  | "FEATURE_DEPENDENCY_MISMATCH"
  | "PROVENANCE_MISMATCH"
  | "BINDING_MISMATCH"
  | "STATUS_MISMATCH"
  | "STRATEGY_RULE_IDS_MISMATCH"
  | "BOUND_WITHOUT_PREDICATES";

export interface RuleClosureViolation {
  kind: RuleClosureViolationKind;
  rule_id: string | null;
  strategy_id: string | null;
  detail: string;
}

export interface RuleClosureReport {
  /** runtime rule nodes checked against the registry */
  checked_nodes: number;
  /** MACHINE_EXECUTABLE_RULE registry rows checked against the runtime */
  checked_rows: number;
  /** source-text registry rows asserted to stay unbound + DISABLED */
  checked_text_rows: number;
  violations: RuleClosureViolation[];
  ok: boolean;
}

function refsOverlap(a: SourceRef[], b: SourceRef[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x.file !== y.file) continue;
      const xs = x.start_line ?? 0, xe = x.end_line ?? xs;
      const ys = y.start_line ?? 0, ye = y.end_line ?? ys;
      if (xs <= ye && ys <= xe) return true;
    }
  }
  return false;
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/**
 * Verify the RULE REGISTRY ↔ MACHINE RULE GRAPH ↔ RUNTIME closure.
 *
 * Checks, in both directions:
 *   runtime → registry: every executable rule has a faithful
 *     MACHINE_EXECUTABLE_RULE row (predicates, feature deps, provenance,
 *     binding, status).
 *   registry → runtime: every MACHINE_EXECUTABLE_RULE row resolves to a live
 *     runtime rule; no orphan machine rows; no bound row without predicates.
 *   strategy records: a record bound via `compiled:` lists exactly the
 *     runtime rule ids of that strategy.
 *   source-text rows: never bound, never non-DISABLED, empty predicates.
 */
export function verifyRuleRegistryClosure(opts: {
  graph?: MachineRuleGraph;
  registryRules: RuleSpec[];
  strategies: StrategyRecord[];
}): RuleClosureReport {
  const graph = opts.graph ?? buildMachineRuleGraph();
  const violations: RuleClosureViolation[] = [];

  const rowsById = new Map<string, RuleSpec>();
  for (const r of opts.registryRules) rowsById.set(r.rule_id, r);
  const machineRows = opts.registryRules.filter((r) => r.rule_class === "MACHINE_EXECUTABLE_RULE");
  const textRows = opts.registryRules.filter((r) => r.rule_class !== "MACHINE_EXECUTABLE_RULE");

  // runtime → registry
  for (const n of graph.nodes) {
    const row = rowsById.get(n.rule_id);
    if (!row || row.rule_class !== "MACHINE_EXECUTABLE_RULE") {
      violations.push({
        kind: "MISSING_REGISTRY_ROW",
        rule_id: n.rule_id,
        strategy_id: n.strategy_id,
        detail: `runtime rule '${n.rule_id}' has no MACHINE_EXECUTABLE_RULE registry row`,
      });
      continue;
    }
    if (!sameSet(row.predicates, n.predicates.map((p) => p.expr))) {
      violations.push({
        kind: "PREDICATE_MISMATCH",
        rule_id: n.rule_id,
        strategy_id: n.strategy_id,
        detail: `registry predicates [${row.predicates.join("; ")}] != runtime predicates [${n.predicates.map((p) => p.expr).join("; ")}]`,
      });
    }
    if (!sameSet(row.required_features, n.feature_dependencies)) {
      violations.push({
        kind: "FEATURE_DEPENDENCY_MISMATCH",
        rule_id: n.rule_id,
        strategy_id: n.strategy_id,
        detail: `registry features [${row.required_features.join(",")}] != runtime features [${n.feature_dependencies.join(",")}]`,
      });
    }
    if (!refsOverlap(row.source_refs, n.source_refs)) {
      violations.push({
        kind: "PROVENANCE_MISMATCH",
        rule_id: n.rule_id,
        strategy_id: n.strategy_id,
        detail: "registry source_refs do not overlap the runtime rule's corpus refs",
      });
    }
    const b = row.binding;
    if (!b || b.strategy_id !== n.strategy_id || b.setup_id !== n.setup_id || b.stage !== n.stage) {
      violations.push({
        kind: "BINDING_MISMATCH",
        rule_id: n.rule_id,
        strategy_id: n.strategy_id,
        detail: `registry binding ${JSON.stringify(b)} != runtime binding {strategy:${n.strategy_id}, setup:${n.setup_id}, stage:${n.stage}}`,
      });
    }
    const expectedStatus = n.executable ? "CANDIDATE" : "DISABLED";
    if (row.runtime_status !== expectedStatus) {
      violations.push({
        kind: "STATUS_MISMATCH",
        rule_id: n.rule_id,
        strategy_id: n.strategy_id,
        detail: `registry runtime_status '${row.runtime_status}' but the node is ${n.executable ? "executable (expect CANDIDATE)" : `blocked (expect DISABLED): ${n.unresolved.join(", ")}`}`,
      });
    }
  }

  // registry → runtime (orphans + bound-without-predicates)
  const nodeIds = new Set(graph.nodes.map((n) => n.rule_id));
  for (const row of machineRows) {
    if (!nodeIds.has(row.rule_id)) {
      violations.push({
        kind: "ORPHAN_MACHINE_RULE",
        rule_id: row.rule_id,
        strategy_id: row.binding?.strategy_id ?? null,
        detail: "MACHINE_EXECUTABLE_RULE row has no corresponding runtime rule — a hidden registry entry",
      });
    }
    if (row.predicates.length === 0) {
      violations.push({
        kind: "BOUND_WITHOUT_PREDICATES",
        rule_id: row.rule_id,
        strategy_id: row.binding?.strategy_id ?? null,
        detail: "machine rule row carries no predicates — a sentence is not a predicate",
      });
    }
  }

  // source-text rows must stay unbound and DISABLED
  for (const row of textRows) {
    if (row.binding || row.runtime_status !== "DISABLED") {
      violations.push({
        kind: "BOUND_WITHOUT_PREDICATES",
        rule_id: row.rule_id,
        strategy_id: row.binding?.strategy_id ?? null,
        detail: `source-text rule '${row.rule_id}' must never be bound or promoted (binding=${row.binding ? "present" : "null"}, runtime_status=${row.runtime_status})`,
      });
    }
  }

  // strategy records ↔ runtime rule ids
  const byStrategy = nodesByStrategy(graph);
  for (const rec of opts.strategies) {
    const bound = typeof rec.implementation === "string" && rec.implementation.startsWith("compiled:");
    const runtimeNodes = byStrategy.get(rec.strategy_id) ?? [];
    if (bound) {
      const expected = runtimeNodes.map((n) => n.rule_id).sort();
      if (!sameSet(rec.rule_ids, expected)) {
        violations.push({
          kind: "STRATEGY_RULE_IDS_MISMATCH",
          rule_id: null,
          strategy_id: rec.strategy_id,
          detail: `record rule_ids [${rec.rule_ids.join(",")}] != runtime rule ids [${expected.join(",")}]`,
        });
      }
    } else if (runtimeNodes.length > 0 && rec.rule_ids.length === 0) {
      violations.push({
        kind: "STRATEGY_RULE_IDS_MISMATCH",
        rule_id: null,
        strategy_id: rec.strategy_id,
        detail: "strategy has runtime rules but the record lists none and no compiled binding",
      });
    }
  }

  return {
    checked_nodes: graph.nodes.length,
    checked_rows: machineRows.length,
    checked_text_rows: textRows.length,
    violations,
    ok: violations.length === 0,
  };
}
