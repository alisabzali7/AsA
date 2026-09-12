/**
 * Market store tests against LIVE TTT fixtures: universe filtering
 * (TONUSDT must vanish), metric truth semantics (capability vs measured),
 * coverage contract rows.
 */
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MarketStore } from "../src/lib/market/store";
import { UNIVERSE } from "../src/lib/domain/universe";

const F = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/live", n), "utf8"));

function makeStoreWithStats(): MarketStore {
  const store = new MarketStore();
  const markets = F("markets.json") as { symbol: string; baseAsset: string; quoteAsset: string; category: string; name: string; tickSize: string; stepSize: string; maxLeverage: number; maintenanceMarginRate: string; makerFeeCoefficient: string; takerFeeCoefficient: string; isActive: boolean }[];
  store.ingestCatalog(markets);
  const stats = F("stats.json") as { symbol: string; lastPrice: string; markPrice: string; indexPrice: string; fundingRate: string; openInterest: string; change24hPct: string; volume24hQuote: string }[];
  const provenance = { source_name: "ttt" as const, endpoint: "/futures/markets/stats", fetched_at_ms: Date.now(), auth: "public" as const };
  for (const r of stats) {
    if (!UNIVERSE.includes(r.symbol)) continue;
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
    store = makeStoreWithStats();
  });

  it("filters TONUSDT and non-universe symbols out of the catalog", () => {
    expect(store.catalog.size).toBe(48);
    expect(store.catalog.has("TONUSDT")).toBe(false);
    // fixture venue contains TONUSDT in stats only (55 rows vs 54 markets)
    expect(store.stats.has("TONUSDT")).toBe(false);
  });

  it("reports 48/48 live rows after one sweep", () => {
    const rows = store.liveRows();
    expect(rows.length).toBe(48);
    const live = rows.filter((r) => r.state === "LIVE" && r.price !== null);
    expect(live.length).toBe(48);
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
});
