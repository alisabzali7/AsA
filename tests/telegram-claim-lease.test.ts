/**
 * TEAM 05 — Telegram outbox claim/lease concurrency suite (Task 3).
 *
 * Pins the race at the shared persistence boundary: `drainOutbox` callers
 * (engine 60s timer with no running-guard, POST /api/system/notify drain/test,
 * future workers) could read the same QUEUED/FAILED row and BOTH send to
 * Telegram before either persisted anything. Task 2's progress persistence
 * stopped re-sends across sequential retries but not simultaneous double-sends.
 *
 * Invariants pinned here (claim protocol: claim -> verify ownership ->
 * transport -> persist only as current owner):
 *   - claim exclusivity: at most one active consumer owns a row (atomic
 *     conditional UPDATE at the persistence layer — cross-process safe)
 *   - duplicate-send prevention: the losing consumer never calls Telegram
 *   - lease expiry / crash recovery: a crashed claim is reclaimable after its
 *     persisted lease — no permanent processing deadlock
 *   - stale-owner protection: an old owner cannot overwrite the reclaimed
 *     row's state or progress
 *   - parallel rows stay independent (no global queue lock)
 *   - attempts: one increment per logical cycle that ENTERS the transport
 *     phase (even a photo+text cycle = 1); claim/parse failures = 0
 *   - partial progress survives claim loss and resumes without re-sends
 *   - poison payload DEADs without consuming the transport budget
 *
 * The TELEGRAM transport is the mocked boundary (global fetch); the claim
 * protocol itself runs against the REAL SqliteRepo.
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-tgclaim-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "123456789";
process.env.TELEGRAM_DRY_RUN = "0"; // real send mode — the transport itself is stubbed

type Repo = import("../src/db/repo").Repo;
type OutboxRow = import("../src/db/repo").OutboxRow;
type OutboxClaim = import("../src/db/repo").OutboxClaim;
type ChartEvidence = import("../src/lib/chart/evidence").ChartEvidence;
type CandleSeries = import("../src/lib/domain/types").CandleSeries;

let repo: Repo;
let deliverOutboxRow: (row: OutboxRow, repo?: Repo) => Promise<{ ok: boolean; error?: string }>;
let closeRepo: () => void;

let photoCalls: number;
let textCalls: number;
let photoResults: boolean[];
let textResults: boolean[];

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let origFetch: FetchImpl;

beforeAll(async () => {
  origFetch = globalThis.fetch as FetchImpl;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/sendPhoto")) {
      photoCalls += 1;
      const ok = photoResults.length > 0 ? photoResults.shift()! : true;
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 502 });
    }
    if (url.includes("/sendMessage")) {
      textCalls += 1;
      const ok = textResults.length > 0 ? textResults.shift()! : true;
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 502 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }) as FetchImpl;

  const sqlite = await import("../src/db/sqlite");
  const tg = await import("../src/lib/notify/telegram");
  const candles = await import("../src/lib/market/candles");
  repo = sqlite.getRepo();
  closeRepo = sqlite.closeRepo;
  deliverOutboxRow = tg.deliverOutboxRow;
  vi.spyOn(candles.candleManager, "ensureSeries").mockResolvedValue(testSeries());
  photoCalls = 0;
  textCalls = 0;
  photoResults = [];
  textResults = [];
});

afterAll(() => {
  vi.restoreAllMocks();
  globalThis.fetch = origFetch as typeof globalThis.fetch;
  closeRepo();
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  photoCalls = 0;
  textCalls = 0;
  photoResults = [];
  textResults = [];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function testSeries(): CandleSeries {
  const candles = Array.from({ length: 40 }, (_, i) => ({
    t: 1_700_000_000 + i * 3600,
    o: 100, h: 101, l: 99, c: 100, v: 10,
  }));
  return { symbol: "BTCUSDT", timeframe: "1h", candles, native: true, source: "ttt", fetched_at_ms: Date.now(), closed_count: 40 } as CandleSeries;
}

function evidence(): ChartEvidence {
  return {
    symbol: "BTCUSDT",
    timeframe: "1h",
    strategy_id: "STR-RAW-2-803",
    setup_id: "SET-STR-RAW-2-803",
    direction: "short",
    bar_time: 1_700_000_000_000,
    annotations: [
      {
        annotation_id: "ann-claim-1",
        kind: "level",
        label: "test level",
        price: 64000,
        produced_by: { type: "feature", id: "feat-test" },
        source_refs: [],
        detector_version: "1.0.0",
        evidence_kind: "MEASURED",
      },
    ],
    rules: [],
    score: 87.5,
    score_semantics: "Score is a deterministic evidence sum (0-100), NOT a probability or win rate.",
    assumptions: ["ENGINEERING PARAMETER — test fixture"],
    lineage_complete: true,
  };
}

function seedOppWithEvidence(id: string): void {
  repo.opportunityUpsert({
    id, symbol: "BTCUSDT", timeframe: "1h", direction: "short", score: 87.5,
    state: "READY", mode: "live", strategy_id: "STR-RAW-2-803",
    payload_json: JSON.stringify({ chart_evidence: evidence() }),
    created_ms: 1, updated_ms: 1,
  });
}

function enqueueSignalRow(oppId: string): number {
  return repo.outboxEnqueue("signal", {
    kind: "signal", advisory_only: true, symbol: "BTCUSDT", timeframe: "1h",
    direction: "short", score: 87.5, opportunity_id: oppId,
    generated_at_ms: Date.now(), timestamp: Date.now(),
  });
}

function enqueueTextRow(): number {
  return repo.outboxEnqueue("system", { kind: "system", thesis: "claim test", generated_at_ms: Date.now() });
}

function rowById(id: number): OutboxRow {
  return repo.outboxList("ALL", 200).find((r) => r.id === id)!;
}

function progressOf(row: OutboxRow): { photo_required?: boolean; photo_sent?: boolean; text_sent?: boolean } {
  return (JSON.parse(row.payload_json) as { delivery_progress?: Record<string, boolean> }).delivery_progress ?? {};
}

function claimOf(token: string, leaseMs = 120_000): OutboxClaim {
  const now = Date.now();
  return { token, claimed_at_ms: now, expires_at_ms: now + leaseMs };
}

describe("T05 outbox claim: exclusivity & duplicate-send prevention", () => {
  it("two consumers competing for the same row: exactly one claim wins (persistence-layer atomicity)", () => {
    const id = enqueueTextRow();
    const a = claimOf("worker-A");
    expect(repo.outboxClaim(id, a)).toBe(true);
    expect(repo.outboxClaim(id, claimOf("worker-B"))).toBe(false);
    // a write from a MISMATCHED claim identity (stale/forged owner) is rejected
    const forged = { ...a, claimed_at_ms: a.claimed_at_ms - 1 };
    expect(repo.outboxMark(id, "FAILED", "released", forged)).toBe(false);
    expect(repo.outboxClaim(id, claimOf("worker-B"))).toBe(false); // A still owns it
    // the genuine owner releases; only then may B claim
    expect(repo.outboxMark(id, "FAILED", "released", a)).toBe(true);
    expect(repo.outboxClaim(id, claimOf("worker-B"))).toBe(true);
  });

  it("a losing consumer does NOT call Telegram (concurrent deliverOutboxRow on one row)", async () => {
    seedOppWithEvidence("opp-race");
    const id = enqueueSignalRow("opp-race");
    const row = rowById(id);
    const p1 = deliverOutboxRow(row, repo);
    const p2 = deliverOutboxRow(row, repo);
    const [r1, r2] = await Promise.all([p1, p2]);
    const oks = [r1, r2].filter((r) => r.ok);
    const losers = [r1, r2].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].error).toMatch(/claimed by another active consumer/);
    // THE invariant: exactly one logical delivery reached the provider
    expect(photoCalls).toBe(1);
    expect(textCalls).toBe(1);
    expect(rowById(id).state).toBe("SENT");
  });

  it("a failed claim consumes NOTHING: no attempts, no state change, no provider call", async () => {
    const id = enqueueTextRow();
    expect(repo.outboxClaim(id, claimOf("busy-worker", 60_000))).toBe(true);
    const r = await deliverOutboxRow(rowById(id), repo);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/claimed by another active consumer/);
    const row = rowById(id);
    expect(row.attempts).toBe(0); // honest: a claim failure is not a delivery attempt
    expect(row.state).toBe("QUEUED"); // untouched
    expect(textCalls).toBe(0);
    expect(photoCalls).toBe(0);
  });
});

describe("T05 outbox claim: lease expiry & crash recovery", () => {
  it("a crashed claim is reclaimable after its lease — no permanent processing deadlock", async () => {
    const id = enqueueTextRow();
    // worker claims with a SHORT lease, then the process "crashes" (no writes)
    expect(repo.outboxClaim(id, claimOf("crashed-worker", 30))).toBe(true);
    // while the lease is live the row is protected
    const early = await deliverOutboxRow(rowById(id), repo);
    expect(early.ok).toBe(false);
    expect(early.error).toMatch(/claimed by another active consumer/);
    expect(textCalls).toBe(0);
    // ...after the persisted lease expires, any consumer may reclaim and deliver
    await sleep(50);
    const r = await deliverOutboxRow(rowById(id), repo);
    expect(r.ok).toBe(true);
    expect(rowById(id).state).toBe("SENT");
    expect(textCalls).toBe(1);
  });

  it("stale-owner protection: an old owner cannot overwrite the reclaimed row", async () => {
    const id = enqueueTextRow();
    const stale = claimOf("stale-worker", 30);
    expect(repo.outboxClaim(id, stale)).toBe(true);
    await sleep(50); // lease expired — simulate the stale worker waking up
    const fresh = claimOf("fresh-worker", 120_000);
    expect(repo.outboxClaim(id, fresh)).toBe(true); // legitimately reclaimed

    // every stale-owner write is rejected; the new owner's row stays intact
    expect(repo.outboxSetPayload(id, '{"hijack":true}', stale)).toBe(false);
    expect(repo.outboxMark(id, "SENT", null, stale)).toBe(false);
    expect(repo.outboxCountAttempt(id, stale)).toBeNull();
    expect(repo.outboxMark(id, "DEAD", "stale kill", stale)).toBe(false);
    let row = rowById(id);
    expect(row.state).toBe("QUEUED");
    expect(row.attempts).toBe(0);
    expect(row.payload_json).not.toContain("hijack");

    // the current owner can finish normally
    expect(repo.outboxSetPayload(id, JSON.stringify({ kind: "system", generated_at_ms: 1, delivery_progress: { text_sent: true } }), fresh)).toBe(true);
    expect(repo.outboxMark(id, "SENT", null, fresh)).toBe(true);
    row = rowById(id);
    expect(row.state).toBe("SENT");
  });

  it("partial progress survives a crash/claim-loss and resumes WITHOUT re-sending the photo", async () => {
    seedOppWithEvidence("opp-resume");
    const id = enqueueSignalRow("opp-resume");
    textResults = [false, true]; // first cycle: photo ok, text fails
    await deliverOutboxRow(rowById(id), repo);
    expect(rowById(id).state).toBe("FAILED");
    expect(progressOf(rowById(id))).toEqual({ photo_required: true, photo_sent: true, text_sent: false });
    expect(photoCalls).toBe(1);

    // a worker claims the row and crashes mid-cycle (progress persisted, nothing sent)
    expect(repo.outboxClaim(id, claimOf("crashed-mid-cycle", 30))).toBe(true);
    await sleep(50); // its lease expires
    // reclamation continues exactly where the progress log says — photo NOT replayed
    const r = await deliverOutboxRow(rowById(id), repo);
    expect(r.ok).toBe(true);
    expect(rowById(id).state).toBe("SENT");
    expect(photoCalls).toBe(1); // across BOTH real cycles + the reclaim: one photo ever
    expect(textCalls).toBe(2);
    expect(progressOf(rowById(id))).toEqual({ photo_required: true, photo_sent: true, text_sent: true });
  });
});

describe("T05 outbox claim: schema migration for existing databases", () => {
  it("a legacy telegram_outbox table gains the claim/lease columns and keeps its rows", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { SqliteRepo } = await import("../src/db/sqlite");
    const f = path.join(TMP, "legacy.db");
    // reproduce a PRE-Task-3 database exactly as the old SCHEMA created it
    const legacy = new Database(f);
    legacy.exec(`CREATE TABLE telegram_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'QUEUED',
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
      created_ms INTEGER NOT NULL, sent_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_ms INTEGER NOT NULL, note TEXT NOT NULL DEFAULT ''
    );`);
    legacy
      .prepare("INSERT INTO telegram_outbox (kind, payload_json, state, attempts, created_ms) VALUES ('system', '{}', 'QUEUED', 2, 1)")
      .run();
    legacy.close();

    // opening through SqliteRepo runs the guarded migration
    const upgraded = new SqliteRepo(f);
    try {
      const rows = upgraded.outboxList("ALL", 10);
      expect(rows.length).toBe(1); // existing rows preserved
      expect(rows[0].attempts).toBe(2); // existing data untouched
      // claim columns exist and work (outboxClaim would throw without them)
      const first = { token: "legacy-A", claimed_at_ms: Date.now(), expires_at_ms: Date.now() + 60_000 };
      expect(upgraded.outboxClaim(1, first)).toBe(true);
      expect(upgraded.outboxClaim(1, { token: "legacy-B", claimed_at_ms: Date.now(), expires_at_ms: Date.now() + 60_000 })).toBe(false);
      // re-opening an already-migrated file is idempotent
      upgraded.close();
      const again = new SqliteRepo(f);
      try {
        expect(again.outboxList("ALL", 10).length).toBe(1);
      } finally {
        again.close();
      }
    } catch (err) {
      try { upgraded.close(); } catch { /* already closed */ }
      throw err;
    }
  });
});

