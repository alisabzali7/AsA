/**
 * MARKET ENGINE HEALTH TRUTH (Task 06 — mandate §16 / §7.5).
 *
 * Verified defect: `computeHealth()` derived the market state ONLY from the
 * age of the last successful stats FETCH (`lastStatsSweepAtMs`). A venue that
 * keeps answering /futures/markets/stats on schedule while its own row
 * timestamps stop moving (observed class: a market row served for days behind
 * the rest) therefore produced `market: "LIVE"` — and `/api/system/health`
 * returned `ok: true, market: LIVE` — even when ZERO rows were live at source.
 *
 *   fetch success ≠ market truth success
 *   STALE source rows must never be upgraded to LIVE by retrieval freshness
 *
 * The boot path is covered too: "first stats sweep pending" must not hide
 * repeated measured failures.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-engine-health-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
process.env.TTT_API_BASE = "https://apiv2.thetruetrade.io";
process.env.TTT_RATE_PER_MIN = "60000";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function harness() {
  vi.resetModules();
  const { MarketEngine } = await import("../src/lib/market/engine");
  const { sharedStore, STATS_SOURCE_STALE_MS } = await import("../src/lib/market/store");
  const { __setOperationalUniverse } = await import("../src/lib/market/operational-universe");
  __setOperationalUniverse(["BTCUSDT", "ETHUSDT"]);
  const engine = new MarketEngine();
  return { engine, sharedStore, STATS_SOURCE_STALE_MS };
}

function statsRow(symbol: string, fetchedAtMs: number, sourceTsMs: number | undefined) {
  return {
    symbol,
    lastPrice: 100,
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
    provenance: {
      source_name: "ttt" as const,
      endpoint: "/futures/markets/stats",
      fetched_at_ms: fetchedAtMs,
      source_ts_ms: sourceTsMs,
      latency_ms: 5,
      auth: "public" as const,
    },
  };
}

describe("MarketEngine.computeHealth — fetch success is not market truth", () => {
  it("recent sweep + ALL measured rows with frozen source timestamps = STALE, never LIVE", async () => {
    const { engine, sharedStore, STATS_SOURCE_STALE_MS } = await harness();
    const now = Date.now();
    sharedStore.lastStatsSweepAtMs = now; // fetch happened milliseconds ago
    sharedStore.ingestStats(statsRow("BTCUSDT", now, now - STATS_SOURCE_STALE_MS - 60_000));
    sharedStore.ingestStats(statsRow("ETHUSDT", now, now - STATS_SOURCE_STALE_MS - 60_000));

    const h = engine.computeHealth();
    expect(h.market).toBe("STALE"); // pre-fix returned LIVE
    expect(h.reason).toMatch(/source not updating/i);
    engine.stop();
  });

  it("recent sweep + fresh source timestamps = LIVE with measured row counts in the reason", async () => {
    const { engine, sharedStore } = await harness();
    const now = Date.now();
    sharedStore.lastStatsSweepAtMs = now;
    sharedStore.ingestStats(statsRow("BTCUSDT", now, now - 2_000));
    sharedStore.ingestStats(statsRow("ETHUSDT", now, now - 2_000));

    const h = engine.computeHealth();
    expect(h.market).toBe("LIVE");
    expect(h.reason).toMatch(/2\/2 rows live/);
    engine.stop();
  });

  it("one genuinely halted (source-stale) market does not degrade the whole feed", async () => {
    const { engine, sharedStore, STATS_SOURCE_STALE_MS } = await harness();
    const now = Date.now();
    sharedStore.lastStatsSweepAtMs = now;
    sharedStore.ingestStats(statsRow("BTCUSDT", now, now - 2_000));
    sharedStore.ingestStats(statsRow("ETHUSDT", now, now - STATS_SOURCE_STALE_MS - 60_000)); // halted

    const h = engine.computeHealth();
    expect(h.market).toBe("LIVE");
    expect(h.reason).toMatch(/1\/2 rows live/);
    // the halted row is still STALE at row level — row truth is untouched
    const eth = sharedStore.liveRows().find((r) => r.symbol === "ETHUSDT");
    expect(eth?.state).toBe("STALE");
    engine.stop();
  });

  it("fetch ladder still dominates: no sweep for >10 min = UNAVAILABLE regardless of rows", async () => {
    const { engine, sharedStore } = await harness();
    const now = Date.now();
    sharedStore.lastStatsSweepAtMs = now - 601_000;
    sharedStore.ingestStats(statsRow("BTCUSDT", now, now));

    const h = engine.computeHealth();
    expect(h.market).toBe("UNAVAILABLE");
    engine.stop();
  });

  it("boot with no sweep and repeated failures reports the measured failures, not a bare pending", async () => {
    const { engine } = await harness();
    const loops = (engine as unknown as { statsLoop: { consecutiveErrors: number; lastError: string | null } }).statsLoop;
    loops.consecutiveErrors = 4;
    loops.lastError = "TTT network error: ECONNRESET (/futures/markets/stats)";

    const h = engine.computeHealth();
    expect(h.market).toBe("CONNECTING"); // never received data — not LIVE, not invented
    expect(h.reason).toMatch(/4 consecutive failure/);
    expect(h.reason).toMatch(/ECONNRESET/);
    engine.stop();
  });

  it("boot with no attempt yet keeps the honest first-sweep-pending reason", async () => {
    const { engine } = await harness();
    const h = engine.computeHealth();
    expect(h).toEqual({ market: "CONNECTING", reason: "first stats sweep pending" });
    engine.stop();
  });
});
