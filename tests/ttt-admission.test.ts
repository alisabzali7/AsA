/**
 * TASK 1 — SINGLE TTT RATE-BUDGET ENFORCEMENT.
 *
 * Invariants under test:
 *
 *   intent -> shared TTT transport -> scheduler admission -> fetch()
 *
 *   A. every successful network attempt consumes exactly ONE admission
 *   B. every retry is a new attempt and pays ANOTHER admission
 *   C. every observed HTTP 429 produces exactly ONE note429(), from the transport
 *   D. no production caller acquires budget (or records 429s) on its own
 *   E. validation failures consume ZERO tokens and perform ZERO network calls
 *   F. lane order + same-lane FIFO are deterministic (injectable clock)
 *   G. a paused circuit grants NOTHING, even with tokens available
 *   H. the scheduler resumes and the bucket recovers after the pause
 *   I. waiting is timer/event driven — no polling loop, no idle wakeups
 *   J. the instance that charges admissions is the instance status reports
 *   K. PR #7 history-boundary semantics are unchanged by the move
 *
 * Everything is deterministic: the lane tests drive an injected FakeClock, the
 * 429 retry test uses vitest fake timers, and the venue is stubbed — no test
 * depends on wall-clock sleeps or on the real network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PRIORITY,
  TttScheduler,
  activeScheduler,
  laneOf,
  schedulerStats,
  setActiveScheduler,
  sharedScheduler,
  type SchedulerClock,
} from "../src/lib/ttt/scheduler";
import { tttRequest, TttHttpError } from "../src/lib/ttt/http";
import { makeFakeVenue, stubVenue, type VenueBarSpec } from "./fixtures/market/fake-venue";

/* ───────────────────────────── deterministic clock ───────────────────────────── */

/** Manual clock: timers only fire when a test advances virtual time. */
class FakeClock implements SchedulerClock {
  private t = 1_700_000_000_000;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;
  /** how many wakes the scheduler asked for (busy-poll detector) */
  registrations = 0;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    this.registrations++;
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + Math.max(0, Math.ceil(ms)), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      this.timers = this.timers.filter((x) => x !== due);
      due.fn();
      await Promise.resolve();
    }
    this.t = end;
    await Promise.resolve();
  }
}

/* ───────────────────────────── stubbed transport ───────────────────────────── */

/** Localhost is allow-listed for tests; nothing ever reaches a socket. */
const LOCAL = "http://127.0.0.1:9";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubRoutes(routes: Record<string, { status: number; body: unknown }>): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const route = routes[url];
      if (!route) return json({ errors: [{ message: "not found" }] }, 404);
      return json(route.body, route.status);
    }),
  );
  return { calls };
}

/** A scripted stub: each call consumes the next step ("network" throws). */
function stubScript(steps: Array<{ status: number; body: unknown } | "network">): { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step === "network") throw new TypeError("fetch failed");
      return json(step.body, step.status);
    }),
  );
  return { calls };
}

/** Advance virtual time until `promise` settles (faked timers only). */
async function drive<T>(promise: Promise<T>, advance: () => Promise<void>, rounds = 8): Promise<T> {
  let settled = false;
  const tracked = promise.then(
    (v) => {
      settled = true;
      return v;
    },
    (e) => {
      settled = true;
      throw e;
    },
  );
  for (let i = 0; i < rounds && !settled; i++) await advance();
  return tracked;
}

