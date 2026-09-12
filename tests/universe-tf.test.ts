/**
 * Universe & timeframe contract tests: 48 exact symbols, TONUSDT excluded,
 * 10 timeframes with native 1D semantics (TTT resolution '1D').
 */
import { describe, expect, it } from "vitest";
import { UNIVERSE, UNIVERSE_SIZE, isUniverseSymbol, assertUniverseSymbol } from "../src/lib/domain/universe";
import { TIMEFRAMES, CORE_TFS, getTimeframe, assertTimeframe, isTimeframe, tfStartMs } from "../src/lib/domain/timeframes";

const EXPECTED_48 = [
  "1000PEPEUSDT", "1000SHIBUSDT", "AAVEUSDT", "ADAUSDT", "ALGOUSDT", "APEUSDT",
  "APTUSDT", "ARBUSDT", "ASTERUSDT", "ATOMUSDT", "AVAXUSDT", "BANDUSDT",
  "BCHUSDT", "BNBUSDT", "BTCUSDT", "CAKEUSDT", "DASHUSDT", "DOGEUSDT",
  "DOTUSDT", "ENAUSDT", "ETCUSDT", "ETHUSDT", "FETUSDT", "FILUSDT",
  "HBARUSDT", "HYPEUSDT", "ICPUSDT", "INJUSDT", "KSMUSDT", "LINKUSDT",
  "LTCUSDT", "NEARUSDT", "NOTUSDT", "ONDOUSDT", "OPUSDT", "PAXGUSDT",
  "QNTUSDT", "SANDUSDT", "SOLUSDT", "SUIUSDT", "TRUMPUSDT", "TRXUSDT",
  "UNIUSDT", "VETUSDT", "WLDUSDT", "XLMUSDT", "XRPUSDT", "ZECUSDT",
];

describe("canonical universe", () => {
  it("has exactly 48 symbols matching the product universe", () => {
    expect(UNIVERSE_SIZE).toBe(48);
    expect([...UNIVERSE]).toEqual(EXPECTED_48);
  });

  it("excludes TONUSDT completely", () => {
    expect(UNIVERSE.includes("TONUSDT")).toBe(false);
    expect(isUniverseSymbol("TONUSDT")).toBe(false);
    expect(() => assertUniverseSymbol("TONUSDT")).toThrow();
  });

  it("accepts every listed symbol and rejects strangers", () => {
    for (const s of EXPECTED_48) expect(isUniverseSymbol(s)).toBe(true);
    for (const s of ["BTCUSD", "ETHUSDTX", "btcusdt", "", " ", "TONUSDT"]) {
      expect(isUniverseSymbol(s)).toBe(false);
    }
    expect(() => assertUniverseSymbol("BTCUSD")).toThrow(/legacy regression set|discovered TTT universe/);
  });
});

describe("timeframes", () => {
  it("covers 1m..1d (10 TFs) with native TTT resolutions incl. 1D", () => {
    const ids = TIMEFRAMES.map((t) => t.id);
    expect(ids).toEqual(["1m", "5m", "15m", "30m", "45m", "1h", "2h", "4h", "8h", "1d"]);
    const d = getTimeframe("1d")!;
    expect(d.tttResolution).toBe("1D"); // native 1D per live TTT verification
    expect(d.minutes).toBe(1440);
    expect(getTimeframe("4h")!.tttResolution).toBe("240");
    expect(getTimeframe("8h")!.tttResolution).toBe("480");
    expect(getTimeframe("1h")!.tttResolution).toBe("60");
  });

  it("exposes the core hierarchy 4H macro / 1H context / 15M trigger", () => {
    expect(CORE_TFS).toEqual(["4h", "1h", "15m"]);
  });

  it("normalizes and rejects unknown ids", () => {
    expect(isTimeframe("1d")).toBe(true);
    expect(isTimeframe("3h")).toBe(false);
    expect(() => assertTimeframe("3h")).toThrow(/unsupported timeframe/);
    expect(getTimeframe("bogus")).toBeUndefined();
  });

  it("aligns timestamps to timeframe starts", () => {
    // 2026-09-05T12:34:56.789Z
    const ms = Date.UTC(2026, 8, 5, 12, 34, 56, 789);
    expect(tfStartMs(ms, "1h")).toBe(Date.UTC(2026, 8, 5, 12));
    expect(tfStartMs(ms, "15m")).toBe(Date.UTC(2026, 8, 5, 12, 30));
    expect(tfStartMs(ms, "1d")).toBe(Date.UTC(2026, 8, 5));
    expect(tfStartMs(ms, "4h")).toBe(Date.UTC(2026, 8, 5, 12));
  });
});
