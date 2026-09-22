/**
 * Stage 1 + Stage 2 — corpus ingestion and canonical knowledge compilation.
 *
 * Guarantees enforced here (and asserted by tests/brain-ingest.test.ts):
 *  - EVERY line of EVERY supplied RAW file becomes exactly one fragment with
 *    file+line provenance. Nothing is summarized away or dropped.
 *  - sha256 of each file is recorded; a content change is detectable.
 *  - UNKNOWN / CONFLICT / CLAIM / META_COMMENTARY classifications are preserved
 *    verbatim and never rewritten into rules.
 *  - Strategy blocks are parsed literally; missing fields stay UNKNOWN.
 *  - The canonical pack (authority #2) supplies aliases/registry acceleration,
 *    but RAW lines remain the provenance of record.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ASA_CORPUS_DIR } from "../env";
import { BrainStore } from "./store";
import { classifyLine, parseStrategyBlocks, topicTags, unknownCriticalFields, type ParsedStrategyBlock } from "./classify";
import { compileBlock, setupFromSpec, type CompiledSpec } from "./compile";
import { evaluateGate } from "./gate";
import { isConflictUnresolved } from "./conflicts";
import { CORPUS_FILES, CANONICAL_PACK_FILE } from "./corpus-manifest";
import { buildPrimitives, buildFeatures } from "./primitives";
import { buildRiskPolicies, buildPsychologyPolicies, buildConflictGroups } from "./policies";
import { canonicalFamilyFor } from "./ontology";
import {
  buildMachineRuleGraph, compiledImplementationBinding, machineRuleRegistryRows, nodesByStrategy,
} from "../strategy/rule-graph";
import type {
  ClaimRecord, KnowledgeItem, RuleSpec, SourceDocument, SourceFragment, SourceRef, StrategyRecord,
} from "./types";

export interface IngestReport {
  ok: boolean;
  documents: { file_id: string; lines: number; chars: number; sha256: string; truncated: boolean }[];
  fragments_written: number;
  lines_seen: number;
  coverage_ok: boolean;
  strategies: number;
  executable_specs: number;
  setups: number;
  rules: number;
  /** machine-executable rules registered into the rule registry (rule-graph closure) */
  machine_rules: number;
  claims: number;
  conflicts: number;
  unknown_fragments: number;
  quarantined: number;
  primitives: number;
  features: number;
  risk_policies: number;
  psychology_policies: number;
  errors: string[];
  duration_ms: number;
}

interface PackStrategy {
  id: string; canonical_name: string; type: string; source_status: string;
  aliases?: string[]; evidence?: { file: string; line: number; text: string }[];
  empirical_status?: string; live_status?: string;
}
interface PackRule { id: string; file: string; line: number; text: string; source_status: string; tags?: string[] }
interface Pack {
  strategy_registry?: PackStrategy[];
  rule_registry?: PackRule[];
  uncertainty_registry?: Record<string, { file: string; line: number; text: string }[]>;
}

