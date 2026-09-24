/**
 * Dashboard (Command Center) board selectors.
 *
 * Pure, render-only derivations over /api/market/board rows — no computation
 * of market values happens here, only truthful selection/ordering of measured
 * values:
 *   - a row whose value is unmeasured (null) is NEVER imputed (no 0, no guess)
 *   - a "gainer" is strictly change24hPct > 0 — a losing row is never shown as a gainer
 *   - market cap is NOT a TTT /futures/markets/stats metric, so nothing here
 *     may rank by it
 */

export interface BoardRowLite {
  symbol: string;
  price: number | null;
  change24hPct: number | null;
}

/** Top-N rows by measured last price, descending. Unmeasured prices excluded. */
export function topByPrice<T extends BoardRowLite>(rows: readonly T[], n = 8): T[] {
  return [...rows]
    .filter((r) => r.price !== null && Number.isFinite(r.price))
    .sort((a, b) => (b.price as number) - (a.price as number))
    .slice(0, n);
}

/**
 * Strict day gainers: change24hPct > 0 only, descending.
 * Unmeasured (null) rows are excluded — never displayed as 0.
 * Returns [] in a down market; the UI must then say "no gainers", not show losers.
 */
export function topGainers<T extends BoardRowLite>(rows: readonly T[], n = 5): T[] {
  return [...rows]
    .filter((r) => r.change24hPct !== null && r.change24hPct > 0)
    .sort((a, b) => (b.change24hPct as number) - (a.change24hPct as number))
    .slice(0, n);
}

/* ------------------------------------------------------------------ freshness
 *
 * Server-computed ages are FROZEN at response time. While the connection is
 * down (or just stale), a naive render would keep showing the snapshot's
 * original "LIVE" state forever. The client therefore re-derives freshness as
 *
 *   effective age = server-reported age + elapsed time since the response
 *
 * and maps it through the SAME thresholds the server itself uses for board
 * rows (src/app/api/market/board): <60s LIVE · <300s STALE · else DEGRADED.
 * This is presentation only — no value is altered, only the displayed state
 * and elapsed age of the already-received data.
 */
export const BOARD_LIVE_MS = 60_000;
export const BOARD_STALE_MS = 300_000;

/** Effective age of a snapshot: server age + time since the client received it. */
export function effectiveAgeMs(snapshotAgeMs: number | null | undefined, sinceResponseMs: number | null | undefined): number | null {
  if (snapshotAgeMs === null || snapshotAgeMs === undefined || !Number.isFinite(snapshotAgeMs)) return null;
  const since = typeof sinceResponseMs === "number" && Number.isFinite(sinceResponseMs) ? sinceResponseMs : 0;
  return snapshotAgeMs + since;
}

/**
 * Display state for a board row / sweep given its EFFECTIVE age.
 * Rows without a measured age (e.g. CONNECTING) keep their server state.
 * A snapshot is LIVE only while its effective age is under the LIVE threshold
 * — reconnection alone never makes stale data live; a fresh successful
 * response (client age reset to 0) does.
 */
const STATE_RANK: Record<string, number> = { LIVE: 0, STALE: 1, DEGRADED: 2, UNAVAILABLE: 3 };

export function displayStateFor(state: string, ageMs: number | null): string {
  if (ageMs === null) return state;
  const byAge = ageMs < BOARD_LIVE_MS ? "LIVE" : ageMs < BOARD_STALE_MS ? "STALE" : "DEGRADED";
  // Task 03: the client may only DOWNGRADE. A server STALE (e.g. the venue
  // row's own source timestamp stopped moving) must never render as LIVE just
  // because the snapshot was received recently. Unknown server states win.
  const serverRank = STATE_RANK[state];
  if (serverRank === undefined) return state;
  return serverRank >= STATE_RANK[byAge] ? state : byAge;
}
