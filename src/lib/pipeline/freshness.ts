/**
 * Timeframe bar duration + opportunity/signal freshness.
 *
 * ONE table, shared by admission staleness (`tfStalenessMs` = 2 bars) and
 * READY/EXPIRED (`opportunityFreshness` = 4 bars) so the two contracts cannot
 * drift. Unknown timeframes and invalid/future timestamps fail closed. Durations
 * come from the domain registry, not a second timeframe table.
 */
import { getTimeframe } from "../domain/timeframes";

export function tfBarMs(tf: string): number {
  const frame = getTimeframe(tf);
  return frame ? frame.minutes * 60_000 : Number.NaN;
}

/** Staleness budget = 2 closed bars of the strategy's own timeframe. */
export function tfStalenessMs(tf: string): number {
  return tfBarMs(tf) * 2;
}

/**
 * Freshness rule: anchor older than 4 closed bars of the OPPORTUNITY'S OWN
 * timeframe -> EXPIRED. The timeframe is REQUIRED (typed data, not a hidden
 * default): anchors are the strategy's own tf close — never a 15m trigger.
 */
export function opportunityFreshness(
  anchor_close_ms: number | null,
  nowMs: number,
  timeframe: string,
): { state: "READY" | "EXPIRED"; age_ms: number | null } {
  if (typeof anchor_close_ms !== "number" || !Number.isFinite(anchor_close_ms) || anchor_close_ms <= 0
    || !Number.isFinite(nowMs) || anchor_close_ms > nowMs || !getTimeframe(timeframe)) return { state: "EXPIRED", age_ms: null };
  const age = nowMs - anchor_close_ms;
  return age <= 4 * tfBarMs(timeframe)
    ? { state: "READY", age_ms: age }
    : { state: "EXPIRED", age_ms: age };
}
