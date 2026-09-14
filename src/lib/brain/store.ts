/**
 * Brain persistence — a SEPARATE SQLite database from the runtime store.
 *
 * Why separate: the corpus and its canonical derivatives are immutable
 * knowledge with provenance; `asa.db` holds mutable runtime state (signals,
 * outbox, news). Keeping them apart means a runtime wipe can never destroy
 * provenance, and the brain can be shipped/inspected on its own.
 *
 * Writes go through `ingest*` functions only. Everything read back carries
 * source refs so the UI can always answer "where did this come from?".
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ASA_BRAIN_DB_PATH } from "../env";
import type {
  BrainStats,
  ClaimRecord,
  ConflictGroup,
  FeatureSpec,
  KnowledgeItem,
  Primitive,
  PsychologyPolicy,
  RiskPolicy,
  RuleSpec,
  SetupSpec,
  SourceDocument,
  SourceFragment,
  StrategyRecord,
} from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source_documents (
  file_id TEXT PRIMARY KEY, filename TEXT NOT NULL, source_hash TEXT NOT NULL,
  source_version TEXT NOT NULL, immutable INTEGER NOT NULL DEFAULT 1,
  total_lines INTEGER NOT NULL, total_chars INTEGER NOT NULL,
  ingestion_timestamp INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0, truncation_note TEXT
);
CREATE TABLE IF NOT EXISTS source_fragments (
  fragment_id TEXT PRIMARY KEY, file_id TEXT NOT NULL,
  start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  raw_text TEXT NOT NULL, topic_tags TEXT NOT NULL DEFAULT '[]',
  fragment_class TEXT NOT NULL, quarantined INTEGER NOT NULL DEFAULT 0,
  quarantine_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_frag_file ON source_fragments(file_id, start_line);
CREATE INDEX IF NOT EXISTS idx_frag_class ON source_fragments(fragment_class);
CREATE TABLE IF NOT EXISTS knowledge_items (
  knowledge_id TEXT PRIMARY KEY, type TEXT NOT NULL, canonical_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', source_refs TEXT NOT NULL DEFAULT '[]',
  source_status TEXT NOT NULL, empirical_status TEXT NOT NULL,
  runtime_status TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0,
  conflict_group_id TEXT, claim_group_id TEXT,
  unknown_fields TEXT NOT NULL DEFAULT '[]', external_notes TEXT NOT NULL DEFAULT '[]',
  aliases TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS primitives (
  primitive_id TEXT PRIMARY KEY, kind TEXT NOT NULL, canonical_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', aliases TEXT NOT NULL DEFAULT '[]',
  source_refs TEXT NOT NULL DEFAULT '[]', source_status TEXT NOT NULL,
  detector TEXT, availability TEXT NOT NULL, unavailable_reason TEXT
);
CREATE TABLE IF NOT EXISTS features (
  feature_id TEXT PRIMARY KEY, primitive_id TEXT NOT NULL, canonical_name TEXT NOT NULL,
  formula TEXT NOT NULL, inputs TEXT NOT NULL DEFAULT '[]',
  timeframes TEXT NOT NULL DEFAULT '[]', lookback INTEGER,
  data_quality TEXT NOT NULL DEFAULT '{}', edge_cases TEXT NOT NULL DEFAULT '[]',
  availability TEXT NOT NULL, unavailable_reason TEXT,
  source_refs TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS rules (
  rule_id TEXT PRIMARY KEY, description TEXT NOT NULL,
  predicates TEXT NOT NULL DEFAULT '[]', required_features TEXT NOT NULL DEFAULT '[]',
  direction TEXT NOT NULL, timeframe TEXT, confirmation TEXT NOT NULL DEFAULT '[]',
  invalidation TEXT NOT NULL DEFAULT '[]', source_refs TEXT NOT NULL DEFAULT '[]',
  missing_fields TEXT NOT NULL DEFAULT '[]', source_status TEXT NOT NULL,
  empirical_status TEXT NOT NULL, runtime_status TEXT NOT NULL,
  rule_class TEXT NOT NULL DEFAULT 'UNFORMALIZED_RULE',
  non_executable_reason TEXT,
  binding TEXT
);
CREATE TABLE IF NOT EXISTS setups (
  setup_id TEXT PRIMARY KEY, family TEXT NOT NULL,
  prerequisites TEXT NOT NULL DEFAULT '[]', trigger_rules TEXT NOT NULL DEFAULT '[]',
  confirmation TEXT NOT NULL DEFAULT '[]', invalidation TEXT NOT NULL DEFAULT '[]',
  entry_model TEXT, stop_model TEXT, target_model TEXT,
  scoring_weights TEXT NOT NULL DEFAULT '{}', source_refs TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS strategies (
  strategy_id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, family TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]', type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', source_refs TEXT NOT NULL DEFAULT '[]',
  source_status TEXT NOT NULL, empirical_status TEXT NOT NULL, runtime_status TEXT NOT NULL,
  unknown_critical TEXT NOT NULL DEFAULT '[]', conflict_group_id TEXT,
  setup_ids TEXT NOT NULL DEFAULT '[]', rule_ids TEXT NOT NULL DEFAULT '[]',
  implementation TEXT, version TEXT NOT NULL DEFAULT '1.0.0', disabled_reason TEXT
);
CREATE TABLE IF NOT EXISTS risk_policies (
  policy_id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL,
  risk_per_trade_pct REAL, daily_loss_limit_pct REAL, max_account_risk_pct REAL,
  period_loss_limit_pct REAL, max_leverage REAL, max_concurrent_positions INTEGER,
  source_refs TEXT NOT NULL DEFAULT '[]', source_status TEXT NOT NULL,
  conflict_group_id TEXT, runtime_status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS psychology_policies (
  policy_id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, description TEXT NOT NULL,
  effect TEXT NOT NULL, score_penalty REAL NOT NULL DEFAULT 0,
  trigger_condition TEXT NOT NULL DEFAULT '', source_refs TEXT NOT NULL DEFAULT '[]',
  source_status TEXT NOT NULL, runtime_status TEXT NOT NULL,
  user_overridable INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conflict_groups (
  conflict_group_id TEXT PRIMARY KEY, topic TEXT NOT NULL,
  variants TEXT NOT NULL DEFAULT '[]', resolution TEXT NOT NULL DEFAULT 'UNRESOLVED',
  chosen_variant TEXT, resolved_by TEXT, resolved_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY, statement TEXT NOT NULL, quantitative_hint TEXT,
  source_refs TEXT NOT NULL DEFAULT '[]', empirical_status TEXT NOT NULL,
  test_result TEXT
);
CREATE TABLE IF NOT EXISTS brain_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

const J = (v: unknown): string => JSON.stringify(v ?? null);
const P = <T>(s: string | null | undefined, fb: T): T => {
  if (!s) return fb;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fb;
  }
};

export class BrainStore {
  private db: Database.Database;

  constructor(filePath: string = ASA_BRAIN_DB_PATH) {
    if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Additive migrations for brain DBs created before a schema change.
   * The brain DB is rebuildable (`npm run brain:ingest`), so migrations only
   * ever ADD optional columns — never rewrite stored provenance.
   */
  private migrate(): void {
    const cols = this.db.prepare("PRAGMA table_info(rules)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "binding")) {
      this.db.exec("ALTER TABLE rules ADD COLUMN binding TEXT");
    }
  }

  meta(k: string): string | null {
    const r = this.db.prepare("SELECT v FROM brain_meta WHERE k=?").get(k) as { v: string } | undefined;
    return r?.v ?? null;
  }
  setMeta(k: string, v: string): void {
    this.db.prepare("INSERT INTO brain_meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
  }

  /** Reset knowledge tables. The RAW corpus itself is never mutated on disk. */
  resetKnowledge(): void {
    for (const t of [
      "source_documents", "source_fragments", "knowledge_items", "primitives", "features",
      "rules", "setups", "strategies", "risk_policies", "psychology_policies",
      "conflict_groups", "claims",
    ]) {
      this.db.exec(`DELETE FROM ${t}`);
    }
  }

  putDocument(d: SourceDocument): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO source_documents
       (file_id,filename,source_hash,source_version,immutable,total_lines,total_chars,ingestion_timestamp,truncated,truncation_note)
       VALUES (?,?,?,?,1,?,?,?,?,?)`,
    ).run(d.file_id, d.filename, d.source_hash, d.source_version, d.total_lines, d.total_chars,
      d.ingestion_timestamp, d.truncated ? 1 : 0, d.truncation_note);
  }

  putFragments(rows: SourceFragment[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO source_fragments
       (fragment_id,file_id,start_line,end_line,raw_text,topic_tags,fragment_class,quarantined,quarantine_reason)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    this.db.transaction((list: SourceFragment[]) => {
      for (const f of list) {
        st.run(f.fragment_id, f.file_id, f.start_line, f.end_line, f.raw_text,
          J(f.topic_tags), f.fragment_class, f.quarantined ? 1 : 0, f.quarantine_reason);
      }
    })(rows);
  }

  putKnowledge(rows: KnowledgeItem[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO knowledge_items
       (knowledge_id,type,canonical_name,description,source_refs,source_status,empirical_status,
        runtime_status,confidence,conflict_group_id,claim_group_id,unknown_fields,external_notes,aliases)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.transaction((list: KnowledgeItem[]) => {
      for (const k of list) {
        st.run(k.knowledge_id, k.type, k.canonical_name, k.description, J(k.source_refs),
          k.source_status, k.empirical_status, k.runtime_status, k.confidence,
          k.conflict_group_id, k.claim_group_id, J(k.unknown_fields), J(k.external_notes), J(k.aliases));
      }
    })(rows);
  }

  putPrimitives(rows: Primitive[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO primitives
       (primitive_id,kind,canonical_name,description,aliases,source_refs,source_status,detector,availability,unavailable_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.transaction((l: Primitive[]) => {
      for (const p of l) st.run(p.primitive_id, p.kind, p.canonical_name, p.description, J(p.aliases),
        J(p.source_refs), p.source_status, p.detector, p.availability, p.unavailable_reason);
    })(rows);
  }

  putFeatures(rows: FeatureSpec[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO features
       (feature_id,primitive_id,canonical_name,formula,inputs,timeframes,lookback,data_quality,edge_cases,availability,unavailable_reason,source_refs)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.transaction((l: FeatureSpec[]) => {
      for (const f of l) st.run(f.feature_id, f.primitive_id, f.canonical_name, f.formula, J(f.inputs),
        J(f.timeframes), f.lookback, J(f.data_quality), J(f.edge_cases), f.availability,
        f.unavailable_reason, J(f.source_refs));
    })(rows);
  }

  putRules(rows: RuleSpec[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO rules
       (rule_id,description,predicates,required_features,direction,timeframe,confirmation,invalidation,source_refs,missing_fields,source_status,empirical_status,runtime_status,rule_class,non_executable_reason,binding)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.transaction((l: RuleSpec[]) => {
      for (const r of l) st.run(r.rule_id, r.description, J(r.predicates), J(r.required_features),
        r.direction, r.timeframe, J(r.confirmation), J(r.invalidation), J(r.source_refs),
        J(r.missing_fields), r.source_status, r.empirical_status, r.runtime_status,
        r.rule_class ?? "UNFORMALIZED_RULE", r.non_executable_reason ?? null,
        r.binding ? J(r.binding) : null);
    })(rows);
  }

  /**
   * Full rule registry read-back (rule-graph closure). Every row carries its
   * governance class and binding so a caller can separate machine-executable
   * rules from source-text rules without re-deriving anything.
   */
  rules(): RuleSpec[] {
    const rows = this.db.prepare("SELECT * FROM rules ORDER BY rule_id").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      rule_id: String(r.rule_id),
      rule_class: String(r.rule_class ?? "UNFORMALIZED_RULE") as RuleSpec["rule_class"],
      non_executable_reason: (r.non_executable_reason as string) ?? null,
      binding: r.binding ? (JSON.parse(r.binding as string) as RuleSpec["binding"]) : null,
      description: String(r.description),
      predicates: P(r.predicates as string, [] as string[]),
      required_features: P(r.required_features as string, [] as string[]),
      direction: String(r.direction) as RuleSpec["direction"],
      timeframe: (r.timeframe as string) ?? null,
      confirmation: P(r.confirmation as string, [] as string[]),
      invalidation: P(r.invalidation as string, [] as string[]),
      source_refs: P(r.source_refs as string, []),
      missing_fields: P(r.missing_fields as string, [] as string[]),
      source_status: String(r.source_status) as RuleSpec["source_status"],
      empirical_status: String(r.empirical_status) as RuleSpec["empirical_status"],
      runtime_status: String(r.runtime_status) as RuleSpec["runtime_status"],
    }));
  }

  putSetups(rows: SetupSpec[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO setups
       (setup_id,family,prerequisites,trigger_rules,confirmation,invalidation,entry_model,stop_model,target_model,scoring_weights,source_refs)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.transaction((l: SetupSpec[]) => {
      for (const s of l) st.run(s.setup_id, s.family, J(s.prerequisites), J(s.trigger), J(s.confirmation),
        J(s.invalidation), s.entry_model, s.stop_model, s.target_model, J(s.scoring_weights), J(s.source_refs));
    })(rows);
  }

  putStrategies(rows: StrategyRecord[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO strategies
       (strategy_id,canonical_name,family,aliases,type,description,source_refs,source_status,empirical_status,runtime_status,unknown_critical,conflict_group_id,setup_ids,rule_ids,implementation,version,disabled_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.transaction((l: StrategyRecord[]) => {
      for (const s of l) st.run(s.strategy_id, s.canonical_name, s.family, J(s.aliases), s.type,
        s.description, J(s.source_refs), s.source_status, s.empirical_status, s.runtime_status,
        J(s.unknown_critical), s.conflict_group_id, J(s.setup_ids), J(s.rule_ids),
        s.implementation, s.version, s.disabled_reason);
    })(rows);
  }

  putRiskPolicies(rows: RiskPolicy[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO risk_policies
       (policy_id,canonical_name,risk_per_trade_pct,daily_loss_limit_pct,max_account_risk_pct,period_loss_limit_pct,max_leverage,max_concurrent_positions,source_refs,source_status,conflict_group_id,runtime_status,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.transaction((l: RiskPolicy[]) => {
      for (const p of l) st.run(p.policy_id, p.canonical_name, p.risk_per_trade_pct, p.daily_loss_limit_pct,
        p.max_account_risk_pct, p.period_loss_limit_pct, p.max_leverage, p.max_concurrent_positions,
        J(p.source_refs), p.source_status, p.conflict_group_id, p.runtime_status, p.notes);
    })(rows);
  }

  putPsychologyPolicies(rows: PsychologyPolicy[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO psychology_policies
       (policy_id,canonical_name,description,effect,score_penalty,trigger_condition,source_refs,source_status,runtime_status,user_overridable)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    this.db.transaction((l: PsychologyPolicy[]) => {
      for (const p of l) st.run(p.policy_id, p.canonical_name, p.description, p.effect, p.score_penalty,
        p.trigger_condition, J(p.source_refs), p.source_status, p.runtime_status, p.user_overridable ? 1 : 0);
    })(rows);
  }

  putConflicts(rows: ConflictGroup[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO conflict_groups (conflict_group_id,topic,variants,resolution,chosen_variant,resolved_by,resolved_at_ms)
       VALUES (?,?,?,?,?,?,?)`,
    );
    this.db.transaction((l: ConflictGroup[]) => {
      for (const c of l) st.run(c.conflict_group_id, c.topic, J(c.variants), c.resolution,
        c.chosen_variant, c.resolved_by, c.resolved_at_ms);
    })(rows);
  }

  putClaims(rows: ClaimRecord[]): void {
    const st = this.db.prepare(
      `INSERT OR REPLACE INTO claims (claim_id,statement,quantitative_hint,source_refs,empirical_status,test_result)
       VALUES (?,?,?,?,?,?)`,
    );
    this.db.transaction((l: ClaimRecord[]) => {
      for (const c of l) st.run(c.claim_id, c.statement, c.quantitative_hint, J(c.source_refs),
        c.empirical_status, c.test_result);
    })(rows);
  }

  /* ------------------------------------------------------------- readers */

  documents(): SourceDocument[] {
    const rows = this.db.prepare("SELECT * FROM source_documents ORDER BY file_id").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      file_id: String(r.file_id), filename: String(r.filename), source_hash: String(r.source_hash),
      source_version: String(r.source_version), immutable: true as const,
      total_lines: Number(r.total_lines), total_chars: Number(r.total_chars),
      ingestion_timestamp: Number(r.ingestion_timestamp),
      truncated: Number(r.truncated) === 1, truncation_note: (r.truncation_note as string) ?? null,
    }));
  }

  strategies(): StrategyRecord[] {
    const rows = this.db.prepare("SELECT * FROM strategies ORDER BY strategy_id").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      strategy_id: String(r.strategy_id), canonical_name: String(r.canonical_name),
      family: String(r.family) as StrategyRecord["family"], aliases: P(r.aliases as string, [] as string[]),
      type: String(r.type), description: String(r.description),
      source_refs: P(r.source_refs as string, []), source_status: String(r.source_status) as StrategyRecord["source_status"],
      empirical_status: String(r.empirical_status) as StrategyRecord["empirical_status"],
      runtime_status: String(r.runtime_status) as StrategyRecord["runtime_status"],
      unknown_critical: P(r.unknown_critical as string, []), conflict_group_id: (r.conflict_group_id as string) ?? null,
      setup_ids: P(r.setup_ids as string, []), rule_ids: P(r.rule_ids as string, []),
      implementation: (r.implementation as string) ?? null, version: String(r.version),
      disabled_reason: (r.disabled_reason as string) ?? null,
    }));
  }

  strategy(id: string): StrategyRecord | null {
    return this.strategies().find((s) => s.strategy_id === id) ?? null;
  }

  riskPolicies(): RiskPolicy[] {
    const rows = this.db.prepare("SELECT * FROM risk_policies ORDER BY policy_id").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      policy_id: String(r.policy_id), canonical_name: String(r.canonical_name),
      risk_per_trade_pct: r.risk_per_trade_pct as number | null,
      daily_loss_limit_pct: r.daily_loss_limit_pct as number | null,
      max_account_risk_pct: r.max_account_risk_pct as number | null,
      period_loss_limit_pct: r.period_loss_limit_pct as number | null,
      max_leverage: r.max_leverage as number | null,
      max_concurrent_positions: r.max_concurrent_positions as number | null,
      source_refs: P(r.source_refs as string, []), source_status: String(r.source_status) as RiskPolicy["source_status"],
      conflict_group_id: (r.conflict_group_id as string) ?? null,
      runtime_status: String(r.runtime_status) as RiskPolicy["runtime_status"], notes: String(r.notes),
    }));
  }

  psychologyPolicies(): PsychologyPolicy[] {
    const rows = this.db.prepare("SELECT * FROM psychology_policies ORDER BY policy_id").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      policy_id: String(r.policy_id), canonical_name: String(r.canonical_name),
      description: String(r.description), effect: String(r.effect) as PsychologyPolicy["effect"],
      score_penalty: Number(r.score_penalty), trigger_condition: String(r.trigger_condition),
      source_refs: P(r.source_refs as string, []), source_status: String(r.source_status) as PsychologyPolicy["source_status"],
      runtime_status: String(r.runtime_status) as PsychologyPolicy["runtime_status"],
      user_overridable: Number(r.user_overridable) === 1,
    }));
  }

  conflicts(): ConflictGroup[] {
    const rows = this.db.prepare("SELECT * FROM conflict_groups ORDER BY conflict_group_id").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      conflict_group_id: String(r.conflict_group_id), topic: String(r.topic),
      variants: P(r.variants as string, []), resolution: String(r.resolution) as ConflictGroup["resolution"],
      chosen_variant: (r.chosen_variant as string) ?? null, resolved_by: (r.resolved_by as string) ?? null,
      resolved_at_ms: (r.resolved_at_ms as number) ?? null,
    }));
  }

  primitives(): Primitive[] {
    const rows = this.db.prepare("SELECT * FROM primitives ORDER BY primitive_id").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      primitive_id: String(r.primitive_id), kind: String(r.kind) as Primitive["kind"],
      canonical_name: String(r.canonical_name), description: String(r.description),
      aliases: P(r.aliases as string, []), source_refs: P(r.source_refs as string, []),
      source_status: String(r.source_status) as Primitive["source_status"],
      detector: (r.detector as string) ?? null, availability: String(r.availability) as Primitive["availability"],
      unavailable_reason: (r.unavailable_reason as string) ?? null,
    }));
  }

  features(): FeatureSpec[] {
    const rows = this.db.prepare("SELECT * FROM features ORDER BY feature_id").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      feature_id: String(r.feature_id), primitive_id: String(r.primitive_id),
      canonical_name: String(r.canonical_name), formula: String(r.formula),
      inputs: P(r.inputs as string, []), timeframes: P(r.timeframes as string, []),
      lookback: (r.lookback as number) ?? null, data_quality: P(r.data_quality as string, { min_bars: 0, max_staleness_ms: null }),
      edge_cases: P(r.edge_cases as string, []), availability: String(r.availability) as FeatureSpec["availability"],
      unavailable_reason: (r.unavailable_reason as string) ?? null, source_refs: P(r.source_refs as string, []),
    }));
  }

  claims(limit = 500): ClaimRecord[] {
    const rows = this.db.prepare("SELECT * FROM claims ORDER BY claim_id LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      claim_id: String(r.claim_id), statement: String(r.statement),
      quantitative_hint: (r.quantitative_hint as string) ?? null,
      source_refs: P(r.source_refs as string, []),
      empirical_status: String(r.empirical_status) as ClaimRecord["empirical_status"],
      test_result: (r.test_result as string) ?? null,
    }));
  }

  /** Fragments for a file/line window — powers "show me the source" in the UI. */
  fragmentsFor(file: string, line: number, radius = 2): SourceFragment[] {
    const rows = this.db.prepare(
      "SELECT * FROM source_fragments WHERE file_id=? AND start_line BETWEEN ? AND ? ORDER BY start_line",
    ).all(file, line - radius, line + radius) as Record<string, unknown>[];
    return rows.map((r) => ({
      fragment_id: String(r.fragment_id), file_id: String(r.file_id),
      start_line: Number(r.start_line), end_line: Number(r.end_line), raw_text: String(r.raw_text),
      topic_tags: P(r.topic_tags as string, []), fragment_class: String(r.fragment_class) as SourceFragment["fragment_class"],
      quarantined: Number(r.quarantined) === 1, quarantine_reason: (r.quarantine_reason as string) ?? null,
    }));
  }

  searchFragments(q: string, limit = 50): SourceFragment[] {
    const rows = this.db.prepare(
      "SELECT * FROM source_fragments WHERE raw_text LIKE ? ORDER BY file_id, start_line LIMIT ?",
    ).all(`%${q}%`, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      fragment_id: String(r.fragment_id), file_id: String(r.file_id),
      start_line: Number(r.start_line), end_line: Number(r.end_line), raw_text: String(r.raw_text),
      topic_tags: P(r.topic_tags as string, []), fragment_class: String(r.fragment_class) as SourceFragment["fragment_class"],
      quarantined: Number(r.quarantined) === 1, quarantine_reason: (r.quarantine_reason as string) ?? null,
    }));
  }

  /** Governance breakdown of stored rules (remediation P1). */
  ruleClassCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT rule_class k, COUNT(*) n FROM rules GROUP BY 1 ORDER BY n DESC").all() as { k: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.k, r.n]));
  }

  ruleSourceStatusCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT source_status k, COUNT(*) n FROM rules GROUP BY 1 ORDER BY n DESC").all() as { k: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.k, r.n]));
  }

  private count(table: string, where = ""): number {
    return (this.db.prepare(`SELECT COUNT(*) c FROM ${table} ${where}`).get() as { c: number }).c;
  }

  stats(): BrainStats {
    return {
      documents: this.count("source_documents"),
      fragments: this.count("source_fragments"),
      knowledge_items: this.count("knowledge_items"),
      primitives: this.count("primitives"),
      features: this.count("features"),
      rules: this.count("rules"),
      setups: this.count("setups"),
      strategies: this.count("strategies"),
      risk_policies: this.count("risk_policies"),
      psychology_policies: this.count("psychology_policies"),
      conflicts: this.count("conflict_groups"),
      claims: this.count("claims"),
      unknowns: this.count("source_fragments", "WHERE fragment_class='UNKNOWN_MARKER'"),
      quarantined: this.count("source_fragments", "WHERE quarantined=1"),
    };
  }

  close(): void {
    this.db.close();
  }
}

let inst: BrainStore | null = null;
export function getBrain(): BrainStore {
  if (!inst) inst = new BrainStore();
  return inst;
}
export function closeBrain(): void {
  inst?.close();
  inst = null;
}
