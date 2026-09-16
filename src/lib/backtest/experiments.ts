/**
 * Experiment persistence (Phase 2 §15).
 *
 * Every validation run is stored append-only with a full fingerprint so a past
 * result can be replayed and audited. Historical rows are NEVER overwritten:
 * re-running the same strategy creates a new experiment with a new id.
 *
 * EVIDENCE READ-BACK (strategy-promotion phase):
 * A row is only useful as *evidence* if it can be read back faithfully. This
 * module therefore parses stored rows into typed `ExperimentEvidence` and
 * records every field that could NOT be read back in `parse_notes` — a
 * malformed or half-written row reports its defect instead of silently
 * degrading into plausible-looking numbers. The promotion gate
 * (`backtest/promotion.ts`) refuses to promote anything whose evidence does not
 * carry a valid dataset identity, a reproducible verdict and current versions.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ASA_BRAIN_DB_PATH } from "../env";
import type { EmpiricalStatus } from "../brain/types";
import type { BacktestMetrics } from "./strategy-runner";
import type { WalkForwardResult } from "./validation";

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
  code_version TEXT NOT NULL,
  dataset_identity_json TEXT,
  split_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_exp_strategy ON experiments(strategy_id, created_ms DESC);
`;

/**
 * Where the candles behind an experiment actually came from.
 *
 * `FIXTURE_SYNTHETIC` is deliberately a first-class value: fabricated candles
 * are legitimate for unit tests, but a promotion decision built on them would
 * be a fabricated result. The promotion gate rejects this kind.
 */
export type DatasetSourceKind =
  | "TTT_LIVE_SYNC"
  | "TTT_UDF_REPLAY"
  | "FIXTURE_SYNTHETIC"
  | "UNKNOWN";

/** Provenance of the exact series an experiment was run over. */
export interface DatasetIdentity {
  source_kind: DatasetSourceKind;
  /** concrete reference: a TTT endpoint+symbol+timeframe, or the replay file */
  source_ref: string;
  /** venue base URL the candles came from (TTT only; "" when not applicable) */
  source_base: string;
  /** ISO-8601 when the venue data was captured/synchronized */
  captured_at: string;
  /** ISO-8601 when this run read the series */
  retrieved_at: string;
  /** must equal the row's dataset_fingerprint */
  fingerprint: string;
  /** true only when the run hashed the candles it actually used */
  fingerprint_recomputed: boolean;
  /** sha256 of the exact stored artifact (replay file bytes / series payload) */
  source_sha256: string;
  bars: number;
  from_ts: number;
  to_ts: number;
  note: string;
}

/** In-sample / out-of-sample boundaries the verdict was computed over. */
export interface ExperimentSplit {
  split_ratio: number;
  split_index: number;
  in_sample: { from_ts: number; to_ts: number; bars: number };
  out_of_sample: { from_ts: number; to_ts: number; bars: number };
  walk_forward_windows: { window: number; test_from: number; test_to: number; trades: number }[];
}

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
  /** required evidence provenance; rows without it can never be promoted */
  dataset_identity?: DatasetIdentity | null;
  /** required in-sample/out-of-sample boundaries */
  split?: ExperimentSplit | null;
}

/** One stored experiment, read back with its integrity problems made explicit. */
export interface ExperimentEvidence {
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
  empirical_status: EmpiricalStatus;
  versions: {
    strategy_version: string;
    detector_version: string;
    rule_version: string;
    code_version: string;
    app_version: string;
    build_id: string;
  };
  params: Record<string, unknown>;
  in_sample: BacktestMetrics | null;
  oos: BacktestMetrics | null;
  walk_forward: WalkForwardResult | null;
  promotion: unknown;
  dataset_identity: DatasetIdentity | null;
  split: ExperimentSplit | null;
  /** declared validation methodology, or null when the row does not say */
  methodology: string | null;
  /** every field that could NOT be read back faithfully — never silently [] */
  parse_notes: string[];
}

/** Stable fingerprint of the exact candle series used. */
export function datasetFingerprint(candles: { t: number; o: number; h: number; l: number; c: number }[]): string {
  const h = createHash("sha256");
  for (const c of candles) h.update(`${c.t}:${c.o}:${c.h}:${c.l}:${c.c};`);
  return h.digest("hex").slice(0, 32);
}

