/**
 * TEAM 05 — signal publication boundary regression suite (Task 1).
 *
 * Pins the defect found at the Signal -> Telegram Outbox integration boundary:
 * `publishSignal` short-circuited ONLY on `state === "published"`, so any
 * signal that left `published` (the engine's `expireStaleSignals` runs on age,
 * while >=1h-strategy anchors remain fresh) was RESURRECTED to `published` and
 * RE-QUEUED on the next scan of the same anchor — a duplicate Telegram advisory
 * for one opportunity (idempotency key = idFor symbol|tf|direction|strategy|
 * anchor, closure §V) and a non-deterministic lifecycle. `INSERT OR REPLACE`
 * destroyed the row's history, and the exported publisher applied no final
 * risk-boundary check at all.
 *
 * Invariants pinned here:
 *   - exactly-once publication: one opportunity -> one signal row -> ONE outbox row
 *   - lifecycle one-wayness: expired/invalidated/closed/archived/blocked_by_risk
 *     are terminal; candidate/qualified activate exactly once (created_ms kept)
 *   - FINAL hard risk boundary at the publish step (STRICT, Task 2): only an
 *     explicit well-formed risk-gate PASS may publish; blocked/missing/
 *     unavailable/unknown/malformed risk NEVER becomes a published signal or
 *     an outbox row (and therefore can never reach Telegram delivery)
 *   - fail-safe classification of unknown signal states
 *
 * NOTE on isolation: env-dependent paths are set BEFORE any src module is
 * dynamically imported (same pattern as audit-regressions.test.ts).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpportunityPayload } from "../src/lib/pipeline/orchestrator";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-sigpub-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");

type Repo = import("../src/db/repo").Repo;
type SignalRow = import("../src/db/repo").SignalRow;

let repo: Repo;
let publishSignal: (o: OpportunityPayload) => { id: string; published: boolean; reason: string };
let publishActionFor: (s: string | null) => string;
let expireStaleSignals: (maxAgeMs?: number, r?: Repo) => number;
let SIGNAL_STATES: readonly string[];
let closeRepo: () => void;

beforeAll(async () => {
  const sqlite = await import("../src/db/sqlite");
  const orch = await import("../src/lib/pipeline/orchestrator");
  closeRepo = sqlite.closeRepo;
  repo = sqlite.getRepo();
  publishSignal = orch.publishSignal;
  publishActionFor = orch.publishActionFor;
  expireStaleSignals = (maxAgeMs?: number, r?: Repo) => orch.expireStaleSignals(maxAgeMs, r ?? repo);
  SIGNAL_STATES = orch.SIGNAL_STATES;
});

afterAll(() => {
  closeRepo();
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
function makeOpp(overrides: Partial<OpportunityPayload> = {}): OpportunityPayload {
  seq += 1;
  return {
    id: `opptest${seq}`,
    symbol: "BTCUSDT",
    timeframe: "1h",
    direction: "long",
    score: 90,
    setup: "s",
    thesis: "t",
    entry_zone: null,
    invalidation: null,
    stop: null,
    targets: [],
    rr: null,
    strategy_id: "STR-RAW-2-803",
    mode: "live",
    state: "READY",
    anchor_ts_ms: 0,
    anchor_close_ms: Date.now(),
    freshness_ms: 0,
    evidence: [],
    contradictions: [],
    score_breakdown: null,
    positive_factors: [],
    negative_factors: [],
    blocked_factors: [],
    unknown_factors: [],
    source_refs: [],
    data_quality: { bars: 1, stale: false, age_ms: 0, state: "FRESH" },
    psychology: null,
    portfolio: null,
    setup_id: null,
    score_semantics: "s",
    chart_evidence: null,
    // FIX (T05 T2): an explicit valid risk-PASS is the ONLY publishable risk
    // state — fixtures must never rely on a missing risk object.
    risk: { verdict: "pass", reasons: ["risk checks passed"], numbers: {} },
    ai: null,
    provenance: {
      generated_at_ms: 0,
      data: { series_fetched_ms: 0, stats_fetched_ms: null, native_1d: true, candles: { macro: null, context: null, trigger: 1 } },
    },
    ...overrides,
  };
}

const RISK_BLOCK = { verdict: "block", reasons: ["LONG requires stop < entry"], numbers: {} };
const RISK_PASS = { verdict: "pass", reasons: ["risk checks passed"], numbers: {} };

/** Outbox rows queued for ONE opportunity — the duplicate-delivery detector. */
function outboxRowsFor(oppId: string) {
  return repo
    .outboxList("ALL", 500)
    .filter((r) => r.kind === "signal")
    .filter((r) => (JSON.parse(r.payload_json) as { opportunity_id?: string }).opportunity_id === oppId);
}

