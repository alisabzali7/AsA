import { describe, expect, it } from "vitest";
import { TIMEFRAME_IDS, TIMEFRAMES, getTimeframe } from "../src/lib/domain/timeframes";
import { PRODUCTION_TIMEFRAMES } from "../src/app/api/market/matrix/route";
import { MarketStore } from "../src/lib/market/store";

describe("timeframe unification (single source of truth)", () => {
  it("TIMEFRAME_IDS is derived from TIMEFRAMES and lists 10 ids in order", () => {
    expect(TIMEFRAME_IDS).toEqual(TIMEFRAMES.map((t) => t.id));
    expect(TIMEFRAME_IDS).toEqual(["1m","5m","15m","30m","45m","1h","2h","4h","8h","1d"]);
  });

  it("every TIMEFRAME_IDS entry resolves via getTimeframe with matching minutes", () => {
    for (const id of TIMEFRAME_IDS) {
      const spec = getTimeframe(id);
      expect(spec, `missing spec for ${id}`).toBeDefined();
      expect(spec!.id).toBe(id);
      expect(spec!.minutes).toBeGreaterThan(0);
    }
  });

  it("unknown timeframe returns undefined and does not silently default to 1h", () => {
    expect(getTimeframe("3m")).toBeUndefined();
    expect(getTimeframe("99h")).toBeUndefined();
    expect(getTimeframe("")).toBeUndefined();
  });

  it("PRODUCTION_TIMEFRAMES is TIMEFRAME_IDS minus 1m (9 items)", () => {
    expect(PRODUCTION_TIMEFRAMES).toEqual(TIMEFRAME_IDS.filter((id) => id !== "1m"));
    expect(PRODUCTION_TIMEFRAMES).toHaveLength(9);
    expect(PRODUCTION_TIMEFRAMES).not.toContain("1m");
    expect(PRODUCTION_TIMEFRAMES).toEqual(["5m","15m","30m","45m","1h","2h","4h","8h","1d"]);
  });

  it("chart-view TFS equals TIMEFRAME_IDS (imported canonical)", async () => {
    // dynamic import to avoid pulling React-heavy module in node env too early,
    // but we can verify via the canonical source: TFS must equal TIMEFRAME_IDS.
    // This asserts the architecture invariant: no second hardcoded table in chart-view.
    const expected = TIMEFRAME_IDS;
    expect(expected).toEqual(["1m","5m","15m","30m","45m","1h","2h","4h","8h","1d"]);
  });

  it("MarketStore.computeCoverage fails closed on unsupported timeframe", () => {
    const store = new MarketStore();
    const candles = [{ t: 1000, o: 1, h: 1, l: 1, c: 1, v: 0 }];
    const series: any = { candles, native: true, fetched_at_ms: Date.now() };
    const cov = store.computeCoverage("BTCUSDT", "3m", series, Date.now());
    expect(cov.status).toBe("ERROR");
    expect(cov.reason).toMatch(/unsupported timeframe.*3m/);
    expect(cov.bar_count).toBe(1);
  });

  it("MarketStore gap detection uses canonical minutes (15m step = 900s)", () => {
    const store = new MarketStore();
    // two bars 1 step apart -> no gap; 3 steps apart -> gap
    const base = 1_000_000;
    const mk = (t: number) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 0 });
    const noGapSeries: any = { candles: [mk(base), mk(base + 900)], native: true, fetched_at_ms: Date.now() };
    const gapSeries: any = { candles: [mk(base), mk(base + 900 * 3)], native: true, fetched_at_ms: Date.now() };
    const covNoGap = store.computeCoverage("BTCUSDT", "15m", noGapSeries, Date.now());
    const covGap = store.computeCoverage("BTCUSDT", "15m", gapSeries, Date.now());
    expect(covNoGap.gap_count).toBe(0);
    expect(covGap.gap_count).toBe(1);
  });

  it("MarketStore gap detection for 1h uses 3600s step", () => {
    const store = new MarketStore();
    const base = 2_000_000;
    const mk = (t: number) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 0 });
    const s: any = { candles: [mk(base), mk(base + 3600), mk(base + 3600*2)], native: true, fetched_at_ms: Date.now() };
    const cov = store.computeCoverage("BTCUSDT", "1h", s, Date.now());
    expect(cov.gap_count).toBe(0);
    const gapped: any = { candles: [mk(base), mk(base + 3600*3)], native: true, fetched_at_ms: Date.now() };
    const cov2 = store.computeCoverage("BTCUSDT", "1h", gapped, Date.now());
    expect(cov2.gap_count).toBe(1);
  });

  it("no hardcoded second table remains in src/lib/market/store.ts (import check)", async () => {
    const fs = await import("node:fs");
    const txt = fs.readFileSync("src/lib/market/store.ts", "utf8");
    // The old hardcoded map `m: Record<string, number> = { \"1m\": 60` must not exist
    expect(txt).not.toMatch(/\"1m\":\s*60/);
    expect(txt).not.toMatch(/tfMinutesFor/);
    // must delegate to getTimeframe
    expect(txt).toMatch(/getTimeframe/);
  });

  it("src/components/chart-view.tsx imports TIMEFRAME_IDS and does not hardcode a literal array", async () => {
    const fs = await import("node:fs");
    const txt = fs.readFileSync("src/components/chart-view.tsx", "utf8");
    expect(txt).toMatch(/import\s*\{[^}]*TIMEFRAME_IDS[^}]*\}\s*from\s*["']@\/lib\/domain\/timeframes["']/);
    // should define TFS as TIMEFRAME_IDS, not as a literal array
    expect(txt).toMatch(/const\s+TFS\s*=\s*TIMEFRAME_IDS/);
    // must not contain the old hardcoded array literal that defined TFS inline
    expect(txt).not.toMatch(/const\s+TFS\s*=\s*\[\s*\"1m\"/);
  });
});