afterEach(() => {
  setActiveScheduler(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ══════════════════════ A / B / C / E / J: transport admission ══════════════════════ */

describe("transport is the single admission point", () => {
  let scheduler: TttScheduler;

  beforeEach(() => {
    scheduler = new TttScheduler({ ratePerMin: 1000, jitter: () => 0 });
    setActiveScheduler(scheduler);
  });

  it("A. a successful attempt consumes exactly one admission, on its lane", async () => {
    const { calls } = stubRoutes({ [`${LOCAL}/ok`]: { status: 200, body: [{ symbol: "BTCUSDT" }] } });

    const res = await tttRequest<{ symbol: string }[]>("/ok", { baseUrl: LOCAL, priority: PRIORITY.FOCUS });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const st = schedulerStats();
    expect(st.total_requests).toBe(1);
    expect(st.total_grants).toBe(1);
    expect(st.lanes.focus.granted).toBe(1);
    expect(st.lanes.focus.waited_ms).toBeGreaterThanOrEqual(0);
    expect(st.lanes.backfill.granted).toBe(0);
  });

  it("A2. a HEAD request is admitted exactly once too", async () => {
    const { calls } = stubRoutes({ [`${LOCAL}/head`]: { status: 200, body: null } });
    await tttRequest("/head", { method: "HEAD", baseUrl: LOCAL, priority: PRIORITY.SWEEP });
    expect(calls).toHaveLength(1);
    expect(scheduler.stats().total_grants).toBe(1);
    expect(scheduler.stats().lanes.sweep.granted).toBe(1);
  });

  it("B1. a retried attempt pays again (network failure, then success)", async () => {
    const { calls } = stubScript(["network", { status: 200, body: [{ symbol: "BTCUSDT" }] }]);

    const res = await tttRequest<{ symbol: string }[]>("/retry", {
      baseUrl: LOCAL,
      retries: 1,
      priority: PRIORITY.SWEEP,
    });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2); // attempt 1 (failed) + retry (succeeded)
    expect(scheduler.stats().total_requests).toBe(2);
    expect(scheduler.stats().total_grants).toBe(2);
    expect(scheduler.stats().total_429).toBe(0);
  });

  it("B1b. unchanged transport semantics: a 5xx is surfaced, never looped, and costs one admission", async () => {
    const { calls } = stubRoutes({ [`${LOCAL}/boom`]: { status: 500, body: { errors: [{ message: "boom" }] } } });

    await expect(tttRequest("/boom", { baseUrl: LOCAL, retries: 2, priority: PRIORITY.SWEEP })).rejects.toSatisfy(
      (e: unknown) => e instanceof TttHttpError && e.kind === "server",
    );

    expect(calls).toHaveLength(1); // the transport's existing retry policy is untouched
    expect(scheduler.stats().total_requests).toBe(1);
    expect(scheduler.stats().total_429).toBe(0); // a 5xx is not rate-limit pressure
  });

  it("B2. a 429 retry is a new attempt: new admission, and the circuit pause is honoured", async () => {
    vi.useFakeTimers(); // the 12s pause is virtual, never slept
    const limited = new TttScheduler({ ratePerMin: 1000, jitter: () => 0 });
    setActiveScheduler(limited);
    const { calls } = stubRoutes({ [`${LOCAL}/rl`]: { status: 429, body: { errors: [{ message: "rate limit" }] } } });

    const outcome = tttRequest("/rl", { baseUrl: LOCAL, retries: 1, timeoutMs: 5000, priority: PRIORITY.REFRESH }).then(
      () => null,
      (e: unknown) => e as TttHttpError,
    );
    const err = await drive(outcome, async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(err?.kind).toBe("rate_limited");
    expect(calls).toHaveLength(2); // two network attempts
    const st = limited.stats();
    expect(st.total_requests).toBe(2); // ...two admissions
    expect(st.total_grants).toBe(2);
    expect(st.total_429).toBe(2); // one per observed 429
    expect(st.lanes.refresh.granted).toBe(2);
  });

  it("C. each observed 429 records exactly one note429(), from the transport", async () => {
    const spy = vi.spyOn(scheduler, "note429");
    stubRoutes({ [`${LOCAL}/once`]: { status: 429, body: { errors: [{ message: "slow down" }] } } });

    await expect(tttRequest("/once", { baseUrl: LOCAL, retries: 0, priority: PRIORITY.SWEEP })).rejects.toSatisfy(
      (e: unknown) => e instanceof TttHttpError && e.kind === "rate_limited",
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(scheduler.stats().total_429).toBe(1);
    expect(scheduler.stats().paused).toBe(true);
  });

  it("E. method/host validation failures consume ZERO tokens and ZERO network calls", async () => {
    const { calls } = stubRoutes({});

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      await expect(
        tttRequest("/futures/markets/stats", { method: method as never, baseUrl: LOCAL, priority: PRIORITY.FOCUS }),
      ).rejects.toThrow(/unsafe method/i);
    }
    // a host outside the TTT allow-list is refused before any admission
    await expect(tttRequest("/futures/markets", { baseUrl: "https://not-ttt.example" })).rejects.toThrow(/allow-list/i);

    expect(calls).toHaveLength(0);
    const st = scheduler.stats();
    expect(st.total_requests).toBe(0);
    expect(st.total_grants).toBe(0);
    expect(st.lanes.focus.granted).toBe(0);
    expect(st.lanes.sweep.granted).toBe(0);
  });

  it("a non-retryable 401 costs exactly one admission and is never retried", async () => {
    const { calls } = stubRoutes({ [`${LOCAL}/auth`]: { status: 401, body: { errors: [{ message: "no token" }] } } });

    await expect(tttRequest("/auth", { baseUrl: LOCAL, retries: 3 })).rejects.toSatisfy(
      (e: unknown) => e instanceof TttHttpError && e.kind === "auth",
    );

    expect(calls).toHaveLength(1);
    expect(scheduler.stats().total_requests).toBe(1);
    expect(scheduler.stats().total_grants).toBe(1);
  });

  it("K2a. a timeout is retried and every retry pays: 2 attempts = 2 admissions", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => {
        calls++;
        const abort = new Error("The operation was aborted");
        abort.name = "AbortError";
        throw abort;
      }),
    );

    await expect(tttRequest("/timeout", { baseUrl: LOCAL, retries: 1, timeoutMs: 25 })).rejects.toSatisfy(
      (e: unknown) => e instanceof TttHttpError && e.kind === "timeout",
    );

    expect(calls).toBe(2); // initial attempt + one bounded retry (real backoff sleep)
    expect(scheduler.stats().total_requests).toBe(2);
    expect(scheduler.stats().total_grants).toBe(2);
    expect(scheduler.stats().total_429).toBe(0);
  });

  it("K2b. a non-JSON content-type is NOT retried and costs exactly one admission", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => {
        calls++;
        return new Response("<html>not json</html>", { status: 200, headers: { "Content-Type": "text/html" } });
      }),
    );

    await expect(tttRequest("/html", { baseUrl: LOCAL, retries: 2 })).rejects.toSatisfy(
      (e: unknown) => e instanceof TttHttpError && e.kind === "invalid_response",
    );

    expect(calls).toBe(1);
    expect(scheduler.stats().total_requests).toBe(1);
    expect(scheduler.stats().total_grants).toBe(1);
  });

  it("K2c. malformed JSON under a JSON content-type is invalid_response: one attempt, one admission, no retry", async () => {
    // AUDIT DEFECT: `JSON.parse` on a well-labelled but corrupt body throws a
    // native SyntaxError. The outer catch classified every non-TttHttpError as
    // `network`, so a corrupt payload was retried (3 fetches / 3 admissions at
    // retries:2) and surfaced as a transport outage instead of a bad response.
    // The content-type here IS application/json, so parsing is actually reached —
    // the case a text/html body never exercises.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => {
        calls++;
        return new Response('{"s":"ok","t":[1,2,', { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    await expect(tttRequest("/broken-json", { baseUrl: LOCAL, retries: 2 })).rejects.toSatisfy(
      (e: unknown) => e instanceof TttHttpError && e.kind === "invalid_response",
    );

    expect(calls).toBe(1); // no retry: a corrupt body is not a transport failure
    expect(scheduler.stats().total_requests).toBe(1);
    expect(scheduler.stats().total_grants).toBe(1);
  });

  it("J. the instance that charges admissions is the instance status reports", async () => {
    const injected = new TttScheduler({ ratePerMin: 1000, jitter: () => 0 });
    const perTest = activeScheduler(); // this file's describe-level instance
    setActiveScheduler(injected);
    try {
      stubRoutes({ [`${LOCAL}/ok`]: { status: 200, body: [{ symbol: "BTCUSDT" }] } });

      await tttRequest("/ok", { baseUrl: LOCAL, priority: PRIORITY.BACKFILL });

      // status/observability (schedulerStats) == enforcement (the injected one)
      expect(schedulerStats()).toEqual(injected.stats());
      expect(schedulerStats().total_requests).toBe(1);
      expect(schedulerStats().lanes.backfill.granted).toBe(1);
      // ...and the untouched instance saw nothing at all
      expect(perTest.stats().total_requests).toBe(0);
      expect(perTest.stats().total_grants).toBe(0);
    } finally {
      setActiveScheduler(null);
    }
    expect(activeScheduler()).toBe(sharedScheduler); // the process-wide default is restored
  });
});

