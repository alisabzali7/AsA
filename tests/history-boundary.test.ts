/**
 * FORENSIC TASK — TTT HISTORY BOUNDARY PROOF (no false boundary proof).
 *
 * Invariant under test:
 *
 *   NO PROGRESS != NO DATA != TTT BOUNDARY
 *
 * `COMPLETE_TO_TTT_BOUNDARY` may ONLY be produced from explicit, authoritative
 * upstream evidence: the venue answering `s:"no_data"` for a probe window
 * strictly older than the bars already held. Overlap, empty-but-ok answers,
 * stalled cursors, duplicate windows and inherited completion flags can never
 * prove a boundary.
 *
 * Determinism: the venue is a scripted fake (`tests/fixtures/market/fake-venue`)
 * stubbed as `fetch`, the store is an in-memory double
 * (`tests/fixtures/market/memory-history-store`) injected via `__setHistoryStore`
 * because the real store needs the better-sqlite3 native binding, and the rate
 * budget is raised via env so no request ever waits for a token. No network, no
 * sleeps, exact request counting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakeVenue, stubVenue, type VenueBarSpec } from "./fixtures/market/fake-venue";
import { MemoryHistoryStore } from "./fixtures/market/memory-history-store";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-boundary-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
process.env.TTT_API_BASE = "https://apiv2.thetruetrade.io";

const STEP = 3600; // 1h
const newest = () => Math.floor(Date.now() / 1000 / STEP) * STEP;

/** A venue holding `count` contiguous 1h bars ending at the newest closed hour. */
function venueSpec(count: number, holes: number[] = []): VenueBarSpec {
  return { stepSec: STEP, earliest: newest() - (count - 1) * STEP, count, holes };
}

let store: MemoryHistoryStore;

beforeEach(async () => {
  // The rate limiter is NOT what these tests exercise, and the production budget
  // (24/min) would make every request wait on a refill. Raise it before any
  // production module is imported so admission is instant and sleep-free.
  // Boundary semantics do not depend on the budget.
  process.env.TTT_RATE_PER_MIN = "60000";
  const { __setHistoryStore } = await import("../src/lib/market/history-store");
  store = new MemoryHistoryStore();
  __setHistoryStore(store);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.TTT_RATE_PER_MIN; // never leak the raised budget to another file
  const { __resetHistoryStore } = await import("../src/lib/market/history-store");
  __resetHistoryStore();
});

/* ───────────────────────────── helpers ───────────────────────────── */

async function load() {
  const history = await import("../src/lib/market/history");
  const storeMod = await import("../src/lib/market/history-store");
  return { ...history, ...storeMod };
}

const SYM = "BTCUSDT";
const TF = "1h" as const;

/** Every COMPLETE claim in these tests must be backed by a recorded proof. */
function expectCompleteIsProven(row: { completion_state: string; boundary_proof: string | null; boundary_proof_ms: number }): void {
  if (row.completion_state !== "COMPLETE_TO_TTT_BOUNDARY") return;
  expect(row.boundary_proof).toBe("TTT_NO_DATA");
  expect(row.boundary_proof_ms).toBeGreaterThan(0);
}

/* ══════════════════════════ A–D: walk-level semantics ══════════════════════════ */

