/**
 * Persistent candle store with incremental sync (remediation §9, §18, §23).
 *
 * RETENTION RULE: candles are NEVER deleted because a chart viewport moved.
 * The only boundary is TTT's own historical boundary. A separate SQLite file
 * keeps market history out of the runtime state DB so a runtime wipe cannot
 * destroy an expensive backfill.
 *
 * Incremental sync: once a range is stored, later syncs fetch only the newest
 * missing tail, and a fingerprint check short-circuits work when nothing moved.
 *
 * BOUNDARY PROOF vs DATASET COMPLETENESS (forensic task: no false boundary proof)
 * These are two DIFFERENT facts and are never collapsed into one boolean:
 *
 *   boundary_proven_this_attempt — THIS sync attempt obtained explicit upstream
 *     evidence (TTT answered `s:"no_data"` for a window strictly older than the
 *     oldest bar known before the attempt). Only this may refresh the proof
 *     record (`boundary_proof` / `boundary_proof_ms`).
 *
 *   completion_state === "COMPLETE_TO_TTT_BOUNDARY" — the STORED dataset still
 *     reaches a previously verified boundary. A prior verified sync may be
 *     RETAINED as historical evidence (the bars and the proof record are still
 *     ours), but it can never manufacture a fresh proof, and it is invalidated
 *     the moment the dataset grows OLDER than the extent that was verified.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Candle } from "../domain/types";
import type { TimeframeId } from "../domain/timeframes";
import { getTimeframe } from "../domain/timeframes";
import {
  fetchFullHistory, detectGaps, fingerprint, mergeCandles,
  type CompletionState, type HistoryMeta,
} from "./history";
import { ASA_HISTORY_DB_PATH } from "../env";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT NOT NULL, timeframe TEXT NOT NULL, t INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, timeframe, t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles(symbol, timeframe, t);
CREATE TABLE IF NOT EXISTS history_sync (
  symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
  earliest_ts INTEGER, latest_ts INTEGER, bar_count INTEGER NOT NULL DEFAULT 0,
  completion_state TEXT NOT NULL DEFAULT 'PARTIAL',
  gap_count INTEGER NOT NULL DEFAULT 0,
  dataset_fingerprint TEXT NOT NULL DEFAULT '',
  last_sync_ms INTEGER NOT NULL DEFAULT 0,
  last_attempt_ms INTEGER NOT NULL DEFAULT 0,
  last_successful_sync_ms INTEGER NOT NULL DEFAULT 0,
  -- HOW the earliest boundary was proven for the stored extent ('TTT_NO_DATA'),
  -- or NULL when no proof is recorded (legacy row, or never proven).
  boundary_proof TEXT,
  boundary_proof_ms INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, retrieval_version TEXT NOT NULL DEFAULT '1.0.0',
  source TEXT NOT NULL DEFAULT 'ttt',
  PRIMARY KEY (symbol, timeframe)
);
-- MULTI-PROCESS CELL LEASE (cross-process critical-section guard): the
-- per-cell sync body is a READ-MODIFY-WRITE over one history_sync row. The
-- in-process FIFO chain serializes callers inside ONE process, but two
-- processes sharing this database file (two dev servers, a cron worker + a
-- server) could still interleave reads/writes and destroy a fresh boundary
-- proof. This tiny table is a TTL lease taken in the same SQLite file, so the
-- mutual exclusion is as durable as the data itself. One row per held cell.
CREATE TABLE IF NOT EXISTS sync_lease (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
);
`;

export const RETRIEVAL_VERSION = "1.1.0";

export interface SyncRow {
  symbol: string;
  timeframe: string;
  earliest_ts: number | null;
  latest_ts: number | null;
  bar_count: number;
  completion_state: CompletionState;
  gap_count: number;
  dataset_fingerprint: string;
  /** legacy column = last ATTEMPT time (kept for compatibility); do NOT read it as a success timestamp */
  last_sync_ms: number;
  /** AUDIT FIX (P0-6): every attempt, success or failure */
  last_attempt_ms: number;
  /** AUDIT FIX (P0-6): only set when the sync actually SUCCEEDED */
  last_successful_sync_ms: number;
  /**
   * Evidence type of the recorded boundary proof, or NULL when none exists.
   * Distinguishes "this dataset was proven complete by explicit upstream
   * evidence" from "we merely inherited a completion flag".
   */
  boundary_proof: string | null;
  /** epoch ms of the recorded boundary proof (0 = none recorded) */
  boundary_proof_ms: number;
  last_error: string | null;
  retrieval_version: string;
  source: string;
}