describe("T05 outbox claim: parallel rows & honest attempts", () => {
  it("independent rows are processed independently (no global lock)", async () => {
    const a = enqueueTextRow();
    const b = enqueueTextRow();
    const [ra, rb] = await Promise.all([deliverOutboxRow(rowById(a), repo), deliverOutboxRow(rowById(b), repo)]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(rowById(a).state).toBe("SENT");
    expect(rowById(b).state).toBe("SENT");
    expect(textCalls).toBe(2);
  });

  it("attempts increments EXACTLY ONCE per logical transport cycle (photo+text = 1 attempt)", async () => {
    seedOppWithEvidence("opp-count");
    const id = enqueueSignalRow("opp-count");
    textResults = [false]; // cycle 1 makes TWO provider requests but is ONE logical attempt
    await deliverOutboxRow(rowById(id), repo);
    expect(photoCalls).toBe(1);
    expect(textCalls).toBe(1);
    expect(rowById(id).attempts).toBe(1); // 2 provider requests, 1 logical delivery attempt

    await deliverOutboxRow(rowById(id), repo); // cycle 2 completes
    expect(rowById(id).attempts).toBe(2);
    expect(rowById(id).state).toBe("SENT");
  });

  it("poison payload is DEAD with ZERO transport attempts (parse failure never spends the budget)", async () => {
    const id = enqueueTextRow();
    repo.outboxSetPayload(id, "{definitely-not-json", null);
    const r = await deliverOutboxRow(rowById(id), repo);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unparseable/);
    const row = rowById(id);
    expect(row.state).toBe("DEAD");
    expect(row.attempts).toBe(0);
    expect(textCalls).toBe(0);
    expect(repo.outboxRetryable(50).some((x) => x.id === id)).toBe(false); // DEAD is never selected again
  });

  it("retry budget is deterministic: DEAD only after OUTBOX_MAX_ATTEMPTS real transport attempts", async () => {
    const id = enqueueTextRow();
    textResults = [false, false, false, false, false];
    for (let i = 1; i <= 5; i++) {
      const r = await deliverOutboxRow(rowById(id), repo);
      expect(r.ok).toBe(false);
      expect(rowById(id).attempts).toBe(i); // exactly i after i transport cycles
    }
    const row = rowById(id);
    expect(row.state).toBe("DEAD");
    expect(row.error).toMatch(/text not delivered/);
    expect(textCalls).toBe(5);
    expect(repo.outboxRetryable(50).some((x) => x.id === id)).toBe(false);
  });
});
