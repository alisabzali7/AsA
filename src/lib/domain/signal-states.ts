/** Shared display vocabulary only. Transitions and expiry remain server-owned. */
export const SIGNAL_STATES = ["candidate", "qualified", "blocked_by_risk", "published", "expired", "invalidated", "closed", "archived"] as const;
