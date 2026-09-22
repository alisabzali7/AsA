/**
 * TEAM 05 — Telegram partial-send retry safety regression suite (Task 2).
 *
 * Pins the defect at the Telegram transport layer: ONE logical outbox item is
 * delivered as TWO sub-steps (annotated chart photo + full advisory text), but
 * `deliverOutboxRow` re-ran BOTH sub-steps on every retry. A photo accepted by
 * Telegram followed by a failed text send re-sent the photo on retry — a
 * duplicate advisory message for one logical delivery (and symmetrically for
 * text when the photo failed first).
 *
 * Invariants pinned here:
 *   - one logical delivery = photo (when part of the item) + text, each
 *     accepted exactly once
 *   - a retry of the SAME outbox row resumes from persisted sub-step progress
 *     (`payload_json.delivery_progress`) and NEVER repeats an accepted sub-step
 *   - "SENT" only when the full logical contract is satisfied — never from a
 *     mere attempt
 *   - terminal failure (DEAD) is truthful (exact missing sub-steps in `error`)
 *     and observable (error-level system event), and DEAD is never retried
 *   - transport failure never touches the underlying decision (rows only)
 *
 * NOTE on isolation: env is set BEFORE any src module is dynamically imported.
 * The TELEGRAM transport is the mocked boundary (global fetch, as in
 * audit-regressions.test.ts); chart rendering runs the REAL renderer on real
 * ChartEvidence + candles (candle series fetch is stubbed at the data seam).
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-tgpart-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "123456789";
process.env.TELEGRAM_DRY_RUN = "0"; // real send mode — the transport itself is stubbed

type Repo = import("../src/db/repo").Repo;
type OutboxRow = import("../src/db/repo").OutboxRow;
type ChartEvidence = import("../src/lib/chart/evidence").ChartEvidence;
type CandleSeries = import("../src/lib/domain/types").CandleSeries;

let repo: Repo;
let deliverOutboxRow: (row: OutboxRow, repo?: Repo) => Promise<{ ok: boolean; error?: string }>;
let drainOutbox: (repo?: Repo) => Promise<{ attempted: number; sent: number; retried_failed: number }>;
let eventBus: typeof import("../src/lib/events").eventBus;
let closeRepo: () => void;

/* transport stub state — counts every attempt and serves queued outcomes */
let photoCalls: number;
let textCalls: number;
let photoResults: boolean[]; // queued HTTP-accept outcomes for sendPhoto (default accept)
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
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 502, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/sendMessage")) {
      textCalls += 1;
      const ok = textResults.length > 0 ? textResults.shift()! : true;
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 502, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: false, description: `unexpected URL in test: ${url}` }), { status: 500 });
  }) as FetchImpl;

  const sqlite = await import("../src/db/sqlite");
  const tg = await import("../src/lib/notify/telegram");
  const candles = await import("../src/lib/market/candles");
  const events = await import("../src/lib/events");
  repo = sqlite.getRepo();
  closeRepo = sqlite.closeRepo;
  deliverOutboxRow = tg.deliverOutboxRow;
  drainOutbox = tg.drainOutbox;
  eventBus = events.eventBus;

  // candle series fetch is incidental input material for the REAL renderer —
  // stub the data seam so chart rendering is deterministic in tests
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

function testSeries(): CandleSeries {
  const candles = Array.from({ length: 60 }, (_, i) => ({
    t: 1_700_000_000 + i * 3600,
    o: 100 + (i % 7),
    h: 101 + (i % 7),
    l: 99 + (i % 7),
    c: 100 + (i % 7),
    v: 10,
  }));
  return {
    symbol: "BTCUSDT",
    timeframe: "1h",
    candles,
    native: true,
    source: "ttt",
    fetched_at_ms: Date.now(),
    closed_count: candles.length,
  } as CandleSeries;
}

/** Real ChartEvidence shape with one traceable annotation (closure §W). */
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
        annotation_id: "ann-test-1",
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
    assumptions: ["ENGINEERING PARAMETER — test fixture level quantification"],
    lineage_complete: true,
  };
}

/** A stored opportunity carrying chart evidence — makes the photo a sub-step. */
function seedOppWithEvidence(id: string): void {
  repo.opportunityUpsert({
    id,
    symbol: "BTCUSDT",
    timeframe: "1h",
    direction: "short",
    score: 87.5,
    state: "READY",
    mode: "live",
    strategy_id: "STR-RAW-2-803",
    payload_json: JSON.stringify({ chart_evidence: evidence() }),
    created_ms: 1,
    updated_ms: 1,
  });
}

function enqueueSignalRow(oppId: string): number {
  return repo.outboxEnqueue("signal", {
    kind: "signal",
    advisory_only: true,
    symbol: "BTCUSDT",
    timeframe: "1h",
    direction: "short",
    score: 87.5,
    opportunity_id: oppId,
    generated_at_ms: Date.now(),
    timestamp: Date.now(),
  });
}

function rowById(id: number): OutboxRow {
  return repo.outboxList("ALL", 200).find((r) => r.id === id)!;
}

function progressOf(row: OutboxRow): { photo_required?: boolean; photo_sent?: boolean; text_sent?: boolean } {
  return (JSON.parse(row.payload_json) as { delivery_progress?: Record<string, boolean> }).delivery_progress ?? {};
}

