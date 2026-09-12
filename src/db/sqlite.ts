/**
 * SQLite adapter implementing Repo (better-sqlite3). Migration SQL lives
 * here; the schema is deliberately small and portable.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ASA_DB_PATH } from "../lib/env";
import type { Repo, OpportunityRow, SignalRow, JournalRow, OutboxRow, AiCallRow, NewsRow, RetentionRunRow, BacktestJobRow } from "./repo";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
  direction TEXT NOT NULL, score REAL NOT NULL, state TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'research', strategy_id TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opp_updated ON opportunities(updated_ms DESC);
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL, direction TEXT NOT NULL, score REAL NOT NULL,
  strategy_id TEXT NOT NULL, opp_id TEXT, payload_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sig_updated ON signals(updated_ms DESC);
-- Signal idempotency (closure §V): one signal per opportunity, enforced by the
-- database rather than by a best-effort application check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sig_opp ON signals(opp_id) WHERE opp_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, applied_ms INTEGER NOT NULL, note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '', opp_id TEXT, r_multiple REAL
);
CREATE TABLE IF NOT EXISTS telegram_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'QUEUED',
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
  created_ms INTEGER NOT NULL, sent_ms INTEGER
);
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_ms INTEGER NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, latency_ms INTEGER,
  verdict TEXT NOT NULL, structured_json TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS news_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
  source_type TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '', impact TEXT NOT NULL DEFAULT '',
  symbols_json TEXT NOT NULL DEFAULT '[]',
  published_ms INTEGER, ingested_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_ingested ON news_events(ingested_ms DESC);
CREATE TABLE IF NOT EXISTS retention_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ran_ms INTEGER NOT NULL,
  table_name TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  cutoff_ms INTEGER NOT NULL, ok INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS backtest_jobs (
  id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, status TEXT NOT NULL,
  symbol TEXT NOT NULL, timeframe TEXT NOT NULL, strategy_id TEXT NOT NULL,
  params_json TEXT NOT NULL, result_json TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_bt_created ON backtest_jobs(created_ms DESC);
`;

export class SqliteRepo implements Repo {
  private db: Database.Database;

  constructor(filePath: string = ASA_DB_PATH) {
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  configGet(k: string): string | null {
    const r = this.db.prepare("SELECT v FROM config WHERE k = ?").get(k) as { v: string } | undefined;
    return r ? r.v : null;
  }
  configSet(k: string, v: string): void {
    this.db.prepare("INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
  opportunityUpsert(o: OpportunityRow): void {
    this.db
      .prepare(
        `INSERT INTO opportunities (id, symbol, timeframe, direction, score, state, mode, strategy_id, payload_json, created_ms, updated_ms)
         VALUES (@id, @symbol, @timeframe, @direction, @score, @state, @mode, @strategy_id, @payload_json, @created_ms, @updated_ms)
         ON CONFLICT(id) DO UPDATE SET state=@state, score=@score, payload_json=@payload_json, updated_ms=@updated_ms`,
      )
      .run(o);
  }
  opportunityList(limit: number): OpportunityRow[] {
    return this.db.prepare("SELECT * FROM opportunities ORDER BY updated_ms DESC LIMIT ?").all(limit) as OpportunityRow[];
  }
  opportunityGet(id: string): OpportunityRow | null {
    return (this.db.prepare("SELECT * FROM opportunities WHERE id = ?").get(id) as OpportunityRow) ?? null;
  }
  opportunityCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM opportunities").get() as { c: number }).c;
  }
  signalInsert(s: SignalRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO signals (id, state, symbol, timeframe, direction, score, strategy_id, opp_id, payload_json, created_ms, updated_ms)
         VALUES (@id, @state, @symbol, @timeframe, @direction, @score, @strategy_id, @opp_id, @payload_json, @created_ms, @updated_ms)`,
      )
      .run(s);
  }
  signalUpdate(s: Partial<SignalRow> & { id: string }): void {
    const cur = this.db.prepare("SELECT * FROM signals WHERE id = ?").get(s.id) as SignalRow | undefined;
    if (!cur) return;
    const next = { ...cur, ...s, updated_ms: Date.now() };
    this.db
      .prepare(
        `UPDATE signals SET state=@state, symbol=@symbol, timeframe=@timeframe, direction=@direction,
         score=@score, strategy_id=@strategy_id, opp_id=@opp_id, payload_json=@payload_json, updated_ms=@updated_ms WHERE id=@id`,
      )
      .run(next);
  }
  signalPage(limit: number, offset: number): SignalRow[] {
    return this.db.prepare("SELECT * FROM signals ORDER BY updated_ms DESC LIMIT ? OFFSET ?").all(limit, offset) as SignalRow[];
  }
  signalByOpp(oppId: string): SignalRow | null {
    return (this.db.prepare("SELECT * FROM signals WHERE opp_id = ?").get(oppId) as SignalRow) ?? null;
  }
  signalList(limit: number): SignalRow[] {
    return this.db.prepare("SELECT * FROM signals ORDER BY updated_ms DESC LIMIT ?").all(limit) as SignalRow[];
  }
  journalAdd(j: Omit<JournalRow, "id">): number {
    const r = this.db
      .prepare(
        `INSERT INTO journal (created_ms, updated_ms, symbol, direction, notes, opp_id, r_multiple)
         VALUES (@created_ms, @updated_ms, @symbol, @direction, @notes, @opp_id, @r_multiple)`,
      )
      .run(j);
    return Number(r.lastInsertRowid);
  }
  journalList(): JournalRow[] {
    return this.db.prepare("SELECT * FROM journal ORDER BY created_ms DESC").all() as JournalRow[];
  }
  journalDelete(id: number): void {
    this.db.prepare("DELETE FROM journal WHERE id = ?").run(id);
  }
  outboxEnqueue(kind: string, payload: unknown): number {
    const r = this.db
      .prepare("INSERT INTO telegram_outbox (kind, payload_json, state, created_ms) VALUES (?, ?, 'QUEUED', ?)")
      .run(kind, JSON.stringify(payload), Date.now());
    return Number(r.lastInsertRowid);
  }
  outboxList(state: OutboxRow["state"] | "ALL", limit: number): OutboxRow[] {
    if (state === "ALL") return this.db.prepare("SELECT * FROM telegram_outbox ORDER BY created_ms DESC LIMIT ?").all(limit) as OutboxRow[];
    return this.db.prepare("SELECT * FROM telegram_outbox WHERE state = ? ORDER BY created_ms DESC LIMIT ?").all(state, limit) as OutboxRow[];
  }
  outboxMark(id: number, state: OutboxRow["state"], error: string | null = null): void {
    if (state === "SENT") this.db.prepare("UPDATE telegram_outbox SET state=?, error=?, sent_ms=? WHERE id=?").run(state, error, Date.now(), id);
    else this.db.prepare("UPDATE telegram_outbox SET state=?, error=?, attempts=attempts+1 WHERE id=?").run(state, error, id);
  }
  aiCallInsert(c: Omit<AiCallRow, "id">): void {
    this.db
      .prepare("INSERT INTO ai_calls (created_ms, provider, model, latency_ms, verdict, structured_json, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(c.created_ms, c.provider, c.model, c.latency_ms, c.verdict, c.structured_json, c.error);
  }
  aiCallList(limit: number): AiCallRow[] {
    return this.db.prepare("SELECT * FROM ai_calls ORDER BY created_ms DESC LIMIT ?").all(limit) as AiCallRow[];
  }
  newsUpsert(n: Omit<NewsRow, "id">): { inserted: boolean } {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO news_events (dedupe_key, source, source_type, url, title, summary, impact, symbols_json, published_ms, ingested_ms)
         VALUES (@dedupe_key, @source, @source_type, @url, @title, @summary, @impact, @symbols_json, @published_ms, @ingested_ms)`,
      )
      .run(n);
    return { inserted: r.changes > 0 };
  }
  newsList(opts: { days: number; limit: number }): NewsRow[] {
    const cutoff = Date.now() - opts.days * 86400_000;
    return this.db.prepare("SELECT * FROM news_events WHERE ingested_ms >= ? ORDER BY ingested_ms DESC LIMIT ?").all(cutoff, opts.limit) as NewsRow[];
  }
  newsDeleteOlderThan(cutoffMs: number): number {
    return this.db.prepare("DELETE FROM news_events WHERE ingested_ms < ?").run(cutoffMs).changes;
  }
  retentionLog(r: Omit<RetentionRunRow, "id">): void {
    this.db
      .prepare("INSERT INTO retention_runs (ran_ms, table_name, deleted, cutoff_ms, ok, note) VALUES (?, ?, ?, ?, ?, ?)")
      .run(r.ran_ms, r.table_name, r.deleted, r.cutoff_ms, r.ok ? 1 : 0, r.note);
  }
  retentionRuns(limit: number): RetentionRunRow[] {
    return this.db.prepare("SELECT * FROM retention_runs ORDER BY ran_ms DESC LIMIT ?").all(limit) as RetentionRunRow[];
  }
  backtestCreate(j: BacktestJobRow): void {
    this.db
      .prepare("INSERT INTO backtest_jobs (id, created_ms, status, symbol, timeframe, strategy_id, params_json, result_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(j.id, j.created_ms, j.status, j.symbol, j.timeframe, j.strategy_id, j.params_json, j.result_json, j.error);
  }
  backtestUpdate(id: string, status: string, resultJson: string | null, error: string | null): void {
    this.db.prepare("UPDATE backtest_jobs SET status=?, result_json=?, error=? WHERE id=?").run(status, resultJson, error, id);
  }
  backtestGet(id: string): BacktestJobRow | null {
    return (this.db.prepare("SELECT * FROM backtest_jobs WHERE id = ?").get(id) as BacktestJobRow) ?? null;
  }
  backtestList(limit: number): BacktestJobRow[] {
    return this.db.prepare("SELECT * FROM backtest_jobs ORDER BY created_ms DESC LIMIT ?").all(limit) as BacktestJobRow[];
  }
  close(): void {
    this.db.close();
  }
}

let repoInstance: Repo | null = null;

/** App-wide repository singleton (lazy; db path from env). */
export function getRepo(): Repo {
  if (!repoInstance) {
    repoInstance = new SqliteRepo(ASA_DB_PATH);
  }
  return repoInstance;
}

export function closeRepo(): void {
  repoInstance?.close();
  repoInstance = null;
}
