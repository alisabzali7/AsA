/**
 * TTT RATE SCHEDULER — the SINGLE admission authority for TTT network traffic.
 *
 * Task 1 (single rate-budget enforcement):
 *
 *   intent -> shared TTT transport (http.ts) -> scheduler admission -> fetch()
 *
 * Production callers may only express LANE INTENT (`priority`). The shared
 * transport charges the admission, once per ACTUAL network attempt, so a retry
 * is a new attempt and pays again. No caller consumes budget on its own.
 *
 * Lanes (lower number = higher priority):
 *   0 FOCUS     focused-symbol live lanes and its active candles
 *   1 REFRESH   refresh-after-close / on-demand working set
 *   2 SWEEP     periodic universe sweeps, discovery
 *   3 BACKFILL  long, low-value chunk walks
 *
 * Guarantees:
 *   - deterministic FIFO inside a lane (monotonic arrival sequence)
 *   - a newly arrived higher-priority waiter overtakes queued lower-priority
 *     work (selection = effective lane first, arrival second)
 *   - anti-starvation: every `agingMs` a waiter spends queued promotes it one
 *     lane, so background work cannot be postponed forever
 *   - a paused circuit grants NOTHING — not even while tokens are available
 *   - waiting is TIMER/EVENT driven: at most one scheduled wake per token or
 *     pause boundary, never a fixed-interval poll loop
 *   - clock, jitter source and aging window are injectable (deterministic,
 *     sleep-free tests)
 *   - `note429()` is TRANSPORT-OWNED: http.ts calls it exactly once per observed
 *     HTTP 429. This module only records the consequence (shrunken budget +
 *     circuit pause + a wake-up for everyone waiting).
 */
import { TTT_RATE_PER_MIN } from "../env";
import { randomInt } from "node:crypto";

/** Canonical lanes. Lower number = higher priority. */
export const PRIORITY = {
  FOCUS: 0,
  REFRESH: 1,
  SWEEP: 2,
  BACKFILL: 3,
} as const;

export type PriorityLane = (typeof PRIORITY)[keyof typeof PRIORITY];

export const LANE_NAMES = ["focus", "refresh", "sweep", "backfill"] as const;
export type LaneName = (typeof LANE_NAMES)[number];

export const DEFAULT_LANE: PriorityLane = PRIORITY.SWEEP;

/**
 * Clamp arbitrary lane intent onto the supported lanes.
 * Malformed intent (nullish, NaN, non-numeric) falls back to the DEFAULT lane —
 * never to FOCUS: a broken label must not silently buy top-priority service.
 */
export function laneOf(priority: number | undefined | null): PriorityLane {
  if (priority === undefined || priority === null) return DEFAULT_LANE;
  const n = Math.floor(Number(priority));
  if (!Number.isFinite(n)) return DEFAULT_LANE;
  if (n <= PRIORITY.FOCUS) return PRIORITY.FOCUS;
  if (n >= PRIORITY.BACKFILL) return PRIORITY.BACKFILL;
  return n as PriorityLane;
}

export function laneName(priority: number | undefined | null): LaneName {
  return LANE_NAMES[laneOf(priority)];
}

/**
 * Timing seam. The production clock is `systemClock`; tests inject a fake clock
 * so ordering, pause and recovery behaviour is deterministic and sleep-free.
 */
export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TttSchedulerOptions {
  /** requests per minute (bucket capacity + refill rate) */
  ratePerMin?: number;
  /** injectable timing source; defaults to the wall clock */
  clock?: SchedulerClock;
  /** injectable jitter source (min inclusive, max exclusive); defaults to crypto */
  jitter?: (minMs: number, maxMs: number) => number;
  /** ms of queueing that promotes a waiter by one lane (anti-starvation) */
  agingMs?: number;
}

export interface SchedulerLaneStats {
  waiting: number;
  granted: number;
  waited_ms: number;
}

export interface SchedulerStats {
  budget_per_min: number;
  configured_per_min: number;
  total_requests: number;
  /** grants actually charged (one per network attempt) */
  total_grants: number;
  total_429: number;
  current_waiters: number;
  paused_until_ms: number;
  paused: boolean;
  last_429_ms: number | null;
  rejected_non_ttt: number;
  /** per-lane observability (Task 1) */
  lanes: Record<LaneName, SchedulerLaneStats>;
  /** scheduled timer wakes — an idle scheduler schedules nothing (no polling) */
  wakes_scheduled: number;
}

interface Waiter {
  lane: PriorityLane;
  seq: number;
  enqueuedAtMs: number;
  resolve: () => void;
}

const PAUSE_BASE_MS = 12_000;
const PAUSE_JITTER_MS = 4_000;
const FLOOR_PER_MIN = 4;