/** Upstream cap that truncated some supplied files (see STAGE0_BASELINE.md). */
const TRUNCATION_CHAR_CAP = 350_000;

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function ingestCorpus(store: BrainStore, corpusDir = ASA_CORPUS_DIR): IngestReport {
  const started = Date.now();
  const errors: string[] = [];
  const docs: IngestReport["documents"] = [];
  let fragmentsWritten = 0;
  let linesSeen = 0;
  let unknownFragments = 0;
  let quarantined = 0;

  // REFRESH CONTRACT: rebuilding knowledge from the immutable corpus must not
  // silently erase prior conflict ADJUDICATION (operator or empirical). The
  // reset below DELETEs every conflict row — and `buildConflictGroups` would
  // re-insert them all as UNRESOLVED — so snapshot the non-UNRESOLVED
  // adjudication state first and re-apply it onto the rebuilt groups before
  // they are written back. Source-derived fields (topic/variants) always come
  // fresh from the corpus; adjudication fields are operator/evidence state
  // that only an explicit putConflicts write may change.
  const priorAdjudications = new Map(
    store
      .conflicts()
      .filter((c) => c.resolution !== "UNRESOLVED")
      .map((c) => [c.conflict_group_id, c]),
  );

  store.resetKnowledge();

  const allBlocks: ParsedStrategyBlock[] = [];
  const blockByStrategy = new Map<string, ParsedStrategyBlock>();
  const claimRows: ClaimRecord[] = [];
  const conflictLines: { file: string; line: number; text: string }[] = [];

  for (const cf of CORPUS_FILES) {
    const full = path.join(corpusDir, cf.filename);
    if (!fs.existsSync(full)) {
      errors.push(`MISSING corpus file: ${full}`);
      continue;
    }
    const buf = fs.readFileSync(full);
    const text = buf.toString("utf8");
    const hash = sha256(buf);
    const lines = text.split("\n");
    const chars = text.length;

    // Truncation is a property of the SUPPLIED bytes; record it, never fix it.
    // Detected two ways: (a) the file sits at/just below the upstream 350k cap,
    // or (b) the manifest recorded it during Stage 0 verification. Relying on
    // terminal punctuation alone is unreliable for Persian text.
    const nearCap = chars >= TRUNCATION_CHAR_CAP - 5;
    const truncated = nearCap || cf.known_truncated;
    const doc: SourceDocument = {
      file_id: cf.file_id,
      filename: cf.filename,
      source_hash: hash,
      source_version: "v1-as-supplied",
      immutable: true,
      total_lines: lines.length,
      total_chars: chars,
      ingestion_timestamp: Date.now(),
      truncated,
      truncation_note: truncated
        ? `supplied bytes end mid-content at ${chars} chars (upstream ${TRUNCATION_CHAR_CAP}-char cap); content beyond this point is NOT present in this package and is not reconstructed`
        : null,
    };
    store.putDocument(doc);
    docs.push({ file_id: cf.file_id, lines: lines.length, chars, sha256: hash, truncated });

    // One fragment per source line — total provenance, zero loss.
    const frags: SourceFragment[] = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const lineNo = i + 1;
      linesSeen++;
      const { cls, quarantine } = classifyLine(raw);
      if (cls === "UNKNOWN_MARKER") unknownFragments++;
      if (quarantine) quarantined++;
      if (cls === "CONFLICT_MARKER") conflictLines.push({ file: cf.file_id, line: lineNo, text: raw.trim() });
      if (cls === "CLAIM" && raw.trim()) {
        const stmt = raw.trim();
        claimRows.push({
          claim_id: `CLM-${cf.file_id.replace(".txt", "")}-${lineNo}`,
          statement: stmt.slice(0, 2000),
          quantitative_hint: extractQuantHint(stmt),
          source_refs: [{ file: cf.file_id, start_line: lineNo, end_line: lineNo, quote: stmt.slice(0, 400) }],
          empirical_status: "UNTESTED",
          test_result: null,
        });
      }
      frags.push({
        fragment_id: `FRG-${cf.file_id.replace(".txt", "")}-${lineNo}`,
        file_id: cf.file_id,
        start_line: lineNo,
        end_line: lineNo,
        raw_text: raw,
        topic_tags: raw.trim() ? topicTags(raw) : [],
        fragment_class: cls,
        quarantined: quarantine !== null,
        quarantine_reason: quarantine,
      });
    }
    store.putFragments(frags);
    fragmentsWritten += frags.length;

    for (const b of parseStrategyBlocks(cf.file_id, lines)) allBlocks.push(b);
  }

  /* ------------------------------------------- canonical pack acceleration */
  let pack: Pack = {};
  const packPath = path.join(corpusDir, CANONICAL_PACK_FILE);
  if (fs.existsSync(packPath)) {
    try {
      pack = JSON.parse(fs.readFileSync(packPath, "utf8")) as Pack;
    } catch (e) {
      errors.push(`canonical pack unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    errors.push(`canonical knowledge pack not found at ${packPath} — proceeding from RAW only`);
  }

  /* ------------------------------------------------------------ strategies */
  const strategies: StrategyRecord[] = [];
  const seenNames = new Map<string, StrategyRecord>();

  // 1) From parsed RAW blocks (authoritative provenance).
  for (const b of allBlocks) {
    const cleanName = b.name.replace(/\[(VERIFIED|INFERRED|CLAIM|CONFLICT)\]/g, "").trim();
    if (!cleanName || cleanName.toUpperCase().startsWith("UNKNOWN")) continue;
    const key = normalizeName(cleanName);
    const unknownCritical = unknownCriticalFields(b);
    const refs: SourceRef[] = [{
      file: b.file, start_line: b.start_line, end_line: b.end_line,
      quote: `${b.name}`.slice(0, 300),
    }];
    const srcStatus = b.name.includes("VERIFIED")
      ? "SOURCE_VERIFIED" : b.name.includes("INFERRED") ? "SOURCE_INFERRED" : "SOURCE_VERIFIED";

    const existing = seenNames.get(key);
    if (existing) {
      // Deduplicate rather than creating a second engine (governance J).
      existing.source_refs.push(...refs);
      if (!existing.aliases.includes(cleanName)) existing.aliases.push(cleanName);
      continue;
    }
    const blockText = b.fields.map((f) => `${f.field}: ${f.value}`).join(" | ");
    const rec: StrategyRecord = {
      strategy_id: `STR-RAW-${b.file.replace(".txt", "")}-${b.name_line}`,
      canonical_name: cleanName,
      family: canonicalFamilyFor(cleanName, blockText),
      aliases: [cleanName],
      type: "strategy",
      description: b.fields.find((f) => f.field === "idea")?.value ?? "",
      source_refs: refs,
      source_status: srcStatus,
      empirical_status: "UNTESTED",
      runtime_status: "DISABLED",
      unknown_critical: unknownCritical,
      conflict_group_id: null,
      setup_ids: [],
      rule_ids: [],
      implementation: null,
      version: "1.0.0",
      disabled_reason: null,
    };
    // Ingest carries the record's own conflict linkage into the gate through the
    // canonical contract — never a hardcoded boolean. Strategy records hold
    // no linkage today (null → NONE → false); a future linkage whose
    // resolution is unreadable at gate time fails closed (true).
    const verdict = evaluateGate({
      source_status: rec.source_status,
      empirical_status: rec.empirical_status,
      unknown_critical: rec.unknown_critical,
      conflict_unresolved: isConflictUnresolved(rec.conflict_group_id, null),
      has_implementation: false,
    });
    rec.runtime_status = verdict.allowed;
    rec.disabled_reason = verdict.reasons.join("; ");
    strategies.push(rec);
    seenNames.set(key, rec);
    blockByStrategy.set(rec.strategy_id, b);
  }

  // 2) Merge canonical-pack registry entries (aliases + ids), dedup by name.
  for (const ps of pack.strategy_registry ?? []) {
    const key = normalizeName(ps.canonical_name);
    const refs: SourceRef[] = (ps.evidence ?? []).map((e) => ({
      file: e.file, start_line: e.line, end_line: e.line, quote: (e.text ?? "").slice(0, 300),
    }));
    const existing = seenNames.get(key);
    if (existing) {
      for (const a of ps.aliases ?? []) if (!existing.aliases.includes(a)) existing.aliases.push(a);
      existing.source_refs.push(...refs);
      continue;
    }
    const srcStatus =
      ps.source_status === "SOURCE_VERIFIED" ? "SOURCE_VERIFIED"
        : ps.source_status === "SOURCE_INFERRED" ? "SOURCE_INFERRED"
          : "SOURCE_VERIFIED";
    const isProcess = /psychology|security_routine|process_routine|principles/.test(ps.type);
    const rec: StrategyRecord = {
      strategy_id: ps.id,
      canonical_name: ps.canonical_name,
      family: isProcess ? "process-layer" : canonicalFamilyFor(ps.canonical_name, (ps.aliases ?? []).join(" ")),
      aliases: ps.aliases ?? [],
      type: ps.type,
      description: "",
      source_refs: refs,
      source_status: srcStatus,
      empirical_status: "UNTESTED",
      runtime_status: "DISABLED",
      // pack entries carry no formal spec -> all five critical fields unknown
      unknown_critical: ["entry", "stop", "target", "timeframe", "invalidation"],
      conflict_group_id: null,
      setup_ids: [],
      rule_ids: [],
      implementation: null,
      version: "1.0.0",
      disabled_reason: null,
    };
    const verdict = evaluateGate({
      source_status: rec.source_status, empirical_status: rec.empirical_status,
      unknown_critical: rec.unknown_critical, conflict_unresolved: isConflictUnresolved(rec.conflict_group_id, null), has_implementation: false,
    });
    rec.runtime_status = verdict.allowed;
    rec.disabled_reason = verdict.reasons.join("; ");
    strategies.push(rec);
    seenNames.set(key, rec);
  }
  /* ------------------------------ Stage 3: compile executable setups ------ */
  const setups = [];
  const compiled: CompiledSpec[] = [];
  for (const rec of strategies) {
    const b = blockByStrategy.get(rec.strategy_id);
    if (!b) continue;
    const spec = compileBlock(rec, b);
    compiled.push(spec);
    if (spec.executable) {
      const setup = setupFromSpec(spec);
      setups.push(setup);
      rec.setup_ids = [setup.setup_id];
      // A compiled source spec makes the strategy evaluable, but empirical
      // gating still caps it at CANDIDATE until it is actually tested.
      rec.implementation = `brain-spec:${setup.setup_id}`;
      const v2 = evaluateGate({
        source_status: rec.source_status,
        empirical_status: rec.empirical_status,
        unknown_critical: rec.unknown_critical,
        conflict_unresolved: isConflictUnresolved(rec.conflict_group_id, null),
        has_implementation: true,
      });
      rec.runtime_status = v2.allowed;
      rec.disabled_reason = v2.reasons.join("; ");
    } else if (spec.blocked_because.length) {
      rec.disabled_reason = `${rec.disabled_reason}; compile: ${spec.blocked_because.join(", ")}`;
    }
  }
  store.putSetups(setups);
  store.setMeta("compiled_specs", JSON.stringify(compiled.filter((c) => c.executable).map((c) => c.strategy_id)));
  store.setMeta("compiled_specs_full", JSON.stringify(compiled));

  /* ------------------------------------ rule-graph closure (registry ↔ runtime)
   * The compiled runtime rules (the ONLY executable representation) are
   * registered into the Brain Rule Registry below; here we wire each strategy
   * record to them: `rule_ids` lists exactly the runtime rules of the
   * strategy, and `implementation` points at the compiled binding that
   * `evaluateRuntime` consumes. Records without a compiled binding keep their
   * brain-spec (text-level) binding and stay non-executable at runtime.
   */
  const machineGraph = buildMachineRuleGraph();
  const nodesByStrat = nodesByStrategy(machineGraph);
  for (const rec of strategies) {
    const nodes = nodesByStrat.get(rec.strategy_id);
    if (!nodes || nodes.length === 0) continue;
    rec.rule_ids = nodes.map((n) => n.rule_id).sort();
    rec.implementation = compiledImplementationBinding(rec.strategy_id, machineGraph);
    rec.setup_ids = [...new Set([...rec.setup_ids, ...nodes.map((n) => n.setup_id)])];
    const v3 = evaluateGate({
      source_status: rec.source_status,
      empirical_status: rec.empirical_status,
      unknown_critical: rec.unknown_critical,
      conflict_unresolved: isConflictUnresolved(rec.conflict_group_id, null),
      has_implementation: true,
    });
    rec.runtime_status = v3.allowed;
    rec.disabled_reason = v3.reasons.join("; ");
  }

  store.putStrategies(strategies);

  /* ----------------------------------------------------------------- rules */
  /**
   * RULE GOVERNANCE (remediation P1).
   *
   * Every one of these 503 rows is SOURCE TEXT with provenance — none carries a
   * machine predicate. Previously they were all persisted as
   * `SOURCE_VERIFIED` + `CANDIDATE`, which overclaimed twice:
   *   * absence of a [VERIFIED] marker is not evidence of verification, and
   *   * a rule with no predicate can never be a runtime candidate.
   *
   * They are now classified honestly. The machine-executable rules live in the
   * compiled strategies and are exposed via /api/brain/rules; these rows are
   * explicitly UNFORMALIZED_RULE unless the source marks them otherwise.
   */
  const rules: RuleSpec[] = (pack.rule_registry ?? []).map((r) => {
    const text = r.text ?? "";
    const marked = (re: RegExp) => re.test(text);
    const ruleClass: RuleSpec["rule_class"] =
      marked(/\[CONFLICT\]|تناقض/) ? "CONFLICT"
        : marked(/CLAIMED BY INSTRUCTOR|\[CLAIM\]|ادعای/) ? "CLAIM"
          : marked(/\bUNKNOWN\b/) ? "UNKNOWN"
            : "UNFORMALIZED_RULE";
    const sourceStatus: RuleSpec["source_status"] =
      ruleClass === "CONFLICT" ? "CONFLICT"
        : ruleClass === "CLAIM" ? "CLAIM"
          : ruleClass === "UNKNOWN" ? "UNKNOWN"
            : marked(/\[VERIFIED\]/) ? "SOURCE_VERIFIED"
              : "SOURCE_INFERRED"; // no marker != verified
    return {
      rule_id: r.id,
      description: text,
      predicates: [],
      required_features: [],
      direction: "none" as const,
      timeframe: null,
      confirmation: [],
      invalidation: [],
      source_refs: [{ file: r.file, start_line: r.line, end_line: r.line, quote: text.slice(0, 400) }],
      missing_fields: ["predicates", "required_features", "direction", "timeframe"],
      source_status: sourceStatus,
      empirical_status: "UNTESTED" as const,
      // A rule with no predicate is NOT a runtime candidate.
      runtime_status: "DISABLED" as const,
      rule_class: ruleClass,
      non_executable_reason:
        ruleClass === "CONFLICT" ? "source marks a contradiction here — never executed"
          : ruleClass === "CLAIM" ? "instructor claim — requires empirical proof, never executed"
            : ruleClass === "UNKNOWN" ? "source explicitly states UNKNOWN"
              : "source text carries no deterministic predicate; formalizing it would require inventing semantics",
    };
  });
  store.putRules(rules);

  /* ------------------------------------------- machine rule registration ---
   * RULE-GRAPH CLOSURE: the 503 rows above are source text (never executable).
   * The machine-executable rules are the compiled runtime's RuleDefinitions;
   * they are registered HERE so the Brain Rule Registry is the single,
   * complete, auditable rule record: every executable rule exists as a
   * MACHINE_EXECUTABLE_RULE row with structural predicates, feature
   * dependencies, corpus provenance and an explicit runtime binding.
   * No text rule is touched, and no predicate is invented for one.
   */
  const machineRules = machineRuleRegistryRows(machineGraph);
  store.putRules(machineRules);
  store.setMeta("machine_rule_graph", JSON.stringify({
    node_count: machineGraph.node_count,
    executable_count: machineGraph.executable_count,
    blocked_count: machineGraph.blocked_count,
    feature_ids: machineGraph.feature_ids,
    strategy_ids: machineGraph.strategy_ids,
    semantics: machineGraph.semantics,
  }));

  /* -------------------------------------------------- claims from the pack */
  for (const c of pack.uncertainty_registry?.CLAIM ?? []) {
    claimRows.push({
      claim_id: `CLM-PACK-${c.file.replace(".txt", "")}-${c.line}`,
      statement: (c.text ?? "").slice(0, 2000),
      quantitative_hint: extractQuantHint(c.text ?? ""),
      source_refs: [{ file: c.file, start_line: c.line, end_line: c.line, quote: (c.text ?? "").slice(0, 400) }],
      empirical_status: "UNTESTED",
      test_result: null,
    });
  }
  const dedupClaims = Array.from(new Map(claimRows.map((c) => [c.claim_id, c])).values());
  store.putClaims(dedupClaims);

  /* ------------------------------------------- primitives/features/policies */
  const primitives = buildPrimitives();
  store.putPrimitives(primitives);
  const features = buildFeatures();
  store.putFeatures(features);

  const conflicts = buildConflictGroups(conflictLines);
  // Re-apply preserved adjudications (see snapshot before resetKnowledge):
  // only groups that still exist in the rebuilt set inherit their prior
  // resolution/chosen_variant/resolved_by/resolved_at_ms. A pristine store
  // (no snapshot) rebuilds every group exactly as before — UNRESOLVED.
  for (const c of conflicts) {
    const prior = priorAdjudications.get(c.conflict_group_id);
    if (prior) {
      c.resolution = prior.resolution;
      c.chosen_variant = prior.chosen_variant;
      c.resolved_by = prior.resolved_by;
      c.resolved_at_ms = prior.resolved_at_ms;
    }
  }
  store.putConflicts(conflicts);

  const riskPolicies = buildRiskPolicies();
  store.putRiskPolicies(riskPolicies);
  const psychPolicies = buildPsychologyPolicies();
  store.putPsychologyPolicies(psychPolicies);

  /* ------------------------------------------------------- knowledge items */
  const knowledge: KnowledgeItem[] = strategies.map((s) => ({
    knowledge_id: `KN-${s.strategy_id}`,
    type: s.family === "process-layer" ? "process" : "strategy",
    canonical_name: s.canonical_name,
    description: s.description,
    source_refs: s.source_refs,
    source_status: s.source_status,
    empirical_status: s.empirical_status,
    runtime_status: s.runtime_status,
    confidence: s.source_status === "SOURCE_VERIFIED" ? 0.7 : 0.4,
    conflict_group_id: s.conflict_group_id,
    claim_group_id: null,
    unknown_fields: s.unknown_critical,
    external_notes: [],
    aliases: s.aliases,
  }));
  store.putKnowledge(knowledge);

  store.setMeta("last_ingest_ms", String(Date.now()));
  store.setMeta("corpus_files", String(docs.length));
  store.setMeta("truncated_files", JSON.stringify(docs.filter((d) => d.truncated).map((d) => d.file_id)));

  const expectedLines = docs.reduce((a, d) => a + d.lines, 0);
  return {
    ok: errors.length === 0,
    documents: docs,
    fragments_written: fragmentsWritten,
    lines_seen: linesSeen,
    coverage_ok: fragmentsWritten === expectedLines && linesSeen === expectedLines,
    strategies: strategies.length,
    executable_specs: compiled.filter((c) => c.executable).length,
    setups: setups.length,
    rules: rules.length,
    machine_rules: machineRules.length,
    claims: dedupClaims.length,
    conflicts: conflicts.length,
    unknown_fragments: unknownFragments,
    quarantined,
    primitives: primitives.length,
    features: features.length,
    risk_policies: riskPolicies.length,
    psychology_policies: psychPolicies.length,
    errors,
    duration_ms: Date.now() - started,
  };
}

function normalizeName(n: string): string {
  return n.toLowerCase().replace(/[\s\u200c()[\]«».,:؛-]/g, "").trim();
}

/** Pull a quantitative hint like "۹۰ درصد" / "60/40" out of a claim line. */
function extractQuantHint(t: string): string | null {
  const m = t.match(/(\d{1,3}\s*\/\s*\d{1,3})|([۰-۹\d]{1,3}\s*(?:درصد|%))/);
  return m ? m[0].trim() : null;
}