/**
 * The persistence surface `syncHistory()` and the API routes depend on.
 * Structural, so a deterministic in-memory double can be injected with
 * `__setHistoryStore()` in tests (the real store needs SQLite). Production
 * always uses `HistoryStore`.
 */
export interface HistoryStoreLike {
  put(symbol: string, timeframe: TimeframeId, candles: Candle[]): number;
  get(symbol: string, timeframe: TimeframeId, from?: number, to?: number, limit?: number): Candle[];
  count(symbol: string, timeframe: TimeframeId): number;
  bounds(symbol: string, timeframe: TimeframeId): { earliest: number | null; latest: number | null };
  syncRow(symbol: string, timeframe: TimeframeId): SyncRow | null;
  allSyncRows(): SyncRow[];
  putSync(r: SyncRow): void;
  touchSyncAttempt(symbol: string, timeframe: TimeframeId, atMs: number, error?: string | null): void;
  /**
   * MULTI-PROCESS: try to take the cell lease. Returns true when acquired
   * (fresh row, expired foreign lease, or already ours); false while another
   * owner's lease is still valid.
   */
  acquireSyncLease(key: string, owner: string, ttlMs: number): boolean;
  /** MULTI-PROCESS: heartbeat. Extends only when `owner` still holds the lease. */
  renewSyncLease(key: string, owner: string, ttlMs: number): boolean;
  /** MULTI-PROCESS: release only our own lease (idempotent). */
  releaseSyncLease(key: string, owner: string): void;
  totalBars(): number;
  close(): void;
}

export class HistoryStore implements HistoryStoreLike {
  private db: Database.Database;

  constructor(filePath: string = ASA_HISTORY_DB_PATH) {
    if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Lightweight column migration: CREATE TABLE IF NOT EXISTS does not alter an
   * existing database, so the attempt/success columns are added explicitly.
   */
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(history_sync)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!cols.has("last_attempt_ms")) {
      // pre-1.1.0 rows: the old last_sync_ms was written on FAILED attempts too,
      // so it cannot be trusted as a success timestamp — seed it as the attempt
      // time only and leave last_successful_sync_ms at 0 (unknown, re-provable
      // by one successful sync).
      this.db.exec("ALTER TABLE history_sync ADD COLUMN last_attempt_ms INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE history_sync SET last_attempt_ms = last_sync_ms WHERE last_attempt_ms = 0");
    }
    if (!cols.has("boundary_proof")) {
      // Additive: a pre-existing row keeps its completion flag but records NO
      // evidence type — it can never be mistaken for a freshly proven boundary.
      this.db.exec("ALTER TABLE history_sync ADD COLUMN boundary_proof TEXT");
    }
    if (!cols.has("boundary_proof_ms")) {
      this.db.exec("ALTER TABLE history_sync ADD COLUMN boundary_proof_ms INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.has("last_successful_sync_ms")) {
      this.db.exec("ALTER TABLE history_sync ADD COLUMN last_successful_sync_ms INTEGER NOT NULL DEFAULT 0");
      // A row with no recorded error and stored bars was, to the best prior
      // knowledge, successfully synced; a row with an error was not.
      this.db.exec(
        "UPDATE history_sync SET last_successful_sync_ms = last_sync_ms WHERE last_error IS NULL AND bar_count > 0",
      );
    }
  }

  /** Append/upsert candles. Existing bars are corrected, never duplicated. */
  put(symbol: string, timeframe: TimeframeId, candles: Candle[]): number {
    if (candles.length === 0) return 0;
    const st = this.db.prepare(
      `INSERT INTO candles (symbol,timeframe,t,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(symbol,timeframe,t) DO UPDATE SET o=excluded.o,h=excluded.h,l=excluded.l,c=excluded.c,v=excluded.v`,
    );
    const tx = this.db.transaction((rows: Candle[]) => {
      for (const c of rows) st.run(symbol, timeframe, c.t, c.o, c.h, c.l, c.c, c.v ?? 0);
    });
    tx(candles);
    return candles.length;
  }

