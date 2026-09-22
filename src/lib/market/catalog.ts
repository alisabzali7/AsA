/**
 * Dynamic TTT market catalog (remediation §1, §2, §3, §14, §19).
 *
 * The 48-symbol hard-coded list is NO LONGER the universe. The production
 * catalog is DISCOVERED from TTT `/futures/markets` at runtime, so newly listed
 * contracts appear without a code change.
 *
 * TONUSDT is permanently excluded at the discovery layer — the very first place
 * a symbol can enter the system — so no refresh can ever reintroduce it.
 *
 * Eligibility is layered (§3). A market is never hidden because a feature is
 * missing; the FEATURE is marked unavailable instead.
 */
import { tttRequest } from "../ttt/http";
import { PRIORITY } from "../ttt/scheduler";
import { registerDiscoveredSymbols } from "../domain/universe";

/** Permanently excluded from the AsA production universe. Never remove. */
export const PERMANENT_EXCLUSIONS = ["TONUSDT"] as const;

export function isPermanentlyExcluded(symbol: string): boolean {
  return (PERMANENT_EXCLUSIONS as readonly string[]).includes(symbol.toUpperCase());
}

/** Layered eligibility (§3): discovery is not the same as feature support. */
export type EligibilityTier =
  | "TTT_DISCOVERED"      // present in the TTT market list
  | "TTT_SUPPORTED"       // active and tradable on TTT
  | "ASA_MARKET_ELIGIBLE" // passes AsA policy (not excluded, USDT-quoted perp)
  | "ASA_FEATURE_ELIGIBLE"// enough history/precision for the feature engine
  | "ASA_STRATEGY_ELIGIBLE"; // a compiled strategy can actually run on it

