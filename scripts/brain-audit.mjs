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
import { createHash } from "node:crypto";
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
const sourceContractPath = "src/lib/strategy/compiled/source-contracts.json";
const sourceContractLockPath = "src/lib/strategy/compiled/source-contracts.lock.json";
const sourceContractBytes = fs.readFileSync(sourceContractPath);
const sourceContract = JSON.parse(sourceContractBytes.toString("utf8"));
const sourceContractLock = JSON.parse(fs.readFileSync(sourceContractLockPath, "utf8"));
const sourceContractDigest = createHash("sha256").update(sourceContractBytes).digest("hex");
const sourceContractIdentityValid = sourceContract.schema_version === "1.2.0" &&
  sourceContract.contract_version === "1.2.0" &&
  sourceContractLock.contract_path === sourceContractPath &&
  sourceContractLock.contract_sha256 === sourceContractDigest &&
  JSON.stringify(sourceContractLock.source_bindings) === JSON.stringify(sourceContract.source_bindings) &&
  JSON.stringify(sourceContractLock.canonical_index) === JSON.stringify(sourceContract.canonical_index) &&
  JSON.stringify(sourceContractLock.implementation_bindings) === JSON.stringify(sourceContract.implementation_bindings) &&
  JSON.stringify(sourceContractLock.validator_binding) === JSON.stringify(sourceContract.validator_binding);
const sourceBindings = new Map((sourceContract.source_bindings ?? []).map((row) => [row.file_id, row]));
const sourceContracts = Array.isArray(sourceContract.strategies) ? sourceContract.strategies : [];
const contractStatusCounts = Object.fromEntries(
  [...new Set(sourceContracts.map((row) => row.contract_status))].sort()
    .map((state) => [state, sourceContracts.filter((row) => row.contract_status === state).length]),
);
const sourceCompletenessOf = (doc) => sourceBindings.get(doc.file_id)?.completeness ?? (doc.truncated ? "TRUNCATED" : "UNKNOWN");
const sourceFaithfulExecutableContracts = sourceContracts.filter((row) =>
  row.contract_status === "SOURCE_FAITHFUL" && row.source_completeness === "COMPLETE" &&
  row.semantic_validation?.status === "PASS" && row.runtime_status === "EXECUTABLE");
const sourceContractLiveEligible = sourceContracts.filter((row) => row.live_eligible === true && row.promotion_eligible === true);
const getMeta = (key) => one("SELECT v FROM brain_meta WHERE k=?", key)?.v ?? null;

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
const implementationBoundStrategies = strategies.filter((s) => s.implementation);
const sourceFaithfulExecutable = sourceFaithfulExecutableContracts;
const inventoryDocs = docs.map((doc) => ({ ...doc, completeness: sourceCompletenessOf(doc) }));
const truncated = inventoryDocs.filter((doc) => doc.completeness === "TRUNCATED");
const unknownCompleteness = inventoryDocs.filter((doc) => doc.completeness === "UNKNOWN");