  /**
   * Read a range. `from`/`to` omitted means EVERYTHING stored — there is no
   * implicit recent-N window anywhere in this method.
   */
  get(symbol: string, timeframe: TimeframeId, from?: number, to?: number, limit?: number): Candle[] {
    const clauses = ["symbol = ?", "timeframe = ?"];
    const args: (string | number)[] = [symbol, timeframe];
    if (from !== undefined) { clauses.push("t >= ?"); args.push(from); }
    if (to !== undefined) { clauses.push("t <= ?"); args.push(to); }
    let sql = `SELECT t,o,h,l,c,v FROM candles WHERE ${clauses.join(" AND ")} ORDER BY t ASC`;
    if (limit !== undefined && limit > 0) {
      // newest-N window for transport, still ordered ascending on return
      sql = `SELECT t,o,h,l,c,v FROM (SELECT t,o,h,l,c,v FROM candles WHERE ${clauses.join(" AND ")} ORDER BY t DESC LIMIT ${Math.floor(limit)}) ORDER BY t ASC`;
    }
    return this.db.prepare(sql).all(...args) as Candle[];
  }

  count(symbol: string, timeframe: TimeframeId): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM candles WHERE symbol=? AND timeframe=?").get(symbol, timeframe) as { c: number }).c;
  }

  bounds(symbol: string, timeframe: TimeframeId): { earliest: number | null; latest: number | null } {
    const r = this.db.prepare("SELECT MIN(t) lo, MAX(t) hi FROM candles WHERE symbol=? AND timeframe=?").get(symbol, timeframe) as { lo: number | null; hi: number | null };
    return { earliest: r?.lo ?? null, latest: r?.hi ?? null };
  }

  syncRow(symbol: string, timeframe: TimeframeId): SyncRow | null {
    return (this.db.prepare("SELECT * FROM history_sync WHERE symbol=? AND timeframe=?").get(symbol, timeframe) as SyncRow) ?? null;
  }

  allSyncRows(): SyncRow[] {
    return this.db.prepare("SELECT * FROM history_sync ORDER BY symbol, timeframe").all() as SyncRow[];
  }

  putSync(r: SyncRow): void {
    this.db.prepare(
      `INSERT INTO history_sync (symbol,timeframe,earliest_ts,latest_ts,bar_count,completion_state,gap_count,dataset_fingerprint,last_sync_ms,last_attempt_ms,last_successful_sync_ms,boundary_proof,boundary_proof_ms,last_error,retrieval_version,source)
       VALUES (@symbol,@timeframe,@earliest_ts,@latest_ts,@bar_count,@completion_state,@gap_count,@dataset_fingerprint,@last_sync_ms,@last_attempt_ms,@last_successful_sync_ms,@boundary_proof,@boundary_proof_ms,@last_error,@retrieval_version,@source)
       ON CONFLICT(symbol,timeframe) DO UPDATE SET
         earliest_ts=excluded.earliest_ts, latest_ts=excluded.latest_ts, bar_count=excluded.bar_count,
         completion_state=excluded.completion_state, gap_count=excluded.gap_count,
         dataset_fingerprint=excluded.dataset_fingerprint, last_sync_ms=excluded.last_sync_ms,
         last_attempt_ms=excluded.last_attempt_ms, last_successful_sync_ms=excluded.last_successful_sync_ms,
         boundary_proof=excluded.boundary_proof, boundary_proof_ms=excluded.boundary_proof_ms,
         last_error=excluded.last_error, retrieval_version=excluded.retrieval_version`,
    ).run(r);
  }

  /**
   * AUDIT FIX (P0-6): record that an attempt happened WITHOUT claiming success.
   * Used by the skip path (no round trip was made, so nothing was verified)
   * and by failed syncs, so `last_sync_ms` can never masquerade as
   * "last successful sync".
   */
  touchSyncAttempt(symbol: string, timeframe: TimeframeId, atMs: number, error: string | null = null): void {
    this.db.prepare(
      `UPDATE history_sync SET last_sync_ms = ?, last_attempt_ms = ?, last_error = COALESCE(?, last_error)
       WHERE symbol = ? AND timeframe = ?`,
    ).run(atMs, atMs, error, symbol, timeframe);
  }

  /**
   * MULTI-PROCESS: atomically take/refresh the cell lease.
   * `INSERT ... ON CONFLICT` is evaluated inside one SQLite transaction, so
   * two connections racing the same cell produce exactly one winner: the
   * loser sees the winner's still-valid `expires_ms` and backs off.
   */
  acquireSyncLease(key: string, owner: string, ttlMs: number): boolean {
    const now = Date.now();
    const expires = now + ttlMs;
    // Take when: no row, our own row, or the foreign lease already expired.
    this.db.prepare(
      `INSERT INTO sync_lease (key, owner, acquired_ms, expires_ms) VALUES (?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET
         owner = excluded.owner,
         acquired_ms = CASE WHEN sync_lease.owner = excluded.owner THEN sync_lease.acquired_ms ELSE excluded.acquired_ms END,
         expires_ms = excluded.expires_ms
       WHERE sync_lease.expires_ms <= ? OR sync_lease.owner = excluded.owner`,
    ).run(key, owner, now, expires, now);
    return this.leaseOwner(key) === owner;
  }

  renewSyncLease(key: string, owner: string, ttlMs: number): boolean {
    const res = this.db
      .prepare("UPDATE sync_lease SET expires_ms = ? WHERE key = ? AND owner = ? AND expires_ms > ?")
      .run(Date.now() + ttlMs, key, owner, Date.now());
    return res.changes > 0;
  }

  releaseSyncLease(key: string, owner: string): void {
    this.db.prepare("DELETE FROM sync_lease WHERE key = ? AND owner = ?").run(key, owner);
  }

  private leaseOwner(key: string): string | null {
    return (this.db.prepare("SELECT owner FROM sync_lease WHERE key = ?").get(key) as { owner: string } | undefined)?.owner ?? null;
  }

  totalBars(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM candles").get() as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }
}