describe("T05 publish boundary: lifecycle classification", () => {
  it("classifies every SIGNAL_STATES value; unknown states fail SAFE as terminal", () => {
    expect(publishActionFor(null)).toBe("create");
    expect(publishActionFor("published")).toBe("already_published");
    expect(publishActionFor("candidate")).toBe("activate");
    expect(publishActionFor("qualified")).toBe("activate");
    for (const s of SIGNAL_STATES) {
      expect(publishActionFor(s), s).not.toBe("create");
    }
    for (const s of ["expired", "invalidated", "closed", "archived", "blocked_by_risk"]) {
      expect(publishActionFor(s), s).toBe("terminal");
    }
    // a state this build does not understand must NEVER become "published"
    expect(publishActionFor("SOMETHING_NEW")).toBe("terminal");
    expect(publishActionFor("")).toBe("terminal");
  });
});

describe("T05 publish boundary: exactly-once publication (closure §V)", () => {
  it("repeated publishes of one opportunity yield ONE signal row and ONE outbox row", () => {
    const opp = makeOpp({ risk: RISK_PASS });
    const r1 = publishSignal(opp);
    const r2 = publishSignal(opp);
    const r3 = publishSignal(opp);
    expect(r1.published).toBe(true);
    expect(r1.reason).toMatch(/published/);
    expect(r2.published).toBe(true);
    expect(r2.reason).toMatch(/already published/);
    expect(r3.published).toBe(true);
    expect(r3.reason).toMatch(/already published/);
    const signals = repo.signalList(500).filter((s) => s.opp_id === opp.id);
    expect(signals.length).toBe(1);
    expect(signals[0].state).toBe("published");
    // THE defect: the outbox used to gain a row per re-publish once the signal
    // was no longer in state "published" — duplicates must never appear.
    expect(outboxRowsFor(opp.id).length).toBe(1);
  });

  it("an expired signal is NEVER resurrected and NEVER re-queued", async () => {
    const opp = makeOpp();
    expect(publishSignal(opp).published).toBe(true);
    // the engine's real expiry walk (maxAgeMs=0 expires any row written in the
    // past — wait a few ms so updated_ms < now deterministically)
    await new Promise((r) => setTimeout(r, 10));
    expect(expireStaleSignals(0)).toBeGreaterThanOrEqual(1);
    const afterExpiry = repo.signalByOpp(opp.id)!;
    expect(afterExpiry.state).toBe("expired");

    // a later scan of the SAME anchor re-calls publishSignal — the historical
    // defect resurrected this row to "published" AND queued a second Telegram
    // advisory for the same opportunity.
    const r2 = publishSignal(opp);
    const r3 = publishSignal(opp);
    expect(r2.published).toBe(false);
    expect(r2.reason).toMatch(/expired .*terminal/);
    expect(r3.published).toBe(false);
    expect(repo.signalByOpp(opp.id)!.state).toBe("expired"); // lifecycle preserved
    expect(outboxRowsFor(opp.id).length).toBe(1); // no duplicate advisory
  });

  it("terminal states are preserved verbatim and never re-queued", () => {
    for (const state of ["invalidated", "closed", "archived", "blocked_by_risk"] as const) {
      const opp = makeOpp();
      const id = `sig-${opp.id}`;
      repo.signalInsert({
        id,
        state,
        symbol: opp.symbol,
        timeframe: opp.timeframe,
        direction: opp.direction,
        score: opp.score,
        strategy_id: opp.strategy_id,
        opp_id: opp.id,
        payload_json: "{}",
        created_ms: 1,
        updated_ms: 1,
      });
      const r = publishSignal(opp);
      expect(r.published, state).toBe(false);
      expect(r.reason, state).toMatch(/terminal/);
      expect(repo.signalByOpp(opp.id)!.state, state).toBe(state);
      expect(outboxRowsFor(opp.id).length, state).toBe(0);
    }
  });

  it("candidate/qualified activate exactly once and preserve created_ms", () => {
    const opp = makeOpp();
    const id = `sig-${opp.id}`;
    repo.signalInsert({
      id,
      state: "qualified",
      symbol: opp.symbol,
      timeframe: opp.timeframe,
      direction: opp.direction,
      score: opp.score,
      strategy_id: opp.strategy_id,
      opp_id: opp.id,
      payload_json: "{}",
      created_ms: 12345,
      updated_ms: 12345,
    });
    const r1 = publishSignal(opp);
    expect(r1.published).toBe(true);
    const row = repo.signalByOpp(opp.id)!;
    expect(row.state).toBe("published");
    expect(row.created_ms).toBe(12345); // UPDATE, not REPLACE — identity kept
    expect(outboxRowsFor(opp.id).length).toBe(1); // queued ONCE at activation
    const r2 = publishSignal(opp);
    expect(r2.reason).toMatch(/already published/);
    expect(outboxRowsFor(opp.id).length).toBe(1);
  });
});