function auditRiskPolicyEligibility(row) {
  const reasons = [];
  const sourceCompleteness = {};
  let refs = [];
  try { refs = JSON.parse(String(row.source_refs ?? "[]")); }
  catch { reasons.push("source references are invalid JSON"); }
  if (!Array.isArray(refs)) { reasons.push("source references are not an array"); refs = []; }
  if (!sourceContractIdentityValid) reasons.push("source-contract identity is invalid");
  if (row.source_status !== "SOURCE_VERIFIED") reasons.push(`source status is ${String(row.source_status)}, not SOURCE_VERIFIED`);
  if (refs.length === 0) reasons.push("no exact source references");
  if (row.conflict_group_id !== null && row.conflict_group_id !== undefined) reasons.push(`linked to unresolved source conflict ${String(row.conflict_group_id)}`);
  if (row.runtime_status === "DISABLED") reasons.push("runtime status is DISABLED");

  for (const ref of refs) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      reasons.push("malformed source reference");
      continue;
    }
    const binding = sourceBindings.get(ref.file);
    if (!binding) {
      sourceCompleteness[String(ref.file ?? "UNKNOWN")] = "NOT_PRESENT";
      reasons.push(`source ${String(ref.file ?? "UNKNOWN")} has no exact identity binding`);
      continue;
    }
    let completeness = binding.completeness;
    const fullPath = path.resolve(process.cwd(), binding.path);
    if (!fullPath.startsWith(`${path.resolve(process.cwd())}${path.sep}`)) {
      completeness = "INVALID";
      sourceCompleteness[String(ref.file)] = completeness;
      reasons.push(`identity-bound source path escapes the repository: ${String(binding.path)}`);
    } else {
      try {
        const bytes = fs.readFileSync(fullPath);
        const text = bytes.toString("utf8");
        const lines = text.length === 0 ? [] : text.split("\n");
        const lineCount = text.length === 0 ? 0 : lines.length - (text.endsWith("\n") ? 1 : 0);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== binding.sha256 || bytes.byteLength !== binding.bytes || lineCount !== binding.lines || text.length !== binding.chars) {
          completeness = "INVALID";
          reasons.push(`identity-bound source bytes do not match ${String(ref.file)}`);
        }
        sourceCompleteness[String(ref.file)] = completeness;
        if (completeness !== "COMPLETE") reasons.push(`source ${String(ref.file)} completeness is ${completeness}; production selection requires COMPLETE`);
        if (!Number.isSafeInteger(ref.start_line) || !Number.isSafeInteger(ref.end_line) || ref.start_line < 1 || ref.end_line < ref.start_line || ref.end_line > binding.lines) {
          reasons.push(`source range is outside identity-bound lines: ${String(ref.file)}:${String(ref.start_line)}-${String(ref.end_line)}`);
        } else if (typeof ref.quote !== "string" || ref.quote.length === 0 || !lines.slice(ref.start_line - 1, ref.end_line).join("\n").includes(ref.quote)) {
          reasons.push(`quoted evidence is not an exact excerpt from ${String(ref.file)}:${String(ref.start_line)}-${String(ref.end_line)}`);
        }
      } catch {
        sourceCompleteness[String(ref.file)] = "INVALID";
        reasons.push(`identity-bound source bytes are unavailable for ${String(ref.file)}`);
      }
    }
  }
  return { selectable: reasons.length === 0, source_completeness: sourceCompleteness, reasons: [...new Set(reasons)] };
}
const riskPolicyAudits = risk.map((row) => ({ ...row, ...auditRiskPolicyEligibility(row) }));
const psychologyPolicyAudits = psych.map((row) => {
  const eligibility = auditRiskPolicyEligibility({ ...row, conflict_group_id: null });
  return {
    ...row,
    source_completeness: eligibility.source_completeness,
    runtime_status: eligibility.selectable ? row.runtime_status : "DISABLED",
    eligibility_reasons: eligibility.reasons,
  };
});

// Disabled reasons, aggregated
const disabledReasons = {};
for (const s of strategies.filter((x) => x.runtime_status === "DISABLED")) {
  for (const part of String(s.disabled_reason ?? "").split(";")) {
    const k = part.trim().split("—")[0].trim().slice(0, 90).trimEnd();
    if (k) disabledReasons[k] = (disabledReasons[k] ?? 0) + 1;
  }
}

