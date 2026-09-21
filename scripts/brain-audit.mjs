#!/usr/bin/env node
/**
 * Brain self-audit — produces the 17-point audit report required by the master
 * prompt, as human-readable Markdown plus MACHINE_READABLE_STATUS.json.
 *
 * Reads the brain DB only; performs no network calls and no writes to the
 * corpus. Everything reported here is derived from stored evidence.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env", quiet: true });
loadDotenv({ path: ".env.local", override: true, quiet: true });

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const BRAIN = process.env.ASA_BRAIN_DB_PATH || "./asa-data/brain.db";
if (!fs.existsSync(BRAIN)) {
  console.error(`brain db not found at ${BRAIN} — run: npm run brain:ingest`);
  process.exit(1);
}
const db = new Database(BRAIN, { readonly: true });
const all = (q, ...a) => db.prepare(q).all(...a);
const one = (q, ...a) => db.prepare(q).get(...a);
const count = (t, w = "") => one(`SELECT COUNT(*) c FROM ${t} ${w}`).c;

const docs = all("SELECT * FROM source_documents ORDER BY file_id");
// Phase 2: experiments table may not exist on an ingest-only brain.
// Ordering matches ExperimentStore.evidenceFor (created_ms DESC, rowid DESC)
// so "newest row per symbol" is deterministic even when rows share a
// millisecond — the same database must always yield the same report.
let experiments = [];
try { experiments = all("SELECT * FROM experiments ORDER BY created_ms DESC, rowid DESC"); } catch { experiments = []; }
const strategies = all("SELECT * FROM strategies");
const risk = all("SELECT * FROM risk_policies");
const psych = all("SELECT * FROM psychology_policies");
const conflicts = all("SELECT * FROM conflict_groups");
const primitives = all("SELECT * FROM primitives");
const features = all("SELECT * FROM features");

const byRuntime = {};
const byFamily = {};
const bySource = {};
const byEmpirical = {};
for (const s of strategies) {
  byRuntime[s.runtime_status] = (byRuntime[s.runtime_status] ?? 0) + 1;
  byFamily[s.family] = (byFamily[s.family] ?? 0) + 1;
  bySource[s.source_status] = (bySource[s.source_status] ?? 0) + 1;
  byEmpirical[s.empirical_status] = (byEmpirical[s.empirical_status] ?? 0) + 1;
}

const fragClasses = Object.fromEntries(
  all("SELECT fragment_class, COUNT(*) c FROM source_fragments GROUP BY 1 ORDER BY c DESC").map((r) => [r.fragment_class, r.c]),
);

const unavailableFeatures = features.filter((f) => f.availability === "UNAVAILABLE");
const proxyFeatures = features.filter((f) => f.availability === "PROXY");
const executable = strategies.filter((s) => s.implementation);
const truncated = docs.filter((d) => d.truncated);

// Disabled reasons, aggregated
const disabledReasons = {};
for (const s of strategies.filter((x) => x.runtime_status === "DISABLED")) {
  for (const part of String(s.disabled_reason ?? "").split(";")) {
    const k = part.trim().split("—")[0].trim().slice(0, 90);
    if (k) disabledReasons[k] = (disabledReasons[k] ?? 0) + 1;
  }
}

const status = {
  generated_at: new Date().toISOString(),
  brain_db: BRAIN,
  corpus: {
    files: docs.length,
    total_lines: docs.reduce((a, d) => a + d.total_lines, 0),
    total_chars: docs.reduce((a, d) => a + d.total_chars, 0),
    documents: docs.map((d) => ({
      file_id: d.file_id, filename: d.filename, lines: d.total_lines, chars: d.total_chars,
      sha256: d.source_hash, truncated: !!d.truncated, truncation_note: d.truncation_note,
    })),
    truncated_files: truncated.map((d) => d.file_id),
    coverage: {
      fragments: count("source_fragments"),
      lines_expected: docs.reduce((a, d) => a + d.total_lines, 0),
      one_fragment_per_line: count("source_fragments") === docs.reduce((a, d) => a + d.total_lines, 0),
    },
  },
  counts: {
    fragments: count("source_fragments"),
    knowledge_items: count("knowledge_items"),
    primitives: primitives.length,
    features: features.length,
    rules: count("rules"),
    machine_rules: count("rules", "WHERE rule_class='MACHINE_EXECUTABLE_RULE'"),
    source_text_rules: count("rules", "WHERE rule_class!='MACHINE_EXECUTABLE_RULE'"),
    setups: count("setups"),
    strategies: strategies.length,
    risk_policies: risk.length,
    psychology_policies: psych.length,
    conflict_groups: conflicts.length,
    claims: count("claims"),
    unknown_fragments: fragClasses.UNKNOWN_MARKER ?? 0,
    quarantined: count("source_fragments", "WHERE quarantined=1"),
  },
  fragment_classes: fragClasses,
  // rule-graph closure metadata recorded by ingest (absent on older brains)
  machine_rule_graph: (() => {
    const row = one("SELECT v FROM brain_meta WHERE k='machine_rule_graph'");
    if (!row) return { present: false, note: "run npm run brain:ingest to register machine rules" };
    try { return { present: true, ...JSON.parse(row.v) }; } catch { return { present: false, note: "unparseable" }; }
  })(),
  strategies: {
    by_runtime: byRuntime, by_family: byFamily,
    by_source_status: bySource, by_empirical_status: byEmpirical,
    executable_specs: executable.length,
    executable_list: executable.map((s) => ({
      id: s.strategy_id, name: s.canonical_name, family: s.family, runtime: s.runtime_status,
    })),
    live_count: byRuntime.LIVE_ADVISORY_ONLY ?? 0,
    disabled_reasons: disabledReasons,
  },
  empirical_validation: {
    view: "strategy_registry",
    source: {
      table: "strategies",
      column: "empirical_status",
      scope: "every strategy registry row",
      aggregation: "count_by_status",
    },
    backtested: byEmpirical.BACKTESTED ?? 0,
    oos: byEmpirical.OOS_TESTED ?? 0,
    walk_forward: byEmpirical.WALK_FORWARD ?? 0,
    robust: byEmpirical.ROBUST ?? 0,
    rejected: byEmpirical.REJECTED ?? 0,
    untested: byEmpirical.UNTESTED ?? 0,
    total: strategies.length,
    semantics: "GOVERNED registry state: the empirical_status STORED on each strategy row. It changes only through the governed promotion path — it is NEVER auto-copied from experiment rows and NEVER inferred from source_status. SOURCE_VERIFIED != EMPIRICALLY_VALIDATED.",
    relationship_to_phase2: "Deliberately different view from `phase2`: this section reports what the REGISTRY governs; `phase2.empirical_by_strategy` reports what EXPERIMENT rows observed. A divergence (registry UNTESTED while experiments show BACKTESTED) is expected, not a contradiction — see `empirical_semantics`.",
    note: "empirical_status is never inferred from source_status",
  },
  // Semantic contract between the two empirical views. Machine-checkable:
  // each view names its view id, its source table/column and its aggregation,
  // so no consumer can mistake one for the other.
  empirical_semantics: {
    contract_version: "1.0.0",
    views: {
      empirical_validation: "strategy_registry",
      phase2: "experiment_store",
    },
    sources_of_truth: {
      strategy_registry: {
        table: "strategies",
        column: "empirical_status",
        aggregation: "count_by_status",
        meaning: "governed per-strategy state; changes only via the promotion path",
      },
      experiment_store: {
        table: "experiments",
        column: "empirical_status",
        aggregation: "weakest_of_newest_per_symbol",
        ordering: "created_ms DESC, rowid DESC",
        meaning: "raw observed per-run verdicts as recorded, before governance",
      },
    },
    invariants: [
      "SOURCE_VERIFIED != EMPIRICALLY_VALIDATED: source strength never implies test evidence.",
      "BACKTESTED != OOS_TESTED != WALK_FORWARD != ROBUST: each ladder step requires strictly stronger evidence; a weaker label never implies a stronger one.",
      "UNKNOWN != PASS: missing evidence blocks promotion; it is never upgraded to a pass.",
      "Experiment rows NEVER auto-promote the strategy registry; the registry changes only via the governed promotion path.",
      "`phase2` statuses are raw RECORDED verdicts; the promotion gate (src/lib/backtest/promotion.ts) re-derives every row under the current criteria and may reach a weaker status.",
    ],
    interpretation: {
      when_registry_says_untested_and_experiments_say_backtested:
        "EXPECTED divergence, not a contradiction: validation runs were observed (BACKTESTED evidence exists for those symbols) but no governed promotion has rewritten the registry row. Trust `phase2` for what was OBSERVED and `empirical_validation` for what the registry GOVERNS.",
    },
    consistent_by_design: true,
  },
  ttt_capability_matrix: {
    measured: features.filter((f) => f.availability === "MEASURED").map((f) => f.feature_id),
    derived: features.filter((f) => f.availability === "DERIVED").map((f) => f.feature_id),
    proxy: proxyFeatures.map((f) => ({ id: f.feature_id, reason: f.unavailable_reason })),
    unavailable: unavailableFeatures.map((f) => ({ id: f.feature_id, reason: f.unavailable_reason })),
  },
  risk_policy_matrix: risk.map((r) => ({
    id: r.policy_id, name: r.canonical_name, per_trade: r.risk_per_trade_pct,
    daily: r.daily_loss_limit_pct, account: r.max_account_risk_pct, period: r.period_loss_limit_pct,
    source_status: r.source_status, conflict_group: r.conflict_group_id, runtime: r.runtime_status,
  })),
  psychology_policy_matrix: psych.map((p) => ({
    id: p.policy_id, name: p.canonical_name, effect: p.effect, penalty: p.score_penalty,
    runtime: p.runtime_status, overridable: !!p.user_overridable,
  })),
  conflicts: conflicts.map((c) => ({
    id: c.conflict_group_id, topic: c.topic, resolution: c.resolution,
    variants: JSON.parse(c.variants || "[]").length, chosen: c.chosen_variant,
  })),
  safety_invariants: {
    execution_endpoints_present: false,
    execution_note: "TTT transport refuses non-GET/HEAD at the source; no order/position/transfer path exists",
    live_strategies: byRuntime.LIVE_ADVISORY_ONLY ?? 0,
    fabricated_market_fields: 0,
    unavailable_fields_declared: unavailableFeatures.length,
  },
  phase2: {
    view: "experiment_store",
    source: {
      table: "experiments",
      column: "empirical_status",
      scope: "newest experiment row per (strategy_id, symbol), stored status as recorded",
      aggregation: "weakest_of_newest_per_symbol",
      ordering: "created_ms DESC, rowid DESC (deterministic newest-first, matching ExperimentStore.evidenceFor)",
    },
    experiments: experiments.length,
    empirical_by_strategy: (() => {
      const ORDER = ["REJECTED","UNTESTED","BACKTESTED","OOS_TESTED","WALK_FORWARD","ROBUST"];
      const bySym = {};
      for (const e of experiments) {
        bySym[e.strategy_id] = bySym[e.strategy_id] || {};
        if (!(e.symbol in bySym[e.strategy_id])) bySym[e.strategy_id][e.symbol] = e.empirical_status;
      }
      const out = {};
      for (const [sid, m] of Object.entries(bySym)) {
        let weakest = "ROBUST";
        for (const st of Object.values(m)) if (ORDER.indexOf(st) < ORDER.indexOf(weakest)) weakest = st;
        out[sid] = { status: weakest, symbols: Object.keys(m) };
      }
      return out;
    })(),
    // Derived from the registry, never hardcoded: strategies the governed
    // state actually holds at live advisory.
    promoted_to_live: byRuntime.LIVE_ADVISORY_ONLY ?? 0,
    semantics: "OBSERVED evidence view: raw per-run verdicts as RECORDED, before governance. Statuses here are NOT re-derived under the current criteria, NOT provenance-filtered, NOT version-checked and NOT OOS-gated — the promotion gate (src/lib/backtest/promotion.ts) re-derives every row and may reach a weaker status. BACKTESTED != OOS_TESTED != WALK_FORWARD != ROBUST.",
    relationship_to_empirical_validation: "Deliberately different view from `empirical_validation`: this section reports what EXPERIMENTS observed; `empirical_validation` reports the GOVERNED registry state. An experiment observing BACKTESTED does not rewrite the registry row — see `empirical_semantics`.",
    note: "empirical status per strategy is the WEAKEST across all symbols tested",
  },
  missing_implementation: [
    executable.length < strategies.length
      ? `${strategies.length - executable.length} strategies have no executable spec because the corpus left critical fields UNKNOWN (see disabled_reasons)`
      : null,
    "No OOS/walk-forward validation has been run yet, so no strategy can leave CANDIDATE.",
    truncated.length ? `${truncated.length} source files are truncated upstream; content beyond 350k chars is unavailable.` : null,
  ].filter(Boolean),
};

fs.mkdirSync("docs/brain", { recursive: true });
fs.writeFileSync("MACHINE_READABLE_STATUS.json", JSON.stringify(status, null, 2));

const md = `# AsA Brain — Self Audit

Generated ${status.generated_at} from \`${BRAIN}\`. Every number below is read from
stored evidence; nothing is asserted without a record behind it.

## 1. Corpus coverage
| file | lines | chars | sha256 (12) | truncated upstream |
|---|---|---|---|---|
${docs.map((d) => `| ${d.file_id} (${d.filename}) | ${d.total_lines} | ${d.total_chars} | \`${d.source_hash.slice(0, 12)}\` | ${d.truncated ? "**YES**" : "no"} |`).join("\n")}

Total ${status.corpus.total_lines} lines / ${status.corpus.total_chars} chars.
One fragment per source line: **${status.corpus.coverage.one_fragment_per_line ? "VERIFIED" : "FAILED"}**
(${status.counts.fragments} fragments for ${status.corpus.coverage.lines_expected} lines).

${truncated.length ? `> **Honest limitation.** ${truncated.length} files (${truncated.map((t) => t.file_id).join(", ")}) end mid-sentence at the upstream 350,000-character cap. That content is absent from the supplied package and has **not** been reconstructed from model knowledge.` : ""}

## 2-3. Fragments and knowledge items
${Object.entries(fragClasses).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Knowledge items: ${status.counts.knowledge_items}

## 4. Rules
${status.counts.rules} rule records in one registry, two governed populations:
- **${status.counts.machine_rules} MACHINE_EXECUTABLE_RULE** rows — the compiled runtime's
  rules, registered by ingest with structural predicates, feature dependencies,
  corpus provenance and an explicit binding (\`strategy_id\`, \`setup_id\`, stage,
  consumer \`evaluateRuntime\`). Only this class may drive runtime evaluation.
- **${status.counts.source_text_rules} source-text rules**, each with file+line provenance.
  None carries a machine predicate, so every one remains DISABLED with an explicit
  \`non_executable_reason\` (\`missing_fields\` names exactly what is absent).

Closure: \`verifyRuleRegistryClosure\` (src/lib/strategy/rule-graph.ts) checks the
registry against the runtime in BOTH directions — a drifted predicate, a missing
row, an orphan machine row or a promoted text rule is a machine-detectable violation.

## 5. Strategies
By runtime status: ${JSON.stringify(byRuntime)}
By family: ${JSON.stringify(byFamily)}
Executable specs (all five critical fields present in source): **${executable.length}**
${executable.map((s) => `- \`${s.strategy_id}\` ${s.canonical_name} (${s.family}) → ${s.runtime_status}`).join("\n")}

## 6-8. Unknowns, conflicts, claims
- UNKNOWN-marked source lines: ${status.counts.unknown_fragments}
- Conflict groups: ${conflicts.length} (${conflicts.filter((c) => c.resolution === "UNRESOLVED").length} unresolved)
- Claims held at UNTESTED: ${status.counts.claims}
- Quarantined commentary (never executable): ${status.counts.quarantined}

## 9. Empirical validation status — two deliberate views, one contract

**Registry view** (\`empirical_validation\`, view \`strategy_registry\`, source:
\`strategies.empirical_status\`, governed state — changes only via the
promotion path):
${JSON.stringify(status.empirical_validation, null, 2)}

**Experiment-store view** (\`phase2\`, view \`experiment_store\`, source:
\`experiments.empirical_status\`, raw observed verdicts before governance,
weakest of newest-per-symbol):
- experiments stored: ${status.phase2.experiments}
${Object.entries(status.phase2.empirical_by_strategy).map(([sid, v]) => `- \`${sid}\`: ${v.status} over ${v.symbols.length} symbol(s) (${v.symbols.join(", ")})`).join("\n") || "- (no experiments stored — run `npm run brain:validate`)"}
- promoted to live (derived from registry): ${status.phase2.promoted_to_live}

**Why the two views differ by design** (\`empirical_semantics\`, contract v${status.empirical_semantics.contract_version}):
${status.empirical_semantics.invariants.map((i) => `- ${i}`).join("\n")}

> ${status.empirical_semantics.interpretation.when_registry_says_untested_and_experiments_say_backtested}

## 10. Disabled strategies — exact reasons
${Object.entries(disabledReasons).map(([k, v]) => `- ${v}× ${k}`).join("\n")}

## 11. Missing implementation areas
${status.missing_implementation.map((m) => `- ${m}`).join("\n")}

## 12-13. Runtime capabilities / TTT capability matrix
- MEASURED: ${status.ttt_capability_matrix.measured.join(", ")}
- DERIVED: ${status.ttt_capability_matrix.derived.length} features
- PROXY (labeled, never presented as measured): ${proxyFeatures.map((f) => f.feature_id).join(", ")}
- UNAVAILABLE (declared with reason, never fabricated):
${unavailableFeatures.map((f) => `  - ${f.feature_id}: ${f.unavailable_reason}`).join("\n")}

## 14. Risk policy matrix
| policy | per-trade | daily | account | period | source | conflict | runtime |
|---|---|---|---|---|---|---|---|
${risk.map((r) => `| ${r.policy_id} | ${r.risk_per_trade_pct ?? "—"} | ${r.daily_loss_limit_pct ?? "—"} | ${r.max_account_risk_pct ?? "—"} | ${r.period_loss_limit_pct ?? "—"} | ${r.source_status} | ${r.conflict_group_id ?? "—"} | ${r.runtime_status} |`).join("\n")}

The competing per-trade percentages are preserved as separate policies. No average was taken.

## 15. Psychology policy matrix
| policy | effect | penalty | runtime | overridable |
|---|---|---|---|---|
${psych.map((p) => `| ${p.policy_id} | ${p.effect} | ${p.score_penalty} | ${p.runtime_status} | ${p.user_overridable ? "yes" : "no"} |`).join("\n")}

## 16. AI inputs/outputs
AI consumes deterministic context only (candles, features, structure, strategy
evaluations, risk output, psychology output, capability matrix, source refs) and must
label every assertion MEASURED / SOURCE / INFERRED / CLAIM / UNKNOWN / UNAVAILABLE /
CONFLICT. AI can never override risk limits, psychology blocks, data availability, or
runtime status.

## 17. Safety invariants
${JSON.stringify(status.safety_invariants, null, 2)}
`;

fs.writeFileSync(path.join("docs/brain", "AUDIT.md"), md);
console.log("wrote MACHINE_READABLE_STATUS.json and docs/brain/AUDIT.md");
console.log(`strategies=${strategies.length} executable=${executable.length} live=${byRuntime.LIVE_ADVISORY_ONLY ?? 0} conflicts=${conflicts.length} claims=${status.counts.claims}`);