let inst: HistoryStore | null = null;
let override: HistoryStoreLike | null = null;

/**
 * The store currently backing history persistence (production: the SQLite
 * `HistoryStore`).
 */
export function getHistoryStore(): HistoryStoreLike {
  return override ?? (inst ??= new HistoryStore());
}

export function closeHistoryStore(): void {
  if (override) {
    override = null;
    return;
  }
  inst?.close();
  inst = null;
}

/** Test seam: inject a deterministic store. Production never calls this. */
export function __setHistoryStore(store: HistoryStoreLike): void {
  override = store;
}

/** Test seam: restore the production SQLite store. */
export function __resetHistoryStore(): void {
  override = null;
}

export interface SyncOptions {
  /** re-walk to the TTT boundary even if history is already stored */
  full?: boolean;
  maxChunks?: number;
  /**
   * Test/ops seam: how long to wait for a concurrent cell lease (cross
   * process) before failing the sync. Default: SYNC_LEASE_WAIT_TIMEOUT_MS.
   */
  leaseTimeoutMs?: number;
}

/** Lease TTL for one cell's sync critical section; heartbeated while held. */
export const SYNC_LEASE_TTL_MS = 30_000;
/** Lease acquisition poll interval while waiting for a foreign holder. */
const SYNC_LEASE_POLL_MS = 200;
/** Default max wait for a foreign cell lease before failing the sync. */
export const SYNC_LEASE_WAIT_TIMEOUT_MS = 120_000;