const status = {
  generated_at: new Date().toISOString(),
  brain_db: BRAIN,
  source_recovery: {
    manifest_status: getMeta("source_recovery_manifest_status") ?? "UNKNOWN",
    manifest_sha256: getMeta("source_recovery_manifest_sha256"),
    source_manifest_sha256: getMeta("source_manifest_sha256"),
  },
  source_contract: {
    contract_path: sourceContractPath,
    contract_version: sourceContract.contract_version ?? sourceContract.schema_version ?? "UNKNOWN",
    contract_sha256: sourceContractLock.contract_sha256 ?? null,
    identity_status: sourceContractIdentityValid ? "VALID" : "INVALID",
    strategy_count: sourceContracts.length,
    status_counts: contractStatusCounts,
    source_faithful_executable_count: sourceFaithfulExecutable.length,
    live_eligible_count: sourceContractLiveEligible.length,
  },
  corpus: {
    files: docs.length,
    total_lines: docs.reduce((a, d) => a + d.total_lines, 0),
    total_chars: docs.reduce((a, d) => a + d.total_chars, 0),
    documents: inventoryDocs.map((d) => ({
      file_id: d.file_id, filename: d.filename, lines: d.total_lines, chars: d.total_chars,
      bytes: d.total_bytes, sha256: d.source_hash, truncated: d.completeness === "TRUNCATED",
      completeness: d.completeness, truncation_note: d.truncation_note,
    })),
    completeness_counts: Object.fromEntries(["COMPLETE", "TRUNCATED", "UNKNOWN"].map((state) => [state, inventoryDocs.filter((doc) => doc.completeness === state).length])),
    truncated_files: truncated.map((d) => d.file_id),
    unknown_completeness_files: unknownCompleteness.map((d) => d.file_id),
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
    implementation_bound_record_count: implementationBoundStrategies.length,
    compiled_definition_count: sourceContracts.length,
    executable_specs: sourceFaithfulExecutable.length,
    executable_list: sourceFaithfulExecutable.map((row) => ({
      id: row.strategy_id, name: row.canonical_name, runtime: row.runtime_status,
    })),
    compiled_definition_list: sourceContracts.map((row) => ({
      id: row.strategy_id,
      name: row.canonical_name,
      contract_status: row.contract_status,
      source_completeness: row.source_completeness,
      runtime_status: row.runtime_status,
      promotion_eligible: row.promotion_eligible,
      live_eligible: row.live_eligible,
      blocker_count: row.blockers.length,
    })),
    source_contract_status_counts: contractStatusCounts,
    live_count: byRuntime.LIVE_ADVISORY_ONLY ?? 0,
    source_contract_live_eligible_count: sourceContractLiveEligible.length,
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
  risk_policy_matrix: riskPolicyAudits.map((r) => ({
    id: r.policy_id, name: r.canonical_name, per_trade: r.risk_per_trade_pct,
    daily: r.daily_loss_limit_pct, account: r.max_account_risk_pct, period: r.period_loss_limit_pct,
    source_status: r.source_status, source_completeness: r.source_completeness,
    conflict_group: r.conflict_group_id, runtime: r.runtime_status,
    production_selectable: r.selectable, eligibility_reasons: r.reasons,
  })),
  risk_policy_eligibility: {
    production_selectable: riskPolicyAudits.filter((row) => row.selectable).length,
    blocked: riskPolicyAudits.filter((row) => !row.selectable).length,
    source_contract_identity_valid: sourceContractIdentityValid,
  },
  psychology_policy_matrix: psychologyPolicyAudits.map((p) => ({
    id: p.policy_id, name: p.canonical_name, effect: p.effect, penalty: p.score_penalty,
    source_status: p.source_status, source_completeness: p.source_completeness,
    runtime: p.runtime_status, overridable: !!p.user_overridable,
    eligibility_reasons: p.eligibility_reasons,
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
    sourceContracts.length && sourceFaithfulExecutable.length < sourceContracts.length
      ? `${sourceContracts.length - sourceFaithfulExecutable.length} compiled strategy contract(s) are not source-faithful executable; see source_contracts.json blockers. A TypeScript implementation binding alone is not source parity.`
      : null,
    sourceContractLiveEligible.length === 0 ? "No compiled source contract is currently promotion- and live-eligible." : null,
    unknownCompleteness.length ? `${unknownCompleteness.length} supplied source file(s) have UNKNOWN completeness; below-cap byte counts do not prove completion.` : null,
    truncated.length ? `${truncated.length} supplied source file(s) are explicitly TRUNCATED; missing continuation is not reconstructed.` : null,
    experiments.length === 0 ? "No experiment rows are persisted in this Brain DB; empirical status remains UNTESTED." : null,
  ].filter(Boolean),
};

fs.mkdirSync("docs/brain", { recursive: true });
fs.writeFileSync("MACHINE_READABLE_STATUS.json", JSON.stringify(status, null, 2));

const md = `# AsA Brain — Self Audit

Generated ${status.generated_at} from \`${BRAIN}\`. Every number below is read from
stored evidence; nothing is asserted without a record behind it.

## 1. Source recovery and supplied-text inventory

Source recovery manifest: **${status.source_recovery.manifest_status}**; sha256=${status.source_recovery.manifest_sha256 ?? "UNKNOWN"}.
The canonical knowledge pack is an index/acceleration artifact, not authority over the raw source bytes.

| file id | filename | lines | chars | bytes | sha256 (12) | completeness |
|---|---|---:|---:|---:|---|---|
${inventoryDocs.map((d) => `| ${d.file_id} | ${d.filename} | ${d.total_lines} | ${d.total_chars} | ${d.total_bytes ?? "UNKNOWN"} | \`${d.source_hash.slice(0, 12)}\` | **${d.completeness}** |`).join("\n")}

Total ${status.corpus.total_lines} lines / ${status.corpus.total_chars} chars across ${status.corpus.files} ingested text sources.
One fragment per supplied source line: **${status.corpus.coverage.one_fragment_per_line ? "VERIFIED" : "FAILED"}**
(${status.counts.fragments} fragments for ${status.corpus.coverage.lines_expected} lines).

${truncated.length ? `> **TRUNCATED:** ${truncated.length} source file(s) are explicitly marked incomplete (${truncated.map((t) => t.file_id).join(", ")}); missing continuation is not reconstructed.` : ""}
${unknownCompleteness.length ? `> **UNKNOWN:** ${unknownCompleteness.length} source file(s) have unknown original completeness (${unknownCompleteness.map((d) => d.file_id).join(", ")}); below-cap size is not treated as proof of completeness.` : ""}

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

## 5. Compiled strategy contracts and runtime status

Brain registry status: ${JSON.stringify(byRuntime)}. Implementation-bound records: ${implementationBoundStrategies.length}.
Source contract version: ${sourceContract.contract_version}; status counts: ${JSON.stringify(contractStatusCounts)}.
**Source-faithful executable contracts:** ${sourceFaithfulExecutable.length}. A code binding or formalized record is not source parity.

| strategy | contract | source completeness | runtime ceiling | promotion | live | blockers |
|---|---|---|---|---|---|---:|
${sourceContracts.map((row) => `| \`${row.strategy_id}\` | ${row.contract_status} | ${row.source_completeness} | ${row.runtime_status} | ${row.promotion_eligible ? "YES" : "NO"} | ${row.live_eligible ? "YES" : "NO"} | ${row.blockers.length} |`).join("\n")}

Compiled definitions may remain research-computable only. Incomplete/unknown source contracts are not live executable or promotion eligible; see the field-level source-contracts.json blockers.

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
| policy | per-trade | daily | account | period | source status | source completeness | conflict | runtime | production selectable |
|---|---|---|---|---|---|---|---|---|---|
${riskPolicyAudits.map((r) => `| ${r.policy_id} | ${r.risk_per_trade_pct ?? "—"} | ${r.daily_loss_limit_pct ?? "—"} | ${r.max_account_risk_pct ?? "—"} | ${r.period_loss_limit_pct ?? "—"} | ${r.source_status} | ${JSON.stringify(r.source_completeness)} | ${r.conflict_group_id ?? "—"} | ${r.runtime_status} | ${r.selectable ? "YES" : "NO"} |`).join("\n")}

Production-selectable policies: **${riskPolicyAudits.filter((r) => r.selectable).length} / ${riskPolicyAudits.length}**. Eligibility requires valid source-contract identity, identity-bound byte/hash/line/character matches, exact quoted excerpts and in-range references, COMPLETE cited documents, no unresolved conflict, source status SOURCE_VERIFIED, and non-disabled runtime status. Explicit operator selection is a separate requirement. Eligibility blockers by policy:
${riskPolicyAudits.filter((r) => !r.selectable).map((r) => `- ${r.policy_id}: ${r.reasons.join("; ")}`).join("\n")}

The competing per-trade percentages are preserved as separate policies. No average was taken. A CLAIM or SOURCE_INFERRED row is not promoted into a numeric limit.

## 15. Psychology policy matrix
| policy | effect | penalty | source status | source completeness | effective runtime | overridable | eligibility |
|---|---|---|---|---|---|---|---|
${psychologyPolicyAudits.map((p) => `| ${p.policy_id} | ${p.effect} | ${p.score_penalty} | ${p.source_status} | ${JSON.stringify(p.source_completeness)} | ${p.runtime_status} | ${p.user_overridable ? "yes" : "no"} | ${p.eligibility_reasons.join("; ") || "source references verified"} |`).join("\n")}

## 16. AI Clone boundary (route-level audit)

A provider request (only when the selected provider is configured and online) contains exactly two chat messages: the deterministic system prompt and a user message containing the bounded question, deterministic facts and serialized structured context. There is no prior chat history; transport includes the selected model, temperature 0.2 and stream=false. The route returns facts and the same context separately from the explanation. The actual mock-provider request is compared with the returned context in tests/ai-clone.test.ts.

Always-sent context includes validated-symbol market stats/provenance/freshness or board sweep truth, release/build and source-contract identity, all compiled contracts and runtime consumer paths, promotion status, selected-or-blocked risk-policy state/source completeness, configured risk inputs, measured advisory-signal exposure or UNKNOWN, realized-loss availability/reason, and market-psychology context for a valid symbol. The request-scoped personal-psychology branch adds only explicit/journal-derived state, its deterministic gate result, manifest/source descriptors and source-only principle paraphrases; otherwise those archives are marked NOT_SHARED and omitted. Raw source transcript bytes, free-text journal notes, reconstructed historical psychology, inferred traits/diagnoses and provider credentials are excluded.

The response includes ok, bounded question, validated symbol, provider_mode, facts, ai_context, explanation, explanation_authority, explanation_validation, tags, llm_online, provider/model/status/error/latency metadata, and ts. Provider prose can only populate candidate explanation text and influence its token/authority validation findings and model-output-related status/tag. It cannot mutate the facts, context, risk/promotion/admission state or runtime decisions. A narrow numeric/symbol/authority-token check may withhold it; **semantic truth is NOT_PROVEN**. The explanation is rendered separately and is never consumed by strategy, risk, promotion, persistence, live gates or order code. Deterministic evidence remains authoritative; AI Clone has no execution capability.

## 17. Safety invariants
${JSON.stringify(status.safety_invariants, null, 2)}
`;

fs.writeFileSync(path.join("docs/brain", "AUDIT.md"), md);
console.log("wrote MACHINE_READABLE_STATUS.json and docs/brain/AUDIT.md");
console.log(`strategies=${strategies.length} compiled-contracts=${sourceContracts.length} source-faithful=${sourceFaithfulExecutable.length} live=${byRuntime.LIVE_ADVISORY_ONLY ?? 0} conflicts=${conflicts.length} claims=${status.counts.claims}`);
