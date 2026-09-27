/**
 * MULTI-PROCESS CELL LEASE + CRASH-WINDOW PROOF INVALIDATION (closure gaps).
 *
 * Gap 1 — CROSS-PROCESS SERIALIZATION: the FIFO chain in `syncHistory()`
 * serializes same-cell callers inside ONE process only. Two processes sharing
 * `history.db` (two dev servers, a cron worker + a server) could interleave
 * the same READ-MODIFY-WRITE the in-process chain exists to protect. Fixed by
 * a TTL lease in the SAME SQLite file (`sync_lease`), taken around the cell
 * critical section, heartbeated across the venue walk, and re-verified before
 * every write (`ensureOwned`).
 *
 * Invariants pinned here:
 *   - a foreign, unexpired lease blocks the cell: no venue walk, no writes,
 *     no lease theft, fails after `leaseTimeoutMs` with an explicit error;
 *   - an EXPIRED foreign lease (holder presumed dead) is taken over;
 *   - a sync WAITING on the lease proceeds once the holder releases;
 *   - the lease is released on failure too (no leak);
 *   - the real SQLite implementation excludes a FOREIGN CONNECTION (the
 *     cross-process stand-in: separate connection to the same file);
 *   - CRASH WINDOW: a put that extends the dataset BEYOND the proven extent
 *     first persists the downgrade (proof dropped, completion weakened) — a
 *     crash before the final row write lands on truthful-unproven PARTIAL,
 *     never on a stale COMPLETE+proof over an extent the proof never covered,
 *     and a later successful sync re-proves from scratch.
 *
 * Determinism: fake venue + injected store + raised rate budget (same harness
 * as sync-concurrency.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakeVenue, type VenueBarSpec } from "./fixtures/market/fake-venue";
import { MemoryHistoryStore } from "./fixtures/market/memory-history-store";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-sync-lease-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
process.env.TTT_API_BASE = "https://apiv2.thetruetrade.io";

const STEP = 3600;
const newest = () => Math.floor(Date.now() / 1000 / STEP) * STEP;
const SYM = "BTCUSDT";
const TF = "1h" as const;
const KEY = `${SYM}|${TF}`;

function venueSpec(count: number): VenueBarSpec {
  return { stepSec: STEP, earliest: newest() - (count - 1) * STEP, count };
}

let store: MemoryHistoryStore;

beforeEach(async () => {
  process.env.TTT_RATE_PER_MIN = "60000";
  const { __setHistoryStore } = await import("../src/lib/market/history-store");
  store = new MemoryHistoryStore();
  __setHistoryStore(store);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.TTT_RATE_PER_MIN;
  const { __resetHistoryStore } = await import("../src/lib/market/history-store");
  __resetHistoryStore();
});

async function load() {
  const history = await import("../src/lib/market/history");
  const storeMod = await import("../src/lib/market/history-store");
  return { ...history, ...storeMod };
}

async function drain(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("cross-process cell lease", () => {
  it("1. a foreign unexpired lease blocks the cell: no venue walk, no writes, no theft, explicit timeout", async () => {
    const { syncHistory } = await load();
    const venue = makeFakeVenue(venueSpec(8));
    vi.stubGlobal("fetch", vi.fn(venue.fetchImpl));
    expect(store.acquireSyncLease(KEY, "other-process-42", 60_000)).toBe(true);

    const t0 = Date.now();
    await expect(
      syncHistory(SYM, TF, { full: true, leaseTimeoutMs: 400 }),
    ).rejects.toThrow(/cross-process sync lease/);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(350); // it actually waited for the holder

    expect(venue.requests.length).toBe(0); // never reached the venue
    expect(store.rows.size).toBe(0); // no sync row written
    expect(store.putCalls.length).toBe(0); // no candles written
    // the foreign lease is untouched: no theft, no release of someone else's hold
    expect(store.leases.get(KEY)).toEqual({ owner: "other-process-42", expires: expect.any(Number) });
  });

  it("2. an EXPIRED foreign lease (holder presumed dead) is taken over", async () => {
    const { syncHistory } = await load();
    const venue = makeFakeVenue(venueSpec(8));
    vi.stubGlobal("fetch", vi.fn(venue.fetchImpl));
    store.acquireSyncLease(KEY, "stalled-process", 60_000);
    store.leases.get(KEY)!.expires = Date.now() - 1_000; // TTL elapsed

    const res = await syncHistory(SYM, TF, { full: true, leaseTimeoutMs: 5_000 });
    expect(res.sync_succeeded).toBe(true);
    const row = store.syncRow(SYM, TF)!;
    expect(row.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(row.boundary_proof).toBe("TTT_NO_DATA");
    expect(store.leases.has(KEY)).toBe(false); // our hold released after the body
  });

  it("3. a sync waiting on the lease proceeds once the holder releases it", async () => {
    const { syncHistory } = await load();
    const venue = makeFakeVenue(venueSpec(8));
    vi.stubGlobal("fetch", vi.fn(venue.fetchImpl));
    store.acquireSyncLease(KEY, "holder-now", 60_000);

    const p = syncHistory(SYM, TF, { full: true, leaseTimeoutMs: 10_000 });
    await drain(4);
    expect(venue.requests.length).toBe(0); // still waiting, not walking

    store.releaseSyncLease(KEY, "holder-now");
    const res = await p;
    expect(res.sync_succeeded).toBe(true);
    expect(venue.requests.length).toBeGreaterThan(0);
    expect(store.leases.has(KEY)).toBe(false);
  });

  it("4. the lease is released when the sync FAILS (no leak blocks the next run)", async () => {
    const { syncHistory } = await load();
    const failVenue = makeFakeVenue(venueSpec(8), { failure: "http500" }); // 5xx not retried
    vi.stubGlobal("fetch", vi.fn(failVenue.fetchImpl));

    const res = await syncHistory(SYM, TF, { full: true, leaseTimeoutMs: 5_000 });
    expect(res.sync_succeeded).toBe(false);
    expect(store.leases.has(KEY)).toBe(false); // finally-block released it

    // and the cell is immediately re-syncable
    const okVenue = makeFakeVenue(venueSpec(8));
    vi.stubGlobal("fetch", vi.fn(okVenue.fetchImpl));
    const retry = await syncHistory(SYM, TF, { full: true, leaseTimeoutMs: 5_000 });
    expect(retry.sync_succeeded).toBe(true);
  });

  it("5. a REAL second OS process holding the lease blocks the sync until its TTL expires", async () => {
    const { syncHistory, HistoryStore, __setHistoryStore } = await load();
    const dbPath = path.join(TMP, "two-process.db");
    const real = new HistoryStore(dbPath);
    __setHistoryStore(real);

    const venue = makeFakeVenue(venueSpec(8));
    vi.stubGlobal("fetch", vi.fn(venue.fetchImpl));

    // A genuine second OS process: opens the same history.db, takes the lease
    // with the same SQL the store uses, holds it for ~2.5s, exits without
    // releasing (crash-style: only the TTL can free it).
    const childScript = path.join(TMP, "lease-holder.cjs");
    fs.writeFileSync(
      childScript,
      `const Database = require(require("path").join(process.cwd(), "node_modules", "better-sqlite3"));
       const [dbPath, key, ttlMs] = process.argv.slice(2);
       const db = new Database(dbPath);
       const now = Date.now();
       db.prepare("INSERT INTO sync_lease (key, owner, acquired_ms, expires_ms) VALUES (?,?,?,?)")
         .run(key, "child-process:" + process.pid, now, now + Number(ttlMs));
       console.log("child-holding:" + process.pid);
       setTimeout(() => { try { db.close(); } catch {} }, Number(ttlMs));`,
    );
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [childScript, dbPath, KEY, "2500"], { stdio: ["ignore", "pipe", "pipe"] });
    const childPidLine = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d: Buffer) => { out += d; if (out.includes("child-holding:")) resolve(out.trim()); });
      child.stderr.on("data", (d: Buffer) => reject(new Error(String(d))));
      child.on("exit", (code) => reject(new Error(`child exited early (${code})`)));
      setTimeout(() => reject(new Error("child never reported")), 5_000);
    });
    expect(childPidLine).toContain("child-holding:");

    const t0 = Date.now();
    const res = await syncHistory(SYM, TF, { full: true, leaseTimeoutMs: 15_000 });
    const waited = Date.now() - t0;
    expect(res.sync_succeeded).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(2_000); // really waited on the OTHER PROCESS's TTL
    expect(venue.requests.length).toBeGreaterThan(0);
    const row = real.syncRow(SYM, TF)!;
    expect(row.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(row.boundary_proof).toBe("TTT_NO_DATA");
    // the child exits at its TTL — it may already be gone by now
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.on("exit", r)));

    real.close();
  });

  it("6. real SQLite store: a lease held by a SEPARATE CONNECTION (cross-process stand-in) excludes the sync", async () => {
    const { syncHistory, HistoryStore, __setHistoryStore } = await load();
    const dbPath = path.join(TMP, "cross-connection.db");
    const real = new HistoryStore(dbPath);
    __setHistoryStore(real); // replaces the memory double for this test

    const Database = (await import("better-sqlite3")).default;
    const ext = new Database(dbPath); // independent connection, as another process would have
    const now = Date.now();
    ext
      .prepare("INSERT INTO sync_lease (key, owner, acquired_ms, expires_ms) VALUES (?,?,?,?)")
      .run(KEY, "external-process", now, now + 60_000);

    const venue = makeFakeVenue(venueSpec(8));
    vi.stubGlobal("fetch", vi.fn(venue.fetchImpl));

    // blocked by the external connection's lease — against the REAL schema
    await expect(
      syncHistory(SYM, TF, { full: true, leaseTimeoutMs: 400 }),
    ).rejects.toThrow(/cross-process sync lease/);
    expect(venue.requests.length).toBe(0);

    // holder releases -> the same sync now succeeds and proves the boundary
    ext.prepare("DELETE FROM sync_lease WHERE key = ?").run(KEY);
    const res = await syncHistory(SYM, TF, { full: true, leaseTimeoutMs: 10_000 });
    expect(res.sync_succeeded).toBe(true);
    const row = real.syncRow(SYM, TF)!;
    expect(row.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(row.boundary_proof).toBe("TTT_NO_DATA");
    // no lease rows left behind in the real database
    expect(ext.prepare("SELECT COUNT(*) c FROM sync_lease").get()).toEqual({ c: 0 });

    ext.close();
    real.close();
  });
});

describe("crash-window proof invalidation", () => {
  it("7. a crash between an EXTENDING put and the final row write lands on PARTIAL+no-proof (never stale proof), and a later sync re-proves", async () => {
    const { syncHistory } = await load();

    // Phase 1: establish a proven extent of 10 bars (venue proves its boundary).
    const venue10 = makeFakeVenue(venueSpec(10));
    vi.stubGlobal("fetch", vi.fn(venue10.fetchImpl));
    await syncHistory(SYM, TF, { full: true, leaseTimeoutMs: 5_000 });
    let row = store.syncRow(SYM, TF)!;
    expect(row.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(row.boundary_proof).toBe("TTT_NO_DATA");
    const provenEarliest = row.earliest_ts!;
    expect(store.count(SYM, TF)).toBe(10);

    // Phase 2: the venue now holds 12 bars — two OLDER than our proven extent,
    // and it refuses boundary questions (repeat_newest => NO_PROGRESS, no proof).
    const extendedSpec: VenueBarSpec = { stepSec: STEP, earliest: newest() - 11 * STEP, count: 12 };
    const extendNoProof = makeFakeVenue(extendedSpec, { belowOldest: "repeat_newest" });
    vi.stubGlobal("fetch", vi.fn(extendNoProof.fetchImpl));

    // Simulate the crash: the FIRST putSync is the honest downgrade (proof
    // dropped BEFORE bars land); the SECOND is the final row write — kill it.
    const origPutSync = store.putSync.bind(store);
    let putSyncCalls = 0;
    store.putSync = (r) => {
      putSyncCalls += 1;
      if (putSyncCalls === 2) throw new Error("simulated crash before final row write");
      origPutSync(r);
    };

    await expect(
      syncHistory(SYM, TF, { full: true, leaseTimeoutMs: 5_000 }),
    ).rejects.toThrow("simulated crash before final row write");
    expect(putSyncCalls).toBe(2); // downgrade first, final write second

    // The bars landed (the walk's extension is stored)…
    expect(store.count(SYM, TF)).toBe(12);
    expect(store.bounds(SYM, TF).earliest).toBeLessThan(provenEarliest);
    // …but the row can NEVER claim a proof that no longer covers that extent.
    row = store.syncRow(SYM, TF)!;
    expect(row.completion_state).toBe("PARTIAL");
    expect(row.boundary_proof).toBeNull();
    expect(row.boundary_proof_ms).toBe(0);
    expect(store.leases.has(KEY)).toBe(false); // lease released despite the throw

    // Phase 3: recovery — a later successful sync re-proves the new extent.
    store.putSync = origPutSync;
    const venue12 = makeFakeVenue(extendedSpec); // same bars, honest no_data below oldest
    vi.stubGlobal("fetch", vi.fn(venue12.fetchImpl));
    const res = await syncHistory(SYM, TF, { full: true, leaseTimeoutMs: 5_000 });
    expect(res.sync_succeeded).toBe(true);
    expect(res.boundary_proven_this_attempt).toBe(true);
    row = store.syncRow(SYM, TF)!;
    expect(row.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(row.boundary_proof).toBe("TTT_NO_DATA");
    expect(row.earliest_ts).toBe(venue12.held[0].t);
  });
});