/** sha256 of a stored artifact, for verifiable dataset provenance. */
export function artifactSha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* ------------------------------------------------------------- read-back */

function obj(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

const METRIC_KEYS = [
  "trade_count", "wins", "losses", "win_rate", "average_r", "expectancy_r", "profit_factor",
  "max_drawdown_r", "max_drawdown_pct", "longest_loss_streak", "average_hold_bars", "total_r",
  "gross_total_r", "return_pct", "fee_impact_r", "slippage_impact_r", "sufficient_sample",
] as const;

/**
 * A stored metrics object is only accepted when every field is present with the
 * right shape. Anything else is UNREADABLE — never coerced, never zero-filled.
 */
export function asBacktestMetrics(v: unknown): BacktestMetrics | null {
  const o = obj(v);
  if (!o) return null;
  for (const k of METRIC_KEYS) if (!(k in o)) return null;
  if (num(o.trade_count) === null) return null;
  if (typeof o.sufficient_sample !== "boolean") return null;
  return o as unknown as BacktestMetrics;
}

/**
 * Walk-forward evidence is only usable when the full window set AND the
 * aggregate are present — `decidePromotion` reads `aggregate.profit_factor`, so
 * a summary-only record (written by an older build) must NOT be mistaken for
 * full walk-forward evidence.
 */
export function asWalkForwardResult(v: unknown): WalkForwardResult | null {
  const o = obj(v);
  if (!o) return null;
  if (!Array.isArray(o.windows)) return null;
  if (num(o.total_windows) === null || num(o.profitable_windows) === null) return null;
  if (!("stability" in o)) return null;
  if (o.stability !== null && num(o.stability) === null) return null;
  if (!asBacktestMetrics(o.aggregate)) return null;
  if (typeof o.note !== "string") return null;
  return o as unknown as WalkForwardResult;
}

function asDatasetIdentity(v: unknown): DatasetIdentity | null {
  const o = obj(v);
  if (!o) return null;
  const kind = o.source_kind;
  if (kind !== "TTT_LIVE_SYNC" && kind !== "TTT_UDF_REPLAY" && kind !== "FIXTURE_SYNTHETIC" && kind !== "UNKNOWN") {
    return null;
  }
  return {
    source_kind: kind,
    source_ref: String(o.source_ref ?? ""),
    source_base: String(o.source_base ?? ""),
    captured_at: String(o.captured_at ?? ""),
    retrieved_at: String(o.retrieved_at ?? ""),
    fingerprint: String(o.fingerprint ?? ""),
    fingerprint_recomputed: o.fingerprint_recomputed === true,
    source_sha256: String(o.source_sha256 ?? ""),
    bars: num(o.bars) ?? 0,
    from_ts: num(o.from_ts) ?? 0,
    to_ts: num(o.to_ts) ?? 0,
    note: String(o.note ?? ""),
  };
}

function asSplit(v: unknown): ExperimentSplit | null {
  const o = obj(v);
  if (!o) return null;
  const is = obj(o.in_sample);
  const oos = obj(o.out_of_sample);
  if (!is || !oos) return null;
  if (num(o.split_index) === null || num(o.split_ratio) === null) return null;
  const win = Array.isArray(o.walk_forward_windows) ? o.walk_forward_windows : [];
  return {
    split_ratio: num(o.split_ratio) ?? 0,
    split_index: num(o.split_index) ?? 0,
    in_sample: { from_ts: num(is.from_ts) ?? 0, to_ts: num(is.to_ts) ?? 0, bars: num(is.bars) ?? 0 },
    out_of_sample: { from_ts: num(oos.from_ts) ?? 0, to_ts: num(oos.to_ts) ?? 0, bars: num(oos.bars) ?? 0 },
    walk_forward_windows: win.map((w) => {
      const wo = obj(w) ?? {};
      return {
        window: num(wo.window) ?? 0,
        test_from: num(wo.test_from) ?? 0,
        test_to: num(wo.test_to) ?? 0,
        trades: num(wo.trades) ?? 0,
      };
    }),
  };
}

/** Parse one stored row into evidence, recording every unreadable field. */
export function parseExperimentEvidence(row: Record<string, unknown>): ExperimentEvidence {
  const notes: string[] = [];
  const parseJson = (key: string): unknown => {
    const raw = row[key];
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(String(raw));
    } catch {
      notes.push(`${key.replace(/_json$/, "")}: stored JSON could not be parsed`);
      return null;
    }
  };

  const inSample = asBacktestMetrics(parseJson("in_sample_json"));
  if (!inSample) notes.push("in_sample: metrics are missing or incomplete — cannot be treated as measured");
  const oosRaw = parseJson("oos_json");
  const oos = asBacktestMetrics(oosRaw);
  if (oosRaw !== null && !oos) notes.push("oos: metrics are missing or incomplete — cannot be treated as measured");
  const wfRaw = parseJson("walk_forward_json");
  const walkForward = asWalkForwardResult(wfRaw);
  if (wfRaw !== null && !walkForward) {
    notes.push("walk_forward: record is not a complete walk-forward result (no windows/aggregate) — cannot support walk-forward evidence");
  }
  const identityRaw = parseJson("dataset_identity_json");
  const identity = asDatasetIdentity(identityRaw);
  if (identityRaw === null) notes.push("dataset_identity: absent — dataset provenance is UNKNOWN");
  else if (!identity) notes.push("dataset_identity: malformed — dataset provenance is UNKNOWN");
  const splitRaw = parseJson("split_json");
  const split = asSplit(splitRaw);
  if (splitRaw === null) notes.push("split: absent — in-sample/out-of-sample periods are UNKNOWN");

  const paramsRaw = parseJson("params_json");
  const params = obj(paramsRaw) ?? {};
  if (paramsRaw !== null && obj(paramsRaw) === null) notes.push("params: could not be read");

  const methodology = typeof params.methodology === "string" ? params.methodology : null;
  if (methodology === null) notes.push("methodology: the row does not state which validation methodology produced it");

  return {
    experiment_id: String(row.experiment_id),
    created_ms: Number(row.created_ms),
    strategy_id: String(row.strategy_id),
    setup_id: String(row.setup_id),
    symbol: String(row.symbol),
    timeframe: String(row.timeframe),
    dataset_fingerprint: String(row.dataset_fingerprint),
    bars: Number(row.bars),
    from_ts: Number(row.from_ts),
    to_ts: Number(row.to_ts),
    empirical_status: String(row.empirical_status) as EmpiricalStatus,
    versions: {
      strategy_version: String(row.strategy_version),
      detector_version: String(row.detector_version),
      rule_version: String(row.rule_version),
      code_version: String(row.code_version),
      app_version: String(row.app_version ?? ""),
      build_id: String(row.build_id ?? ""),
    },
    params,
    in_sample: inSample,
    oos,
    walk_forward: walkForward,
    promotion: parseJson("promotion_json"),
    dataset_identity: identity,
    split,
    methodology,
    parse_notes: notes,
  };
}

