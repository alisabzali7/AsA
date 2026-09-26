/**
 * SYNC CONCURRENCY TRUTH (Task 06 — boundary proof under concurrent writers).
 *
 * Verified defect: `syncHistory()` is a READ-MODIFY-WRITE transaction over a
 * cell's sync row (read prior/bounds → async venue walk → write completion +
 * boundary_proof, last-writer-wins) with NO per-cell serialization. Two
 * concurrent callers (chart `sync=full` + backtest `sync=full`, double click,
 * parallel API clients) could interleave:
 *
 *   1. INTERLEAVE: a second sync issued venue requests while the first was
 *      still mid-transaction (two overlapping walks on one cell).
 *   2. PROOF CLOBBER: a caller that read `prior` before another caller proved
 *      the boundary later overwrote the fresh TTT_NO_DATA proof with its own
 *      stale snapshot — a failed concurrent sync erased a fresh proof AND the
 *      successful-sync timestamp.
 *
 * Invariants pinned here:
 *   - same-cell syncs are strictly serialized (FIFO); no interleaved walks;
 *   - whatever serial order occurs, a fresh explicit boundary proof survives a
 *     concurrent failing sync (both serial orders end COMPLETE+proof).
 *
 * Determinism: fake venue + in-memory store + raised rate budget (same harness
 * as history-boundary.test.ts). The failing sync's first venue response is
 * gated on an explicitly released promise, so both interleavings are scripted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakeVenue, type VenueBarSpec } from "./fixtures/market/fake-venue";
import { MemoryHistoryStore } from "./fixtures/market/memory-history-store";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-sync-race-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
process.env.TTT_API_BASE = "https://apiv2.thetruetrade.io";

const STEP = 3600;
const newest = () => Math.floor(Date.now() / 1000 / STEP) * STEP;
const SYM = "BTCUSDT";
const TF = "1h" as const;

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

/** Let every already-scheduled microtask/macrotask turn run (no real network). */
async function drain(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("syncHistory per-cell serialization", () => {
  it("1. a second sync for the SAME cell never interleaves venue walks with an in-flight sync", async () => {
    const { syncHistory } = await load();
    const venue = makeFakeVenue(venueSpec(12));
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    let historyCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/futures/udf/history")) {
        historyCalls++;
        if (historyCalls === 1) await gate; // first walk's first chunk hangs
      }
      return venue.fetchImpl(input);
    }));

    const pA = syncHistory(SYM, TF, { full: true });
    await drain(2); // A acquires the cell and reaches the gated venue call
    expect(historyCalls).toBe(1);

    const pB = syncHistory(SYM, TF, { full: true });
    await drain(6); // B must NOT start its own walk while A is mid-transaction
    expect(historyCalls).toBe(1); // pre-fix: B fired its own request -> >= 2

    releaseFirst();
    await Promise.all([pA, pB]);
    // B ran only after A finished; the cell ends proven, once.
    expect(historyCalls).toBeGreaterThan(1);
    const row = store.syncRow(SYM, TF)!;
    expect(row.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(row.boundary_proof).toBe("TTT_NO_DATA");
  });

  it("2. a fresh boundary proof survives a concurrent failing sync (no last-writer-wins clobber)", async () => {
    const { syncHistory } = await load();
    const proveVenue = makeFakeVenue(venueSpec(12)); // full data + no_data below oldest
    const failVenue = makeFakeVenue(venueSpec(12), { failure: "http500" });
    let releaseFail!: () => void;
    const gate = new Promise<void>((r) => { releaseFail = r; });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls++;
      if (calls === 1) {
        // the FIRST sync's first venue call hangs, then fails with 500
        await gate;
        return failVenue.fetchImpl(input);
      }
      return proveVenue.fetchImpl(input);
    }));

    // The failing sync arrives FIRST (FIFO slot 1); the proving sync second.
    const pFail = syncHistory(SYM, TF, { full: true });
    const pProve = syncHistory(SYM, TF, { full: true });
    await drain(); // with serialization: fail is gated, prove is QUEUED
    releaseFail();
    const [failRes, proveRes] = await Promise.all([pFail, pProve]);

    // Whatever the serial order, the final row must hold the fresh proof —
    // the failing writer must not erase the proving writer's evidence.
    const row = store.syncRow(SYM, TF)!;
    expect(row.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(row.boundary_proof).toBe("TTT_NO_DATA");
    expect(row.boundary_proof_ms).toBeGreaterThan(0);
    expect(proveRes.boundary_proven_this_attempt).toBe(true);
    // and the failing sync must still report itself as failed
    expect(failRes.sync_succeeded).toBe(false);
    // serial order is fail→prove (FIFO): the LAST attempt succeeded, so the
    // error channel reflects the prove run, and its success timestamp stands.
    expect(row.last_error).toBeNull();
    expect(row.last_successful_sync_ms).toBeGreaterThan(0);
    expect(failRes.last_successful_sync_ms).toBeNull(); // the failed attempt never moved the success clock
  });

  it("3. different cells still sync concurrently (serialization is per-cell, not global)", async () => {
    const { syncHistory } = await load();
    const venueA = makeFakeVenue(venueSpec(8));
    const venueB = makeFakeVenue(venueSpec(8));
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const venue = url.includes("ETHUSDT") ? venueB : venueA;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); // hold the request open a tick
      try { return await venue.fetchImpl(input); } finally { active--; }
    }));

    await Promise.all([
      syncHistory("BTCUSDT", TF, { full: true }),
      syncHistory("ETHUSDT", TF, { full: true }),
    ]);
    expect(maxActive).toBeGreaterThan(1); // both cells walked at the same time
    expect(store.syncRow("BTCUSDT", TF)!.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(store.syncRow("ETHUSDT", TF)!.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
  });

  it("4. a failed sync never breaks the next queued sync on the same cell (chain survives rejection)", async () => {
    const { syncHistory } = await load();
    const failVenue = makeFakeVenue(venueSpec(8), { failure: "http500" }); // 5xx is NOT retried
    const okVenue = makeFakeVenue(venueSpec(8));
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls++;
      return calls === 1 ? failVenue.fetchImpl(input) : okVenue.fetchImpl(input);
    }));

    const results = await Promise.all([
      syncHistory(SYM, TF, { full: true }),
      syncHistory(SYM, TF, { full: true }),
    ]);
    expect(results[0].sync_succeeded).toBe(false);
    expect(results[1].sync_succeeded).toBe(true);
    const row = store.syncRow(SYM, TF)!;
    expect(row.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(row.boundary_proof).toBe("TTT_NO_DATA");
  });
});
