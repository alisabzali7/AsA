/**
 * CROSS-PROCESS OUTBOX / PUBLICATION CONCURRENCY SUITE.
 *
 * Why this exists as a separate suite: every other concurrency assertion in
 * this repository runs inside ONE vitest worker — one process, one SQLite
 * connection, one JS event loop. The outbox claim/lease protocol and the
 * publication transaction make claims ABOUT OTHER PROCESSES (the engine timer,
 * an operator drain, a restarted container), and those claims were never
 * exercised that way.
 *
 * This suite therefore bundles the REAL `SqliteRepo` (esbuild, the same source
 * the app imports), spawns REAL child `node` processes against ONE database
 * file, and asserts the invariants a single-process test cannot reach:
 *
 *   - exclusive claim: N processes racing for one row, exactly one winner
 *   - stale owner: a worker whose lease expired cannot mutate the reclaimed row
 *   - interrupted final attempt: COMPLETE persisted progress resolves SENT,
 *     INCOMPLETE progress resolves DEAD (ambiguous acceptance is never "sent")
 *   - publication atomicity: two processes publishing one opportunity commit
 *     exactly one signal row, one outbox row, and no orphan delivery
 *   - a live lease in another process hides the row from the retry selector
 *   - one transport attempt per claim, even when counted from two processes
 *   - a forged/mismatched claim identity cannot spend the retry budget
 *
 * The Telegram transport is NOT involved: these tests pin the persistence-layer
 * coordination that decides who is allowed to talk to the provider at all.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const ROOT = path.join(__dirname, "..");
const DRIVER_SRC = `
import { SqliteRepo } from "./src/db/sqlite";
import type { OutboxClaim } from "./src/db/repo";

const cmd = JSON.parse(process.argv[2] ?? "{}") as Record<string, unknown>;
const repo = new SqliteRepo(String(cmd.db));
const syncSleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
function claim(token: string, leaseMs: number): OutboxClaim {
  const now = Date.now();
  return { token, claimed_at_ms: now, expires_at_ms: now + leaseMs };
}
let out: unknown = { error: "unhandled op" };
switch (String(cmd.op)) {
  case "claim": {
    if (cmd.startAtMs) { while (Date.now() < Number(cmd.startAtMs)) { /* synchronized gate */ } }
    const c = claim(String(cmd.token), Number(cmd.leaseMs ?? 120000));
    out = { token: cmd.token, ok: repo.outboxClaim(Number(cmd.id), c), claim: c };
    break;
  }
  case "claim-then-write-after-expiry": {
    const c = claim(String(cmd.token), Number(cmd.leaseMs));
    const claimed = repo.outboxClaim(Number(cmd.id), c);
    syncSleep(Number(cmd.sleepMs));
    out = {
      claimed,
      mark: repo.outboxMark(Number(cmd.id), "SENT", null, c),
      setPayload: repo.outboxSetPayload(Number(cmd.id), JSON.stringify({ hijacked: true }), c),
      countAttempt: repo.outboxCountAttempt(Number(cmd.id), c),
      renew: repo.outboxRenewClaim(Number(cmd.id), c, Date.now() + 120000),
    };
    break;
  }
  case "count-attempt": {
    out = { attempts: repo.outboxCountAttempt(Number(cmd.id), cmd.claim as OutboxClaim) };
    break;
  }
  case "retryable": {
    const rows = repo.outboxRetryable(Number(cmd.limit ?? 50));
    out = { ids: rows.map((r) => r.id) };
    break;
  }
  case "state": {
    out = { row: repo.outboxGet(Number(cmd.id)) };
    break;
  }
  case "publish": {
    if (cmd.startAtMs) { while (Date.now() < Number(cmd.startAtMs)) { /* synchronized gate */ } }
    const oppId = String(cmd.oppId);
    try {
      const outboxId = repo.withTransaction(() => {
        const enqueued = repo.outboxEnqueue("signal", { kind: "signal", opportunity_id: oppId, signal_id: String(cmd.signalId) });
        repo.signalInsert({
          id: String(cmd.signalId), state: "published", symbol: "BTCUSDT", timeframe: "1h",
          direction: "long", score: 90, strategy_id: "STR-XPROC", opp_id: oppId,
          payload_json: JSON.stringify({ opportunity_id: oppId }), created_ms: Date.now(), updated_ms: Date.now(),
          outbox_id: enqueued,
        });
        return enqueued;
      });
      out = { committed: true, outboxId };
    } catch (err) {
      out = { committed: false, error: err instanceof Error ? err.message : String(err) };
    }
    break;
  }
}
process.stdout.write(JSON.stringify(out));
repo.close();
`;

let driver: string;
let tmp: string;

function freshDb(name: string): string {
  const dir = fs.mkdtempSync(path.join(tmp, name + "-"));
  return path.join(dir, "asa.db");
}

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NODE_PATH: path.join(ROOT, "node_modules") };
}

function run(payload: Record<string, unknown>): { out: Record<string, unknown>; row: { claimed_by?: string | null; state?: string; attempts?: number; sent_ms?: number | null; payload_json?: string } | null } {
  const stdout = execFileSync(process.execPath, [driver, JSON.stringify(payload)], { encoding: "utf8", env: childEnv() });
  const out = JSON.parse(stdout) as Record<string, unknown>;
  const row = payload.id !== undefined
    ? JSON.parse(execFileSync(process.execPath, [driver, JSON.stringify({ op: "state", db: payload.db, id: payload.id })], { encoding: "utf8", env: childEnv() })).row
    : null;
  return { out, row };
}

function runAsync(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [driver, JSON.stringify(payload)], { encoding: "utf8", env: childEnv() }, (err, stdout) => {
      if (err) reject(err);
      else resolve(JSON.parse(stdout) as Record<string, unknown>);
    });
  });
}

function seedRow(db: string, payload: unknown, attempts = 0, state = "QUEUED"): number {
  const dir = path.dirname(db);
  const script = path.join(dir, "seed.cjs");
  fs.writeFileSync(
    script,
    `const Database = require('better-sqlite3');
