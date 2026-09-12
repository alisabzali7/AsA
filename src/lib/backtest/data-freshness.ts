/**
 * Backtest data-freshness contract (audit P0-7).
 *
 * A backtest may legitimately run on previously stored TTT history, but the
 * result must NEVER present that as freshly synchronized. This module turns a
 * `syncHistory` outcome (or its thrown error) into an explicit, testable
 * statement:
 *
 *   fresh sync succeeded
 *   OR fresh sync failed + stored dataset used (with the last successful sync)
 *   OR nothing was stored at all (insufficient data — the run is refused
 *      upstream anyway).
 */
import type { SyncResult } from "../market/history-store";

export type FreshSyncStatus = "succeeded" | "failed" | "skipped-current";

export interface DataFreshness {
  fresh_sync_status: FreshSyncStatus;
  /** error from the failed fresh sync attempt, when applicable */
  fresh_sync_error: string | null;
  /** epoch ms of the last SUCCESSFUL sync backing the dataset (null = never) */
  last_successful_sync_ms: number | null;
  /** true when the run used previously stored data after a failed fresh sync */
  used_stored_data_after_failed_sync: boolean;
  /** human-readable one-liner for warnings arrays */
  warning: string | null;
}

export function describeFreshSync(
  outcome: SyncResult | null,
  syncError: unknown,
  nowMs: number = Date.now(),
): DataFreshness {
  if (syncError !== null && syncError !== undefined) {
    const msg = syncError instanceof Error ? syncError.message : String(syncError);
    return {
      fresh_sync_status: "failed",
      fresh_sync_error: msg,
      last_successful_sync_ms: outcome?.last_successful_sync_ms ?? null,
      used_stored_data_after_failed_sync: true,
      warning:
        `fresh history sync FAILED (${msg}) — the backtest ran on PREVIOUSLY STORED TTT data` +
        (outcome?.last_successful_sync_ms
          ? ` (last successful sync: ${new Date(outcome.last_successful_sync_ms).toISOString()})`
          : " (no successful sync ever recorded)"),
    };
  }
  if (!outcome) {
    return {
      fresh_sync_status: "failed",
      fresh_sync_error: "no sync result",
      last_successful_sync_ms: null,
      used_stored_data_after_failed_sync: true,
      warning: "fresh history sync produced no result — stored data may be stale",
    };
  }
  if (outcome.sync_succeeded) {
    if (outcome.skipped_reason) {
      return {
        fresh_sync_status: "skipped-current",
        fresh_sync_error: null,
        last_successful_sync_ms: outcome.last_successful_sync_ms,
        used_stored_data_after_failed_sync: false,
        warning: null,
      };
    }
    return {
      fresh_sync_status: "succeeded",
      fresh_sync_error: null,
      last_successful_sync_ms: outcome.last_successful_sync_ms ?? nowMs,
      used_stored_data_after_failed_sync: false,
      warning: null,
    };
  }
  // syncHistory completed without throwing but the fetch itself failed
  // (e.g. every chunk errored -> completion UNAVAILABLE).
  const msg = outcome.meta.reason ?? `completion_state=${outcome.meta.completion_state}`;
  return {
    fresh_sync_status: "failed",
    fresh_sync_error: msg,
    last_successful_sync_ms: outcome.last_successful_sync_ms,
    used_stored_data_after_failed_sync: true,
    warning:
      `fresh history sync FAILED (${msg}) — the backtest ran on PREVIOUSLY STORED TTT data` +
      (outcome.last_successful_sync_ms
        ? ` (last successful sync: ${new Date(outcome.last_successful_sync_ms).toISOString()})`
        : " (no successful sync ever recorded)"),
  };
}
