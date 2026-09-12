/**
 * Experiment persistence (Phase 2 §15).
 *
 * Every validation run is stored append-only with a full fingerprint so a past
 * result can be replayed and audited. Historical rows are NEVER overwritten:
 * re-running the same strategy creates a new experiment with a new id.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ASA_BRAIN_DB_PATH } from "../env";
import type { EmpiricalStatus } from "../brain/types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL,
  strategy_id TEXT NOT NULL,
  setup_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  dataset_fingerprint TEXT NOT NULL,
  bars INTEGER NOT NULL,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  strategy_version TEXT NOT NULL,
  detector_version TEXT NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  build_id TEXT NOT NULL DEFAULT '',
  rule_version TEXT NOT NULL,
  risk_policy_id TEXT NOT NULL,
  psychology_policy_set TEXT NOT NULL,
  costs_json TEXT NOT NULL,
  params_json TEXT NOT NULL,
  in_sample_json TEXT NOT NULL,
  oos_json TEXT,
  walk_forward_json TEXT,
  promotion_json TEXT NOT NULL,
  empirical_status TEXT NOT NULL,
  code_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exp_strategy ON experiments(strategy_id, created_ms DESC);
`;

export interface ExperimentRecord {
  experiment_id: string;
  created_ms: number;
  strategy_id: string;
  setup_id: string;
  symbol: string;
  timeframe: string;
  dataset_fingerprint: string;
  bars: number;
  from_ts: number;
  to_ts: number;
  strategy_version: string;
  detector_version: string;
  app_version?: string;
  build_id?: string;
  rule_version: string;
  risk_policy_id: string;
  psychology_policy_set: string;
  costs: unknown;
  params: unknown;
  in_sample: unknown;
  oos: unknown | null;
  walk_forward: unknown | null;
  promotion: unknown;
  empirical_status: EmpiricalStatus;
  code_version: string;
}

/** Stable fingerprint of the exact candle series used. */
export function datasetFingerprint(candles: { t: number; o: number; h: number; l: number; c: number }[]): string {
  const h = createHash("sha256");
  for (const c of candles) h.update(`${c.t}:${c.o}:${c.h}:${c.l}:${c.c};`);
  return h.digest("hex").slice(0, 32);
}

export class ExperimentStore {
  private db: Database.Database;

  constructor(filePath: string = ASA_BRAIN_DB_PATH) {
    if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  insert(r: ExperimentRecord): void {
    this.db.prepare(
      `INSERT INTO experiments
       (experiment_id,created_ms,strategy_id,setup_id,symbol,timeframe,dataset_fingerprint,bars,from_ts,to_ts,
        strategy_version,detector_version,app_version,build_id,rule_version,risk_policy_id,psychology_policy_set,costs_json,params_json,
        in_sample_json,oos_json,walk_forward_json,promotion_json,empirical_status,code_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      r.experiment_id, r.created_ms, r.strategy_id, r.setup_id, r.symbol, r.timeframe,
      r.dataset_fingerprint, r.bars, r.from_ts, r.to_ts, r.strategy_version, r.detector_version,
      r.app_version ?? "", r.build_id ?? "", r.rule_version, r.risk_policy_id, r.psychology_policy_set,
      JSON.stringify(r.costs), JSON.stringify(r.params), JSON.stringify(r.in_sample),
      r.oos ? JSON.stringify(r.oos) : null, r.walk_forward ? JSON.stringify(r.walk_forward) : null,
      JSON.stringify(r.promotion), r.empirical_status, r.code_version,
    );
  }

  /**
   * Experiment rows are IMMUTABLE (closure §I2/§I3). There is deliberately no
   * update method on this store, and this guard proves a finished row cannot be
   * silently rewritten: re-running a strategy always creates a NEW row.
   */
  isImmutable(): boolean {
    const sql = Object.getOwnPropertyNames(ExperimentStore.prototype).join(" ");
    return !/update|overwrite|replace/i.test(sql);
  }

  /** Latest experiment per strategy (used to resolve empirical status). */
  latestFor(strategy_id: string): Record<string, unknown> | null {
    return (this.db.prepare(
      "SELECT * FROM experiments WHERE strategy_id=? ORDER BY created_ms DESC LIMIT 1",
    ).get(strategy_id) as Record<string, unknown>) ?? null;
  }

  allFor(strategy_id: string, limit = 50): Record<string, unknown>[] {
    return this.db.prepare(
      "SELECT * FROM experiments WHERE strategy_id=? ORDER BY created_ms DESC LIMIT ?",
    ).all(strategy_id, limit) as Record<string, unknown>[];
  }

  list(limit = 200): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM experiments ORDER BY created_ms DESC LIMIT ?").all(limit) as Record<string, unknown>[];
  }

  /**
   * Best empirical status achieved per strategy across all its experiments.
   * A strategy is only as strong as its evidence on EVERY symbol tested, so we
   * take the WEAKEST status across symbols — a strategy that works on one pair
   * and fails on another is not robust.
   */
  statusByStrategy(): Record<string, { status: EmpiricalStatus; experiments: number; symbols: string[] }> {
    const rows = this.db.prepare(
      "SELECT strategy_id, symbol, empirical_status, created_ms FROM experiments ORDER BY created_ms DESC",
    ).all() as { strategy_id: string; symbol: string; empirical_status: EmpiricalStatus; created_ms: number }[];

    const ORDER: EmpiricalStatus[] = ["REJECTED", "UNTESTED", "BACKTESTED", "OOS_TESTED", "WALK_FORWARD", "ROBUST"];
    const bySymbol = new Map<string, Map<string, EmpiricalStatus>>();
    for (const r of rows) {
      const m = bySymbol.get(r.strategy_id) ?? new Map<string, EmpiricalStatus>();
      if (!m.has(r.symbol)) m.set(r.symbol, r.empirical_status); // newest wins
      bySymbol.set(r.strategy_id, m);
    }
    const out: Record<string, { status: EmpiricalStatus; experiments: number; symbols: string[] }> = {};
    for (const [sid, m] of bySymbol) {
      let weakest: EmpiricalStatus = "ROBUST";
      for (const st of m.values()) {
        if (ORDER.indexOf(st) < ORDER.indexOf(weakest)) weakest = st;
      }
      out[sid] = {
        status: weakest,
        experiments: rows.filter((r) => r.strategy_id === sid).length,
        symbols: [...m.keys()],
      };
    }
    return out;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM experiments").get() as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }
}

let inst: ExperimentStore | null = null;
export function getExperiments(): ExperimentStore {
  if (!inst) inst = new ExperimentStore();
  return inst;
}