const db = new Database(process.argv[2]);
db.exec("CREATE TABLE IF NOT EXISTS telegram_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'QUEUED', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, error_kind TEXT, created_ms INTEGER NOT NULL, sent_ms INTEGER, claimed_by TEXT, claim_ms INTEGER, claim_expires_ms INTEGER, attempt_claim TEXT)");
const r = db.prepare("INSERT INTO telegram_outbox (kind,payload_json,state,attempts,created_ms) VALUES ('signal',?,?,?,?)").run(process.argv[3], process.argv[4], Number(process.argv[5]), Date.now());
process.stdout.write(String(r.lastInsertRowid));`,
  );
  const id = execFileSync(process.execPath, [script, db, JSON.stringify(payload), state, String(attempts)], { encoding: "utf8", env: childEnv() });
  return Number(id);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asa-xproc-"));
  driver = path.join(tmp, "driver.cjs");
  await build({
    stdin: { contents: DRIVER_SRC, resolveDir: ROOT, loader: "ts", sourcefile: "driver.ts" },
    outfile: driver,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    external: ["better-sqlite3"],
  });
}, 60_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("cross-process outbox claim protocol", () => {
  it("N real processes racing for one row: exactly one claim wins", async () => {
    const db = freshDb("exclusive");
    const id = seedRow(db, { kind: "system", generated_at_ms: Date.now() });
    const startAtMs = Date.now() + 1200;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => runAsync({ op: "claim", db, id, token: `proc-${i}`, leaseMs: 60_000, startAtMs })),
    );
    const winners = results.filter((r) => r.ok === true);
    expect(winners.length).toBe(1);
    const { row } = run({ op: "state", db, id });
    expect(row?.claimed_by).toBe(winners[0].token);
  }, 60_000);

  it("a stale owner cannot mutate a row another process reclaimed", async () => {
    const db = freshDb("stale");
    const id = seedRow(db, { kind: "system", generated_at_ms: Date.now() });
    // worker claims with a 120 ms lease, sleeps past it, then tries to write
    const stale = runAsync({ op: "claim-then-write-after-expiry", db, id, token: "stale", leaseMs: 120, sleepMs: 260 });
    await new Promise((r) => setTimeout(r, 180));
    const fresh = await runAsync({ op: "claim", db, id, token: "fresh", leaseMs: 60_000 });
    const staleResult = await stale;
    expect(fresh.ok).toBe(true);
    expect(staleResult.mark).toBe(false);
    expect(staleResult.setPayload).toBe(false);
    expect(staleResult.countAttempt).toBeNull();
    expect(staleResult.renew).toBe(false);
    const { row } = run({ op: "state", db, id });
    expect(row?.claimed_by).toBe("fresh");
    expect(row?.state).toBe("QUEUED");
    expect(row?.attempts).toBe(0);
    expect(row?.payload_json).not.toContain("hijacked");
  }, 60_000);

  it("a live lease held by another process hides the row from the retry selector", () => {
    const db = freshDb("livelease");
    const id = seedRow(db, { kind: "system", generated_at_ms: Date.now() });
    const claimed = run({ op: "claim", db, id, token: "holder", leaseMs: 60_000 });
    expect(claimed.out.ok).toBe(true);
    const retryable = run({ op: "retryable", db, limit: 50 });
    expect(retryable.out.ids).not.toContain(id);
  }, 60_000);

  it("one transport attempt is counted once per claim, and a forged claim identity spends nothing", () => {
    const db = freshDb("attempts");
    const id = seedRow(db, { kind: "system", generated_at_ms: Date.now() });
    const claimed = run({ op: "claim", db, id, token: "counter", leaseMs: 60_000 });
    const claim = claimed.out.claim as { token: string; claimed_at_ms: number; expires_at_ms: number };
    const first = run({ op: "count-attempt", db, id, claim });
    const second = run({ op: "count-attempt", db, id, claim });
    expect(first.out.attempts).toBe(1);
    expect(second.out.attempts).toBe(1);
    const forged = run({ op: "count-attempt", db, id, claim: { ...claim, claimed_at_ms: claim.claimed_at_ms - 1 } });
    expect(forged.out.attempts).toBeNull();
    const { row } = run({ op: "state", db, id });
    expect(row?.attempts).toBe(1);
  }, 60_000);
});

describe("cross-process crash-window recovery", () => {
  it("an interrupted final attempt with COMPLETE persisted progress resolves to SENT in a different process", () => {
    const db = freshDb("crash-complete");
    const id = seedRow(db, { kind: "system", generated_at_ms: Date.now(), delivery_progress: { photo_required: false, photo_sent: true, text_sent: true } }, 5, "QUEUED");
    const retryable = run({ op: "retryable", db, limit: 50 });
    expect(retryable.out.ids).not.toContain(id);
    const { row } = run({ op: "state", db, id });
    expect(row?.state).toBe("SENT");
    expect(row?.sent_ms).not.toBeNull();
  }, 60_000);

  it("an interrupted final attempt with INCOMPLETE progress becomes DEAD in a different process", () => {
    const db = freshDb("crash-incomplete");
    const id = seedRow(db, { kind: "system", generated_at_ms: Date.now(), delivery_progress: { photo_required: true, photo_sent: true, text_sent: false } }, 5, "QUEUED");
    run({ op: "retryable", db, limit: 50 });
    const { row } = run({ op: "state", db, id });
    expect(row?.state).toBe("DEAD");
  }, 60_000);
});

describe("cross-process publication atomicity", () => {
  it("two processes publishing one opportunity commit exactly one signal and one outbox row", async () => {
    const db = freshDb("publish");
    const oppId = "opp-xproc-1";
    const startAtMs = Date.now() + 1000;
    const [a, b] = await Promise.all([
      runAsync({ op: "publish", db, oppId, signalId: "sig-xproc-A", startAtMs }),
      runAsync({ op: "publish", db, oppId, signalId: "sig-xproc-B", startAtMs }),
    ]);
    const committed = [a, b].filter((r) => r.committed === true);
    expect(committed.length).toBe(1);
    const loser = [a, b].find((r) => r.committed !== true)!;
    expect(String(loser.error)).toMatch(/UNIQUE constraint failed: signals\.opp_id/);
    // no orphan delivery: the loser's outbox row was rolled back with its signal
    const { default: Database } = await import("better-sqlite3");
    const raw = new Database(db, { readonly: true });
    const signals = raw.prepare("SELECT COUNT(*) AS c FROM signals").get() as { c: number };
    const outbox = raw.prepare("SELECT COUNT(*) AS c FROM telegram_outbox").get() as { c: number };
    const orphans = raw.prepare("SELECT COUNT(*) AS c FROM telegram_outbox WHERE json_extract(payload_json,'$.signal_id') NOT IN (SELECT id FROM signals)").get() as { c: number };
    raw.close();
    expect(signals.c).toBe(1);
    expect(outbox.c).toBe(1);
    expect(orphans.c).toBe(0);
  }, 60_000);
});
