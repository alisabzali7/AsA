/**
 * Response ordering guard for polling (Task 10).
 *
 * Polls of the SAME URL can overlap (a slow response outlives the next
 * interval tick) and resolve out of order. Without a guard the older payload
 * lands last and silently replaces newer state. Each request takes a
 * monotonically increasing ticket; a response is applied only if no newer
 * ticket has already been applied.
 */
export interface SequenceGuard {
  /** ticket for a request about to be issued */
  issue(): number;
  /** true → apply this response (and remember it); false → it is stale, drop it */
  accept(ticket: number): boolean;
}

export function createSequenceGuard(): SequenceGuard {
  let issued = 0;
  let applied = 0;
  return {
    issue: () => ++issued,
    accept: (ticket: number) => {
      if (ticket <= applied) return false;
      applied = ticket;
      return true;
    },
  };
}