describe("T05 publish boundary: FINAL hard risk boundary (strict)", () => {
  it("1. an explicit well-formed risk PASS publishes", () => {
    const opp = makeOpp({ state: "READY", risk: RISK_PASS });
    const r = publishSignal(opp);
    expect(r.published).toBe(true);
    expect(repo.signalByOpp(opp.id)!.state).toBe("published");
    expect(outboxRowsFor(opp.id).length).toBe(1);
  });

  it("2. an explicit block verdict can NEVER become a published signal or an outbox row", () => {
    const opp = makeOpp({ state: "READY", risk: RISK_BLOCK });
    const r = publishSignal(opp);
    expect(r.published).toBe(false);
    expect(r.reason).toMatch(/risk gate verdict "block"/);
    expect(repo.signalByOpp(opp.id)).toBeNull();
    expect(outboxRowsFor(opp.id).length).toBe(0);
  });

  it("3. missing risk (null/undefined) is NOT approval — unavailable risk never publishes", () => {
    for (const [label, risk] of [["null", null], ["undefined", undefined]] as const) {
      const opp = makeOpp({ state: "READY", risk: risk as never });
      const r = publishSignal(opp);
      expect(r.published, label).toBe(false);
      expect(r.reason, label).toMatch(/risk result missing\/unavailable/);
      expect(repo.signalByOpp(opp.id), label).toBeNull();
      expect(outboxRowsFor(opp.id).length, label).toBe(0);
    }
  });

  it("4. unavailable/unknown risk verdicts never publish", () => {
    for (const verdict of ["unavailable", "unknown", "UNKNOWN", "UNAVAILABLE", "pending"]) {
      const opp = makeOpp({ state: "READY", risk: { verdict, reasons: [], numbers: {} } });
      const r = publishSignal(opp);
      expect(r.published, verdict).toBe(false);
      expect(r.reason, verdict).toMatch(/only an explicit PASS may be published/);
      expect(repo.signalByOpp(opp.id), verdict).toBeNull();
      expect(outboxRowsFor(opp.id).length, verdict).toBe(0);
    }
  });

  it("5. malformed risk payloads never publish", () => {
    // contract: a publishable risk result is exactly {verdict: string, reasons: []}
    // with verdict === "pass" — anything else is malformed/unknown and refused
    const malformed: [string, unknown][] = [
      ["empty object", {}],
      ["non-string verdict", { verdict: 123, reasons: [] }],
      ["no reasons", { verdict: "pass" }],
      ["reasons not an array", { verdict: "pass", reasons: "not-an-array" }],
      ["risk is a string", "pass"],
      ["risk is a number", 7],
    ];
    for (const [label, risk] of malformed) {
      const opp = makeOpp({ state: "READY", risk: risk as never });
      const r = publishSignal(opp);
      expect(r.published, label).toBe(false);
      expect(r.reason, label).toMatch(/malformed/);
      expect(repo.signalByOpp(opp.id), label).toBeNull();
      expect(outboxRowsFor(opp.id).length, label).toBe(0);
    }
  });

  it("6. refused publication creates no signal row, no Telegram outbox row, and nothing a drain could deliver", () => {
    const refused = [
      makeOpp({ state: "READY", risk: null as never }),
      makeOpp({ state: "READY", risk: RISK_BLOCK }),
      makeOpp({ state: "READY", risk: { verdict: "unavailable", reasons: [], numbers: {} } }),
      makeOpp({ state: "READY", risk: {} as never }),
    ];
    for (const opp of refused) expect(publishSignal(opp).published).toBe(false);
    for (const opp of refused) {
      expect(repo.signalByOpp(opp.id)).toBeNull();
      expect(outboxRowsFor(opp.id).length).toBe(0);
    }
    // nothing references these opportunities => delivery can never see them
    const retryable = repo.outboxRetryable(500).map((r) => JSON.parse(r.payload_json) as { opportunity_id?: string });
    for (const opp of refused) {
      expect(retryable.some((p) => p.opportunity_id === opp.id)).toBe(false);
    }
  });

  it("a non-pass risk verdict is refused, not reinterpreted", () => {
    const opp = makeOpp({ state: "READY", risk: { verdict: "pending", reasons: [], numbers: {} } });
    const r = publishSignal(opp);
    expect(r.published).toBe(false);
    expect(repo.signalByOpp(opp.id)).toBeNull();
    expect(outboxRowsFor(opp.id).length).toBe(0);
  });

  it("a REJECTED / EXPIRED decision never publishes — only READY does", () => {
    for (const state of ["REJECTED", "EXPIRED", "COOLDOWN", "RISK_CHECK"] as const) {
      const opp = makeOpp({ state, risk: RISK_PASS });
      const r = publishSignal(opp);
      expect(r.published, state).toBe(false);
      expect(r.reason, state).toMatch(/not publishable/);
      expect(repo.signalByOpp(opp.id), state).toBeNull();
      expect(outboxRowsFor(opp.id).length, state).toBe(0);
    }
  });

  it("published payload retains full decision provenance", () => {
    const opp = makeOpp({ risk: RISK_PASS, setup_id: "SET-X", thesis: "level touch" });
    publishSignal(opp);
    const row = repo.signalByOpp(opp.id)!;
    expect(row.symbol).toBe(opp.symbol);
    expect(row.timeframe).toBe(opp.timeframe);
    expect(row.strategy_id).toBe(opp.strategy_id);
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload.id).toBe(opp.id);
    expect(payload.thesis).toBe("level touch");
    expect(payload.setup_id).toBe("SET-X");
    expect(typeof payload.published_at_ms).toBe("number");
    // the queued advisory row is traceable to this opportunity
    const outbox = outboxRowsFor(opp.id)[0];
    const op = JSON.parse(outbox.payload_json) as Record<string, unknown>;
    expect(op.advisory_only).toBe(true);
    expect(op.opportunity_id).toBe(opp.id);
  });
});
