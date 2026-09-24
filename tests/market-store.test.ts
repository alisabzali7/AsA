/**
 * Market store tests against LIVE TTT fixtures: universe filtering
 * (TONUSDT must vanish), metric truth semantics (capability vs measured),
 * coverage contract rows.
 *
 * AUDIT FIX (P0): the operational universe is DYNAMIC. These tests used to
 * hard-code "48" and relied on the removed legacy fallback; they now seed the
 * operational universe from the FIXTURE catalog the way discovery would, and
 * every expected count is DERIVED from the fixture — never hard-coded.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MarketStore } from "../src/lib/market/store";
import { __setOperationalUniverse } from "../src/lib/market/operational-universe";
import { isPermanentlyExcluded } from "../src/lib/market/catalog";

const F = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/live", n), "utf8"));

interface FixtureMarket {
  symbol: string; baseAsset: string; quoteAsset: string; category: string; name: string;
  tickSize: string; stepSize: string; maxLeverage: number; maintenanceMarginRate: string;
  makerFeeCoefficient: string; takerFeeCoefficient: string; isActive: boolean;
}

/** The universe discovery would produce from this fixture: active + USDT + not excluded. */
function fixtureUniverse(): string[] {
  const markets = F("markets.json") as FixtureMarket[];
  return markets
    .filter((m) => m.isActive !== false)
    .filter((m) => String(m.quoteAsset ?? "").toUpperCase() === "USDT")
    .map((m) => m.symbol)
    .filter((s) => !isPermanentlyExcluded(s))
    .sort();
}

function makeStoreWithStats(): MarketStore {
  const store = new MarketStore();
  const markets = F("markets.json") as FixtureMarket[];
  store.ingestCatalog(markets);
  const stats = F("stats.json") as { symbol: string; lastPrice: string; markPrice: string; indexPrice: string; fundingRate: string; openInterest: string; change24hPct: string; volume24hQuote: string }[];
  const provenance = { source_name: "ttt" as const, endpoint: "/futures/markets/stats", fetched_at_ms: Date.now(), auth: "public" as const };
  const universe = fixtureUniverse();
  for (const r of stats) {
    if (!universe.includes(r.symbol)) continue;
    store.ingestStats({
      symbol: r.symbol,
      lastPrice: Number(r.lastPrice) || null,
      markPrice: Number(r.markPrice) || null,
      indexPrice: Number(r.indexPrice) || null,
      fundingRate: Number(r.fundingRate) || null,
      nextFundingTimeMs: null,
      fundingIntervalHours: 8,
      change24hPct: Number(r.change24hPct) * 100 || null,
      high24h: null,
      low24h: null,
      volume24hQuote: Number(r.volume24hQuote) || null,
      openInterest: Number(r.openInterest) || null,
      openValue: null,
      provenance,
    });
  }
  store.lastStatsSweepAtMs = Date.now();
  return store;
}

describe("MarketStore over live TTT fixture", () => {
  let store: MarketStore;
  beforeEach(() => {
    // seed the dynamic universe exactly as discovery over this fixture would
    __setOperationalUniverse(fixtureUniverse());
    store = makeStoreWithStats();
  });
  afterEach(() => {
    __setOperationalUniverse(null);
  });

  it("filters TONUSDT and non-universe symbols out of the catalog", () => {
    const expected = fixtureUniverse().length;
    expect(expected).toBeGreaterThan(0);
    expect(store.catalog.size).toBe(expected);
    expect(store.catalog.has("TONUSDT")).toBe(false);
    // fixture venue contains TONUSDT in stats only
    expect(store.stats.has("TONUSDT")).toBe(false);
  });

  it("reports a live row for every operational symbol after one sweep", () => {
    const rows = store.liveRows();
    const expected = fixtureUniverse().length;
    expect(rows.length).toBe(expected);
    const live = rows.filter((r) => r.state === "LIVE" && r.price !== null);
    expect(live.length).toBe(expected);
    expect(live[0].source).toBe("ttt");
    expect(live[0].endpoint).toBe("/futures/markets/stats");
  });

  it("metric truth separates capability, availability and measurement", () => {
    const m = (metric: string) => store.metricTruth("BTCUSDT", metric);
    const last = m("last_price");
    expect(last.capability).toBe(true);
    expect(last.availability).toBe("available");
    expect(last.currently_measured).toBe(true);
    expect(last.verdict).toBe("MEASURED");

    const liq = m("liquidations");
    expect(liq.capability).toBe(false);
    expect(liq.currently_measured).toBe(false);
    expect(liq.verdict).toBe("UNAVAILABLE");
    expect(liq.reason).toContain("no documented public TTT endpoint");

    const ls = m("long_short_ratio");
    expect(ls.verdict).toBe("UNAVAILABLE");

    const cvd = m("cvd");
    expect(cvd.verdict).toBe("UNAVAILABLE");
    expect(cvd.reason).toContain("taker-side semantics");

    const taker = m("taker_volume");
    expect(taker.verdict).toBe("UNVERIFIED");

    const basis = m("basis");
    expect(basis.verdict).toBe("DERIVED");
    expect(basis.derived).toBe(true);
    expect(basis.derivation_source).toContain("mark");
  });

  it("never converts a missing metric into zero", () => {
    const liq = store.metricTruth("BTCUSDT", "liquidations");
    expect(liq.currently_measured).toBe(false);
    expect(liq.availability).not.toBe("available");
    const row = store.liveRows().find((r) => r.symbol === "SOLUSDT")!;
    expect(row.price).not.toBeNull();
  });

  it("coverage rows distinguish board liveness from history", () => {
    const cov = store.computeCoverage("BTCUSDT", "15m", undefined, null);
    expect(cov.status).toBe("PENDING");
    expect(cov.bar_count).toBe(0);
    expect(cov.source).toBe("ttt");
  });

  it("clears focus-lane measurements when the focus symbol changes", () => {
    const universe = fixtureUniverse();
    const next = universe.find((s) => s !== store.focusSymbol)!;
    expect(next).toBeTruthy();
    const provenance = { source_name: "ttt" as const, endpoint: "/futures/markets/trades", fetched_at_ms: Date.now(), auth: "public" as const };
    store.tape = [{ symbol: store.focusSymbol, price: 1, size: 1, side: "UNKNOWN", side_semantics: "UNVERIFIED", ts_ms: Date.now(), provenance }];
    store.tapeFetchedAtMs = Date.now();
    store.orderBook = { symbol: store.focusSymbol, bids: [], asks: [], depthDecimal: null, spreadAbs: null, spreadPct: null, provenance };
    store.orderBookFetchedAtMs = Date.now();

    store.setFocus(next);

    expect(store.focusSymbol).toBe(next);
    expect(store.tape).toEqual([]);
    expect(store.tapeFetchedAtMs).toBeNull();
    expect(store.orderBook).toBeNull();
    expect(store.orderBookFetchedAtMs).toBeNull();
    expect(store.metricTruth(next, "trades").currently_measured).toBe(false);
  });

  it("an EMPTY operational universe yields an EMPTY board (no legacy fallback)", () => {
    __setOperationalUniverse(null);
    const fresh = new MarketStore();
    fresh.ingestCatalog(F("markets.json") as FixtureMarket[]);
    expect(fresh.catalog.size).toBe(0); // nothing ingested while NOT_READY
    expect(fresh.liveRows()).toEqual([]);
  });
});
