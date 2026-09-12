/**
 * LEGACY 48-symbol list — now a REGRESSION SET, not the universe.
 *
 * As of the market-data remediation the production universe is DISCOVERED
 * dynamically from TTT (`src/lib/market/catalog.ts`); TTT listed 63 contracts
 * on 2026-09-09. These 48 symbols remain a permanent regression set: each must
 * still be discovered while it exists on the venue.
 *
 * `isUniverseSymbol()` is retained as a SYNCHRONOUS guard for code paths that
 * cannot await discovery (validation helpers, tests). It accepts the legacy set
 * and always rejects a permanently excluded symbol. Code that needs the live
 * universe must use `eligibleSymbols()` from the catalog instead.
 *
 * TONUSDT is EXCLUDED by definition, here and at the discovery layer.
 */
export const LEGACY_UNIVERSE: readonly string[] = [
  "1000PEPEUSDT","1000SHIBUSDT","AAVEUSDT","ADAUSDT","ALGOUSDT","APEUSDT",
  "APTUSDT","ARBUSDT","ASTERUSDT","ATOMUSDT","AVAXUSDT","BANDUSDT",
  "BCHUSDT","BNBUSDT","BTCUSDT","CAKEUSDT","DASHUSDT","DOGEUSDT",
  "DOTUSDT","ENAUSDT","ETCUSDT","ETHUSDT","FETUSDT","FILUSDT",
  "HBARUSDT","HYPEUSDT","ICPUSDT","INJUSDT","KSMUSDT","LINKUSDT",
  "LTCUSDT","NEARUSDT","NOTUSDT","ONDOUSDT","OPUSDT","PAXGUSDT",
  "QNTUSDT","SANDUSDT","SOLUSDT","SUIUSDT","TRUMPUSDT","TRXUSDT",
  "UNIUSDT","VETUSDT","WLDUSDT","XLMUSDT","XRPUSDT","ZECUSDT",
] as const;

/** @deprecated use `eligibleSymbols()` from market/catalog for the live universe */
export const UNIVERSE = LEGACY_UNIVERSE;

export type UniverseSymbol = (typeof LEGACY_UNIVERSE)[number];

export const UNIVERSE_SET: ReadonlySet<string> = new Set(LEGACY_UNIVERSE);

export const UNIVERSE_SIZE = LEGACY_UNIVERSE.length; // 48 — regression set size

/**
 * Permanently excluded symbols. Enforced here AND at the discovery layer so a
 * catalog refresh can never reintroduce one.
 */
export const EXCLUDED_SYMBOLS: readonly string[] = ["TONUSDT"] as const;

export function isExcludedSymbol(s: string): boolean {
  return EXCLUDED_SYMBOLS.includes(s.toUpperCase());
}

/**
 * Synchronous membership guard.
 *
 * Accepts the legacy regression set plus any symbol already observed in the
 * dynamically discovered catalog, and ALWAYS rejects an excluded symbol.
 */
export function isUniverseSymbol(s: string): s is UniverseSymbol {
  // Exclusion is case-INSENSITIVE (defence in depth); acceptance stays
  // case-SENSITIVE so a malformed lowercase symbol is still rejected.
  if (isExcludedSymbol(s)) return false;
  if (UNIVERSE_SET.has(s)) return true;
  return dynamicAllowList.has(s);
}

/**
 * Symbols observed in the live TTT catalog. Populated by the discovery layer so
 * synchronous guards accept newly listed contracts without a code change.
 * An excluded symbol is silently refused even if a caller tries to add it.
 */
const dynamicAllowList = new Set<string>();

export function registerDiscoveredSymbols(symbols: readonly string[]): number {
  let added = 0;
  for (const raw of symbols) {
    const sym = raw.toUpperCase();
    if (isExcludedSymbol(sym)) continue; // never, under any circumstance
    if (!dynamicAllowList.has(sym)) { dynamicAllowList.add(sym); added++; }
  }
  return added;
}

export function discoveredSymbols(): string[] {
  return [...dynamicAllowList].sort();
}

/** Test seam. */
export function __resetDiscoveredSymbols(): void {
  dynamicAllowList.clear();
}

export function assertUniverseSymbol(s: string, ctx = "symbol"): UniverseSymbol {
  if (!isUniverseSymbol(s)) {
    throw new Error(`[universe] '${s}' is not in the legacy regression set or the discovered TTT universe (${ctx})`);
  }
  return s;
}

/** Normalize a symbol string from external input (trim + upper). */
export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}