interface LeaseGuard {
  /** Throws when the cell lease was lost (expired + taken by another process). */
  ensureOwned(): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * MULTI-PROCESS CRITICAL SECTION for one cell.
 *
 * Composes with the in-process FIFO chain (which runs BEFORE this): the chain
 * guarantees no same-process sibling can be mid-cell when we try to acquire,
 * so a failure to acquire means a DIFFERENT process holds the lease — we poll
 * until it finishes or `leaseTimeoutMs` elapses. A heartbeat keeps our TTL
 * alive across the (long) venue walk; `LeaseGuard.ensureOwned()` is checked
 * before every write, so a process that stalled past its TTL can never write
 * over a takeover's results — it aborts with nothing persisted.
 */
async function withCellLease<T>(
  symbol: string,
  timeframe: TimeframeId,
  opts: SyncOptions,
  body: (guard: LeaseGuard) => Promise<T>,
): Promise<T> {
  const store = getHistoryStore();
  const key = `${symbol}|${timeframe}`;
  // crypto RNG — the production-source scan forbids the global PRNG (see
  // tests/i18n-scan.test.ts) anywhere under src/; the owner id only needs to
  // be collision-free across processes/instances.
  const owner = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const ttl = SYNC_LEASE_TTL_MS;
  const waitMs = opts.leaseTimeoutMs ?? SYNC_LEASE_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + waitMs;

  let acquired = false;
  while (Date.now() < deadline) {
    if (store.acquireSyncLease(key, owner, ttl)) { acquired = true; break; }
    await sleep(SYNC_LEASE_POLL_MS);
  }
  if (!acquired) {
    throw new Error(
      `[history] cell ${key}: timed out after ${waitMs}ms waiting for the cross-process sync lease — another worker is syncing this cell`,
    );
  }

  let lost = false;
  const heartbeat = setInterval(() => {
    try {
      if (!store.renewSyncLease(key, owner, ttl)) lost = true;
    } catch {
      lost = true;
    }
  }, Math.floor(ttl / 3));
  heartbeat.unref?.();

  try {
    return await body({
      ensureOwned() {
        if (lost) throw new Error(`[history] cell ${key}: sync lease lost mid-flight (expired and taken by another process); refusing to write`);
        if (!store.renewSyncLease(key, owner, ttl)) {
          lost = true;
          throw new Error(`[history] cell ${key}: sync lease lost mid-flight (expired and taken by another process); refusing to write`);
        }
      },
    });
  } finally {
    clearInterval(heartbeat);
    try { store.releaseSyncLease(key, owner); } catch { /* lease expires by TTL regardless */ }
  }
}

export interface SyncResult {
  symbol: string;
  timeframe: TimeframeId;
  fetched: number;
  stored_total: number;
  added: number;
  meta: HistoryMeta;
  incremental: boolean;
  skipped_reason?: string;
  /** AUDIT FIX (P0-6): did THIS attempt actually sync from TTT successfully? */
  sync_succeeded: boolean;
  /** epoch ms of the last SUCCESSFUL sync (null when none ever succeeded) */
  last_successful_sync_ms: number | null;
  /**
   * Did THIS attempt obtain explicit upstream boundary evidence? A retained
   * historical completion NEVER sets this flag — it answers a different
   * question ("was the boundary proven NOW?").
   */
  boundary_proven_this_attempt: boolean;
  /** Evidence type recorded for the stored extent ('TTT_NO_DATA'), or null. */
  boundary_proof: string | null;
}

/**
 * Synchronise one symbol/timeframe.
 *
 * SERIALIZATION (concurrency truth fix): the body below is a READ-MODIFY-WRITE
 * transaction over the cell's sync row — it reads `prior`/`bounds`, performs
 * async venue walks, then writes completion_state + boundary_proof last-writer-
 * wins. Two concurrent callers (chart sync=full + backtest sync=full, double
 * click, parallel API clients) used to interleave that transaction:
 *   - a caller that read `prior` BEFORE another caller proved the boundary
 *     would later overwrite the fresh proof with its own stale snapshot
 *     (fresh TTT_NO_DATA evidence destroyed), and
 *   - a caller whose boundary probe raced another caller's extension of the
 *     dataset could label an extent COMPLETE_TO_TTT_BOUNDARY that its own
 *     evidence never covered (false boundary proof).
 * Each cell (symbol×timeframe) now runs its sync critical section strictly
 * serialized in FIFO arrival order, so every writer computes its truth from
 * the state its write actually applies to. Venue walks of DIFFERENT cells
 * still run concurrently — only same-cell syncs queue behind each other.
 */
export async function syncHistory(
  symbol: string,
  timeframe: TimeframeId,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const key = `${symbol}|${timeframe}`;
  const prev = cellSyncChain.get(key) ?? Promise.resolve();
  // In-process FIFO first, then the cross-process cell lease around the body:
  // the chain guarantees a same-process sibling never overlaps our acquisition,
  // so contention on the lease can only come from another process.
  const run = prev.then(() =>
    withCellLease(symbol, timeframe, opts, (lease) => syncHistoryCell(symbol, timeframe, opts, lease)),
  );
  // The chain tail swallows rejections so a failed sync never breaks the next
  // queued one; the ORIGINAL promise still rejects for the caller.
  const tail = run.then(() => undefined, () => undefined);
  cellSyncChain.set(key, tail);
  void tail.then(() => {
    // drop the entry once this task is the last in line (no unbounded map)
    if (cellSyncChain.get(key) === tail) cellSyncChain.delete(key);
  });
  return run;
}

/** FIFO chain of in-flight syncs per `symbol|timeframe` cell. */
const cellSyncChain = new Map<string, Promise<void>>();

async function syncHistoryCell(
  symbol: string,
  timeframe: TimeframeId,
  opts: SyncOptions = {},
  lease: LeaseGuard,
): Promise<SyncResult> {
  const store = getHistoryStore();
  const spec = getTimeframe(timeframe)!;
  const before = store.count(symbol, timeframe);
  const bounds = store.bounds(symbol, timeframe);
  const prior = store.syncRow(symbol, timeframe);

  /**
   * CRASH-WINDOW GUARD for extending writes: a `put` that stores bars OLDER
   * than the previously verified extent makes the stored proof stale — and a
   * crash between the put and the final `putSync` would strand a row claiming
   * COMPLETE_TO_TTT_BOUNDARY (proof covering only the old extent) over a
   * dataset that reaches further back than that proof ever proved. The honest
   * row is therefore persisted FIRST: proof dropped, completion weakened to
   * PARTIAL. Order the writes the other way (bars, then row) and the crash
   * window opens; this order makes a crash land on the truthful-unproven state,
   * which the next successful sync re-proves from scratch.
   */
  const putGuarded = (incoming: Candle[]): void => {
    lease.ensureOwned();
    if (
      incoming.length > 0 &&
      prior?.completion_state === "COMPLETE_TO_TTT_BOUNDARY" &&
      prior.earliest_ts !== null &&
      incoming[0].t < prior.earliest_ts
    ) {
      const now = Date.now();
      store.putSync({
        ...prior,
        completion_state: "PARTIAL",
        boundary_proof: null,
        boundary_proof_ms: 0,
        last_attempt_ms: now,
        last_sync_ms: now,
      });
    }
    store.put(symbol, timeframe, incoming);
  };

  const canIncrement =
    !opts.full && before > 0 && bounds.latest !== null &&
    prior?.completion_state === "COMPLETE_TO_TTT_BOUNDARY";

  // Nothing new can exist until the next bar closes — skip the round trip.
  if (canIncrement) {
    const nowSec = Math.floor(Date.now() / 1000);
    const stepSec = spec.minutes * 60;
    if (nowSec - (bounds.latest as number) < stepSec) {
      // AUDIT FIX (P0-6): a skip is an ATTEMPT, not a verified success. Record
      // the attempt without touching the success timestamp.
      lease.ensureOwned();
      store.touchSyncAttempt(symbol, timeframe, Date.now());
      const stored = store.get(symbol, timeframe);
      return {
        symbol, timeframe, fetched: 0, stored_total: before, added: 0, incremental: true,
        skipped_reason: "no new bar has closed since the last sync",
        sync_succeeded: true, // nothing was asked of the venue; stored data stands
        last_successful_sync_ms: prior?.last_successful_sync_ms ?? null,
        // no request was made: the retained completion is historical evidence,
        // never a fresh proof obtained by this attempt.
        boundary_proven_this_attempt: false,
        boundary_proof: prior?.boundary_proof ?? null,
        meta: {
          symbol, timeframe, ttt_resolution: spec.tttResolution,
          earliest_available: bounds.earliest, latest_available: bounds.latest,
          bar_count: before, requested_range: { from: null, to: nowSec },
          returned_range: { from: bounds.earliest, to: bounds.latest },
          completion_state: (prior?.completion_state ?? "PARTIAL") as CompletionState,
          gap_count: prior?.gap_count ?? 0, gaps: [], duplicate_count: 0, invalid_bar_count: 0,
          data_quality: (prior?.gap_count ?? 0) > 0 ? "GAPPED" : "OK",
          source: "ttt", native: true,
          dataset_fingerprint: prior?.dataset_fingerprint ?? fingerprint(stored),
          chunks_fetched: 0, last_sync_ms: Date.now(),
          boundary_evidence: null, // this attempt observed nothing upstream
          stop_cause: null, // no request was made
        },
      };
    }
  }

  const res = await fetchFullHistory(symbol, timeframe, {
    from: canIncrement ? (bounds.latest as number) - spec.minutes * 60 : undefined,
    maxChunks: opts.maxChunks,
  });

  // ---- FRESH PROOF (this attempt) -----------------------------------------
  // The walk reports explicit evidence only when TTT itself answered
  // `s:"no_data"` for a window strictly older than every bar the walk held.
  // It proves OUR dataset's earliest edge only if the walk actually reached (or
  // passed) the oldest bar we already knew — otherwise the no_data concerns a
  // window above our stored extent and proves nothing about it.
  const knownExtentBefore = bounds.earliest; // oldest bar held BEFORE this attempt
  const walkOldest = res.meta.earliest_available;
  const walkProvenBoundary =
    res.meta.boundary_evidence === "TTT_NO_DATA" &&
    walkOldest !== null &&
    (knownExtentBefore === null || walkOldest <= knownExtentBefore);

  // A `full` sync must PROVE the earliest boundary even when the stored range
  // already covers it: probe one chunk older than the oldest stored bar. TTT
  // answering `no_data` is the only authoritative confirmation.
  let boundaryProven = walkProvenBoundary;
  if (opts.full && !boundaryProven) {
    const merged = mergeCandles(store.get(symbol, timeframe), res.candles).merged;
    const oldest = merged.length ? merged[0].t : null;
    if (oldest !== null) {
      const probe = await fetchFullHistory(symbol, timeframe, {
        // strictly older than EVERY bar we hold, so an explicit no_data here is
        // a statement about the earliest edge and nothing else
        to: oldest - spec.minutes * 60,
        maxChunks: 1,
      });
      // Only EXPLICIT upstream evidence counts. Zero candles alone never proves
      // the boundary: an s:"ok" empty-success (AMBIGUOUS_EMPTY) and a stalled
      // walk (NO_PROGRESS) are both refused here.
      if (probe.meta.boundary_evidence === "TTT_NO_DATA") {
        boundaryProven = true;
      } else if (probe.candles.length > 0) {
        putGuarded(probe.candles);
      }
    }
  }

  putGuarded(res.candles);
  const after = store.count(symbol, timeframe);

  // Recompute metadata over EVERYTHING stored, not just this fetch, so an
  // incremental sync still reports the true earliest boundary.
  const stored = store.get(symbol, timeframe);
  const gaps = detectGaps(stored, spec.minutes);

  // Recompute completion from the CURRENT stored data. A previously GAPPED
  // range whose holes were later backfilled must not stay GAPPED forever.
  //
  // A prior verified completion IS retained — but only as HISTORICAL evidence
  // about the bars we still hold, and only while it still covers their extent.
  // The moment this attempt stores bars OLDER than the verified extent, the old
  // proof no longer applies to the dataset and completeness must be re-earned
  // with fresh explicit evidence.
  const currentEarliest = stored.length ? stored[0].t : null;
  const extendsOlderThanVerifiedExtent =
    knownExtentBefore !== null && currentEarliest !== null && currentEarliest < knownExtentBefore;
  const historicalCompleteRetained =
    prior?.completion_state === "COMPLETE_TO_TTT_BOUNDARY" && !extendsOlderThanVerifiedExtent;

  let completion: CompletionState;
  if (stored.length === 0) {
    // Preserve the walk's own empty classification. The previous else-branch
    // stamped NO_DATA on every other empty result, which claimed an explicit
    // venue no_data the walk had not observed.
    if (
      res.meta.completion_state === "UNAVAILABLE" ||
      res.meta.completion_state === "AMBIGUOUS_EMPTY" ||
      res.meta.completion_state === "INVALID_RESPONSE" ||
      res.meta.completion_state === "NO_DATA"
    ) {
      completion = res.meta.completion_state;
    } else {
      completion = "UNAVAILABLE";
    }
  } else if (gaps.length > 0) {
    completion = "GAPPED";
  } else if (boundaryProven || historicalCompleteRetained) {
    // COMPLETE requires either a FRESH explicit proof or retained historical
    // evidence whose extent still covers every bar stored.
    completion = "COMPLETE_TO_TTT_BOUNDARY";
  } else if (res.meta.completion_state === "NO_PROGRESS") {
    // usable bars, unproven earliest edge (overlap / stalled walk)
    completion = "NO_PROGRESS";
  } else {
    completion = "PARTIAL";
  }

  // ---- proof record --------------------------------------------------------
  // Refreshed ONLY by fresh explicit evidence. A retained/legacy completion
  // keeps whatever evidence type it already recorded (NULL = none recorded),
  // and loses even that the moment the dataset outgrows the verified extent.
  const attemptMs = Date.now();
  const priorProofStillApplies = !extendsOlderThanVerifiedExtent;
  const boundaryProof = boundaryProven
    ? "TTT_NO_DATA"
    : priorProofStillApplies ? (prior?.boundary_proof ?? null) : null;
  const boundaryProofMs = boundaryProven
    ? attemptMs
    : priorProofStillApplies ? (prior?.boundary_proof_ms ?? 0) : 0;

  const meta: HistoryMeta = {
    ...res.meta,
    earliest_available: stored.length ? stored[0].t : null,
    latest_available: stored.length ? stored[stored.length - 1].t : null,
    bar_count: stored.length,
    returned_range: { from: stored.length ? stored[0].t : null, to: stored.length ? stored[stored.length - 1].t : null },
    completion_state: completion,
    gap_count: gaps.length,
    gaps: gaps.slice(0, 50),
    dataset_fingerprint: fingerprint(stored),
    // evidence observed by THIS walk (never inherited from prior state)
    boundary_evidence: res.meta.boundary_evidence,
  };

  // AUDIT FIX (P0-6): failure transparency. A sync SUCCEEDED only when the
  // venue actually answered (no transport error and not UNAVAILABLE). A failed
  // sync must never move `last_successful_sync_ms`, and a successful sync must
  // clear the previous error. `last_error` always reflects the LAST attempt.
  // AUDIT FIX (mandate bug 5): AMBIGUOUS_EMPTY (200 s:"ok", zero bars) is NOT
  // a successful sync either — an anomalous empty answer must never move the
  // success timestamp or clear the error channel.
  // FORENSIC TASK: a stalled walk (NO_PROGRESS) records a `reason` too, so a
  // no-progress attempt can never be stamped as a fresh successful sync.
  const syncSucceeded =
    !res.meta.reason &&
    res.meta.completion_state !== "UNAVAILABLE" &&
    res.meta.completion_state !== "AMBIGUOUS_EMPTY" &&
    res.meta.completion_state !== "INVALID_RESPONSE" &&
    res.meta.completion_state !== "NO_PROGRESS";
  const priorSuccessMs = prior?.last_successful_sync_ms ?? 0;
  const successMs = syncSucceeded ? attemptMs : priorSuccessMs;

  // Refuse the terminal write if the lease was lost mid-flight — another
  // process would already own this cell's truth and our row would overwrite it.
  lease.ensureOwned();
  store.putSync({
    symbol, timeframe,
    earliest_ts: meta.earliest_available, latest_ts: meta.latest_available,
    bar_count: meta.bar_count, completion_state: meta.completion_state,
    gap_count: meta.gap_count, dataset_fingerprint: meta.dataset_fingerprint,
    last_sync_ms: attemptMs, last_attempt_ms: attemptMs,
    last_successful_sync_ms: successMs,
    boundary_proof: boundaryProof,
    boundary_proof_ms: boundaryProofMs,
    last_error: res.meta.reason ?? null,
    retrieval_version: RETRIEVAL_VERSION, source: "ttt",
  });

  return {
    symbol, timeframe, fetched: res.candles.length, stored_total: after,
    added: after - before, incremental: canIncrement, meta,
    sync_succeeded: syncSucceeded,
    last_successful_sync_ms: successMs > 0 ? successMs : null,
    boundary_proven_this_attempt: boundaryProven,
    boundary_proof: boundaryProof,
  };
}

export { mergeCandles };
