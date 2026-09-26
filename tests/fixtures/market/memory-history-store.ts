/**
 * In-memory `HistoryStoreLike` double (test-only).
 *
 * It mirrors the REAL `HistoryStore` semantics that boundary logic depends on:
 *   - `put` upserts by (symbol,timeframe,t) with last-value-wins and NO deletion
 *   - `get` returns everything stored, ascending, with optional from/to/limit
 *   - `bounds`/`count` describe what is actually stored
 *   - `putSync`/`syncRow` persist the sync row verbatim
 *   - `touchSyncAttempt` only updates an EXISTING row (never creates one) and
 *     never moves `last_successful_sync_ms`
 *
 * Why a double: the real store needs the better-sqlite3 native binding, and the
 * forensic boundary semantics under test live in `syncHistory()`, not in SQL.
 * The double exists so those semantics are testable deterministically in every
 * environment. It is injected with `__setHistoryStore()` and never used in
 * production.
 */
import type { Candle } from "../../../src/lib/domain/types";
import type { TimeframeId } from "../../../src/lib/domain/timeframes";
import type { HistoryStoreLike, SyncRow } from "../../../src/lib/market/history-store";

export class MemoryHistoryStore implements HistoryStoreLike {
  /** symbol|timeframe -> (t -> candle) */
  readonly bars = new Map<string, Map<number, Candle>>();
  readonly rows = new Map<string, SyncRow>();
  /** every put() call, so a test can prove nothing was written without cause */
  readonly putCalls: { symbol: string; timeframe: string; timestamps: number[] }[] = [];

  private key(symbol: string, timeframe: string): string {
    return `${symbol}|${timeframe}`;
  }

  put(symbol: string, timeframe: TimeframeId, candles: Candle[]): number {
    if (candles.length === 0) return 0;
    this.putCalls.push({ symbol, timeframe, timestamps: candles.map((c) => c.t) });
    let m = this.bars.get(this.key(symbol, timeframe));
    if (!m) {
      m = new Map();
      this.bars.set(this.key(symbol, timeframe), m);
    }
    for (const c of candles) m.set(c.t, { ...c }); // last write wins, never deleted
    return candles.length;
  }

  get(symbol: string, timeframe: TimeframeId, from?: number, to?: number, limit?: number): Candle[] {
    const all = [...(this.bars.get(this.key(symbol, timeframe))?.values() ?? [])].sort((a, b) => a.t - b.t);
    let out = all;
    if (from !== undefined) out = out.filter((c) => c.t >= from);
    if (to !== undefined) out = out.filter((c) => c.t <= to);
    if (limit !== undefined && limit > 0) out = out.slice(-limit);
    return out;
  }

  count(symbol: string, timeframe: TimeframeId): number {
    return this.bars.get(this.key(symbol, timeframe))?.size ?? 0;
  }

  bounds(symbol: string, timeframe: TimeframeId): { earliest: number | null; latest: number | null } {
    const all = this.get(symbol, timeframe);
    return all.length ? { earliest: all[0].t, latest: all[all.length - 1].t } : { earliest: null, latest: null };
  }

  syncRow(symbol: string, timeframe: TimeframeId): SyncRow | null {
    const r = this.rows.get(this.key(symbol, timeframe));
    return r ? { ...r } : null;
  }

  allSyncRows(): SyncRow[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  putSync(r: SyncRow): void {
    this.rows.set(this.key(r.symbol, r.timeframe), { ...r });
  }

  touchSyncAttempt(symbol: string, timeframe: TimeframeId, atMs: number, error: string | null = null): void {
    const cur = this.rows.get(this.key(symbol, timeframe));
    if (!cur) return; // mirrors the real UPDATE-only statement
    this.rows.set(this.key(symbol, timeframe), {
      ...cur,
      last_sync_ms: atMs,
      last_attempt_ms: atMs,
      last_error: error ?? cur.last_error,
    });
  }

  /** symbol|timeframe cell lease (mirrors the SQLite sync_lease table) */
  readonly leases = new Map<string, { owner: string; expires: number }>();

  acquireSyncLease(key: string, owner: string, ttlMs: number): boolean {
    const now = Date.now();
    const cur = this.leases.get(key);
    if (cur && cur.expires > now && cur.owner !== owner) return false;
    this.leases.set(key, { owner, expires: now + ttlMs });
    return true;
  }

  renewSyncLease(key: string, owner: string, ttlMs: number): boolean {
    const cur = this.leases.get(key);
    const now = Date.now();
    if (!cur || cur.owner !== owner || cur.expires <= now) return false;
    cur.expires = now + ttlMs;
    return true;
  }

  releaseSyncLease(key: string, owner: string): void {
    const cur = this.leases.get(key);
    if (cur && cur.owner === owner) this.leases.delete(key);
  }

  totalBars(): number {
    let n = 0;
    for (const m of this.bars.values()) n += m.size;
    return n;
  }

  close(): void {
    /* nothing to release */
  }
}