describe("walk-level boundary semantics", () => {
  it("A. overlap is NOT a boundary (the venue repeats its window, no no_data)", async () => {
    const { fetchFullHistory } = await load();
    const venue = makeFakeVenue(venueSpec(6), { ignoreWindow: true }); // window ignored -> identical answer
    stubVenue(venue);

    const res = await fetchFullHistory(SYM, TF, {});

    expect(res.candles).toHaveLength(6);
    expect(res.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(res.meta.completion_state).toBe("NO_PROGRESS");
    expect(res.meta.boundary_evidence).toBeNull();
    expect(res.meta.reason).toMatch(/no new bar|no-progress/i);
    expect(venue.requests).toHaveLength(2); // stalls immediately, never loops on the same window
  });

  it("D. a successful response that adds no new bar is not proof", async () => {
    const { fetchFullHistory } = await load();
    // the venue holds bars, but answers the below-oldest probe with its newest bars again
    const venue = makeFakeVenue(venueSpec(5), { belowOldest: "repeat_newest" });
    stubVenue(venue);

    const res = await fetchFullHistory(SYM, TF, {});

    expect(res.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(res.meta.completion_state).toBe("NO_PROGRESS");
    expect(res.meta.boundary_evidence).toBeNull();
    expect(res.meta.duplicate_count).toBeGreaterThan(0); // pure overlap was observed and reported
    expect(venue.requests).toHaveLength(2);
  });

  it("B. an explicit s:\"no_data\" below the oldest held bar IS the boundary", async () => {
    const { fetchFullHistory } = await load();
    const spec = venueSpec(5);
    const venue = makeFakeVenue(spec);
    stubVenue(venue);

    const res = await fetchFullHistory(SYM, TF, {});

    expect(res.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(res.meta.boundary_evidence).toBe("TTT_NO_DATA");
    expect(res.candles).toHaveLength(5);
    expect(venue.requests).toHaveLength(2);
    // the proving probe asked for a window STRICTLY older than the oldest bar held
    expect(venue.requests[1].to).toBe(spec.earliest - STEP);
    expect(venue.requests[1].to).toBeLessThan(res.candles[0].t);
  });

  it("B2. no_data for a window that overlaps already-held bars proves nothing", async () => {
    const { fetchFullHistory } = await load();
    const venue = makeFakeVenue(venueSpec(5), { alwaysNoData: true });
    stubVenue(venue);
    const seed = [
      { t: newest() - 2 * STEP, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 },
      { t: newest() - STEP, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 },
    ];

    // the walk starts from bars held ABOVE the requested window: a no_data here
    // says nothing about the earliest edge
    const res = await fetchFullHistory(SYM, TF, { seed });

    expect(res.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(res.meta.completion_state).toBe("NO_PROGRESS");
    expect(res.meta.boundary_evidence).toBeNull();
    expect(res.meta.reason).toMatch(/overlaps already-held bars/i);
  });

  it("C. s:\"ok\" with zero bars is ambiguous, never a boundary", async () => {
    const { fetchFullHistory } = await load();
    const venue = makeFakeVenue(venueSpec(4), { belowOldest: "ok_empty" });
    stubVenue(venue);

    const res = await fetchFullHistory(SYM, TF, {});

    expect(res.candles).toHaveLength(4); // the newer chunk's bars are kept
    expect(res.meta.completion_state).toBe("PARTIAL");
    expect(res.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(res.meta.boundary_evidence).toBeNull();
    expect(res.meta.reason).toMatch(/zero candles/i);
  });

  it("E. a bounded walk never claims the boundary without an authoritative probe", async () => {
    const { fetchFullHistory } = await load();
    const venue = makeFakeVenue(venueSpec(30), { maxBarsPerResponse: 5 });
    stubVenue(venue);

    const bounded = await fetchFullHistory(SYM, TF, { maxChunks: 2 });
    expect(bounded.meta.completion_state).toBe("PARTIAL");
    expect(bounded.meta.boundary_evidence).toBeNull();

    // only walking until the venue answers no_data proves it
    const walked = await fetchFullHistory(SYM, TF, {});
    expect(walked.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(walked.meta.boundary_evidence).toBe("TTT_NO_DATA");
  });

  it("an explicit `from` bound yields PARTIAL, not a boundary claim", async () => {
    const { fetchFullHistory } = await load();
    const venue = makeFakeVenue(venueSpec(10));
    stubVenue(venue);

    const res = await fetchFullHistory(SYM, TF, { from: newest() - 3 * STEP, maxChunks: 5 });

    expect(res.meta.completion_state).toBe("PARTIAL");
    expect(res.meta.boundary_evidence).toBeNull();
  });
});

/* ═════════════════════ F–H: sync-level proof vs retention ═════════════════════ */

describe("sync-level semantics: fresh proof vs retained historical completeness", () => {
  it("a first sync reaches COMPLETE only through explicit no_data and records its proof", async () => {
    const { syncHistory } = await load();
    const venue = makeFakeVenue(venueSpec(8));
    stubVenue(venue);

    const r = await syncHistory(SYM, TF, { full: true });

    expect(r.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(r.boundary_proven_this_attempt).toBe(true);
    expect(r.boundary_proof).toBe("TTT_NO_DATA");
    expect(r.sync_succeeded).toBe(true);
    expectCompleteIsProven(store.syncRow(SYM, TF)!);
  });

  it("F. prior COMPLETE + current network failure: data preserved, no fresh success, no fresh proof", async () => {
    const { syncHistory } = await load();
    const first = makeFakeVenue(venueSpec(8));
    stubVenue(first);
    const sync1 = await syncHistory(SYM, TF, { full: true });
    const row1 = store.syncRow(SYM, TF)!;
    const barsAfter1 = store.count(SYM, TF);

    // the venue goes down
    const down = makeFakeVenue(venueSpec(8), { failure: "network" });
    stubVenue(down);
    const sync2 = await syncHistory(SYM, TF, { full: true });
    const row2 = store.syncRow(SYM, TF)!;

    expect(sync2.boundary_proven_this_attempt).toBe(false);
    expect(sync2.sync_succeeded).toBe(false);
    expect(store.count(SYM, TF)).toBe(barsAfter1); // history preserved
    expect(row2.earliest_ts).toBe(row1.earliest_ts);
    expect(row2.last_successful_sync_ms).toBe(row1.last_successful_sync_ms); // NOT moved
    expect(row2.last_attempt_ms).toBeGreaterThanOrEqual(row1.last_attempt_ms);
    expect(row2.last_error).toBeTruthy();
    // the completion is RETAINED historical evidence, and its proof record was NOT refreshed
    expect(row2.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(row2.boundary_proof).toBe("TTT_NO_DATA");
    expect(row2.boundary_proof_ms).toBe(row1.boundary_proof_ms);
    expectCompleteIsProven(row2);
    expect(sync1.boundary_proof).toBe("TTT_NO_DATA");
  });

  it("G. prior COMPLETE + current s:\"ok\" empty: no fresh proof, no fresh success", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(8)));
    await syncHistory(SYM, TF, { full: true });
    const row1 = store.syncRow(SYM, TF)!;

    stubVenue(makeFakeVenue(venueSpec(8), { belowOldest: "ok_empty" }));
    const sync2 = await syncHistory(SYM, TF, { full: true });
    const row2 = store.syncRow(SYM, TF)!;

    expect(sync2.meta.boundary_evidence).toBeNull();
    expect(sync2.boundary_proven_this_attempt).toBe(false);
    expect(sync2.sync_succeeded).toBe(false); // an anomalous empty answer is not a success
    expect(row2.last_successful_sync_ms).toBe(row1.last_successful_sync_ms);
    expect(row2.boundary_proof_ms).toBe(row1.boundary_proof_ms); // proof NOT refreshed
    expect(row2.bar_count).toBe(row1.bar_count);
  });

  it("G2. the same ambiguous-empty answer creates NO completion when there is no prior proof", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(4), { belowOldest: "ok_empty" }));

    const r = await syncHistory(SYM, TF, { full: true });

    expect(r.boundary_proven_this_attempt).toBe(false);
    expect(r.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(store.syncRow(SYM, TF)!.boundary_proof).toBeNull();
  });

  it("H. prior PARTIAL + later older data extends history; completion still needs explicit evidence", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(20), { maxBarsPerResponse: 5 }));

    const bounded = await syncHistory(SYM, TF, { full: true, maxChunks: 1 });
    expect(bounded.meta.completion_state).toBe("PARTIAL");
    const partialEarliest = store.bounds(SYM, TF).earliest!;

    // the venue now serves 40 MORE older bars (contiguous), but the walk is
    // still bounded: the dataset extends older and the boundary stays unproven
    stubVenue(makeFakeVenue(venueSpec(60), { maxBarsPerResponse: 5 }));
    const extended = await syncHistory(SYM, TF, { full: true, maxChunks: 3 });
    expect(store.bounds(SYM, TF).earliest!).toBeLessThan(partialEarliest); // extended older
    expect(extended.added).toBeGreaterThan(0);
    expect(extended.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(extended.boundary_proven_this_attempt).toBe(false);

    // only a walk that reaches the venue's explicit no_data completes it
    const proven = await syncHistory(SYM, TF, { full: true });
    expect(proven.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(proven.boundary_proven_this_attempt).toBe(true);
    expectCompleteIsProven(store.syncRow(SYM, TF)!);
  });

  it("a prior COMPLETE is INVALIDATED when the dataset grows older than the verified extent", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(10)));
    const sync1 = await syncHistory(SYM, TF, { full: true });
    expect(sync1.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    const verifiedEarliest = store.bounds(SYM, TF).earliest!;

    // the venue reveals 20 contiguous OLDER bars; the bounded walk collects the
    // first 12 (3 per chunk x 4 chunks) and never reaches an explicit no_data
    stubVenue(makeFakeVenue(venueSpec(30), { maxBarsPerResponse: 3 }));
    const sync2 = await syncHistory(SYM, TF, { full: true, maxChunks: 4 });

    expect(store.bounds(SYM, TF).earliest!).toBeLessThan(verifiedEarliest); // dataset grew older
    expect(sync2.added).toBeGreaterThan(0);
    expect(sync2.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY"); // old proof no longer covers it
    expect(sync2.boundary_proven_this_attempt).toBe(false);
    const row = store.syncRow(SYM, TF)!;
    expect(row.boundary_proof).toBeNull(); // stale proof dropped with the extent it covered
    expect(row.boundary_proof_ms).toBe(0);
  });

  it("a skipped sync (no round trip) never claims a fresh proof", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(6)));
    await syncHistory(SYM, TF, { full: true });
    const row1 = store.syncRow(SYM, TF)!;

    const skipped = await syncHistory(SYM, TF, {}); // no new bar closed -> no request

    expect(skipped.skipped_reason).toMatch(/no new bar/i);
    expect(skipped.boundary_proven_this_attempt).toBe(false);
    expect(skipped.boundary_proof).toBe(row1.boundary_proof);
    expect(store.syncRow(SYM, TF)!.boundary_proof_ms).toBe(row1.boundary_proof_ms);
  });
});

