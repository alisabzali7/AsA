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
import { CORPUS_FILES, CANONICAL_PACK_FILE, CANONICAL_PACK_SHA256, CANONICAL_PACK_BYTES } from "./corpus-manifest";
import { buildPrimitives, buildFeatures } from "./primitives";
import { buildRiskPolicies, buildPsychologyPolicies, buildConflictGroups } from "./policies";
import { canonicalFamilyFor } from "./ontology";
import { ingestUserPsychologySources, verifyUserPsychologySources } from "../psychology/user-source";
import {
  buildMachineRuleGraph, compiledImplementationBinding, machineRuleRegistryRows, nodesByStrategy,
} from "../strategy/rule-graph";
import type {
  ClaimRecord, ConflictGroup, ConflictHistoryRecord, KnowledgeItem, RuleSpec, SourceDocument, SourceFragment, SourceRef, StrategyRecord,
} from "./types";

export interface IngestReport {
  ok: boolean;
  documents: { file_id: string; lines: number; chars: number; bytes: number; sha256: string; truncated: boolean }[];
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
  version?: string;
  source_files?: { file: string; sha256: string; lines: number; chars: number }[];
  counts?: Record<string, number>;
  strategy_registry?: PackStrategy[];
  rule_registry?: PackRule[];
  uncertainty_registry?: Record<string, { file: string; line: number; text: string }[]>;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function corpusManifestSha256(integrity: CorpusIntegrityReport): string {
  return sha256(Buffer.from(JSON.stringify({
    documents: [...integrity.documents].sort((a, b) => a.file_id.localeCompare(b.file_id)),
    canonical_pack: integrity.canonical_pack,
  }), "utf8"));
}

function conflictHistoryId(group: ConflictGroup, manifestSha: string | null): string {
  return `CFH-${sha256(Buffer.from(JSON.stringify({
    manifestSha,
    conflict_group_id: group.conflict_group_id,
    topic: group.topic,
    variants: group.variants,
    resolution: group.resolution,
    chosen_variant: group.chosen_variant,
    resolved_by: group.resolved_by,
    resolved_at_ms: group.resolved_at_ms,
  }), "utf8")).slice(0, 32)}`;
}

function sameConflictSourceShape(a: ConflictGroup, b: ConflictGroup): boolean {
  return a.conflict_group_id === b.conflict_group_id && a.topic === b.topic && JSON.stringify(a.variants) === JSON.stringify(b.variants);
}

export interface CorpusIntegrityReport {
  ok: boolean;
  documents: { file_id: string; filename: string; lines: number; chars: number; bytes: number; sha256: string }[];
  canonical_pack: { filename: string; bytes: number; sha256: string } | null;
  errors: string[];
}

/** Verify the immutable inputs before any destructive database refresh. */
export function verifyCorpusIntegrity(corpusDir = ASA_CORPUS_DIR): CorpusIntegrityReport {
  const errors: string[] = [];
  const documents: CorpusIntegrityReport["documents"] = [];
  const byId = new Map<string, CorpusIntegrityReport["documents"][number]>();
  for (const cf of CORPUS_FILES) {
    const full = path.join(corpusDir, cf.filename);
    if (!fs.existsSync(full)) {
      errors.push(`MISSING corpus file: ${full}`);
      continue;
    }
    const bytes = fs.readFileSync(full);
    const text = bytes.toString("utf8");
    const lines = text.split("\n");
    const actual = { file_id: cf.file_id, filename: cf.filename, lines: lines.length, chars: text.length, bytes: bytes.byteLength, sha256: sha256(bytes) };
    documents.push(actual);
    byId.set(cf.file_id, actual);
    for (const [field, value, expected] of [
      ["sha256", actual.sha256, cf.expected_sha256],
      ["lines", actual.lines, cf.expected_lines],
      ["chars", actual.chars, cf.expected_chars],
      ["bytes", actual.bytes, cf.expected_bytes],
    ] as const) {
      if (value !== expected) errors.push(`${cf.filename} ${field} mismatch: expected ${expected}, got ${value}`);
    }
    if (cf.known_truncated !== (cf.completeness === "TRUNCATED")) {
      errors.push(`${cf.filename} completeness/known_truncated manifest fields disagree`);
    }
  }

  const packPath = path.resolve(corpusDir, CANONICAL_PACK_FILE);
  let canonicalPack: CorpusIntegrityReport["canonical_pack"] = null;
  if (!fs.existsSync(packPath)) {
    errors.push(`canonical knowledge pack missing: ${packPath}`);
  } else {
    const bytes = fs.readFileSync(packPath);
    const digest = sha256(bytes);
    canonicalPack = { filename: path.basename(packPath), bytes: bytes.byteLength, sha256: digest };
    if (digest !== CANONICAL_PACK_SHA256) errors.push(`canonical pack sha256 mismatch: expected ${CANONICAL_PACK_SHA256}, got ${digest}`);
    if (bytes.byteLength !== CANONICAL_PACK_BYTES) errors.push(`canonical pack byte size mismatch: expected ${CANONICAL_PACK_BYTES}, got ${bytes.byteLength}`);
    try {
      const pack = JSON.parse(bytes.toString("utf8")) as Pack;
      const packSources = new Map((pack.source_files ?? []).map((s) => [s.file, s]));
      if (packSources.size !== CORPUS_FILES.length) errors.push(`canonical pack source_files count mismatch: expected ${CORPUS_FILES.length}, got ${packSources.size}`);
      for (const cf of CORPUS_FILES) {
        const raw = byId.get(cf.file_id);
        const source = packSources.get(cf.file_id);
        if (!source) { errors.push(`canonical pack has no source_files identity for ${cf.file_id}`); continue; }
        if (raw && (source.sha256 !== raw.sha256 || source.lines !== raw.lines || source.chars !== raw.chars)) {
          errors.push(`canonical pack identity mismatch for ${cf.file_id}`);
        }
      }
      if (!Array.isArray(pack.strategy_registry) || !Array.isArray(pack.rule_registry) || !pack.uncertainty_registry) {
        errors.push("canonical pack is missing required strategy/rule/uncertainty registries");
      }
    } catch (err) {
      errors.push(`canonical pack unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: errors.length === 0, documents, canonical_pack: canonicalPack, errors };
}

function emptyIngestReport(started: number, integrity: CorpusIntegrityReport): IngestReport {
  return {
    ok: false, documents: integrity.documents.map((d) => ({ file_id: d.file_id, lines: d.lines, chars: d.chars, bytes: d.bytes, sha256: d.sha256, truncated: CORPUS_FILES.find((cf) => cf.file_id === d.file_id)?.known_truncated ?? false })),
    fragments_written: 0, lines_seen: 0, coverage_ok: false, strategies: 0, executable_specs: 0, setups: 0,
    rules: 0, machine_rules: 0, claims: 0, conflicts: 0, unknown_fragments: 0, quarantined: 0, primitives: 0,
    features: 0, risk_policies: 0, psychology_policies: 0, errors: integrity.errors, duration_ms: Date.now() - started,
  };
}

export function ingestCorpus(store: BrainStore, corpusDir = ASA_CORPUS_DIR): IngestReport {
  const started = Date.now();
  const errors: string[] = [];
  const docs: IngestReport["documents"] = [];
  let fragmentsWritten = 0;
  let linesSeen = 0;
  let unknownFragments = 0;
  let quarantined = 0;

  const integrity = verifyCorpusIntegrity(corpusDir);
  if (!integrity.ok) return emptyIngestReport(started, integrity);
  const currentManifestSha = corpusManifestSha256(integrity);

  try {
    return store.transaction(() => {
  // Snapshot EVERY current conflict state before rebuilding, including open
  // groups. Adjudications are only re-applied to byte-identical corpus
  // manifests and identical conflict variants; otherwise the old state stays
  // in history and the rebuilt group remains UNRESOLVED.
  const priorGroups = store.conflicts();
  const priorManifestSha = store.meta("source_manifest_sha256");
  const historyAt = Date.now();
  const historyRows: ConflictHistoryRecord[] = priorGroups.map((group) => ({
    ...group,
    history_id: conflictHistoryId(group, priorManifestSha),
    prior_source_manifest_sha256: priorManifestSha,
    lifecycle: "ACTIVE",
    replaced_by: null,
    recorded_at_ms: historyAt,
  }));
  store.recordConflictHistory(historyRows);
  const historyByGroup = new Map(historyRows.map((row) => [row.conflict_group_id, row]));
  const priorByGroup = new Map(priorGroups.map((group) => [group.conflict_group_id, group]));

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

    // Completeness comes only from the identity-bound source manifest. File
    // size and terminal punctuation do not upgrade UNKNOWN or establish why a
    // supplied source ends where it does.
    const truncated = cf.completeness === "TRUNCATED";
    const doc: SourceDocument = {
      file_id: cf.file_id,
      filename: cf.filename,
      source_hash: hash,
      source_version: "v1-as-supplied",
      immutable: true,
      total_lines: lines.length,
      total_chars: chars,
      total_bytes: buf.byteLength,
      ingestion_timestamp: Date.now(),
      truncated,
      truncation_note: truncated
        ? `source manifest marks these supplied bytes TRUNCATED; cutoff cause and continuation location are not established, and continuation is not reconstructed`
        : null,
    };
    store.putDocument(doc);
    docs.push({ file_id: cf.file_id, lines: lines.length, chars, bytes: buf.byteLength, sha256: hash, truncated });

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
  if (errors.length > 0) throw new Error(errors.join("; "));
  const suppliedLineCount = docs.reduce((total, document) => total + document.lines, 0);
  if (fragmentsWritten !== suppliedLineCount || linesSeen !== suppliedLineCount) {
    throw new Error(`corpus fragment coverage mismatch: expected ${suppliedLineCount}, fragments ${fragmentsWritten}, lines ${linesSeen}`);
  }

  /* ------------------------------------------- canonical pack acceleration */
  const packPath = path.resolve(corpusDir, CANONICAL_PACK_FILE);
  const pack = JSON.parse(fs.readFileSync(packPath, "utf8")) as Pack;

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
    const srcStatus = sourceStatusFromText(b.name);

    const existing = seenNames.get(key);
    if (existing) {
      // Strategy records are aggregates; their occurrence-level evidence is
      // retained separately and the summary status takes the most restrictive
      // status rather than whichever occurrence happened to be parsed first.
      existing.source_refs.push(...refs);
      existing.source_status = restrictiveSourceStatus(existing.source_status, srcStatus);
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
    const srcStatus = sourceStatusFromPack(ps.source_status);
    const existing = seenNames.get(key);
    if (existing) {
      for (const a of ps.aliases ?? []) if (!existing.aliases.includes(a)) existing.aliases.push(a);
      existing.source_refs.push(...refs);
      existing.source_status = restrictiveSourceStatus(existing.source_status, srcStatus);
      continue;
    }
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
              : marked(/\bINFERRED\b/) ? "SOURCE_INFERRED"
                : "SOURCE_NAMED"; // an unmarked source line is named, not inferred or verified
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
  const rebuiltIds = new Set(conflicts.map((group) => group.conflict_group_id));
  for (const prior of priorGroups) {
    const history = historyByGroup.get(prior.conflict_group_id);
    if (!history) continue;
    const current = conflicts.find((group) => group.conflict_group_id === prior.conflict_group_id);
    if (!current) {
      store.updateConflictHistoryLifecycle(history.history_id, "ORPHANED", null);
      continue;
    }
    if (priorManifestSha === currentManifestSha && sameConflictSourceShape(prior, current)) {
      current.resolution = prior.resolution;
      current.chosen_variant = prior.chosen_variant;
      current.resolved_by = prior.resolved_by;
      current.resolved_at_ms = prior.resolved_at_ms;
      store.updateConflictHistoryLifecycle(history.history_id, "ACTIVE", current.conflict_group_id);
    } else {
      store.updateConflictHistoryLifecycle(history.history_id, "REPLACED", current.conflict_group_id);
    }
  }
  // Keep `rebuiltIds` as an explicit completeness check for history transitions.
  for (const history of historyRows) {
    if (!rebuiltIds.has(history.conflict_group_id) && history.lifecycle === "ACTIVE") {
      store.updateConflictHistoryLifecycle(history.history_id, "ORPHANED", null);
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
  store.setMeta("source_manifest_sha256", currentManifestSha);
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return emptyIngestReport(started, {
      ...integrity,
      ok: false,
      errors: [...integrity.errors, `ingest transaction rolled back: ${message}`],
    });
  }
}

export type IngestFaultPoint = "after-corpus" | "after-psychology" | "before-manifest";

export interface SourceRecoveryIngestReport {
  ok: boolean;
  rolled_back: boolean;
  source_manifest_sha256: string | null;
  completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  corpus: IngestReport | null;
  psychology: ReturnType<typeof ingestUserPsychologySources> | null;
  errors: string[];
}

/**
 * Atomic source recovery entry point. Corpus, psychology fragments/principles,
 * conflict history and the persisted source manifest commit together or not at
 * all. The optional fault point exists for deterministic rollback tests only.
 */
export function ingestAllSources(store: BrainStore, options: {
  corpusDir?: string;
  psychologyDir?: string;
  faultAt?: IngestFaultPoint;
} = {}): SourceRecoveryIngestReport {
  const corpusDir = options.corpusDir ?? ASA_CORPUS_DIR;
  const psychologyDir = options.psychologyDir ?? path.join(process.cwd(), "knowledge", "psychology");
  const integrity = verifyCorpusIntegrity(corpusDir);
  let verifiedPsychology: ReturnType<typeof verifyUserPsychologySources>;
  try {
    verifiedPsychology = verifyUserPsychologySources(psychologyDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, rolled_back: false, source_manifest_sha256: null, completeness: "UNKNOWN", corpus: null, psychology: null, errors: [...integrity.errors, message] };
  }
  if (!integrity.ok) {
    return { ok: false, rolled_back: false, source_manifest_sha256: null, completeness: "UNKNOWN", corpus: emptyIngestReport(Date.now(), integrity), psychology: null, errors: integrity.errors };
  }

  let corpusReport: IngestReport | null = null;
  let psychologyReport: ReturnType<typeof ingestUserPsychologySources> | null = null;
  const rawManifestSha = corpusManifestSha256(integrity);
  const rawCompleteness = (doc: CorpusIntegrityReport["documents"][number]): "COMPLETE" | "TRUNCATED" | "UNKNOWN" => {
    // verifyCorpusIntegrity has already bound this row to the exact expected
    // hash/bytes/lines. Completeness remains the explicit manifest value; no
    // size or ending heuristic is used.
    return CORPUS_FILES.find((cf) => cf.file_id === doc.file_id)?.completeness ?? "UNKNOWN";
  };
  const rawSources = integrity.documents.map((doc) => {
    const completeness = rawCompleteness(doc);
    return {
      file_id: doc.file_id,
      filename: doc.filename,
      source_path: path.relative(process.cwd(), path.join(corpusDir, doc.filename)),
      sha256: doc.sha256,
      bytes: doc.bytes,
      lines: doc.lines,
      chars: doc.chars,
      truncated: completeness === "TRUNCATED",
      completeness,
    };
  });
  const psychologySources = verifiedPsychology.map((source) => ({
    file_id: source.file_id,
    filename: source.filename,
    original_filename: source.original_filename,
    source_path: path.relative(process.cwd(), path.join(psychologyDir, source.filename)),
    sha256: source.sha256,
    bytes: source.total_bytes,
    lines: source.total_lines,
    chars: source.total_chars,
    truncated: source.truncated,
    completeness: source.truncated ? "TRUNCATED" as const : "UNKNOWN" as const,
  }));
  const sourceCompleteness = [...rawSources, ...psychologySources].map((source) => source.completeness);
  const overallCompleteness: SourceRecoveryIngestReport["completeness"] = sourceCompleteness.some((status) => status === "TRUNCATED")
    ? "PARTIAL"
    : sourceCompleteness.every((status) => status === "COMPLETE")
      ? "COMPLETE"
      : "UNKNOWN";
  const manifest = {
    schema_version: "1.1.0",
    raw_corpus: rawSources,
    canonical_pack: integrity.canonical_pack
      ? { ...integrity.canonical_pack, role: "INDEX_ONLY" as const }
      : null,
    psychology_sources: psychologySources,
    completeness: overallCompleteness,
  };
  const recoveryManifestSha = sha256(Buffer.from(JSON.stringify(manifest), "utf8"));

  try {
    store.transaction(() => {
      corpusReport = ingestCorpus(store, corpusDir);
      if (!corpusReport.ok || !corpusReport.coverage_ok || corpusReport.documents.length !== CORPUS_FILES.length) {
        throw new Error(`corpus ingestion failed or coverage is incomplete: ${corpusReport.errors.join("; ") || "coverage mismatch"}`);
      }
      if (options.faultAt === "after-corpus") throw new Error("fault injection: after-corpus");

      psychologyReport = ingestUserPsychologySources(store, psychologyDir);
      if (!psychologyReport.ok || psychologyReport.fragments_written !== psychologyReport.lines_seen) {
        throw new Error("user psychology ingestion failed or line coverage is incomplete");
      }
      if (options.faultAt === "after-psychology") throw new Error("fault injection: after-psychology");
      if (options.faultAt === "before-manifest") throw new Error("fault injection: before-manifest");

      store.setMeta("source_recovery_manifest", JSON.stringify(manifest));
      store.setMeta("source_recovery_manifest_sha256", recoveryManifestSha);
      store.setMeta("source_recovery_manifest_status", manifest.completeness);
      store.setMeta("source_recovery_committed_at_ms", String(Date.now()));
      // Bind conflict adjudications to the raw/canonical source identity used
      // for their interpretation. The broader recovery manifest includes psych.
      store.setMeta("source_manifest_sha256", rawManifestSha);
    });
    return {
      ok: true,
      rolled_back: false,
      source_manifest_sha256: recoveryManifestSha,
      completeness: manifest.completeness,
      corpus: corpusReport,
      psychology: psychologyReport,
      errors: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      rolled_back: true,
      source_manifest_sha256: null,
      completeness: "UNKNOWN",
      corpus: null,
      psychology: null,
      errors: [message],
    };
  }
}

type SourceStatusValue = StrategyRecord["source_status"];

function sourceStatusFromText(text: string): SourceStatusValue {
  if (/\[CONFLICT\]|\bCONFLICTING?\b/i.test(text)) return "CONFLICT";
  if (/\[CLAIM\]|\bCLAIM\b/i.test(text)) return "CLAIM";
  if (/\bUNKNOWN\b/i.test(text)) return "UNKNOWN";
  if (/\[INFERRED\]|\bINFERRED\b/i.test(text)) return "SOURCE_INFERRED";
  if (/\[VERIFIED\]|\bVERIFIED\b/i.test(text)) return "SOURCE_VERIFIED";
  return "SOURCE_NAMED";
}

function sourceStatusFromPack(value: string): SourceStatusValue {
  if (value === "SOURCE_VERIFIED" || value === "SOURCE_INFERRED" || value === "SOURCE_NAMED" ||
      value === "UNKNOWN" || value === "CONFLICT" || value === "CLAIM") return value;
  return "SOURCE_NAMED";
}

function restrictiveSourceStatus(a: SourceStatusValue, b: SourceStatusValue): SourceStatusValue {
  const rank: Record<SourceStatusValue, number> = {
    SOURCE_VERIFIED: 0, SOURCE_INFERRED: 1, SOURCE_NAMED: 2, CLAIM: 3, UNKNOWN: 4, CONFLICT: 5,
  };
  return rank[a] >= rank[b] ? a : b;
}

function normalizeName(n: string): string {
  return n.toLowerCase().replace(/[\s\u200c()[\]«».,:؛-]/g, "").trim();
}

/** Pull a quantitative hint like "۹۰ درصد" / "60/40" out of a claim line. */
function extractQuantHint(t: string): string | null {
  const m = t.match(/(\d{1,3}\s*\/\s*\d{1,3})|([۰-۹\d]{1,3}\s*(?:درصد|%))/);
  return m ? m[0].trim() : null;
}
