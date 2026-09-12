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
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
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
  last_error TEXT, retrieval_version TEXT NOT NULL DEFAULT '1.0.0',
  source TEXT NOT NULL DEFAULT 'ttt',
  PRIMARY KEY (symbol, timeframe)
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
  last_error: string | null;
  retrieval_version: string;
  source: string;
}

export class HistoryStore {
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
      `INSERT INTO history_sync (symbol,timeframe,earliest_ts,latest_ts,bar_count,completion_state,gap_count,dataset_fingerprint,last_sync_ms,last_attempt_ms,last_successful_sync_ms,last_error,retrieval_version,source)
       VALUES (@symbol,@timeframe,@earliest_ts,@latest_ts,@bar_count,@completion_state,@gap_count,@dataset_fingerprint,@last_sync_ms,@last_attempt_ms,@last_successful_sync_ms,@last_error,@retrieval_version,@source)
       ON CONFLICT(symbol,timeframe) DO UPDATE SET
         earliest_ts=excluded.earliest_ts, latest_ts=excluded.latest_ts, bar_count=excluded.bar_count,
         completion_state=excluded.completion_state, gap_count=excluded.gap_count,
         dataset_fingerprint=excluded.dataset_fingerprint, last_sync_ms=excluded.last_sync_ms,
         last_attempt_ms=excluded.last_attempt_ms, last_successful_sync_ms=excluded.last_successful_sync_ms,
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

  totalBars(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM candles").get() as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }
}

let inst: HistoryStore | null = null;
export function getHistoryStore(): HistoryStore {
  if (!inst) inst = new HistoryStore();
  return inst;
}
export function closeHistoryStore(): void {
  inst?.close();
  inst = null;
}

export interface SyncOptions {
  /** re-walk to the TTT boundary even if history is already stored */
  full?: boolean;
  maxChunks?: number;
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
}

/**
 * Synchronise one symbol/timeframe.
 *
 * First sync walks to the TTT boundary. Later syncs fetch only the tail after
 * the newest stored bar, so a full backfill is never repeated.
 */
export async function syncHistory(
  symbol: string,
  timeframe: TimeframeId,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const store = getHistoryStore();
  const spec = getTimeframe(timeframe)!;
  const before = store.count(symbol, timeframe);
  const bounds = store.bounds(symbol, timeframe);
  const prior = store.syncRow(symbol, timeframe);

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
      store.touchSyncAttempt(symbol, timeframe, Date.now());
      const stored = store.get(symbol, timeframe);
      return {
        symbol, timeframe, fetched: 0, stored_total: before, added: 0, incremental: true,
        skipped_reason: "no new bar has closed since the last sync",
        sync_succeeded: true, // nothing was asked of the venue; stored data stands
        last_successful_sync_ms: prior?.last_successful_sync_ms ?? null,
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
        },
      };
    }
  }

  const res = await fetchFullHistory(symbol, timeframe, {
    from: canIncrement ? (bounds.latest as number) - spec.minutes * 60 : undefined,
    maxChunks: opts.maxChunks,
  });

  // A `full` sync must PROVE the earliest boundary even when the stored range
  // already covers it: probe one chunk older than the oldest stored bar. TTT
  // answering `no_data` is the only authoritative confirmation.
  let boundaryProven = res.meta.completion_state === "COMPLETE_TO_TTT_BOUNDARY";
  if (opts.full && !boundaryProven) {
    const merged = mergeCandles(store.get(symbol, timeframe), res.candles).merged;
    const oldest = merged.length ? merged[0].t : null;
    if (oldest !== null) {
      const probe = await fetchFullHistory(symbol, timeframe, {
        to: oldest - spec.minutes * 60,
        maxChunks: 1,
      });
      // AUDIT FIX (mandate bug 5): zero candles alone do NOT prove the
      // boundary — an s:"ok" empty-success would slip through. Only the
      // explicit no-data signal (or a proven-boundary walk) counts.
      if (probe.candles.length === 0 &&
          (probe.meta.completion_state === "NO_DATA" || probe.meta.completion_state === "COMPLETE_TO_TTT_BOUNDARY")) {
        boundaryProven = true;
      } else if (probe.candles.length > 0) {
        store.put(symbol, timeframe, probe.candles);
      }
    }
  }

  store.put(symbol, timeframe, res.candles);
  const after = store.count(symbol, timeframe);

  // Recompute metadata over EVERYTHING stored, not just this fetch, so an
  // incremental sync still reports the true earliest boundary.
  const stored = store.get(symbol, timeframe);
  const gaps = detectGaps(stored, spec.minutes);

  // Recompute completion from the CURRENT stored data. A previously GAPPED
  // range whose holes were later backfilled must not stay GAPPED forever, and
  // a range that reached the venue boundary keeps that fact across syncs.
  const everReachedBoundary =
    boundaryProven ||
    res.meta.completion_state === "COMPLETE_TO_TTT_BOUNDARY" ||
    prior?.completion_state === "COMPLETE_TO_TTT_BOUNDARY";

  let completion: CompletionState;
  if (stored.length === 0) {
    if (res.meta.completion_state === "UNAVAILABLE") completion = "UNAVAILABLE";
    // AUDIT FIX (mandate bug 5): keep the empty-success state instead of
    // collapsing it to NO_DATA — they mean different things upstream.
    else if (res.meta.completion_state === "AMBIGUOUS_EMPTY") completion = "AMBIGUOUS_EMPTY";
    else completion = "NO_DATA";
  } else if (gaps.length > 0) {
    completion = "GAPPED";
  } else if (everReachedBoundary) {
    completion = "COMPLETE_TO_TTT_BOUNDARY";
  } else {
    completion = "PARTIAL";
  }

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
  };

  // AUDIT FIX (P0-6): failure transparency. A sync SUCCEEDED only when the
  // venue actually answered (no transport error and not UNAVAILABLE). A failed
  // sync must never move `last_successful_sync_ms`, and a successful sync must
  // clear the previous error. `last_error` always reflects the LAST attempt.
  // AUDIT FIX (mandate bug 5): AMBIGUOUS_EMPTY (200 s:"ok", zero bars) is NOT
  // a successful sync either — an anomalous empty answer must never move the
  // success timestamp or clear the error channel.
  const attemptMs = Date.now();
  const syncSucceeded =
    !res.meta.reason &&
    res.meta.completion_state !== "UNAVAILABLE" &&
    res.meta.completion_state !== "AMBIGUOUS_EMPTY";
  const priorSuccessMs = prior?.last_successful_sync_ms ?? 0;
  const successMs = syncSucceeded ? attemptMs : priorSuccessMs;

  store.putSync({
    symbol, timeframe,
    earliest_ts: meta.earliest_available, latest_ts: meta.latest_available,
    bar_count: meta.bar_count, completion_state: meta.completion_state,
    gap_count: meta.gap_count, dataset_fingerprint: meta.dataset_fingerprint,
    last_sync_ms: attemptMs, last_attempt_ms: attemptMs,
    last_successful_sync_ms: successMs,
    last_error: res.meta.reason ?? null,
    retrieval_version: RETRIEVAL_VERSION, source: "ttt",
  });

  return {
    symbol, timeframe, fetched: res.candles.length, stored_total: after,
    added: after - before, incremental: canIncrement, meta,
    sync_succeeded: syncSucceeded,
    last_successful_sync_ms: successMs > 0 ? successMs : null,
  };
}

export { mergeCandles };
