/**
 * TEAM 05 — honest attempts accounting for the Telegram outbox (Task 3).
 *
 * "attempts" counts logical delivery attempts that ENTERED THE TRANSPORT
 * PHASE (a Telegram provider request was made or attempted) — exactly once
 * per delivery cycle. Every path below makes NO provider request and must
 * therefore NEVER consume the retry budget, no matter how often it runs:
 *
 *   - Telegram not configured        (preflight)
 *   - dry-run / no-send mode         (preflight)
 *   - claim failure                  (row owned elsewhere)   [claim-lease suite]
 *   - payload parse failure          (before any provider request)
 *
 * This file exercises the REAL SqliteRepo with fresh module instances (env
 * consts are frozen at module load, so each scenario re-imports telegram.ts
 * under its own configuration).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-tgattempts-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
// DEFAULT ENV: Telegram NOT configured (the no-configuration preflight path)
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.TELEGRAM_DRY_RUN;

type Repo = import("../src/db/repo").Repo;
type OutboxRow = import("../src/db/repo").OutboxRow;

let repo: Repo;
let closeRepo: () => void;
let notConfiguredDeliver: (row: OutboxRow, repo?: Repo) => Promise<{ ok: boolean; error?: string }>;

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let origFetch: FetchImpl;
let providerCalls: number;

beforeAll(async () => {
  origFetch = globalThis.fetch as FetchImpl;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as FetchImpl;

  const sqlite = await import("../src/db/sqlite");
  const tg = await import("../src/lib/notify/telegram");
  repo = sqlite.getRepo();
  closeRepo = sqlite.closeRepo;
  notConfiguredDeliver = tg.deliverOutboxRow;
  providerCalls = 0;
});

afterAll(() => {
  globalThis.fetch = origFetch as typeof globalThis.fetch;
  closeRepo();
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  providerCalls = 0;
});

function enqueueTextRow(): number {
  return repo.outboxEnqueue("system", { kind: "system", thesis: "attempts accounting test", generated_at_ms: Date.now() });
}

function rowById(id: number): OutboxRow {
  return repo.outboxList("ALL", 200).find((r) => r.id === id)!;
}

describe("T05 honest attempts: preflight failures never consume the retry budget", () => {
  it("not configured: row stays retryable forever with attempts=0 and zero provider calls", async () => {
    const id = enqueueTextRow();
    for (let i = 0; i < 10; i++) {
      const r = await notConfiguredDeliver(rowById(id), repo);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("telegram not configured");
    }
    const row = rowById(id);
    expect(row.attempts).toBe(0); // 10 preflight blocks — not ONE delivery attempt happened
    expect(row.state).toBe("FAILED"); // existing contract: noted as blocked, still retryable
    expect(row.error).toBe("telegram not configured");
    expect(providerCalls).toBe(0);
    expect(repo.outboxRetryable(50).some((r) => r.id === id)).toBe(true); // never DEAD via preflight
  });

  it("dry-run mode: no send attempted, no attempts spent, row stays QUEUED", async () => {
    vi.resetModules();
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "123456789";
    process.env.TELEGRAM_DRY_RUN = "1";
    const tgDryRun = await import("../src/lib/notify/telegram");

    const id = enqueueTextRow();
    for (let i = 0; i < 10; i++) {
      const r = await tgDryRun.deliverOutboxRow(rowById(id), repo);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("dry-run mode");
    }
    const row = rowById(id);
    expect(row.attempts).toBe(0); // "no send attempted" is not a delivery attempt
    expect(row.state).toBe("QUEUED");
    expect(row.error).toBe("dry-run — no send attempted");
    expect(providerCalls).toBe(0);
    expect(repo.outboxRetryable(50).some((r) => r.id === id)).toBe(true);
  });
});
