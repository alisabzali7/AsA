/** Canonical advisory lifecycle. Unknown states are quarantined, not activated. */
export { SIGNAL_STATES } from "../domain/signal-states";
const transitions: Record<string, readonly string[]> = {
  candidate: ["qualified", "blocked_by_risk", "published", "expired", "invalidated"],
  qualified: ["blocked_by_risk", "published", "expired", "invalidated"],
  published: ["expired", "invalidated", "closed", "archived", "blocked_by_risk"],
  blocked_by_risk: [], expired: [], invalidated: [], closed: [], archived: [],
};
export function assertSignalTransition(from: string, to: string): void {
  if (from === to) return;
  if (!transitions[from]?.includes(to)) throw new Error(`forbidden signal transition ${from} -> ${to}`);
}

import type { Repo, SignalRow } from "../../db/repo";
import { opportunityFreshness } from "./freshness";

/** Source-anchor expiry, shared by scheduler and API reads (including cold boot). */
export function signalHasExpired(s: SignalRow, now: number, maxAgeMs?: number): boolean {
  if (s.state !== "published" && s.state !== "qualified") return false;
  if (maxAgeMs !== undefined) return now - s.updated_ms > maxAgeMs;
  let anchor: number | null = null;
  try {
    const p = JSON.parse(s.payload_json);
    if (typeof p?.anchor_close_ms === "number") anchor = p.anchor_close_ms;
    if (p?.timeframe !== undefined && p.timeframe !== s.timeframe) return true;
  } catch { /* cannot certify corrupt data as fresh */ }
  return opportunityFreshness(anchor, now, s.timeframe).state === "EXPIRED";
}

/** Recheck inside the write transaction so a concurrent close wins over expiry. */
export function refreshSignalExpiry(repo: Repo, s: SignalRow, now: number, maxAgeMs?: number): SignalRow {
  if (!signalHasExpired(s, now, maxAgeMs)) return s;
  return repo.withTransaction(() => {
    const current = repo.signalGet(s.id);
    if (!current) return s;
    if (signalHasExpired(current, now, maxAgeMs)) repo.signalUpdate({ id: s.id, state: "expired" });
    return repo.signalGet(s.id) ?? current;
  });
}