export interface MarketRecord {
  symbol: string;
  base_asset: string;
  quote_asset: string;
  settlement_asset: string | null;
  contract_type: string;
  category: string;
  display_name: string;
  status: "ACTIVE" | "INACTIVE";
  source: "ttt";
  first_seen_ms: number;
  last_seen_ms: number;
  /** verified TTT instrument constraints; null means TTT did not supply it */
  constraints: {
    tick_size: number | null;
    step_size: number | null;
    min_qty: number | null;
    min_notional: number | null;
    max_qty: number | null;
    max_leverage: number | null;
    min_leverage: number | null;
    maintenance_margin_rate: number | null;
    price_precision: number | null;
    qty_precision: number | null;
    /** lower bound of leverage tier 0 — NOT a minimum order notional */
    first_tier_min_notional: number | null;
    maker_fee: number | null;
    taker_fee: number | null;
  };
  /** fields TTT does not expose for this instrument */
  unavailable_constraints: string[];
  eligibility: EligibilityTier[];
  /** why the market is not ASA_MARKET_ELIGIBLE, when applicable */
  ineligible_reason: string | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Faithful shape of a TTT `/futures/markets` row (verified live 2026-09-10).
 *
 * IMPORTANT: `precisions` is a STRING ARRAY (e.g. ["0.1","1","0.01"]), NOT an
 * object with price/quantity fields. The previous typing read `.price` and
 * `.quantity`, which were always `undefined` — so precision was silently
 * reported as null for every instrument.
 *
 * TTT does NOT expose: contractType, settlementAsset/marginAsset, minQty,
 * maxQty. Those are recorded UNAVAILABLE rather than inferred.
 */
interface RawMarket {
  symbol?: string; baseAsset?: string; quoteAsset?: string; category?: string; name?: string;
  tickSize?: unknown; stepSize?: unknown; minLeverage?: unknown; maxLeverage?: unknown;
  maintenanceMarginRate?: unknown; isActive?: boolean;
  makerFeeCoefficient?: unknown; takerFeeCoefficient?: unknown;
  /** observed as string[]; an object form is tolerated defensively */
  precisions?: unknown;
  leverageTiers?: { minNotional?: unknown; maxNotional?: unknown }[];
  /** not currently emitted by TTT — read only if the venue starts sending it */
  contractType?: unknown;
  settlementAsset?: unknown;
  marginAsset?: unknown;
}

/** Count decimal places implied by a tick/step string such as "0.001" -> 3. */
export function decimalsFromStep(step: unknown): number | null {
  if (step === null || step === undefined) return null;
  const str = String(step);
  const n = Number(str);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (str.includes("e") || str.includes("E")) {
    const exp = Number(str.split(/[eE]/)[1]);
    return Number.isFinite(exp) ? Math.max(0, -exp) : null;
  }
  const dot = str.indexOf(".");
  if (dot < 0) return 0;
  return str.length - dot - 1;
}

/**
 * Normalize the `precisions` field defensively.
 * Observed form is `[price, quantity, ...]` as strings. If TTT ever switches to
 * an object we read the named fields; anything else yields null (never a guess).
 */
export function parsePrecisions(p: unknown): { price: number | null; qty: number | null } {
  if (Array.isArray(p)) {
    return { price: decimalsFromStep(p[0]), qty: decimalsFromStep(p[1]) };
  }
  if (p && typeof p === "object") {
    const o = p as { price?: unknown; quantity?: unknown; amount?: unknown };
    return { price: decimalsFromStep(o.price), qty: decimalsFromStep(o.quantity ?? o.amount) };
  }
  return { price: null, qty: null };
}

/** Normalize one raw TTT market into the canonical record. */
export function normalizeMarket(raw: RawMarket, nowMs: number): MarketRecord | null {
  const symbol = String(raw.symbol ?? "").toUpperCase().trim();
  if (!symbol) return null;

  // EXCLUSION AT THE DISCOVERY LAYER — the earliest possible point.
  if (isPermanentlyExcluded(symbol)) return null;

  const unavailable: string[] = [];
  const tiers = raw.leverageTiers ?? [];
  // leverageTiers[0].minNotional is the LOWER BOUND OF THE FIRST TIER (usually
  // "0"), which is NOT the venue's minimum order notional. Treating it as such
  // would fabricate a constraint, so min_notional is UNAVAILABLE.
  const firstTierMinNotional = tiers.length ? num(tiers[0]?.minNotional) : null;
  const minNotional: number | null = null;
  // TTT publishes no max order quantity and no distinct minimum quantity.
  // stepSize is a QUANTITY INCREMENT, not a minimum — conflating them would
  // invent a venue rule, so min_qty stays UNAVAILABLE.
  const maxQty: number | null = null;
  const stepSize = num(raw.stepSize);
  const minQty: number | null = null;

  unavailable.push("max_qty", "min_qty", "min_notional");

  const prec = parsePrecisions(raw.precisions);
  if (prec.price === null) unavailable.push("price_precision");
  if (prec.qty === null) unavailable.push("qty_precision");
  const isActive = raw.isActive !== false;
  const quote = String(raw.quoteAsset ?? "").toUpperCase();

  const eligibility: EligibilityTier[] = ["TTT_DISCOVERED"];
  if (isActive) eligibility.push("TTT_SUPPORTED");

  // Contract type / settlement are only recorded when TTT actually sends them.
  const rawContractType = typeof raw.contractType === "string" ? raw.contractType.toUpperCase() : null;
  const rawSettlement = typeof raw.settlementAsset === "string" ? raw.settlementAsset.toUpperCase()
    : typeof raw.marginAsset === "string" ? raw.marginAsset.toUpperCase() : null;
  if (rawContractType === null) unavailable.push("contract_type");
  if (rawSettlement === null) unavailable.push("settlement_asset");

  let ineligible: string | null = null;
  if (!isActive) ineligible = "TTT reports the contract as inactive";
  else if (quote !== "USDT") ineligible = `quote asset ${quote || "unknown"} is not USDT`;
  else eligibility.push("ASA_MARKET_ELIGIBLE");

  return {
    symbol,
    base_asset: String(raw.baseAsset ?? "").toUpperCase(),
    quote_asset: quote,
    // NOT inferred from quoteAsset: TTT does not publish a settlement asset,
    // so this is null/UNAVAILABLE until the venue provides it.
    settlement_asset: rawSettlement,
    // NOT hardcoded to "PERPETUAL": recorded only when TTT states it.
    contract_type: rawContractType ?? "UNAVAILABLE",
    category: String(raw.category ?? "Uncategorized"),
    display_name: String(raw.name ?? symbol),
    status: isActive ? "ACTIVE" : "INACTIVE",
    source: "ttt",
    first_seen_ms: nowMs,
    last_seen_ms: nowMs,
    constraints: {
      tick_size: num(raw.tickSize),
      step_size: stepSize,
      min_qty: minQty,
      min_notional: minNotional,
      max_qty: maxQty,
      max_leverage: num(raw.maxLeverage),
      min_leverage: num(raw.minLeverage),
      maintenance_margin_rate: num(raw.maintenanceMarginRate),
      price_precision: prec.price,
      qty_precision: prec.qty,
      first_tier_min_notional: firstTierMinNotional,
      maker_fee: num(raw.makerFeeCoefficient),
      taker_fee: num(raw.takerFeeCoefficient),
    },
    unavailable_constraints: unavailable,
    eligibility,
    ineligible_reason: ineligible,
  };
}

export interface CatalogSnapshot {
  markets: MarketRecord[];
  discovered_count: number;
  eligible_count: number;
  excluded: { symbol: string; reason: string }[];
  fetched_at_ms: number;
  source: "ttt";
  endpoint: string;
}

/**
 * Result of a discovery attempt (audit P0-4).
 * Each status MUST be handled differently by callers — a valid-but-empty
 * catalog is authoritative, whereas a transport failure is not.
 */
export type DiscoveryStatus = "OK" | "VALID_EMPTY" | "NETWORK_FAILURE" | "INVALID_RESPONSE";

export type DiscoveryOutcome =
  | { status: "OK" | "VALID_EMPTY"; snapshot: CatalogSnapshot; error?: undefined }
  | { status: "NETWORK_FAILURE" | "INVALID_RESPONSE"; snapshot: CatalogSnapshot; error: string };

let cache: CatalogSnapshot | null = null;
let inflight: Promise<DiscoveryOutcome> | null = null;
/** Market listings change rarely; refresh at most every 10 minutes. */
export const CATALOG_TTL_MS = 10 * 60_000;

const emptySnapshot = (now: number): CatalogSnapshot => ({
  markets: [], discovered_count: 0, eligible_count: 0, excluded: [],
  fetched_at_ms: now, source: "ttt", endpoint: "/futures/markets",
});

/**
 * Discover the live TTT market catalog.
 *
 * Never throws: the outcome is discriminated so callers can distinguish a
 * genuine empty venue from an outage or a malformed payload.
 */
export async function discoverMarkets(force = false): Promise<DiscoveryOutcome> {
  const now = Date.now();
  if (!force && cache && now - cache.fetched_at_ms < CATALOG_TTL_MS) {
    return { status: cache.eligible_count === 0 ? "VALID_EMPTY" : "OK", snapshot: cache };
  }
  if (inflight) return inflight;

  inflight = (async (): Promise<DiscoveryOutcome> => {
    let res;
    try {
      // lane intent only (Task 1): discovery is background sweep traffic; the
      // shared transport charges the rate budget per network attempt.
      res = await tttRequest<RawMarket[]>("/futures/markets", {
        timeoutMs: 20_000,
        retries: 2,
        priority: PRIORITY.SWEEP,
      });
    } catch (err) {
      // transport/timeout/5xx/auth — NOT a statement about the venue's listings
      return {
        status: "NETWORK_FAILURE",
        snapshot: cache ?? emptySnapshot(now),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!Array.isArray(res.data)) {
      return {
        status: "INVALID_RESPONSE",
        snapshot: cache ?? emptySnapshot(now),
        error: `expected an array of markets, received ${typeof res.data}`,
      };
    }

    const raw = res.data;
    const markets: MarketRecord[] = [];
    const excluded: { symbol: string; reason: string }[] = [];

    for (const r of raw) {
      const sym = String(r.symbol ?? "").toUpperCase().trim();
      if (isPermanentlyExcluded(sym)) {
        excluded.push({ symbol: sym, reason: "permanently excluded from the AsA production universe" });
        continue;
      }
      const m = normalizeMarket(r, now);
      if (m) markets.push(m);
    }
    markets.sort((a, b) => a.symbol.localeCompare(b.symbol));

    // A non-empty payload that yields zero usable records is malformed, not
    // an empty venue.
    if (raw.length > 0 && markets.length === 0 && excluded.length === 0) {
      return {
        status: "INVALID_RESPONSE",
        snapshot: cache ?? emptySnapshot(now),
        error: `received ${raw.length} rows but none could be normalized`,
      };
    }

    // preserve first_seen across refreshes so listing age is meaningful
    if (cache) {
      const prev = new Map(cache.markets.map((m) => [m.symbol, m.first_seen_ms]));
      for (const m of markets) m.first_seen_ms = prev.get(m.symbol) ?? m.first_seen_ms;
    }

    const snap: CatalogSnapshot = {
      markets,
      discovered_count: markets.length + excluded.length,
      eligible_count: markets.filter((m) => m.eligibility.includes("ASA_MARKET_ELIGIBLE")).length,
      excluded,
      fetched_at_ms: now,
      source: "ttt",
      endpoint: "/futures/markets",
    };
    registerDiscoveredSymbols(markets.map((m) => m.symbol));
    cache = snap;
    return { status: snap.eligible_count === 0 ? "VALID_EMPTY" : "OK", snapshot: snap };
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/** Last discovered snapshot without triggering a fetch. */
export function cachedCatalog(): CatalogSnapshot | null {
  return cache;
}

/** Symbols AsA will operate on. Never includes a permanent exclusion. */
export async function eligibleSymbols(): Promise<string[]> {
  const outcome = await discoverMarkets();
  return outcome.snapshot.markets
    .filter((m) => m.eligibility.includes("ASA_MARKET_ELIGIBLE"))
    .map((m) => m.symbol);
}

export async function getMarket(symbol: string): Promise<MarketRecord | null> {
  const outcome = await discoverMarkets();
  return outcome.snapshot.markets.find((m) => m.symbol === symbol.toUpperCase()) ?? null;
}

/** Test seam: clear the cache so a test can control discovery. */
export function __resetCatalogCache(): void {
  cache = null;
  inflight = null;
}