function emptyLanes(): Record<LaneName, SchedulerLaneStats> {
  return {
    focus: { waiting: 0, granted: 0, waited_ms: 0 },
    refresh: { waiting: 0, granted: 0, waited_ms: 0 },
    sweep: { waiting: 0, granted: 0, waited_ms: 0 },
    backfill: { waiting: 0, granted: 0, waited_ms: 0 },
  };
}

export class TttScheduler {
  private readonly clock: SchedulerClock;
  private readonly jitter: (minMs: number, maxMs: number) => number;
  private readonly agingMs: number;
  private configured: number;
  private budget: number; // tokens currently in the bucket
  private pausedUntilMs = 0;
  private waiters: Waiter[] = [];
  private seq = 0;
  private totalRequests = 0;
  private totalGrants = 0;
  private total429 = 0;
  private last429Ms: number | null = null;
  private wakesScheduled = 0;
  private lanes = emptyLanes();
  private lastRefillMs: number;
  private wake: unknown = null;
  private wakeAtMs: number | null = null;

  constructor(ratePerMinOrOptions: number | TttSchedulerOptions = {}) {
    const opts: TttSchedulerOptions =
      typeof ratePerMinOrOptions === "number" ? { ratePerMin: ratePerMinOrOptions } : ratePerMinOrOptions;
    this.configured = Math.max(1, opts.ratePerMin ?? TTT_RATE_PER_MIN);
    this.budget = this.configured;
    this.clock = opts.clock ?? systemClock;
    this.jitter = opts.jitter ?? ((min, max) => randomInt(min, max));
    this.agingMs = Math.max(1, Math.floor(opts.agingMs ?? 5_000));
    this.lastRefillMs = this.clock.now();
  }

  /**
   * Continuous refill at configured/min, computed lazily from the clock so no
   * timer is needed for correctness. Refill FREEZES while a 429 circuit pause is
   * engaged: the pause genuinely throttles and the shrunk budget only recovers
   * after the pause ends.
   *
   * AUDIT FIX (Task 1): the credited window is explicitly
   * `[max(lastRefillMs, pausedUntilMs), now]`, so time spent INSIDE a pause is
   * never credited. A purely lazy refill must not simply test `now < paused`:
   * because refill only runs at state transitions (no polling), the first call
   * after a pause would be made with `now > pausedUntilMs` and would credit the
   * ENTIRE pause window — handing the queue a burst of tokens the moment the
   * pause lifted (measured: 12.5 tokens after one 12s pause, three waiters
   * granted in the same millisecond). That is the opposite of throttling and
   * invites an immediate second 429.
   */
  private refill(now = this.clock.now()): void {
    if (now <= this.lastRefillMs) return; // clock frozen or stepped backwards
    const from = Math.max(this.lastRefillMs, this.pausedUntilMs);
    this.lastRefillMs = now;
    const elapsed = now - from;
    if (elapsed <= 0) return; // still (or entirely) inside a circuit pause
    const gained = (elapsed / 60_000) * this.configured;
    this.budget = Math.min(this.configured, this.budget + gained);
  }

  /**
   * 429 observed (transport-owned). Shrink the budget, engage the circuit pause
   * and wake the queue so every waiter re-evaluates under the new pause.
   */
  note429(): void {
    const now = this.clock.now();
    this.total429++;
    this.last429Ms = now;
    const shrunken = Math.max(FLOOR_PER_MIN, Math.floor(this.budget * 0.6));
    this.budget = Math.min(this.budget, shrunken);
    this.pausedUntilMs = now + PAUSE_BASE_MS + this.jitter(0, PAUSE_JITTER_MS);
    this.pump();
  }

  /** Health hook (call-site stability). Progress never depends on it. */
  recover(): void {
    this.refill();
    this.pump();
  }

  get paused(): boolean {
    return this.clock.now() < this.pausedUntilMs;
  }

  /**
   * Wait for one admission on `priority`. The resolved promise means "you may
   * make exactly one network attempt".
   */
  acquire(priority: number | undefined = DEFAULT_LANE): Promise<void> {
    const lane = laneOf(priority);
    this.totalRequests++;
    return new Promise<void>((resolve) => {
      this.waiters.push({ lane, seq: this.seq++, enqueuedAtMs: this.clock.now(), resolve });
      this.lanes[laneName(lane)].waiting++;
      this.pump();
    });
  }

  /** For tests and bounded callers: n sequential admissions. */
  async acquireMany(n: number, priority: number | undefined = DEFAULT_LANE): Promise<void> {
    for (let i = 0; i < n; i++) await this.acquire(priority);
  }