/* ══════════════════════════ I–J: gaps and no fabrication ══════════════════════ */

describe("gap semantics stay truthful and nothing is fabricated", () => {
  it("I. a real venue gap yields GAPPED — never COMPLETE — even with boundary evidence", async () => {
    const { syncHistory } = await load();
    const spec = venueSpec(10, [newest() - 5 * STEP]); // one genuine missing bar
    const venue = makeFakeVenue(spec);
    stubVenue(venue);

    const r = await syncHistory(SYM, TF, { full: true });
    const row = store.syncRow(SYM, TF)!;

    expect(r.meta.boundary_evidence).toBe("TTT_NO_DATA"); // evidence was observed
    expect(r.meta.completion_state).toBe("GAPPED"); // but the dataset is not clean
    expect(r.meta.gap_count).toBe(1);
    expect(r.meta.data_quality).toBe("GAPPED");
    expect(row.completion_state).toBe("GAPPED");
    // the hole is reported, never filled
    expect(store.get(SYM, TF).some((c) => c.t === newest() - 5 * STEP)).toBe(false);
  });

  it("I2. a stall with a gap is not COMPLETE either", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(10, [newest() - 4 * STEP]), { belowOldest: "repeat_newest" }));

    const r = await syncHistory(SYM, TF, { full: true });

    expect(r.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(r.meta.gap_count).toBeGreaterThan(0);
    expect(store.syncRow(SYM, TF)!.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
  });

  it("I3. a later backfill of the hole clears GAPPED and can complete", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(10, [newest() - 5 * STEP])));
    const gapped = await syncHistory(SYM, TF, { full: true });
    expect(gapped.meta.completion_state).toBe("GAPPED");

    stubVenue(makeFakeVenue(venueSpec(10))); // the venue now serves the missing bar
    const healed = await syncHistory(SYM, TF, { full: true });

    expect(healed.meta.gap_count).toBe(0);
    expect(healed.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(healed.boundary_proven_this_attempt).toBe(true);
  });

  it("J. no synthetic bars: stored timestamps are exactly the venue's timestamps", async () => {
    const { syncHistory } = await load();
    const spec = venueSpec(12, [spec_hole()]);
    const venue = makeFakeVenue(spec);
    stubVenue(venue);

    await syncHistory(SYM, TF, { full: true });

    const held = new Set(venue.heldTimestamps());
    const stored = store.get(SYM, TF);
    expect(stored.length).toBeGreaterThan(0);
    for (const c of stored) {
      expect(held.has(c.t), `bar ${c.t} was never served by the venue`).toBe(true);
    }
    // nothing invented around the hole either
    expect(stored.some((c) => c.t === spec_hole())).toBe(false);
    expect(stored.map((c) => c.t)).toEqual([...stored.map((c) => c.t)].sort((a, b) => a - b));
  });

  it("J2. stalled / ambiguous / failed attempts write no invented bar", async () => {
    const { syncHistory } = await load();
    const good = makeFakeVenue(venueSpec(6));
    stubVenue(good);
    await syncHistory(SYM, TF, { full: true });
    const before = store.get(SYM, TF).map((c) => c.t);

    stubVenue(makeFakeVenue(venueSpec(6), { belowOldest: "repeat_newest" }));
    await syncHistory(SYM, TF, { full: true });
    expect(store.get(SYM, TF).map((c) => c.t)).toEqual(before);

    stubVenue(makeFakeVenue(venueSpec(6), { failure: "http500" }));
    await syncHistory(SYM, TF, { full: true });
    expect(store.get(SYM, TF).map((c) => c.t)).toEqual(before);

    // 1D derivation is NOT part of the boundary path
    const udf = fs.readFileSync("src/lib/ttt/udf.ts", "utf8");
    expect(udf).toMatch(/export function derive1DFrom8h/);
    for (const f of ["src/lib/market/history.ts", "src/lib/market/history-store.ts"]) {
      expect(fs.readFileSync(f, "utf8")).not.toMatch(/derive1D/);
    }
  });

  function spec_hole(): number {
    return newest() - 6 * STEP;
  }
});

