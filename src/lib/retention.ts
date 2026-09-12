/**
 * Rolling retention job (master: 30-day news window). Runs every 30 min,
 * deletes ONLY rows older than the window, logs an auditable run row, and
 * never removes a row inside the window. Idempotent + observable.
 */
import { RETENTION_NEWS_DAYS, RETENTION_JOB_MIN } from "./env";
import { getRepo } from "../db/sqlite";
import { eventBus } from "./events";

export function retentionCutoffMs(): number {
  return Date.now() - RETENTION_NEWS_DAYS * 86_400_000;
}

/** Run the retention pass (idempotent). Returns the audit summary. */
export function runRetention(): { table: string; deleted: number; cutoff_ms: number; ok: boolean; note: string } {
  const repo = getRepo();
  const cutoff = retentionCutoffMs();
  try {
    const deleted = repo.newsDeleteOlderThan(cutoff);
    const note = `news window ${RETENTION_NEWS_DAYS}d; deleted ${deleted} row(s) older than cutoff`;
    repo.retentionLog({ ran_ms: Date.now(), table_name: "news_events", deleted, cutoff_ms: cutoff, ok: 1, note });
    eventBus.emit("system", { message: note, level: "info" });
    return { table: "news_events", deleted, cutoff_ms: cutoff, ok: true, note };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    repo.retentionLog({ ran_ms: Date.now(), table_name: "news_events", deleted: 0, cutoff_ms: cutoff, ok: 0, note: msg });
    return { table: "news_events", deleted: 0, cutoff_ms: cutoff, ok: false, note: msg };
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startRetentionJob(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      runRetention();
    } catch (err) {
      eventBus.emit("system", { message: `retention job failed: ${err instanceof Error ? err.message : err}`, level: "error" });
    }
  }, RETENTION_JOB_MIN * 60_000);
}

export function stopRetentionJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