  stats(): SchedulerStats {
    const now = this.clock.now();
    this.refill(now);
    return {
      budget_per_min: Math.round(this.budget * 100) / 100,
      configured_per_min: this.configured,
      total_requests: this.totalRequests,
      total_grants: this.totalGrants,
      total_429: this.total429,
      current_waiters: this.waiters.length,
      paused_until_ms: this.pausedUntilMs,
      paused: now < this.pausedUntilMs,
      last_429_ms: this.last429Ms,
      rejected_non_ttt: 0,
      lanes: {
        focus: { ...this.lanes.focus },
        refresh: { ...this.lanes.refresh },
        sweep: { ...this.lanes.sweep },
        backfill: { ...this.lanes.backfill },
      },
      wakes_scheduled: this.wakesScheduled,
    };
  }

  /* ───────────────────────────── internals ───────────────────────────── */

  /**
   * Event-driven dispatch. Grants while the circuit is closed and tokens exist,
   * otherwise schedules AT MOST one wake (next token or pause end) and returns.
   * No interval, no polling, no sleep loop.
   */
  private pump(): void {
    const now = this.clock.now();
    this.refill(now);
    this.clearWake();
    for (;;) {
      if (this.waiters.length === 0) return;
      if (now < this.pausedUntilMs) {
        // PAUSED: grants NOTHING. Wake when the pause ends.
        this.scheduleWake(this.pausedUntilMs + 1 - now);
        return;
      }
      if (this.budget < 1) {
        this.scheduleWake(this.msUntilNextToken());
        return;
      }
      const idx = this.pickIndex(now);
      const [waiter] = this.waiters.splice(idx, 1);
      this.budget -= 1;
      this.totalGrants++;
      const lane = laneName(waiter.lane);
      this.lanes[lane].waiting--;
      this.lanes[lane].granted++;
      this.lanes[lane].waited_ms += Math.max(0, now - waiter.enqueuedAtMs);
      waiter.resolve(); // this is the network attempt's licence; loop for the next waiter
    }
  }

  /**
   * Effective lane = declared lane promoted by queueing time; ties break on
   * arrival order, which is what makes same-lane dispatch deterministic FIFO.
   */
  private effectiveLane(w: Waiter, now: number): number {
    const promoted = Math.floor((now - w.enqueuedAtMs) / this.agingMs);
    return Math.max(PRIORITY.FOCUS, w.lane - promoted);
  }

  private pickIndex(now: number): number {
    let best = 0;
    let bestLane = this.effectiveLane(this.waiters[0], now);
    for (let i = 1; i < this.waiters.length; i++) {
      const lane = this.effectiveLane(this.waiters[i], now);
      if (lane < bestLane) {
        best = i;
        bestLane = lane;
      }
    }
    return best;
  }

  private msUntilNextToken(): number {
    const tokensPerMs = this.configured / 60_000;
    const deficit = 1 - Math.max(0, this.budget);
    return Math.ceil(deficit / tokensPerMs) + 1;
  }

  /**
   * Arm the single pending wake. `pump()` clears any previous timer before it
   * dispatches, so this is the only timer alive and the deadline is always
   * derived from the CURRENT state (next token / pause end) — arming cannot push
   * an existing deadline further out, and an idle scheduler arms nothing.
   * The `wakeAtMs <= at` check is defensive only (never postpone a pending wake).
   */
  private scheduleWake(delayMs: number): void {
    const at = this.clock.now() + Math.max(0, Math.ceil(delayMs));
    if (this.wake !== null && this.wakeAtMs !== null && this.wakeAtMs <= at) return;
    this.clearWake();
    this.wakeAtMs = at;
    this.wakesScheduled++;
    this.wake = this.clock.setTimeout(() => {
      this.wake = null;
      this.wakeAtMs = null;
      this.pump();
    }, Math.max(0, at - this.clock.now()));
  }

  private clearWake(): void {
    if (this.wake === null) return;
    this.clock.clearTimeout(this.wake);
    this.wake = null;
    this.wakeAtMs = null;
  }
}

/** The default process-wide scheduler (single instance). */
export const sharedScheduler = new TttScheduler();

let activeInstance: TttScheduler = sharedScheduler;

/**
 * The ACTIVE scheduler: the one that charges admissions AND the one reported by
 * status/observability. There is a single accessor, so enforcement and reporting
 * can never drift onto different instances.
 */
export function activeScheduler(): TttScheduler {
  return activeInstance;
}

/** Snapshot of the active scheduler — used by the status/observability surface. */
export function schedulerStats(): SchedulerStats {
  return activeInstance.stats();
}

/**
 * Test seam: route enforcement + observability to another instance.
 * `null` restores the process-wide default.
 */
export function setActiveScheduler(next: TttScheduler | null): void {
  activeInstance = next ?? sharedScheduler;
}
