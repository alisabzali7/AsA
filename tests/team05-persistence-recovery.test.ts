import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteRepo } from "../src/db/sqlite";
import type { OutboxClaim } from "../src/db/repo";

let repo: SqliteRepo;
afterEach(() => { repo?.close(); vi.useRealTimers(); });
function setup() { repo = new SqliteRepo(":memory:"); return repo.outboxEnqueue("system", { kind: "system" }); }
function claim(token = "A"): OutboxClaim { return { token, claimed_at_ms: Date.now(), expires_at_ms: Date.now() + 100 }; }

describe("T05 recovery: persistence ownership is temporal, not merely a token", () => {
  it("expired owner cannot mutate even BEFORE another worker reclaims", () => {
    vi.useFakeTimers(); const id = setup(); const c = claim();
    expect(repo.outboxClaim(id, c)).toBe(true);
    vi.advanceTimersByTime(101);
    expect(repo.outboxCountAttempt(id, c)).toBeNull();
    expect(repo.outboxSetPayload(id, '{}', c)).toBe(false);
    expect(repo.outboxMark(id, "SENT", null, c)).toBe(false);
  });
  it("unowned preflight cannot mutate an active claim or resurrect SENT", () => {
    const id = setup(); const c = claim(); repo.outboxClaim(id, c);
    expect(repo.outboxMark(id, "FAILED", "unconfigured worker")).toBe(false);
    expect(repo.outboxSetPayload(id, '{}')).toBe(false);
    expect(repo.outboxMark(id, "SENT", null, c)).toBe(true);
    expect(repo.outboxMark(id, "QUEUED", "stale snapshot")).toBe(false);
    expect(repo.outboxGet(id)?.state).toBe("SENT");
  });
  it("counting the same cycle twice spends only one attempt", () => {
    const id = setup(); const c = claim(); repo.outboxClaim(id, c);
    expect(repo.outboxCountAttempt(id, c)).toBe(1);
    expect(repo.outboxCountAttempt(id, c)).toBe(1);
  });
  it("crash on final attempt is terminalized after lease expiry", () => {
    vi.useFakeTimers(); const id = setup();
    for (let i = 0; i < 5; i++) {
      const c = claim(String(i)); expect(repo.outboxClaim(id, c)).toBe(true);
      repo.outboxCountAttempt(id, c);
      if (i < 4) repo.outboxMark(id, "FAILED", "provider failure", c);
    }
    vi.advanceTimersByTime(101); repo.outboxRetryable(50);
    expect(repo.outboxGet(id)?.state).toBe("DEAD");
    expect(repo.outboxGet(id)?.attempts).toBe(5);
  });
  it("corrupt unrelated legacy payload does not break provenance resolution", () => {
    const id = setup(); repo.outboxSetPayload(id, "{");
    repo.outboxEnqueue("signal", { opportunity_id: "good" });
    // The corrupt row must be of the queried kind to exercise SQLite json_extract.
    const bad = repo.outboxEnqueue("signal", {}); repo.outboxSetPayload(bad, "{");
    expect(() => repo.outboxForOpportunity("missing")).not.toThrow();
    expect(repo.outboxForOpportunity("good")).not.toBeNull();
  });
  it("terminal signal cannot be resurrected through the repository seam", () => {
    setup(); repo.signalInsert({ id: "s", state: "expired", symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 90, strategy_id: "x", opp_id: "o", payload_json: "{}", created_ms: 1, updated_ms: 1 });
    expect(() => repo.signalUpdate({ id: "s", state: "published" })).toThrow(/transition/i);
    expect(repo.signalGet("s")?.state).toBe("expired");
  });
});

describe("T05 recovery: atomic lifecycle audit", () => {
  it("rolls back enqueue, signal and transition history together", () => {
    setup(); const before = repo.outboxList("ALL", 50).length;
    expect(() => repo.withTransaction(() => {
      const outbox = repo.outboxEnqueue("signal", { opportunity_id: "rollback" });
      repo.signalInsert({ id: "rollback", state: "published", symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 90, strategy_id: "x", opp_id: "rollback", outbox_id: outbox, payload_json: "{}", created_ms: 1, updated_ms: 1 });
      throw new Error("injected disk/write failure");
    })).toThrow("injected");
    expect(repo.signalGet("rollback")).toBeNull();
    expect(repo.signalHistory("rollback")).toEqual([]);
    expect(repo.outboxList("ALL", 50)).toHaveLength(before);
  });
  it("persists real transitions once, freezes decision and identity, refuses terminal edits", () => {
    setup(); repo.signalInsert({ id: "audit", state: "published", symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 90, strategy_id: "x", opp_id: "audit", payload_json: "{}", created_ms: 1, updated_ms: 1 });
    expect(() => repo.signalUpdate({ id: "audit", payload_json: '{"forged":true}' })).toThrow(/immutable/);
    expect(() => repo.signalUpdate({ id: "audit", opp_id: "other" })).toThrow(/immutable/);
    repo.signalUpdate({ id: "audit", state: "expired" });
    repo.signalUpdate({ id: "audit", state: "expired" });
    expect(repo.signalHistory("audit").map((h) => [h.from_state, h.to_state])).toEqual([[null, "published"], ["published", "expired"]]);
    expect(repo.signalHistory("audit")[0].changed_ms).toBeGreaterThan(1); // observed now, not fabricated from a legacy created_ms
    expect(() => repo.signalUpdate({ id: "audit", score: 100 })).toThrow(/immutable/);
  });
});

describe("T05 recovery: opportunity projection consistency", () => {
  it("research to live rescan updates the mode column as well as its payload", () => {
    setup();
    const row = { id: "same-anchor", symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 90, state: "READY", mode: "research", strategy_id: "x", payload_json: '{"mode":"research"}', created_ms: 1, updated_ms: 1 };
    repo.opportunityUpsert(row);
    repo.opportunityUpsert({ ...row, mode: "live", payload_json: '{"mode":"live"}', updated_ms: 2 });
    expect(repo.opportunityGet(row.id)?.mode).toBe("live");
    expect(repo.opportunityGet(row.id)?.created_ms).toBe(1);
  });
});

describe("T05 recovery: persisted acceptance on last-attempt crash", () => {
  it("finalizes SENT only when all provider acceptances were persisted before the crash", () => {
    vi.useFakeTimers(); const id = setup();
    for (let i = 0; i < 5; i++) {
      const c = claim("deliberately-reused-worker-token");
      expect(repo.outboxClaim(id, c)).toBe(true);
      expect(repo.outboxCountAttempt(id, c)).toBe(i + 1);
      if (i < 4) repo.outboxMark(id, "FAILED", "provider failure", c);
      else repo.outboxSetPayload(id, JSON.stringify({ kind: "system", delivery_progress: { text_sent: true, photo_required: true, photo_sent: true } }), c);
      vi.advanceTimersByTime(1);
    }
    vi.advanceTimersByTime(101);
    expect(repo.outboxRetryable(50)).toEqual([]);
    expect(repo.outboxGet(id)?.state).toBe("SENT");
    expect(repo.outboxGet(id)?.attempts).toBe(5);
    expect(repo.outboxGet(id)?.sent_ms).not.toBeNull();
  });
});
