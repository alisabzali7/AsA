/**
 * Deep-mining orchestrator (§B, §C, §D, §P).
 *
 * ADDITIVE ONLY: reads the already-ingested `source_fragments` and writes new
 * tables. The existing corpus, strategies, rules and provenance are untouched.
 */
import Database from "better-sqlite3";
import { ASA_BRAIN_DB_PATH } from "../../env";
import { mineAtom, type KnowledgeAtom } from "./atoms";
import {
  buildComponents, generateCandidates, GENERATION_VERSION,
  type StrategyCandidate, type StrategyComponent,
} from "./factory";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_atoms (
  atom_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, line INTEGER NOT NULL,
  text TEXT NOT NULL, kind TEXT NOT NULL, semantic_status TEXT NOT NULL,
  source_status TEXT NOT NULL, concepts TEXT NOT NULL DEFAULT '[]',
  quantities TEXT NOT NULL DEFAULT '[]', timeframes TEXT NOT NULL DEFAULT '[]',
  direction TEXT NOT NULL DEFAULT 'none', non_computable_reason TEXT,
  source_refs TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_atom_kind ON knowledge_atoms(kind);
CREATE INDEX IF NOT EXISTS idx_atom_sem ON knowledge_atoms(semantic_status);
CREATE TABLE IF NOT EXISTS strategy_components (
  component_id TEXT PRIMARY KEY, role TEXT NOT NULL, label TEXT NOT NULL,
  source_text TEXT NOT NULL, concepts TEXT NOT NULL DEFAULT '[]',
  timeframes TEXT NOT NULL DEFAULT '[]', direction TEXT NOT NULL,
  computable INTEGER NOT NULL DEFAULT 0, non_computable_reason TEXT,
  source_refs TEXT NOT NULL DEFAULT '[]', atom_ids TEXT NOT NULL DEFAULT '[]',
  occurrences INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS strategy_candidates (
  strategy_id TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL,
  component_ids TEXT NOT NULL DEFAULT '[]', components TEXT NOT NULL DEFAULT '{}',
  source_refs TEXT NOT NULL DEFAULT '[]', source_status TEXT NOT NULL,
  semantic_status TEXT NOT NULL, empirical_status TEXT NOT NULL,
  runtime_status TEXT NOT NULL, required_features TEXT NOT NULL DEFAULT '[]',
  required_concepts TEXT NOT NULL DEFAULT '[]', timeframes TEXT NOT NULL DEFAULT '[]',
  direction TEXT NOT NULL, entry_model TEXT, stop_model TEXT, target_model TEXT,
  invalidation_model TEXT, risk_dependencies TEXT NOT NULL DEFAULT '[]',
  psychology_dependencies TEXT NOT NULL DEFAULT '[]',
  missing_fields TEXT NOT NULL DEFAULT '[]', rationale TEXT NOT NULL DEFAULT '',
  disabled_reason TEXT, generation_method TEXT NOT NULL,
  generation_version TEXT NOT NULL, created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mining_runs (
  run_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, stats_json TEXT NOT NULL,
  generation_version TEXT NOT NULL
);
`;

export interface MiningStats {
  fragments_scanned: number;
  atoms_mined: number;
  atoms_by_kind: Record<string, number>;
  atoms_by_semantic: Record<string, number>;
  computable_atoms: number;
  concepts_seen: Record<string, number>;
  components_built: number;
  components_by_role: Record<string, number>;
  candidates_generated: number;
  candidates_by_runtime: Record<string, number>;
  combinations_considered: number;
  combinations_rejected: number;
  rejection_reasons: Record<string, number>;
  duration_ms: number;
}

const J = (v: unknown) => JSON.stringify(v ?? null);

export function runDeepMining(dbPath: string = ASA_BRAIN_DB_PATH): {
  stats: MiningStats;
  atoms: KnowledgeAtom[];
  components: StrategyComponent[];
  candidates: StrategyCandidate[];
} {
  const started = Date.now();
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  // read the EXISTING ingested corpus — never re-parse the raw files
  const frags = db.prepare(
    "SELECT file_id, start_line, raw_text, quarantined FROM source_fragments ORDER BY file_id, start_line",
  ).all() as { file_id: string; start_line: number; raw_text: string; quarantined: number }[];

  const atoms: KnowledgeAtom[] = [];
  for (const f of frags) {
    // quarantined meta-commentary can never become knowledge (governance)
    if (f.quarantined === 1) continue;
    const a = mineAtom(f.file_id, f.start_line, f.raw_text);
    if (a) atoms.push(a);
  }

  const components = buildComponents(atoms);
  const gen = generateCandidates(components);

  // ---- persist (rebuilt each run; the RAW corpus is never touched)
  db.exec("DELETE FROM knowledge_atoms; DELETE FROM strategy_components; DELETE FROM strategy_candidates;");

  const insA = db.prepare(
    `INSERT INTO knowledge_atoms (atom_id,file_id,line,text,kind,semantic_status,source_status,concepts,quantities,timeframes,direction,non_computable_reason,source_refs)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.transaction((list: KnowledgeAtom[]) => {
    for (const a of list) {
      insA.run(a.atom_id, a.file_id, a.line, a.text, a.kind, a.semantic_status, a.source_status,
        J(a.concepts), J(a.quantities), J(a.timeframes), a.direction, a.non_computable_reason, J(a.source_refs));
    }
  })(atoms);

  const insC = db.prepare(
    `INSERT INTO strategy_components (component_id,role,label,source_text,concepts,timeframes,direction,computable,non_computable_reason,source_refs,atom_ids,occurrences)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.transaction((list: StrategyComponent[]) => {
    for (const c of list) {
      insC.run(c.component_id, c.role, c.label, c.source_text, J(c.concepts), J(c.timeframes),
        c.direction, c.computable ? 1 : 0, c.non_computable_reason, J(c.source_refs), J(c.atom_ids), c.occurrences);
    }
  })(components);

  const insS = db.prepare(
    `INSERT INTO strategy_candidates (strategy_id,name,origin,component_ids,components,source_refs,source_status,semantic_status,empirical_status,runtime_status,required_features,required_concepts,timeframes,direction,entry_model,stop_model,target_model,invalidation_model,risk_dependencies,psychology_dependencies,missing_fields,rationale,disabled_reason,generation_method,generation_version,created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.transaction((list: StrategyCandidate[]) => {
    for (const s of list) {
      insS.run(s.strategy_id, s.name, s.origin, J(s.component_ids), J(s.components), J(s.source_refs),
        s.source_status, s.semantic_status, s.empirical_status, s.runtime_status, J(s.required_features),
        J(s.required_concepts), J(s.timeframes), s.direction, s.entry_model, s.stop_model, s.target_model,
        s.invalidation_model, J(s.risk_dependencies), J(s.psychology_dependencies), J(s.missing_fields),
        s.rationale, s.disabled_reason, s.generation_method, s.generation_version, Date.now());
    }
  })(gen.candidates);

  const count = <T extends string>(items: T[]): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const i of items) o[i] = (o[i] ?? 0) + 1;
    return o;
  };
  const conceptCounts = count(atoms.flatMap((a) => a.concepts));
  const topConcepts = Object.fromEntries(
    Object.entries(conceptCounts).sort((a, b) => b[1] - a[1]).slice(0, 25),
  );

  const stats: MiningStats = {
    fragments_scanned: frags.length,
    atoms_mined: atoms.length,
    atoms_by_kind: count(atoms.map((a) => a.kind)),
    atoms_by_semantic: count(atoms.map((a) => a.semantic_status)),
    computable_atoms: atoms.filter((a) => a.semantic_status === "EXPLICIT_COMPUTABLE").length,
    concepts_seen: topConcepts,
    components_built: components.length,
    components_by_role: count(components.map((c) => c.role)),
    candidates_generated: gen.candidates.length,
    candidates_by_runtime: count(gen.candidates.map((c) => c.runtime_status)),
    combinations_considered: gen.combinations_considered,
    combinations_rejected: gen.rejected.length,
    rejection_reasons: count(gen.rejected.flatMap((r) => r.reasons.map((x) => x.split(":")[0].slice(0, 60)))),
    duration_ms: Date.now() - started,
  };

  db.prepare("INSERT INTO mining_runs (run_id,created_ms,stats_json,generation_version) VALUES (?,?,?,?)")
    .run(`MINE-${Date.now()}`, Date.now(), J(stats), GENERATION_VERSION);
  db.close();

  return { stats, atoms, components, candidates: gen.candidates };
}
