/**
 * Timeframe bar duration + opportunity/signal freshness.
 *
 * ONE table, shared by admission staleness (`tfStalenessMs` = 2 bars) and
 * READY/EXPIRED (`opportunityFreshness` = 4 bars) so the two contracts cannot
 * drift. 15m is only the unknown-tf fallback — strategies declare their own
 * timeframe and it is never hard-coded at the call site.
 */
export function tfBarMs(tf: string): number {
  const map: Record<string, number> = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "45m": 2_700_000,
    "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000, "1d": 86_400_000,
  };
  return map[tf] ?? 900_000;
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
  if (anchor_close_ms === null) return { state: "EXPIRED", age_ms: null };
  const age = nowMs - anchor_close_ms;
  return age <= 4 * tfBarMs(timeframe)
    ? { state: "READY", age_ms: age }
    : { state: "EXPIRED", age_ms: age };
}