/* ═══════════════════════════ adversarial sequences ═══════════════════════════ */

describe("adversarial sequences", () => {
  it("valid bars → same bars again → same bars again → no explicit boundary is never COMPLETE", async () => {
    const { syncHistory } = await load();
    const venue = makeFakeVenue(venueSpec(6), { ignoreWindow: true });
    stubVenue(venue);

    const requestsPerAttempt: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = venue.requests.length;
      const r = await syncHistory(SYM, TF, { full: true });
      requestsPerAttempt.push(venue.requests.length - before);
      expect(r.meta.completion_state, `attempt ${i + 1}`).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
      expect(r.boundary_proven_this_attempt).toBe(false);
      expect(store.syncRow(SYM, TF)!.boundary_proof ?? null).toBeNull();
    }
    // Every attempt stops at the FIRST stalled chunk (walk chunk 1 + stalled
    // chunk 2 + the full-sync older-than-oldest probe = 3 requests). Repeating
    // the same window is never re-requested: no unbounded loop exists.
    expect(requestsPerAttempt).toEqual([3, 3, 3]);
    expect(store.count(SYM, TF)).toBe(venue.held.length); // and nothing grew
  });

  it("valid bars → ok-empty → network failure never becomes COMPLETE", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(6), { maxBarsPerResponse: 2 }));
    const a = await syncHistory(SYM, TF, { full: true, maxChunks: 1 });
    expect(a.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");

    stubVenue(makeFakeVenue(venueSpec(6), { okEmpty: true }));
    const b = await syncHistory(SYM, TF, { full: true });
    expect(b.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(b.sync_succeeded).toBe(false);

    stubVenue(makeFakeVenue(venueSpec(6), { failure: "network" }));
    const c = await syncHistory(SYM, TF, { full: true });
    expect(c.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(c.boundary_proven_this_attempt).toBe(false);
    expectCompleteIsProven(store.syncRow(SYM, TF)!);
  });

  it("previous COMPLETE → no progress must NOT fabricate a new proof", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(8)));
    await syncHistory(SYM, TF, { full: true });
    const row1 = store.syncRow(SYM, TF)!;

    stubVenue(makeFakeVenue(venueSpec(8), { belowOldest: "repeat_newest" }));
    const sync2 = await syncHistory(SYM, TF, { full: true });
    const row2 = store.syncRow(SYM, TF)!;

    expect(sync2.boundary_proven_this_attempt).toBe(false);
    expect(row2.boundary_proof_ms).toBe(row1.boundary_proof_ms); // untouched
    expect(row2.last_successful_sync_ms).toBe(row1.last_successful_sync_ms); // no fresh success
    expect(row2.last_error).toBeTruthy();
    // retained historical completeness only
    expect(row2.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expectCompleteIsProven(row2);
  });

  it("previous COMPLETE → explicit no_data below the extent is a valid fresh proof", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(8)));
    await syncHistory(SYM, TF, { full: true });
    const row1 = store.syncRow(SYM, TF)!;

    stubVenue(makeFakeVenue(venueSpec(20))); // 12 more older bars + a real no_data below them
    const sync2 = await syncHistory(SYM, TF, { full: true });
    const row2 = store.syncRow(SYM, TF)!;

    expect(sync2.boundary_proven_this_attempt).toBe(true);
    expect(sync2.boundary_proof).toBe("TTT_NO_DATA");
    expect(row2.boundary_proof_ms).toBeGreaterThanOrEqual(row1.boundary_proof_ms);
    expect(store.bounds(SYM, TF).earliest!).toBeLessThan(row1.earliest_ts!); // dataset extended older
    expect(row2.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expectCompleteIsProven(row2);
  });

  it("a full sync with an EMPTY newest window still proves the boundary through the older-than-everything probe", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(6)));
    await syncHistory(SYM, TF, { full: true });
    const stored = store.count(SYM, TF);

    // the venue now answers no_data for every window (its newest edge moved),
    // so the walk collects nothing — the older-than-oldest probe is what proves
    stubVenue(makeFakeVenue(venueSpec(6), { alwaysNoData: true }));
    const r = await syncHistory(SYM, TF, { full: true });

    expect(r.meta.boundary_evidence).toBe("TTT_NO_DATA"); // explicit evidence observed
    expect(r.boundary_proven_this_attempt).toBe(true);
    expect(r.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(store.count(SYM, TF)).toBe(stored); // and nothing was invented
    expectCompleteIsProven(store.syncRow(SYM, TF)!);
  });

  it("an all-invalid payload is NEVER boundary evidence (zero valid bars can never be COMPLETE)", async () => {
    const { fetchFullHistory } = await load();
    // structurally parseable payload whose every bar fails OHLC validation
    const venue = makeFakeVenue(venueSpec(6), { invalidPrices: true });
    stubVenue(venue);

    const res = await fetchFullHistory(SYM, TF, {});

    expect(res.candles).toEqual([]);
    expect(res.meta.boundary_evidence).toBe("TTT_NO_DATA"); // the venue DID say no_data...
    expect(res.meta.completion_state).toBe("NO_DATA"); // ...but with zero valid bars nothing is proven
    expect(res.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
  });

  it("a changed payload ORDERING can only complete through explicit evidence and fabricates nothing", async () => {
    const { fetchFullHistory } = await load();
    // descending arrays: the parser keeps one bar per response, so the walk must
    // advance window by window instead of trusting any "no progress" shortcut
    const venue = makeFakeVenue(venueSpec(20), { descending: true, maxBarsPerResponse: 5 });
    stubVenue(venue);

    const res = await fetchFullHistory(SYM, TF, {});

    // the walk really advanced (many chunks) and only completed because the
    // venue explicitly said no_data below everything it held
    expect(res.meta.chunks_fetched).toBeGreaterThan(10);
    expect(res.meta.boundary_evidence).toBe("TTT_NO_DATA");
    expect(res.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    // and every stored bar is a bar the venue actually served — none invented
    const held = new Set(venue.heldTimestamps());
    for (const c of res.candles) expect(held.has(c.t), `bar ${c.t} was never served`).toBe(true);
  });

  it("ordered vs scrambled payloads agree on the boundary outcome (ordering cannot fabricate proof)", async () => {
    const { fetchFullHistory } = await load();
    const venue = makeFakeVenue(venueSpec(12));
    stubVenue(venue);
    const ascending = await fetchFullHistory(SYM, TF, {});
    expect(ascending.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(ascending.meta.chunks_fetched).toBe(2);

    const scrambled = makeFakeVenue(venueSpec(12), { descending: true });
    stubVenue(scrambled);
    const descending = await fetchFullHistory(SYM, TF, {});
    // same evidence requirement, same bars, no shortcut taken
    expect(descending.meta.boundary_evidence).toBe("TTT_NO_DATA");
    expect(descending.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(descending.candles.map((c) => c.t)).toEqual(ascending.candles.map((c) => c.t));
  });

  it("no_data for the newest window of an empty store is NO_DATA, not COMPLETE", async () => {
    const { syncHistory } = await load();
    stubVenue(makeFakeVenue(venueSpec(1), { alwaysNoData: true }));

    const r = await syncHistory(SYM, TF, { full: true });

    expect(r.meta.completion_state).toBe("NO_DATA");
    expect(r.boundary_proven_this_attempt).toBe(false);
    expect(store.syncRow(SYM, TF)!.boundary_proof ?? null).toBeNull();
  });
});

/* ═════════════════════════ static / structural audit ═════════════════════════ */

describe("static audit: COMPLETE_TO_TTT_BOUNDARY has exactly one evidence path", () => {
  const historySrc = () => fs.readFileSync("src/lib/market/history.ts", "utf8");
  const storeSrc = () => fs.readFileSync("src/lib/market/history-store.ts", "utf8");

  it("the walk has exactly ONE place that records boundary evidence", () => {
    const src = historySrc();
    expect(src.match(/boundaryEvidence = "TTT_NO_DATA"/g) ?? []).toHaveLength(1);
    // ...inside the explicit no_data branch, guarded by the strictly-older probe check
    expect(src).toMatch(/if \(res\.noData\) \{[\s\S]{0,600}?probeIsOlderThanKnownData[\s\S]{0,200}?boundaryEvidence = "TTT_NO_DATA"/);
  });

  it("the walk cannot reach COMPLETE through overlap or a stalled cursor", () => {
    const src = historySrc();
    // the two removed false-proof shortcuts must never return
    expect(src).not.toMatch(/all\.length === before\) \{\s*reachedBoundary/);
    expect(src).not.toMatch(/nextTo >= cursorTo\) \{\s*reachedBoundary/);
    expect(src).not.toMatch(/noData \|\| res\.candles\.length === 0/);
    // the ambiguous flag is gone entirely: evidence is explicit, never inferred
    expect(src).not.toMatch(/\breachedBoundary\b/);
    // exactly one COMPLETE assignment, guarded by the explicit evidence type
    expect(src.match(/completion = "COMPLETE_TO_TTT_BOUNDARY"/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/else if \(boundaryEvidence === "TTT_NO_DATA"\) \{[\s\S]{0,200}?completion = "COMPLETE_TO_TTT_BOUNDARY"/);
  });

  it("no-progress outcomes are their own honest state", () => {
    const src = historySrc();
    expect(src).toMatch(/noProgress = true/);
    expect(src.match(/completion = "NO_PROGRESS"/g) ?? []).toHaveLength(1);
  });

  it("the store's ONLY COMPLETE assignment is guarded by fresh proof or covered retention", () => {
    const src = storeSrc();
    expect(src.match(/completion = "COMPLETE_TO_TTT_BOUNDARY"/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/else if \(boundaryProven \|\| historicalCompleteRetained\) \{[\s\S]{0,300}?completion = "COMPLETE_TO_TTT_BOUNDARY"/);
    // retention is extent-checked, never a bare inheritance of the prior flag
    expect(src).toMatch(/prior\?\.completion_state === "COMPLETE_TO_TTT_BOUNDARY" && !extendsOlderThanVerifiedExtent/);
  });

  it("fresh proof requires explicit evidence AND coverage of the known extent", () => {
    const src = storeSrc();
    expect(src.match(/boundary_evidence === "TTT_NO_DATA"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/walkProvenBoundary =\s*\n?\s*res\.meta\.boundary_evidence === "TTT_NO_DATA"/);
    expect(src).toMatch(/knownExtentBefore === null \|\| walkOldest <= knownExtentBefore/);
    // the full-sync probe accepts ONLY explicit evidence (never a bare NO_DATA label)
    expect(src).toMatch(/if \(probe\.meta\.boundary_evidence === "TTT_NO_DATA"\) \{\s*\n\s*boundaryProven = true;/);
    expect(src).not.toMatch(/probe\.meta\.completion_state === "NO_DATA"/);
  });

  it("every stored COMPLETE row carries evidence provenance columns", () => {
    const src = storeSrc();
    expect(src).toMatch(/boundary_proof TEXT/);
    expect(src).toMatch(/boundary_proof_ms INTEGER NOT NULL DEFAULT 0/);
    expect(src).toMatch(/ALTER TABLE history_sync ADD COLUMN boundary_proof TEXT/);
    expect(src).toMatch(/boundary_proof: boundaryProof/);
  });
});
