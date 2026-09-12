/**
 * OPERATIONAL UNIVERSE — the single production symbol source.
 *
 * The production universe is DERIVED FROM TTT DISCOVERY, always:
 *
 *   TTT /futures/markets
 *     -> normalizeMarket()            (excluded symbols dropped at discovery)
 *       -> ASA_MARKET_ELIGIBLE tier
 *         -> operationalUniverse()    <- every production loop reads this
 *
 * HARD RULE (audit P0-1): production NEVER falls back to the legacy regression
 * set. Before a successful discovery the universe is EMPTY and the state is
 * `NOT_READY`. An empty universe makes callers do nothing, which is correct and
 * safe; silently substituting 48 stale symbols is not.
 *
 * `LEGACY_48_REGRESSION_SET` lives in `domain/universe.ts` and is for tests,
 * regression fixtures and historical documentation only. It is deliberately NOT
 * imported here.
 */
import { cachedCatalog, discoverMarkets, isPermanentlyExcluded, type DiscoveryOutcome } from "./catalog";
import { registerDiscoveredSymbols } from "../domain/universe";

/**
 * Where the current universe came from.
 * `not-ready` means discovery has never succeeded — the universe is EMPTY.
 */
export type UniverseSource = "ttt-dynamic" | "not-ready";

/** Health of the most recent discovery attempt (audit P0-4). */
export type UniverseState =
  | "NOT_READY"        // no successful discovery yet
  | "READY"            // populated from a successful discovery
  | "VALID_EMPTY"      // TTT answered correctly and listed zero eligible markets
  | "STALE"            // last attempt failed; a previous snapshot is still held
  | "NETWORK_FAILURE"  // transport failure on the last attempt
  | "INVALID_RESPONSE";// TTT replied with something unusable

let snapshot: string[] | null = null;
let lastRefreshMs = 0;          // last SUCCESSFUL refresh
let lastAttemptMs = 0;          // last attempt, success or failure
let lastError: string | null = null;
let state: UniverseState = "NOT_READY";

export interface RefreshResult {
  symbols: string[];
  source: UniverseSource;
  state: UniverseState;
  count: number;
  error?: string;
}

/**
 * Refresh the operational universe from TTT.
 *
 * MUST be awaited during boot before catalog ingestion and the stats sweep so
 * newly listed markets are registered before any loop depends on them.
 *
 * Outcome semantics (audit P0-4) — each behaves differently:
 *   OK             -> replace the snapshot
 *   VALID_EMPTY    -> replace the snapshot with EMPTY (an obsolete snapshot is
 *                     NOT preserved: the venue really has no eligible markets)
 *   NETWORK_FAILURE / INVALID_RESPONSE
 *                  -> keep the previous snapshot but mark the state STALE so no
 *                     consumer can mistake it for a fresh read
 */
export async function refreshOperationalUniverse(force = false): Promise<RefreshResult> {
  lastAttemptMs = Date.now();
  let outcome: DiscoveryOutcome;
  try {
    outcome = await discoverMarkets(force);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    state = snapshot ? "STALE" : "NETWORK_FAILURE";
    return { symbols: operationalUniverse(), source: universeSource(), state, count: operationalUniverse().length, error: lastError };
  }

  if (outcome.status === "NETWORK_FAILURE" || outcome.status === "INVALID_RESPONSE") {
    lastError = outcome.error ?? outcome.status;
    // Preserve the previous snapshot (better than going blind) but say STALE.
    state = snapshot ? "STALE" : outcome.status;
    return { symbols: operationalUniverse(), source: universeSource(), state, count: operationalUniverse().length, error: lastError };
  }

  const syms = outcome.snapshot.markets
    .filter((m) => m.eligibility.includes("ASA_MARKET_ELIGIBLE"))
    .map((m) => m.symbol)
    .filter((s) => !isPermanentlyExcluded(s));

  // A VALID empty catalog is authoritative: adopt it rather than keeping an
  // obsolete snapshot alive (audit P0-4).
  snapshot = syms;
  lastRefreshMs = Date.now();
  lastError = null;
  state = syms.length === 0 ? "VALID_EMPTY" : "READY";
  if (syms.length > 0) registerDiscoveredSymbols(syms);

  return { symbols: syms, source: universeSource(), state, count: syms.length };
}

/**
 * The production symbol list. Synchronous by design.
 *
 * Returns EMPTY until discovery succeeds — never the legacy regression set.
 * Never contains a permanently excluded symbol.
 */
export function operationalUniverse(): string[] {
  if (snapshot) return snapshot;
  // Adopt a catalog that another caller already fetched, if one exists.
  const cached = cachedCatalog();
  if (cached) {
    const syms = cached.markets
      .filter((m) => m.eligibility.includes("ASA_MARKET_ELIGIBLE"))
      .map((m) => m.symbol)
      .filter((s) => !isPermanentlyExcluded(s));
    snapshot = syms;
    if (state === "NOT_READY") state = syms.length === 0 ? "VALID_EMPTY" : "READY";
    return syms;
  }
  return []; // NOT_READY — callers must treat this as "no markets yet"
}

export function universeSource(): UniverseSource {
  return snapshot !== null ? "ttt-dynamic" : "not-ready";
}

export function universeState(): UniverseState {
  return state;
}

/** True only when a successful discovery has populated the universe. */
export function isUniverseReady(): boolean {
  return snapshot !== null && (state === "READY" || state === "VALID_EMPTY" || state === "STALE");
}

export function universeMeta(): {
  source: UniverseSource;
  state: UniverseState;
  count: number;
  last_refresh_ms: number;
  last_attempt_ms: number;
  last_error: string | null;
  discovery_complete: boolean;
} {
  return {
    source: universeSource(),
    state,
    count: operationalUniverse().length,
    last_refresh_ms: lastRefreshMs,
    last_attempt_ms: lastAttemptMs,
    last_error: lastError,
    discovery_complete: snapshot !== null && state !== "NOT_READY",
  };
}

/**
 * Operational membership test.
 * Accepts any dynamically discovered TTT market; always rejects an excluded one.
 * Returns FALSE for every symbol while the universe is NOT_READY.
 */
export function isOperationalSymbol(s: string): boolean {
  const sym = (s ?? "").toUpperCase();
  if (!sym || isPermanentlyExcluded(sym)) return false;
  return operationalUniverse().includes(sym);
}

/** Test seam. */
export function __setOperationalUniverse(symbols: string[] | null): void {
  if (symbols === null) {
    snapshot = null;
    state = "NOT_READY";
    lastRefreshMs = 0;
    lastError = null;
    return;
  }
  snapshot = symbols.filter((s) => !isPermanentlyExcluded(s));
  state = snapshot.length === 0 ? "VALID_EMPTY" : "READY";
  lastRefreshMs = Date.now();
}
