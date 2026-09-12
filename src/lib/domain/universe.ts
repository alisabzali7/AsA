/**
 * The 48-member LEGACY REGRESSION SET — test/fixture/documentation ONLY.
 *
 * The production universe is DISCOVERED dynamically from TTT
 * (`src/lib/market/catalog.ts`) and surfaced through
 * `src/lib/market/operational-universe.ts`. NOTHING in this module is a
 * production symbol source: `LEGACY_48_REGRESSION_SET` exists so tests can
 * assert that each historically-listed contract is still discovered while it
 * exists on the venue.
 *
 * TYPE SAFETY (audit): the 48-member union below is a *regression fixture*
 * type. It is deliberately NOT the type of any symbol that flows through the
 * production pipeline — production symbols are plain validated strings
 * (`OperationalSymbol` is a runtime property, not a compile-time union, because
 * the universe is dynamic). No function in this module claims to narrow a
 * string to the 48-member union.
 *
 * TONUSDT is EXCLUDED by definition, here and at the discovery layer.
 */
export const LEGACY_48_REGRESSION_SET: readonly string[] = [
  "1000PEPEUSDT","1000SHIBUSDT","AAVEUSDT","ADAUSDT","ALGOUSDT","APEUSDT",
  "APTUSDT","ARBUSDT","ASTERUSDT","ATOMUSDT","AVAXUSDT","BANDUSDT",
  "BCHUSDT","BNBUSDT","BTCUSDT","CAKEUSDT","DASHUSDT","DOGEUSDT",
  "DOTUSDT","ENAUSDT","ETCUSDT","ETHUSDT","FETUSDT","FILUSDT",
  "HBARUSDT","HYPEUSDT","ICPUSDT","INJUSDT","KSMUSDT","LINKUSDT",
  "LTCUSDT","NEARUSDT","NOTUSDT","ONDOUSDT","OPUSDT","PAXGUSDT",
  "QNTUSDT","SANDUSDT","SOLUSDT","SUIUSDT","TRUMPUSDT","TRXUSDT",
  "UNIUSDT","VETUSDT","WLDUSDT","XLMUSDT","XRPUSDT","ZECUSDT",
] as const;

/** @deprecated alias — use the explicit LEGACY_48_REGRESSION_SET name. */
export const LEGACY_UNIVERSE = LEGACY_48_REGRESSION_SET;

/**
 * @deprecated alias — use the explicit LEGACY_48_REGRESSION_SET name.
 * Kept only because existing regression tests import it.
 */
export const UNIVERSE = LEGACY_48_REGRESSION_SET;

/**
 * The 48-member union of the LEGACY REGRESSION SET.
 * TEST/FIXTURE TYPE ONLY: never used as a production symbol type — the live
 * universe is dynamic, so a compile-time union cannot describe it.
 */
export type LegacyRegressionSymbol = (typeof LEGACY_48_REGRESSION_SET)[number];

export const UNIVERSE_SET: ReadonlySet<string> = new Set(LEGACY_48_REGRESSION_SET);

/** Size of the legacy regression set (48) — NOT the production universe size. */
export const UNIVERSE_SIZE = LEGACY_48_REGRESSION_SET.length;

/**
 * Permanently excluded symbols. Enforced here AND at the discovery layer so a
 * catalog refresh can never reintroduce one.
 */
export const EXCLUDED_SYMBOLS: readonly string[] = ["TONUSDT"] as const;

export function isExcludedSymbol(s: string): boolean {
  return EXCLUDED_SYMBOLS.includes(s.toUpperCase());
}

/**
 * Synchronous membership guard — deliberately NOT a type predicate.
 *
 * TYPE SAFETY (audit): this function can accept symbols discovered dynamically
 * from TTT, which are NOT members of the 48-member `LegacyRegressionSymbol`
 * union. Declaring it as `s is UniverseSymbol` would have lied to the compiler
 * and let dynamic symbols masquerade as legacy members. It returns a plain
 * boolean; production code must use `isOperationalSymbol()` from
 * market/operational-universe instead.
 *
 * Accepts the legacy regression set plus any symbol already observed in the
 * dynamically discovered catalog, and ALWAYS rejects an excluded symbol.
 */
export function isUniverseSymbol(s: string): boolean {
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

/**
 * Test-only assertion helper for regression fixtures. NOT used by production
 * paths — production validates against the operational universe
 * (`assertOperationalSymbol` semantics live in market/operational-universe).
 * Returns a plain string: a dynamically discovered symbol is NOT a
 * `LegacyRegressionSymbol`, so no union narrowing is claimed.
 */
export function assertUniverseSymbol(s: string, ctx = "symbol"): string {
  if (!isUniverseSymbol(s)) {
    throw new Error(`[universe] '${s}' is not in the legacy regression set or the discovered TTT universe (${ctx})`);
  }
  return s;
}

/**
 * Type guard for the legacy regression set ONLY.
 * Safe as a predicate because membership is fully static.
 */
export function isLegacyRegressionSymbol(s: string): s is LegacyRegressionSymbol {
  return UNIVERSE_SET.has(s);
}

/** Normalize a symbol string from external input (trim + upper). */
export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}