describe("T05 partial-send retry safety", () => {
  it("7. photo success + text success = ONE logical successful delivery (and redelivery is a no-op)", async () => {
    seedOppWithEvidence("opp-t7");
    const id = enqueueSignalRow("opp-t7");
    const r1 = await deliverOutboxRow(rowById(id), repo);
    expect(r1.ok).toBe(true);
    const row = rowById(id);
    expect(row.state).toBe("SENT");
    expect(row.error).toBeNull();
    expect(photoCalls).toBe(1);
    expect(textCalls).toBe(1);
    expect(progressOf(row)).toEqual({ photo_required: true, photo_sent: true, text_sent: true });

    // replaying the SAME logical row must not repeat any accepted sub-step
    const r2 = await deliverOutboxRow(rowById(id), repo);
    expect(r2.ok).toBe(true);
    expect(photoCalls).toBe(1);
    expect(textCalls).toBe(1);
  });

  it("8. photo success + text failure -> retry resumes WITHOUT resending the photo", async () => {
    seedOppWithEvidence("opp-t8");
    const id = enqueueSignalRow("opp-t8");
    textResults = [false, true]; // text fails once, then accepted

    const r1 = await deliverOutboxRow(rowById(id), repo);
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/text not delivered/);
    let row = rowById(id);
    expect(row.state).toBe("FAILED"); // truthful: the item is NOT delivered
    expect(progressOf(row)).toEqual({ photo_required: true, photo_sent: true, text_sent: false });

    const r2 = await deliverOutboxRow(rowById(id), repo); // the retry
    expect(r2.ok).toBe(true);
    row = rowById(id);
    expect(row.state).toBe("SENT");
    expect(photoCalls).toBe(1); // THE defect: the accepted photo is never re-sent
    expect(textCalls).toBe(2);
    expect(progressOf(row)).toEqual({ photo_required: true, photo_sent: true, text_sent: true });
  });

  it("9. photo failure before text -> retry completes without duplicating the accepted text sub-step", async () => {
    seedOppWithEvidence("opp-t9");
    const id = enqueueSignalRow("opp-t9");
    photoResults = [false, true]; // photo fails once, then accepted

    const r1 = await deliverOutboxRow(rowById(id), repo);
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/photo not delivered/);
    expect(progressOf(rowById(id))).toEqual({ photo_required: true, photo_sent: false, text_sent: true });

    const r2 = await deliverOutboxRow(rowById(id), repo);
    expect(r2.ok).toBe(true);
    expect(rowById(id).state).toBe("SENT");
    expect(photoCalls).toBe(2); // photo retried until accepted (exactly one success)
    expect(textCalls).toBe(1); // the accepted text is NEVER repeated
    expect(progressOf(rowById(id))).toEqual({ photo_required: true, photo_sent: true, text_sent: true });
  });

  it("10. terminal failure is truthful and observable: DEAD names the missing sub-step and is never retried", async () => {
    seedOppWithEvidence("opp-t10");
    const id = enqueueSignalRow("opp-t10");
    photoResults = [false, false, false, false, false]; // photo never accepted
    const events: { level: string; message: string }[] = [];
    const unsub = eventBus.subscribe((e) => {
      if (e.type === "system") events.push(e as unknown as { level: string; message: string });
    });

    let last: { ok: boolean; error?: string } = { ok: false };
    for (let i = 0; i < 5; i++) last = await deliverOutboxRow(rowById(id), repo);
    unsub();

    expect(last.ok).toBe(false);
    expect(last.error).toMatch(/max attempts reached/);
    const row = rowById(id);
    expect(row.state).toBe("DEAD");
    expect(row.attempts).toBe(5);
    expect(row.error).toMatch(/photo not delivered/); // exact missing sub-step
    expect(photoCalls).toBe(5);
    expect(textCalls).toBe(1); // accepted text not repeated on the road to DEAD
    // observable: an error-level system event reported the permanent loss
    expect(events.some((e) => e.level === "error" && /DEAD/.test(e.message))).toBe(true);
    // DEAD is terminal — the drain never picks it up again
    expect(repo.outboxRetryable(50).some((r) => r.id === id)).toBe(false);
  });

  it("retry via the real drain resumes partial progress (the engine's actual retry path)", async () => {
    seedOppWithEvidence("opp-drain");
    const id = enqueueSignalRow("opp-drain");
    textResults = [false]; // photo accepted, text fails on the first attempt

    await deliverOutboxRow(rowById(id), repo);
    expect(rowById(id).state).toBe("FAILED");
    const before = { photo: photoCalls, text: textCalls };
    expect(before.photo).toBe(1);
    expect(before.text).toBe(1);

    const d = await drainOutbox(repo); // outboxRetryable -> deliverOutboxRow
    expect(d.sent).toBe(1);
    expect(rowById(id).state).toBe("SENT");
    expect(photoCalls).toBe(before.photo); // drain did NOT resend the photo
    expect(textCalls).toBe(before.text + 1); // only the missing text sub-step
  });

  it("text-only items (no chart in the contract) still deliver as one text sub-step", async () => {
    const id = repo.outboxEnqueue("system", {
      kind: "system",
      thesis: "AsA notifier connectivity test — advisory only.",
      generated_at_ms: Date.now(),
    });
    const r = await deliverOutboxRow(rowById(id), repo);
    expect(r.ok).toBe(true);
    expect(rowById(id).state).toBe("SENT");
    expect(photoCalls).toBe(0);
    expect(textCalls).toBe(1);
    expect(progressOf(rowById(id))).toEqual({ photo_required: false, photo_sent: false, text_sent: true });
  });
});
