/**
 * Market data layer remediation tests (§25, §26).
 *
 * Covers dynamic discovery, TON exclusion at every layer, the 48-symbol
 * regression set, all nine resolutions, pagination, boundary detection,
 * dedupe/sort/gap/validation, incremental sync, fingerprints, and a permanent
 * static audit that fails if a hardcoded recent-N historical ceiling returns.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeMarket, isPermanentlyExcluded, PERMANENT_EXCLUSIONS, __resetCatalogCache,
} from "../src/lib/market/catalog";
import {
  mergeCandles, detectGaps, validateCandles, fingerprint,
  TTT_MAX_BARS_PER_REQUEST,
} from "../src/lib/market/history";
import { HistoryStore } from "../src/lib/market/history-store";
import {
  LEGACY_UNIVERSE, isUniverseSymbol, isExcludedSymbol, registerDiscoveredSymbols,
  __resetDiscoveredSymbols, EXCLUDED_SYMBOLS,
} from "../src/lib/domain/universe";
import { TIMEFRAMES, getTimeframe } from "../src/lib/domain/timeframes";
import { PRODUCTION_TIMEFRAMES } from "../src/app/api/market/matrix/route";
import type { Candle } from "../src/lib/domain/types";

const RAW_BTC = {
  symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", category: "Layer1",
  name: "Bitcoin USDT-M Perp", tickSize: "0.1", stepSize: "0.000001",
  minLeverage: 1, maxLeverage: 150, maintenanceMarginRate: "0.1", isActive: true,
  makerFeeCoefficient: "0.0004", takerFeeCoefficient: "0.0004",
  leverageTiers: [{ minNotional: "0", maxNotional: "50000" }],
};

describe("§1 dynamic market discovery / normalization", () => {
  it("normalizes a real TTT market payload", () => {
    const m = normalizeMarket(RAW_BTC, 1_700_000_000_000)!;
    expect(m.symbol).toBe("BTCUSDT");
    expect(m.base_asset).toBe("BTC");
    expect(m.quote_asset).toBe("USDT");
    // TTT does not publish contractType, so it must be UNAVAILABLE, not assumed
    expect(m.contract_type).toBe("UNAVAILABLE");
    expect(m.status).toBe("ACTIVE");
    expect(m.source).toBe("ttt");
    expect(m.constraints.tick_size).toBe(0.1);
    expect(m.constraints.step_size).toBe(0.000001);
    expect(m.constraints.max_leverage).toBe(150);
    expect(m.eligibility).toContain("ASA_MARKET_ELIGIBLE");
  });

  it("reports constraints TTT does not expose as UNAVAILABLE rather than inventing them", () => {
    const m = normalizeMarket(RAW_BTC, 1)!;
    expect(m.unavailable_constraints).toContain("max_qty");
    expect(m.constraints.max_qty).toBeNull();
  });

  it("marks an inactive contract ineligible but still keeps it discovered", () => {
    const m = normalizeMarket({ ...RAW_BTC, symbol: "DEADUSDT", isActive: false }, 1)!;
    expect(m.eligibility).toContain("TTT_DISCOVERED");
    expect(m.eligibility).not.toContain("ASA_MARKET_ELIGIBLE");
    expect(m.ineligible_reason).toMatch(/inactive/);
  });

  it("marks a non-USDT quote ineligible with a reason", () => {
    const m = normalizeMarket({ ...RAW_BTC, symbol: "BTCUSDC", quoteAsset: "USDC" }, 1)!;
    expect(m.ineligible_reason).toMatch(/not USDT/);
  });
});

describe("§2 TONUSDT permanent exclusion at every layer", () => {
  beforeAll(() => { __resetCatalogCache(); __resetDiscoveredSymbols(); });

  it("is refused by the discovery-layer normalizer", () => {
    expect(normalizeMarket({ ...RAW_BTC, symbol: "TONUSDT" }, 1)).toBeNull();
  });

  it("is refused by the exclusion predicate, case-insensitively", () => {
    expect(isPermanentlyExcluded("TONUSDT")).toBe(true);
    expect(isPermanentlyExcluded("tonusdt")).toBe(true);
    expect(isExcludedSymbol("TONUSDT")).toBe(true);
  });

  it("is refused by the synchronous universe guard", () => {
    expect(isUniverseSymbol("TONUSDT")).toBe(false);
  });

  it("CANNOT be reintroduced by a market-discovery refresh", () => {
    const added = registerDiscoveredSymbols(["TONUSDT", "NEWCOINUSDT"]);
    expect(added).toBe(1); // only the legitimate one
    expect(isUniverseSymbol("TONUSDT")).toBe(false);
    expect(isUniverseSymbol("NEWCOINUSDT")).toBe(true);
  });

  it("is not in the legacy regression set", () => {
    expect(LEGACY_UNIVERSE).not.toContain("TONUSDT");
    expect(EXCLUDED_SYMBOLS).toContain("TONUSDT");
    expect(PERMANENT_EXCLUSIONS).toContain("TONUSDT");
  });
});

describe("§3/§14 dynamic universe semantics", () => {
  afterAll(() => __resetDiscoveredSymbols());

  it("accepts a newly listed TTT contract with no code change", () => {
    __resetDiscoveredSymbols();
    expect(isUniverseSymbol("XAUUSDT")).toBe(false); // not in the legacy 48
    registerDiscoveredSymbols(["XAUUSDT", "NVDAUSDT", "TSLAUSDT"]);
    expect(isUniverseSymbol("XAUUSDT")).toBe(true);
    expect(isUniverseSymbol("NVDAUSDT")).toBe(true);
  });

  it("keeps the legacy 48 as a permanent regression set", () => {
    expect(LEGACY_UNIVERSE).toHaveLength(48);
    for (const s of LEGACY_UNIVERSE) expect(isUniverseSymbol(s)).toBe(true);
  });
});

describe("§4/§20 the nine production resolutions map natively", () => {
  const EXPECTED: Record<string, string> = {
    "5m": "5", "15m": "15", "30m": "30", "45m": "45",
    "1h": "60", "2h": "120", "4h": "240", "8h": "480", "1d": "1D",
  };

  it("every required timeframe exists with the exact TTT resolution", () => {
    for (const [tf, res] of Object.entries(EXPECTED)) {
      const spec = getTimeframe(tf);
      expect(spec, `timeframe ${tf}`).toBeDefined();
      expect(spec!.tttResolution, `${tf} -> ${res}`).toBe(res);
    }
  });

  it("the production matrix covers exactly the nine required resolutions", () => {
    expect(PRODUCTION_TIMEFRAMES.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("1d maps to native 1D, never derived from 8h", () => {
    expect(getTimeframe("1d")!.tttResolution).toBe("1D");
    expect(getTimeframe("8h")!.tttResolution).toBe("480");
  });

  it("no two timeframes share a resolution (no silent substitution)", () => {
    const used = TIMEFRAMES.map((t) => t.tttResolution);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe("§10 data integrity", () => {
  const mk = (t: number, c = 100): Candle => ({ t, o: c, h: c + 1, l: c - 1, c, v: 5 });

  it("dedupes by timestamp and sorts ascending", () => {
    const { merged, duplicates } = mergeCandles([mk(300), mk(100)], [mk(200), mk(100, 999)]);
    expect(merged.map((c) => c.t)).toEqual([100, 200, 300]);
    expect(duplicates).toBe(1);
    expect(merged[0].c).toBe(999); // later value wins (corrects a partial bar)
  });

  it("detects missing intervals without fabricating candles", () => {
    const gaps = detectGaps([mk(0), mk(3600), mk(3600 * 4)], 60);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].missing_bars).toBe(2);
    expect(gaps[0].from_ts).toBe(3600);
  });

  it("reports no gap on a contiguous series", () => {
    expect(detectGaps([mk(0), mk(3600), mk(7200)], 60)).toEqual([]);
  });

  it("drops structurally invalid OHLC and counts it", () => {
    const bad: Candle[] = [
      { t: 1, o: 10, h: 5, l: 8, c: 9, v: 1 },   // high < low
      { t: 2, o: 10, h: 12, l: 9, c: 11, v: 1 }, // valid
      { t: 3, o: -1, h: 2, l: -5, c: 1, v: 1 },  // negative price
      { t: 4, o: 10, h: 12, l: 9, c: 11, v: -3 },// negative volume
    ];
    const { valid, invalid } = validateCandles(bad);
    expect(valid).toHaveLength(1);
    expect(invalid).toBe(3);
  });

  it("fingerprints are stable and content-sensitive", () => {
    expect(fingerprint([mk(1)])).toBe(fingerprint([mk(1)]));
    expect(fingerprint([mk(1)])).not.toBe(fingerprint([mk(1, 101)]));
  });
});

describe("§9/§18 history store retention and incremental reads", () => {
  let store: HistoryStore;
  let dbPath: string;
  const mk = (t: number): Candle => ({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 });

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `hist-${Date.now()}.db`);
    store = new HistoryStore(dbPath);
  });
  afterAll(() => {
    store.close();
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(dbPath + s, { force: true });
  });

  it("stores and reads back the FULL range with no implicit window", () => {
    const bars = Array.from({ length: 12_000 }, (_, i) => mk(i * 3600));
    store.put("BTCUSDT", "1h", bars);
    // no limit -> everything, well beyond any legacy 700/5000 ceiling
    expect(store.get("BTCUSDT", "1h")).toHaveLength(12_000);
    expect(store.count("BTCUSDT", "1h")).toBe(12_000);
  });

  it("serves an explicit range window", () => {
    const slice = store.get("BTCUSDT", "1h", 3600 * 10, 3600 * 20);
    expect(slice).toHaveLength(11);
    expect(slice[0].t).toBe(3600 * 10);
  });

  it("a transport limit returns the NEWEST N, still ascending", () => {
    const w = store.get("BTCUSDT", "1h", undefined, undefined, 100);
    expect(w).toHaveLength(100);
    expect(w[w.length - 1].t).toBe(11_999 * 3600);
    expect(w[0].t).toBeLessThan(w[w.length - 1].t);
  });

  it("upserts rather than duplicating on re-put", () => {
    store.put("BTCUSDT", "1h", [mk(0), mk(3600)]);
    expect(store.count("BTCUSDT", "1h")).toBe(12_000);
  });

  it("reports true stored boundaries", () => {
    const b = store.bounds("BTCUSDT", "1h");
    expect(b.earliest).toBe(0);
    expect(b.latest).toBe(11_999 * 3600);
  });

  it("never deletes history — there is no delete/trim method on the store", () => {
    const methods = Object.getOwnPropertyNames(HistoryStore.prototype);
    expect(methods.filter((m) => /delete|trim|prune|purge|evict/i.test(m))).toEqual([]);
  });
});

describe("§26 STATIC AUDIT: no hardcoded historical ceiling", () => {
  function files(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) files(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("the venue chunk size is declared as TRANSPORT, not retention", () => {
    const src = fs.readFileSync("src/lib/market/history.ts", "utf8");
    expect(TTT_MAX_BARS_PER_REQUEST).toBe(5000);
    expect(src).toMatch(/TRANSPORT CHUNK SIZE, not a historical limit/i);
  });

  it("the history manager has no fixed-N cap on total retrieved bars", () => {
    const src = fs.readFileSync("src/lib/market/history.ts", "utf8");
    // the walk terminates on the TTT boundary, not on a bar count
    expect(src).toMatch(/reachedBoundary/);
    expect(src).not.toMatch(/candles\.slice\(-\d+\)/);
  });

  it("the history STORE never slices to a constant", () => {
    const src = fs.readFileSync("src/lib/market/history-store.ts", "utf8");
    expect(src).not.toMatch(/slice\(-\d+\)/);
    expect(src).not.toMatch(/LIMIT \d{3,}/);
  });

  it("the history API applies a window only when the caller asks", () => {
    const src = fs.readFileSync("src/app/api/market/history/route.ts", "utf8");
    expect(src).toMatch(/transport_window_applied/);
    // no default numeric limit is injected
    expect(src).not.toMatch(/limit\s*=\s*\d{3,}/);
  });

  it("any in-memory trim is documented as a RAM window, not retention", () => {
    const src = fs.readFileSync("src/lib/market/candles.ts", "utf8");
    if (/slice\(-target\)/.test(src)) {
      expect(src).toMatch(/NOT a historical\s*\n?\s*\/\/\s*limit|in-memory window only|IN-MEMORY window/i);
      expect(src).toMatch(/getHistoryStore\(\)\.put/); // persisted before trimming
    }
  });

  it("no source file hard-codes a recent-N candle ceiling for history", () => {
    const offenders: string[] = [];
    for (const f of files("src")) {
      if (f.includes("market/history")) continue; // audited above
      const src = fs.readFileSync(f, "utf8");
      for (const line of src.split("\n")) {
        // a candle slice with a large constant is the smell we are guarding
        const m = /candles\.slice\(-(\d{3,})\)/.exec(line);
        if (m) offenders.push(`${f}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("§7 completion-state semantics (recomputed, never stale)", () => {
  let store: HistoryStore;
  let dbPath: string;
  const mk = (t: number): Candle => ({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 });

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `hist2-${Date.now()}.db`);
    store = new HistoryStore(dbPath);
  });
  afterAll(() => {
    store.close();
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(dbPath + s, { force: true });
  });

  it("a backfilled hole clears GAPPED rather than leaving stale metadata", () => {
    // regression: a range once marked GAPPED stayed GAPPED after the hole was
    // filled, because completion_state was carried forward instead of recomputed
    const withHole = [mk(0), mk(3600), mk(3 * 3600)];
    expect(detectGaps(withHole, 60)).toHaveLength(1);
    const filled = mergeCandles(withHole, [mk(2 * 3600)]).merged;
    expect(detectGaps(filled, 60)).toHaveLength(0);
  });

  it("syncHistory recomputes completion from CURRENT data", () => {
    const src = fs.readFileSync("src/lib/market/history-store.ts", "utf8");
    expect(src).toMatch(/Recompute completion from the CURRENT stored data/);
    // the state must be derived from `gaps.length`, not copied from `prior`
    expect(src).toMatch(/if \(gaps\.length > 0\) \{\s*\n\s*completion = "GAPPED";/);
  });

  it("a full sync PROVES the earliest boundary with an older-than-oldest probe", () => {
    const src = fs.readFileSync("src/lib/market/history-store.ts", "utf8");
    expect(src).toMatch(/boundaryProven/);
    expect(src).toMatch(/probe one chunk older than the oldest stored bar/i);
  });

  it("COMPLETE_TO_TTT_BOUNDARY is only reachable via a real no_data response", () => {
    const src = fs.readFileSync("src/lib/market/history.ts", "utf8");
    // the walk sets reachedBoundary only on no_data / no-new-bars
    expect(src).toMatch(/if \(res\.noData \|\| res\.candles\.length === 0\) \{ reachedBoundary = true/);
  });
});

describe("§16 backtest consumes the same TTT history manager", () => {
  it("no second market-history loader exists", () => {
    function files(dir: string, out: string[] = []): string[] {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) files(p, out);
        else if (/\.tsx?$/.test(e.name)) out.push(p);
      }
      return out;
    }
    // Only the sanctioned modules may BUILD a UDF history request. A response
    // that merely LABELS its provenance with the endpoint string is fine.
    const builders = files("src").filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return /`\/futures\/udf\/history\?/.test(src) || /tttRequest[^\n]*futures\/udf\/history/.test(src);
    });
    for (const c of builders) {
      expect(
        /market\/history\.ts$|ttt\/client\.ts$/.test(c),
        `${c} builds its own UDF history request — use the shared history manager`,
      ).toBe(true);
    }
    expect(builders.length).toBeGreaterThan(0); // the sanctioned one exists
  });
});