/* ══════════════════════ D: static call-site audit ══════════════════════ */

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Drop comments so a *mention* of a call is never mistaken for a call. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("D. caller-side scheduler consumption is absent from production paths", () => {
  const SANCTIONED = new Set(["src/lib/ttt/http.ts", "src/lib/ttt/scheduler.ts"]);

  it("only the shared transport acquires budget, and only it records 429s", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const rel = file.split(path.sep).join("/");
      if (SANCTIONED.has(rel)) continue;
      const code = stripComments(fs.readFileSync(file, "utf8"));
      if (/\.acquire\s*\(/.test(code)) offenders.push(`${rel}: acquires budget itself`);
      if (/\bnote429\s*\(/.test(code)) offenders.push(`${rel}: records 429s itself`);
      if (/\bsharedScheduler\b/.test(code)) offenders.push(`${rel}: binds a scheduler instance directly`);
    }
    expect(offenders).toEqual([]);

    // the audit is not vacuous: the single admission point really is in http.ts
    const http = fs.readFileSync("src/lib/ttt/http.ts", "utf8");
    expect(http).toMatch(/scheduler\.acquire\(lane\)/);
    expect(http).toMatch(/scheduler\.note429\(\)/);
    expect(stripComments(http).match(/\.acquire\s*\(/g) ?? []).toHaveLength(1);

    // callers label lanes only
    for (const rel of ["src/lib/market/engine.ts", "src/lib/market/candles.ts", "src/lib/market/history.ts", "src/lib/market/catalog.ts"]) {
      const code = stripComments(fs.readFileSync(rel, "utf8"));
      expect(/PRIORITY\./.test(code), `${rel} expresses no lane intent`).toBe(true);
    }
  });

  it("I-static. the scheduler waits on state transitions only — no polling loop", () => {
    const src = fs.readFileSync("src/lib/ttt/scheduler.ts", "utf8");
    expect(src).not.toMatch(/setInterval/); // no periodic tick
    expect(src).not.toMatch(/\bsleep\s*\(/); // no ad-hoc sleep loop
    // exactly ONE place arms a timer: the single-wake scheduler
    expect(src.match(/this\.clock\.setTimeout\(/g) ?? []).toHaveLength(1);
    // ...and its deadline is derived from the next token / the pause boundary
    expect(src).toMatch(/msUntilNextToken\(\)/);
    expect(src).toMatch(/this\.pausedUntilMs \+ 1 - now/);
  });

  it("lane intent is clamped, and malformed intent never escalates to the top lane", () => {
    expect(laneOf(PRIORITY.FOCUS)).toBe(PRIORITY.FOCUS);
    expect(laneOf(PRIORITY.BACKFILL)).toBe(PRIORITY.BACKFILL);
    expect(laneOf(1.9)).toBe(PRIORITY.REFRESH); // floored onto a real lane
    expect(laneOf(-2)).toBe(PRIORITY.FOCUS); // an urgent clamp stays urgent
    expect(laneOf(99)).toBe(PRIORITY.BACKFILL); // never below the lowest lane
    expect(laneOf(undefined)).toBe(PRIORITY.SWEEP); // default, not FOCUS
    expect(laneOf(null)).toBe(PRIORITY.SWEEP);
    // AUDIT FIX: non-finite intent is malformed — it falls back to the default
    // lane and can never buy top-priority service
    expect(laneOf(Number.NaN)).toBe(PRIORITY.SWEEP);
    expect(laneOf(Number.POSITIVE_INFINITY)).toBe(PRIORITY.SWEEP);
    expect(laneOf(Number.NEGATIVE_INFINITY)).toBe(PRIORITY.SWEEP);
    expect(laneOf("focus" as unknown as number)).toBe(PRIORITY.SWEEP);
  });
});

/* ══════════════════════ F / G / H / I: scheduler behaviour ══════════════════════ */

/** at 60/min, 1001ms of virtual time refills just over one token */
const ONE_TOKEN_MS = 1_001;

describe("scheduler lanes are deterministic, fair, and event driven", () => {
  it("F. lanes dispatch by priority with deterministic FIFO inside a lane", async () => {
    const clock = new FakeClock();
    const s = new TttScheduler({ ratePerMin: 60, clock, jitter: () => 0, agingMs: 60_000 });
    await s.acquireMany(60, PRIORITY.SWEEP); // drain the bucket
    expect(s.stats().budget_per_min).toBeLessThan(1);

    const order: string[] = [];
    const wait = (label: string, lane: number) => {
      void s.acquire(lane).then(() => order.push(label));
    };
    wait("b1", PRIORITY.BACKFILL);
    wait("s1", PRIORITY.SWEEP);
    wait("f1", PRIORITY.FOCUS);
    wait("f2", PRIORITY.FOCUS);
    wait("s2", PRIORITY.SWEEP);
    wait("r1", PRIORITY.REFRESH);
    expect(order).toEqual([]); // an empty bucket grants nothing

    const expected = ["f1", "f2", "r1", "s1", "s2", "b1"];
    for (let i = 0; i < expected.length; i++) {
      await clock.advance(ONE_TOKEN_MS);
      expect(order).toEqual(expected.slice(0, i + 1));
    }
    const st = s.stats();
    expect(st.current_waiters).toBe(0);
    expect(st.lanes.focus.granted).toBe(2);
    expect(st.lanes.refresh.granted).toBe(1);
    expect(st.lanes.backfill.granted).toBe(1);

    // the identical scenario reproduces the identical dispatch
    const s2 = new TttScheduler({ ratePerMin: 60, clock, jitter: () => 0, agingMs: 60_000 });
    await s2.acquireMany(60, PRIORITY.SWEEP);
    const replay: string[] = [];
    for (const [label, lane] of [
      ["b1", PRIORITY.BACKFILL],
      ["s1", PRIORITY.SWEEP],
      ["f1", PRIORITY.FOCUS],
      ["f2", PRIORITY.FOCUS],
      ["s2", PRIORITY.SWEEP],
      ["r1", PRIORITY.REFRESH],
    ] as const) {
      void s2.acquire(lane).then(() => replay.push(label));
    }
    for (let i = 0; i < expected.length; i++) await clock.advance(ONE_TOKEN_MS);
    expect(replay).toEqual(expected);
  });

  it("F2. a newly arrived higher-priority request overtakes queued lower-priority work", async () => {
    const clock = new FakeClock();
    const s = new TttScheduler({ ratePerMin: 60, clock, jitter: () => 0, agingMs: 60_000 });
    await s.acquireMany(60, PRIORITY.SWEEP);

    const done: string[] = [];
    void s.acquire(PRIORITY.BACKFILL).then(() => done.push("backfill"));
    void s.acquire(PRIORITY.FOCUS).then(() => done.push("focus"));

    await clock.advance(ONE_TOKEN_MS);
    expect(done).toEqual(["focus"]); // the newcomer wins its lane
    expect(s.stats().current_waiters).toBe(1);
  });

  it("F3. queueing time prevents starvation of background work", async () => {
    const clock = new FakeClock();
    const s = new TttScheduler({ ratePerMin: 60, clock, jitter: () => 0, agingMs: 1_000 });
    await s.acquireMany(60, PRIORITY.SWEEP);

    const done: string[] = [];
    void s.acquire(PRIORITY.BACKFILL).then(() => done.push("backfill"));
    for (let i = 0; i < 6; i++) {
      void s.acquire(PRIORITY.FOCUS).then(() => done.push(`focus${i}`));
      await clock.advance(ONE_TOKEN_MS);
    }
    // the aged backfill waiter is promoted to lane 0 and, being oldest, wins a token
    expect(done).toContain("backfill");
    expect(done.indexOf("backfill")).toBeLessThan(6);
  });

  it("G. a paused circuit grants NOTHING, even while tokens are available", async () => {
    const clock = new FakeClock();
    const s = new TttScheduler({ ratePerMin: 60, clock, jitter: () => 0 });
    expect(s.stats().budget_per_min).toBeGreaterThan(10);

    s.note429(); // pause = exactly 12s (jitter pinned)
    expect(s.stats().paused).toBe(true);
    expect(s.stats().paused_until_ms).toBeGreaterThan(clock.now());

    let granted = false;
    const pending = s.acquire(PRIORITY.FOCUS).then(() => {
      granted = true;
    });

    await clock.advance(5_000);
    expect(granted).toBe(false); // paused: nothing is handed out
    expect(s.stats().total_grants).toBe(0);
    expect(s.stats().paused).toBe(true);

    await clock.advance(8_000); // past the pause
    await pending;
    expect(granted).toBe(true);
    expect(s.stats().total_grants).toBe(1);
    expect(s.stats().paused).toBe(false);
  });

  it("H. after the pause the bucket recovers from the pause END — no burst of tokens", async () => {
    const clock = new FakeClock();
    const s = new TttScheduler({ ratePerMin: 60, clock, jitter: () => 0 });
    await s.acquireMany(60, PRIORITY.SWEEP); // bucket empty
    expect(s.stats().budget_per_min).toBeLessThan(1);

    s.note429();
    expect(s.stats().paused).toBe(true);

    await clock.advance(12_500); // pause expires
    expect(s.stats().paused).toBe(false);
    // AUDIT: only the 0.5s AFTER the pause may be credited (0.5 tokens at
    // 60/min). Crediting the paused window would hand the queue 12.5 tokens at
    // once — the opposite of throttling, and an instant second 429.
    expect(s.stats().budget_per_min).toBeCloseTo(0.5, 5);

    await clock.advance(10_000); // steady post-pause recovery
    expect(s.stats().budget_per_min).toBeCloseTo(10.5, 5);

    const before = clock.now();
    await s.acquire(PRIORITY.FOCUS);
    expect(clock.now() - before).toBe(0); // admission is immediate again
  });

  it("G2. repeated 429s extend the pause, grant nothing, and never inflate the bucket", async () => {
    const clock = new FakeClock();
    const s = new TttScheduler({ ratePerMin: 60, clock, jitter: () => 0 });
    await s.acquireMany(60, PRIORITY.SWEEP); // drained

    s.note429(); // pause 1: t0 + 12s
    await clock.advance(6_000);
    s.note429(); // pause 2 extends it to t0 + 18s
    expect(s.stats().paused).toBe(true);

    let granted = 0;
    const waiters = [
      s.acquire(PRIORITY.FOCUS).then((): void => { granted++; }),
      s.acquire(PRIORITY.SWEEP).then((): void => { granted++; }),
    ];

    await clock.advance(11_000); // t0+17s: still paused
    expect(granted).toBe(0);
    expect(s.stats().budget_per_min).toBeLessThanOrEqual(4); // floor, zero accrual

    await drive(Promise.all(waiters), async () => {
      await clock.advance(2_000);
    }, 30);
    expect(granted).toBe(2);
    expect(s.stats().budget_per_min).toBeLessThanOrEqual(60); // never above configured
    expect(s.stats().total_429).toBe(2);
  });

  it("G3. a paused window is never credited: waiters resume one token at a time", async () => {
    const clock = new FakeClock();
    const s = new TttScheduler({ ratePerMin: 60, clock, jitter: () => 0 }); // 1 token / s
    await s.acquireMany(60, PRIORITY.SWEEP); // drained

    const grantTimes: number[] = [];
    const all = [
      s.acquire(PRIORITY.FOCUS).then((): void => { grantTimes.push(clock.now()); }),
      s.acquire(PRIORITY.SWEEP).then((): void => { grantTimes.push(clock.now()); }),
      s.acquire(PRIORITY.BACKFILL).then((): void => { grantTimes.push(clock.now()); }),
    ];
    s.note429(); // pause 12s

    await clock.advance(12_500);
    expect(grantTimes).toHaveLength(0); // paused circuit granted NOTHING

    await clock.advance(20_000);
    await Promise.all(all);
    expect(grantTimes).toHaveLength(3);
    // one grant per token (~1s apart at 60/min) instead of a pause-end burst
    expect(grantTimes[2] - grantTimes[0]).toBeGreaterThanOrEqual(1_900);
  });

  it("C1. one token can be consumed by exactly one waiter", async () => {
    const clock = new FakeClock();
    const s = new TttScheduler({ ratePerMin: 1, clock, jitter: () => 0, agingMs: 60_000 }); // capacity 1
    const order: string[] = [];

    const a = s.acquire(PRIORITY.REFRESH).then((): void => { order.push("a"); });
    const b = s.acquire(PRIORITY.SWEEP).then((): void => { order.push("b"); });
    const c = s.acquire(PRIORITY.BACKFILL).then((): void => { order.push("c"); });
    await Promise.resolve();

    expect(order).toEqual(["a"]); // exactly one waiter consumed the only token
    expect(s.stats().total_grants).toBe(1);
    expect(s.stats().current_waiters).toBe(2);

    await clock.advance(61_000);
    expect(order).toEqual(["a", "b"]);
    expect(s.stats().total_grants).toBe(2);
    expect(s.stats().current_waiters).toBe(1);

    await clock.advance(61_000);
    expect(order).toEqual(["a", "b", "c"]);
    await Promise.all([a, b, c]);
    expect(s.stats().total_grants).toBe(3);
    expect(s.stats().current_waiters).toBe(0);
  });

  it("C2. a burst of simultaneous waiters shares one bucket: one grant each, ordered by lane", async () => {
    const clock = new FakeClock();
    // 1 token / 20s; aging far beyond the test window so LANE decides the order
    const s = new TttScheduler({ ratePerMin: 3, clock, jitter: () => 0, agingMs: 3_600_000 });
    await s.acquireMany(3, PRIORITY.SWEEP); // capacity drained -> the bucket is empty
    expect(s.stats().budget_per_min).toBeLessThan(1);

    const counts = new Map<string, number>();
    const order: string[] = [];
    const waiters: Promise<void>[] = [];

    // five callers arrive in the same tick; the bucket is empty, so every one of
    // them is a QUEUED waiter competing for the same tokens
    for (const lane of [PRIORITY.BACKFILL, PRIORITY.SWEEP, PRIORITY.FOCUS, PRIORITY.REFRESH, PRIORITY.SWEEP]) {
      const id = `w${waiters.length}`;
      counts.set(id, 0);
      waiters.push(
        s.acquire(lane).then((): void => {
          counts.set(id, (counts.get(id) ?? 0) + 1);
          order.push(id);
        }),
      );
    }
    await Promise.resolve();
    expect(order).toEqual([]); // no token exists, so nothing is granted
    expect(s.stats().current_waiters).toBe(5);

    await clock.advance(105_000); // five tokens at 3/min
    await Promise.all(waiters);

    // one token per waiter, highest lane first, FIFO inside a lane, never two
    expect(order).toEqual(["w2", "w3", "w1", "w4", "w0"]);
    expect(s.stats().total_grants).toBe(8); // 3 drained + 5 served
    expect(s.stats().current_waiters).toBe(0);
    expect(s.stats().total_requests).toBe(8);
    // lane bookkeeping drains with the queue: no permanently counted waiter
    for (const lane of Object.values(s.stats().lanes)) expect(lane.waiting).toBe(0);
    expect(s.stats().lanes.focus.granted).toBe(1);
    expect(s.stats().lanes.refresh.granted).toBe(1);
    expect(s.stats().lanes.sweep.granted).toBe(5); // 3 drained + w1 + w4
    for (const n of counts.values()) expect(n).toBe(1); // no double grant, no loss
  });

  it("F4a. while queues are younger than the aging window priority is strict (no inversion)", async () => {
    const clock = new FakeClock();
    const s = new TttScheduler({ ratePerMin: 60, clock, jitter: () => 0, agingMs: 3_600_000 }); // 1h aging
    await s.acquireMany(60, PRIORITY.SWEEP); // drained

    const order: string[] = [];
    const all: Promise<void>[] = [s.acquire(PRIORITY.BACKFILL).then((): void => { order.push("b1"); })];
    for (let i = 0; i < 5; i++) {
      all.push(s.acquire(PRIORITY.FOCUS).then((): void => { order.push(`f${i}`); }));
    }

    await clock.advance(20_000);
    await Promise.all(all);
    expect(order).toEqual(["f0", "f1", "f2", "f3", "f4", "b1"]); // FOCUS never queues behind BACKFILL
  });

  it("F4b. aging gives background work service and bounds the inversion it can cause", async () => {
    // 1 token / 10s, one lane promotion every 5s (0.5 token). Four BACKFILL
    // waiters are queued first; FOCUS work keeps arriving afterwards. Hand-derived
    // dispatch (each line = one token):
    //   t+10s f0 (young lanes: b* = 1, f0 = 0)
    //   t+20s b1, t+30s b2, t+40s b3, t+50s b4  (b* aged to lane 0, oldest first)
    //   t+60s f1, t+70s f2, t+80s f3
    const clock = new FakeClock();
    const s = new TttScheduler({ ratePerMin: 6, clock, jitter: () => 0, agingMs: 5_000 });
    await s.acquireMany(6, PRIORITY.SWEEP); // drained

    const order: string[] = [];
    const tokensWaited = new Map<string, number>();
    let grants = 0;
    const enqueue = (id: string, lane: number): Promise<void> => {
      const atGrant = grants;
      return s.acquire(lane).then((): void => {
        grants++;
        order.push(id);
        tokensWaited.set(id, grants - atGrant);
      });
    };

    const all: Promise<void>[] = [];
    for (let i = 1; i <= 4; i++) all.push(enqueue(`b${i}`, PRIORITY.BACKFILL));
    all.push(enqueue("f0", PRIORITY.FOCUS));
    for (let i = 1; i <= 3; i++) {
      await clock.advance(10_100); // new high-priority work keeps arriving
      all.push(enqueue(`f${i}`, PRIORITY.FOCUS));
    }
    await clock.advance(80_800);
    await Promise.all(all);

    expect(order.join(" ")).toBe("f0 b1 b2 b3 b4 f1 f2 f3"); // no starvation, deterministic
    // aging can promote background work to lane 0 (a tie) but never above it, so
    // a FOCUS waiter is delayed by at most (aged waiters ahead + 1) tokens
    expect(tokensWaited.get("b1")).toBeLessThanOrEqual(5);
    expect(tokensWaited.get("b4")).toBeLessThanOrEqual(5);
    expect(tokensWaited.get("f1")).toBeLessThanOrEqual(5);
    expect(tokensWaited.get("f2")).toBeLessThanOrEqual(5);
    expect(tokensWaited.get("f3")).toBeLessThanOrEqual(5);
  });

  it("J2. the injection seam is explicit and cannot leak into later work", async () => {
    const injected = new TttScheduler({ ratePerMin: 100, jitter: () => 0 });
    setActiveScheduler(injected);
    try {
      expect(activeScheduler()).toBe(injected);
      const { calls } = stubRoutes({ [`${LOCAL}/seam`]: { status: 200, body: [] } });
      await tttRequest("/seam", { baseUrl: LOCAL, priority: PRIORITY.SWEEP });
      expect(calls).toHaveLength(1);
      expect(schedulerStats().total_requests).toBe(1);
      expect(schedulerStats()).toEqual(injected.stats());
    } finally {
      setActiveScheduler(null);
    }
    // restored: the process-wide default is active again and the injected
    // instance is frozen at the work it already saw
    expect(activeScheduler()).toBe(sharedScheduler);
    expect(schedulerStats()).toEqual(sharedScheduler.stats());
    expect(injected.stats().total_requests).toBe(1);

    stubRoutes({ [`${LOCAL}/after`]: { status: 200, body: [] } });
    const before = sharedScheduler.stats().total_grants;
    await tttRequest("/after", { baseUrl: LOCAL, priority: PRIORITY.SWEEP });
    expect(sharedScheduler.stats().total_grants).toBe(before + 1);
    expect(injected.stats().total_grants).toBe(1); // nothing leaked back into it
  });

  it("I. waiting is timer/event driven: no polling loop, no idle wakeups", async () => {
    const clock = new FakeClock();
    const s = new TttScheduler({ ratePerMin: 6, clock, jitter: () => 0 }); // one token / 10s
    await s.acquireMany(6, PRIORITY.SWEEP); // drain the capacity

    const waiters = [
      s.acquire(PRIORITY.SWEEP),
      s.acquire(PRIORITY.SWEEP),
      s.acquire(PRIORITY.SWEEP),
      s.acquire(PRIORITY.SWEEP),
    ];

    await clock.advance(120_000); // 12 tokens arrive; all four waiters are served
    await Promise.all(waiters);

    expect(s.stats().current_waiters).toBe(0);
    // event driven: ~1 wake per token boundary. A 500ms poll loop would have
    // registered hundreds of timers here.
    expect(clock.registrations).toBeLessThanOrEqual(20);
    expect(s.stats().wakes_scheduled).toBeLessThanOrEqual(20);

    // with nothing queued the scheduler schedules NOTHING at all
    const idle = clock.registrations;
    await clock.advance(300_000);
    await clock.advance(300_000);
    expect(clock.registrations).toBe(idle);
  });
});

/* ══════════════════════ K: PR #7 boundary semantics ══════════════════════ */

describe("K. PR #7 history-boundary semantics hold under the single admission point", () => {
  const STEP = 3600;
  const newest = () => Math.floor(Date.now() / 1000 / STEP) * STEP;
  const venueSpec = (count: number): VenueBarSpec => ({
    stepSec: STEP,
    earliest: newest() - (count - 1) * STEP,
    count,
  });

  it("each history attempt is admitted once on the BACKFILL lane, and only explicit no_data proves a boundary", async () => {
    const injected = new TttScheduler({ ratePerMin: 1000, jitter: () => 0 });
    setActiveScheduler(injected);
    const venue = makeFakeVenue(venueSpec(5));
    stubVenue(venue);

    const { fetchFullHistory } = await import("../src/lib/market/history");
    const res = await fetchFullHistory("BTCUSDT", "1h", {});

    expect(res.candles).toHaveLength(5);
    expect(res.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(res.meta.boundary_evidence).toBe("TTT_NO_DATA");
    // 1:1 — one network attempt, one admission, and all of them on BACKFILL
    expect(injected.stats().total_grants).toBe(venue.requests.length);
    expect(injected.stats().lanes.backfill.granted).toBe(venue.requests.length);
    expect(injected.stats().lanes.focus.granted).toBe(0);
    expect(injected.stats().lanes.sweep.granted).toBe(0);
  });

  it("an s:ok answer with zero bars is still NOT a boundary and is still admitted once", async () => {
    const injected = new TttScheduler({ ratePerMin: 1000, jitter: () => 0 });
    setActiveScheduler(injected);
    const venue = makeFakeVenue(venueSpec(5), { okEmpty: true });
    stubVenue(venue);

    const { fetchFullHistory } = await import("../src/lib/market/history");
    const res = await fetchFullHistory("BTCUSDT", "1h", {});

    expect(res.meta.completion_state).toBe("AMBIGUOUS_EMPTY");
    expect(res.meta.boundary_evidence).toBeNull();
    expect(injected.stats().total_grants).toBe(venue.requests.length);
    expect(injected.stats().lanes.backfill.granted).toBe(venue.requests.length);
  });
});
