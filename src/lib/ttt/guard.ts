/**
 * MARKET-DATA SOURCE GUARD (master §47).
 * A single central boundary that every market-data producer must cross.
 * Anything that is not the TTT source fails LOUDLY — an accidental
 * third-party fallback is impossible by construction, not just by search.
 */
import { MARKET_SOURCE, type MarketSourceName } from "../domain/types";

export interface SourceGuardToken {
  readonly id: MarketSourceName;
}

export const TTT_SOURCE: SourceGuardToken = { id: MARKET_SOURCE };

/**
 * The only accepted market-data source. Passing any other identifier
 * (e.g. 'binance', 'tradingview', 'coingecko', 'bybit') throws.
 */
export function marketSource(): SourceGuardToken {
  return TTT_SOURCE;
}

export function ensureTttSource(v: unknown, context = "market-data"): SourceGuardToken {
  if (v === MARKET_SOURCE) return TTT_SOURCE;
  const label = typeof v === "string" ? JSON.stringify(v) : String(v);
  throw new Error(
    `[source-guard] ${context} requested source ${label}, but the only permitted ` +
      `production market-data source is '${MARKET_SOURCE}'. Third-party market fallbacks are forbidden.`,
  );
}

export function sourceName(): MarketSourceName {
  return MARKET_SOURCE;
}
