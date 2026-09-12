/**
 * Rate-aware scheduler (master §50, §64). One token bucket shared by every
 * TTT poller. On 429 the budget contracts and a circuit pause engages;
 * recovery is gradual. Counters feed the System observability surface.
 * Request coalescing (in-flight same-URL sharing) happens in the engine via
 * getUdfCoalesced(); the bucket itself is a pure limiter.
 */
import { TTT_RATE_PER_MIN } from "../env";
import { randomInt } from "node:crypto";

export interface SchedulerStats {
  budget_per_min: number;
  configured_per_min: number;
  total_requests: number;
  total_429: number;
  current_waiters: number;
  paused_until_ms: number;
  paused: boolean;
  last_429_ms: number | null;
  rejected_non_ttt: number;
}

export class TttScheduler {
  private configured: number;
  private budget: number; // tokens currently in bucket
  private pausedUntilMs = 0;
  private waiters: { resolve: () => void; priority: number }[] = [];
  private totalRequests = 0;
  private total429 = 0;
  private last429Ms: number | null = null;
  private pausedCount = 0;
  private lastRefillMs: number;

  constructor(ratePerMin: number = TTT_RATE_PER_MIN) {
    this.configured = Math.max(1, ratePerMin);
    this.budget = this.configured;
    this.lastRefillMs = Date.now();
  }

  /**
   * Continuous refill at configured/min (~0.4 token/s at 24/min), computed
   * lazily from wall time so no timer is needed. Refill FREEZES while a 429
   * circuit pause is engaged: the pause then genuinely throttles and the
   * shrunk budget only recovers after the pause ends.
   */
  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec < 0.25) return;
    this.lastRefillMs = now;
    if (this.paused) return; // no accumulation during a circuit pause
    const gained = (elapsedSec / 60) * this.configured;
    this.budget = Math.min(this.configured, this.budget + gained);
  }

  /** 429 observed: shrink budget, engage pause; never below 4/min. */
  note429(): void {
    this.total429++;
    this.last429Ms = Date.now();
    this.pausedCount++;
    const shrunken = Math.max(4, Math.floor(this.budget * 0.6));
    this.budget = Math.min(this.budget, shrunken);
    this.pausedUntilMs = Date.now() + 12_000 + randomInt(0, 4_000);
  }

  /** Periodic health call from the engine loop (kept for call-site stability). */
  recover(): void {
    this.refill();
  }

  get paused(): boolean {
    return Date.now() < this.pausedUntilMs;
  }

  stats(): SchedulerStats {
    this.refill();
    return {
      budget_per_min: Math.round(this.budget * 100) / 100,
      configured_per_min: this.configured,
      total_requests: this.totalRequests,
      total_429: this.total429,
      current_waiters: this.waiters.length,
      paused_until_ms: this.pausedUntilMs,
      paused: this.paused,
      last_429_ms: this.last429Ms,
      rejected_non_ttt: 0,
    };
  }

  /**
   * Wait until a token is available. priority 0..3 (0 = focus lane).
   * Paused circuits wait out the pause first (blocking honest backoff).
   */
  async acquire(priority = 2): Promise<void> {
    this.totalRequests++;
    for (;;) {
      this.refill();
      if (this.paused) {
        await this.sleepUntil(this.pausedUntilMs);
        continue;
      }
      if (this.budget >= 1) {
        this.budget -= 1;
        return;
      }
      // wait for the next refill slice (~0.5s granularity)
      await this.sleep(500 + randomInt(0, 150));
    }
  }

  /** For tests: wait until at least `n` tokens available. */
  async acquireMany(n: number, priority = 2): Promise<void> {
    for (let i = 0; i < n; i++) await this.acquire(priority);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
  private async sleepUntil(ts: number): Promise<void> {
    const d = ts - Date.now();
    if (d > 0) await this.sleep(d);
  }
}

export const sharedScheduler = new TttScheduler();