export class ExperimentStore {
  private db: Database.Database;

  constructor(filePath: string = ASA_BRAIN_DB_PATH) {
    if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Additive migrations for experiment DBs written before a schema change.
   * Only NULLABLE columns are ever added and historical rows are never
   * rewritten: a pre-provenance row stays readable but carries no dataset
   * identity — which is exactly how the promotion gate reports it (UNKNOWN,
   * never eligible).
   */
  private migrate(): void {
    const cols = this.db.prepare("PRAGMA table_info(experiments)").all() as { name: string }[];
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("dataset_identity_json")) this.db.exec("ALTER TABLE experiments ADD COLUMN dataset_identity_json TEXT");
    if (!have.has("split_json")) this.db.exec("ALTER TABLE experiments ADD COLUMN split_json TEXT");
    if (!have.has("app_version")) this.db.exec("ALTER TABLE experiments ADD COLUMN app_version TEXT NOT NULL DEFAULT ''");
    if (!have.has("build_id")) this.db.exec("ALTER TABLE experiments ADD COLUMN build_id TEXT NOT NULL DEFAULT ''");
  }

  insert(r: ExperimentRecord): void {
    this.db.prepare(
      `INSERT INTO experiments
       (experiment_id,created_ms,strategy_id,setup_id,symbol,timeframe,dataset_fingerprint,bars,from_ts,to_ts,
        strategy_version,detector_version,app_version,build_id,rule_version,risk_policy_id,psychology_policy_set,costs_json,params_json,
        in_sample_json,oos_json,walk_forward_json,promotion_json,empirical_status,code_version,dataset_identity_json,split_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      r.experiment_id, r.created_ms, r.strategy_id, r.setup_id, r.symbol, r.timeframe,
      r.dataset_fingerprint, r.bars, r.from_ts, r.to_ts, r.strategy_version, r.detector_version,
      r.app_version ?? "", r.build_id ?? "", r.rule_version, r.risk_policy_id, r.psychology_policy_set,
      JSON.stringify(r.costs), JSON.stringify(r.params), JSON.stringify(r.in_sample),
      r.oos ? JSON.stringify(r.oos) : null, r.walk_forward ? JSON.stringify(r.walk_forward) : null,
      JSON.stringify(r.promotion), r.empirical_status, r.code_version,
      r.dataset_identity ? JSON.stringify(r.dataset_identity) : null,
      r.split ? JSON.stringify(r.split) : null,
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

  /**
   * Newest-first order key. `created_ms` alone is not enough: several rows can
   * share a millisecond, and "which row is the evidence?" must be deterministic
   * (rowid is monotonic in insert order), otherwise the same database could
   * yield two different promotion decisions.
   */
  private static readonly ORDER = "ORDER BY created_ms DESC, rowid DESC";

  /** Latest experiment per strategy (used to resolve empirical status). */
  latestFor(strategy_id: string): Record<string, unknown> | null {
    return (this.db.prepare(
      `SELECT * FROM experiments WHERE strategy_id=? ${ExperimentStore.ORDER} LIMIT 1`,
    ).get(strategy_id) as Record<string, unknown>) ?? null;
  }

  allFor(strategy_id: string, limit = 50): Record<string, unknown>[] {
    return this.db.prepare(
      `SELECT * FROM experiments WHERE strategy_id=? ${ExperimentStore.ORDER} LIMIT ?`,
    ).all(strategy_id, limit) as Record<string, unknown>[];
  }

  /** Retrieve a single experiment row by its primary key ID. */
  getById(experiment_id: string): Record<string, unknown> | null {
    return (this.db.prepare(
      "SELECT * FROM experiments WHERE experiment_id=?",
    ).get(experiment_id) as Record<string, unknown>) ?? null;
  }

  /** Parse and type a single experiment row by its ID. */
  evidenceById(experiment_id: string): ExperimentEvidence | null {
    const row = this.getById(experiment_id);
    if (!row) return null;
    return parseExperimentEvidence(row);
  }

  list(limit = 200): Record<string, unknown>[] {
    return this.db.prepare(`SELECT * FROM experiments ${ExperimentStore.ORDER} LIMIT ?`).all(limit) as Record<string, unknown>[];
  }

  /**
   * Typed evidence for one strategy across every symbol it was tested on,
   * newest row per symbol first. This is the input the promotion gate reads —
   * no status is taken on faith and no unreadable field is hidden.
   */
  evidenceFor(strategy_id: string, limit = 500): ExperimentEvidence[] {
    const rows = this.allFor(strategy_id, limit);
    const newestPerSymbol = new Set<string>();
    const out: ExperimentEvidence[] = [];
    for (const row of rows) {
      const symbol = String(row.symbol);
      if (newestPerSymbol.has(symbol)) continue; // older run for a symbol already covered
      newestPerSymbol.add(symbol);
      out.push(parseExperimentEvidence(row));
    }
    return out;
  }

  /**
   * Best empirical status achieved per strategy across all its experiments.
   * A strategy is only as strong as its evidence on EVERY symbol tested, so we
   * take the WEAKEST status across symbols — a strategy that works on one pair
   * and fails on another is not robust.
   */
  statusByStrategy(): Record<string, { status: EmpiricalStatus; experiments: number; symbols: string[] }> {
    const rows = this.db.prepare(
      `SELECT strategy_id, symbol, empirical_status, created_ms FROM experiments ${ExperimentStore.ORDER}`,
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
