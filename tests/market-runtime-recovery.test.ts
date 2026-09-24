/**
 * Market runtime recovery regressions.
 *
 * These tests pin failures that only appear when the runtime path is traced
 * vertically: boot-time TTT outage, recovery after discovery becomes available,
 * semantic-invalid stats payloads, and API validation while the universe is
 * NOT_READY. They use TTT-shaped fixtures only inside tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function tempDbEnv(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asa-market-runtime-"));
  process.env.ASA_DB_PATH = path.join(dir, "asa.db");
  process.env.ASA_HISTORY_DB_PATH = path.join(dir, "history.db");
  process.env.ASA_BRAIN_DB_PATH = path.join(dir, "brain.db");
  process.env.TTT_API_BASE = "http://127.0.0.1:18080";
  delete process.env.NEWS_RSS_URL;
  return dir;
}

const marketRow = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  category: "crypto",
  name: "Bitcoin",
  tickSize: "0.1",
  stepSize: "0.001",
  minLeverage: 1,
  maxLeverage: 50,
  maintenanceMarginRate: "0.005",
  isActive: true,
  makerFeeCoefficient: "0.0002",
  takerFeeCoefficient: "0.0005",
  precisions: ["0.1", "0.001"],
  leverageTiers: [{ minNotional: "0", maxNotional: "100000", maxLeverage: 50, maintenanceMarginRate: "0.005" }],
};

const statsRow = {
  symbol: "BTCUSDT",
  lastPrice: "64000",
  markPrice: "64001",
  indexPrice: "63999",
  fundingRate: "0.0001",
  nextFundingTime: "2026-09-24T12:00:00.000Z",
  minFundingRate: "-0.003",
  maxFundingRate: "0.003",
  interestRate: "0",
  fundingIntervalHours: 8,
  change24h: "10",
  change24hPct: "0.01",
  high24h: "65000",
  low24h: "63000",
  volume24hBase: "100",
  volume24hQuote: "6400000",
  openInterest: "1200",
  openValue: "76800000",
  turnover24hQuote: "6400000",
  timestamp: "2026-09-24T08:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("market runtime boot and recovery", () => {
  it("boots loops during TTT outage, then discovers the universe and publishes stats without restart", async () => {
    const dir = tempDbEnv();
    vi.resetModules();
    let mode: "down" | "up" = "down";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (mode === "down") throw new TypeError("TTT down (test)");
      if (url.includes("/futures/markets/stats")) return jsonRes([statsRow]);
      if (url.includes("/futures/markets/funding-history")) {
        return jsonRes({ meta: { totalItems: 0, itemCount: 0, itemsPerPage: 20, totalPages: 0, currentPage: 1 }, items: [] });
      }
      if (url.includes("/futures/markets/orderbook")) return jsonRes({ symbol: "BTCUSDT", depthDecimal: 1, asks: [], bids: [] });
      if (url.includes("/futures/markets/trades")) return jsonRes({ symbol: "BTCUSDT", trades: [] });
      if (url.includes("/futures/udf/history")) return jsonRes({ s: "no_data" });
      if (url.includes("/futures/markets")) return jsonRes([marketRow]);
      return jsonRes({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { MarketEngine } = await import("../src/lib/market/engine");
    const { operationalUniverse, universeMeta } = await import("../src/lib/market/operational-universe");
    const { sharedStore } = await import("../src/lib/market/store");
    const engine = new MarketEngine();
    try {
      await expect(engine.start()).resolves.toBeUndefined();
      expect(engine.isRunning()).toBe(true);
      expect(universeMeta().discovery_complete).toBe(false);
      expect(operationalUniverse()).toEqual([]);
      expect(sharedStore.lastStatsSweepAtMs).toBeNull();

      mode = "up";
      await (engine as unknown as { sweepStats(): Promise<void> }).sweepStats();

      expect(universeMeta().discovery_complete).toBe(true);
      expect(operationalUniverse()).toEqual(["BTCUSDT"]);
      expect(sharedStore.getStats("BTCUSDT")?.lastPrice).toBe(64000);
      expect(sharedStore.lastStatsSweepAtMs).not.toBeNull();
    } finally {
      engine.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mark a stats sweep successful when TTT returns no finite prices for the operational universe", async () => {
    const dir = tempDbEnv();
    vi.resetModules();
    const { MarketEngine } = await import("../src/lib/market/engine");
    const { __setOperationalUniverse } = await import("../src/lib/market/operational-universe");
    const { sharedStore } = await import("../src/lib/market/store");
    const { tttClient } = await import("../src/lib/ttt/client");
    __setOperationalUniverse(["BTCUSDT"]);
    vi.spyOn(tttClient, "getStats").mockResolvedValue({
      rows: [{ symbol: "BTCUSDT" } as never],
      provenance: { source_name: "ttt", endpoint: "/futures/markets/stats", fetched_at_ms: Date.now(), auth: "public" },
    });
    const engine = new MarketEngine();
    try {
      await (engine as unknown as { sweepStats(): Promise<void> }).sweepStats();
      expect(sharedStore.lastStatsSweepAtMs).toBeNull();
      expect(sharedStore.tttErrors.at(-1)?.message).toMatch(/no finite lastPrice/);
    } finally {
      engine.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("market truth semantics", () => {
  it("reports unmeasured metric truth as UNAVAILABLE instead of MEASURED", async () => {
    vi.resetModules();
    const { MarketStore } = await import("../src/lib/market/store");
    const store = new MarketStore();
    expect(store.metricTruth("BTCUSDT", "last_price")).toMatchObject({
      currently_measured: false,
      verdict: "UNAVAILABLE",
      availability: "unknown",
    });

    store.ingestStats({
      symbol: "BTCUSDT",
      lastPrice: null,
      markPrice: null,
      indexPrice: null,
      fundingRate: null,
      nextFundingTimeMs: null,
      fundingIntervalHours: null,
      change24hPct: null,
      high24h: null,
      low24h: null,
      volume24hQuote: null,
      openInterest: null,
      openValue: null,
      provenance: { source_name: "ttt", endpoint: "/futures/markets/stats", fetched_at_ms: Date.now(), auth: "public" },
    });
    expect(store.metricTruth("BTCUSDT", "last_price")).toMatchObject({
      currently_measured: false,
      verdict: "UNAVAILABLE",
      availability: "unavailable",
    });
  });

  it("symbol query validation fails with NOT_READY/503 before TTT discovery rather than mislabeling the symbol invalid", async () => {
    vi.resetModules();
    const { __setOperationalUniverse } = await import("../src/lib/market/operational-universe");
    const { sym } = await import("../src/lib/api-common");
    __setOperationalUniverse(null);
    const res = sym(new URLSearchParams("symbol=BTCUSDT"), "symbol").error!;
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ ok: false, state: "NOT_READY", degraded: "DISCOVERY_UNAVAILABLE" });
  });
});
