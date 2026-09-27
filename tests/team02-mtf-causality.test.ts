/**
 * Team 02 — MTF causality (4H / 1H / 15M) through the SAME pure seam that the
 * production loader uses (analysis/mtf.ts buildMtfAsOf ← analysis/load.ts loadMtf).
 *
 *  - a higher-timeframe bar contributes only after it CLOSED (open + period <= as-of)
 *  - every 15M reading taken inside one 4H bar sees the identical macro state
 *  - a cached snapshot is cut at its own fetch instant (forming-bar leakage fix)
 *  - roles carry their contract timeframes; undetermined trend is not "neutral"
 */
import { describe, it, expect } from "vitest";
import type { Candle, CandleSeries } from "../src/lib/domain/types";
import { buildMtf, buildMtfAsOf, MTF_ROLE_TF } from "../src/lib/analysis/mtf";
import { prepareAnalysisInput } from "../src/lib/analysis/input";
import { buildBundle, buildBundleFromInput } from "../src/lib/analysis/bundle";

const M15 = 900, H1 = 3600, H4 = 14400;
// fixed clock: a 4H boundary + 2h (inside the forming 4H bar)
const H4_OPEN = Math.floor(1_800_000_000 / H4) * H4; // epoch s, open of the forming 4H bar
const NOW = (H4_OPEN + 2 * H1 + 7 * 60) * 1000;       // 2h07m into it

/** zig-zag with midpoint opens (real fractal pivots), ending with the bar that opens at lastOpen */
function zig(n: number, step: number, lastOpen: number, drift: number): Candle[] {
  const closes = Array.from({ length: n }, (_, i) => 200 + i * drift + 6 * Math.sin((2 * Math.PI * i) / 10));
  return closes.map((c, i) => {
    const o = i > 0 ? (closes[i - 1] + c) / 2 : c;
    return { t: lastOpen - (n - 1 - i) * step, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 10 + i };
  });
}
function ser(tf: string, candles: Candle[], fetchedAtMs = NOW): CandleSeries {
  return { symbol: "BTCUSDT", timeframe: tf, candles, native: true, source: "ttt", fetched_at_ms: fetchedAtMs };
}
const cur = (step: number, nowMs = NOW) => Math.floor(nowMs / 1000 / step) * step;

/** a forming bar with an absurd print — if it ever leaks, every assertion below breaks */
function withPoisonedFormingBar(closed: Candle[], step: number, nowMs = NOW): Candle[] {
  const t = cur(step, nowMs);
  return [...closed, { t, o: 5000, h: 9000, l: 4000, c: 8000, v: 1e9 }];
}

describe("4H forming bar never informs the MTF (as-of causality)", () => {
  const h4Closed = zig(90, H4, H4_OPEN - H4, 0.8);
  const h1Closed = zig(120, H1, cur(H1) - H1, 0.8);
  const m15Closed = zig(120, M15, cur(M15) - M15, 0.8);

  it("the poisoned forming 4H/1H/15M bars are excluded and the result equals the closed-only series", () => {
    const poisoned = buildMtfAsOf("BTCUSDT", {
      macro: ser("4h", withPoisonedFormingBar(h4Closed, H4)),
      context: ser("1h", withPoisonedFormingBar(h1Closed, H1)),
      trigger: ser("15m", withPoisonedFormingBar(m15Closed, M15)),
    }, NOW);
    const clean = buildMtfAsOf("BTCUSDT", { macro: ser("4h", h4Closed), context: ser("1h", h1Closed), trigger: ser("15m", m15Closed) }, NOW);
    for (const p of poisoned.parts) {
      expect(p.input.forming_bar_excluded).toBe(true);
      expect(p.bundle!.candle_window!.price_max).toBeLessThan(1000);
    }
    expect(poisoned.mtf.macro!.as_of_t).toBe(H4_OPEN - H4);
    expect(poisoned.mtf.macro!.last_close).toBe(h4Closed[h4Closed.length - 1].c);
    expect(poisoned.mtf.verdict).toBe(clean.mtf.verdict);
    expect(poisoned.mtf.macro!.structure).toEqual(clean.mtf.macro!.structure);
    expect(poisoned.mtf.macro!.indicators).toEqual(clean.mtf.macro!.indicators);
    expect(poisoned.mtf.as_of_ms).toBe(NOW);
  });

  it("every 15M reading inside one 4H bar sees an identical macro bundle; the next 4H close changes it", () => {
    // the full 4H history includes the bar opening at H4_OPEN (it closes at H4_OPEN + 4h)
    const h4All = zig(91, H4, H4_OPEN, 0.8);
    const macroAt = (nowMs: number) =>
      buildMtfAsOf("BTCUSDT", { macro: ser("4h", h4All, nowMs), context: null, trigger: null }, nowMs).parts[0].bundle!;
    const readings = [0, 15, 60, 119, 180, 239].map((min) => macroAt((H4_OPEN + min * 60 + 1) * 1000));
    for (const r of readings) {
      expect(r.as_of_t).toBe(H4_OPEN - H4);
      expect(r.structure).toEqual(readings[0].structure);
      expect(r.indicators).toEqual(readings[0].indicators);
    }
    const after = macroAt((H4_OPEN + H4) * 1000); // the exact close instant
    expect(after.as_of_t).toBe(H4_OPEN);
    expect(after.bars).toBe(readings[0].bars + 1);
  });

  it("MTF role timeframes are the contract 4h / 1h / 15m", () => {
    expect(MTF_ROLE_TF).toEqual({ macro: "4h", context: "1h", trigger: "15m" });
  });
});

describe("cached snapshot is cut at its own fetch instant (DEFECT: forming-bar leakage through a <=45 s cache)", () => {
  it("a snapshot fetched 20 s BEFORE a 15M close, analysed 10 s AFTER it, does not treat the snapshot bar as closed", () => {
    const closeS = cur(M15); // a 15M boundary at or before NOW
    const fetched = (closeS - 20) * 1000;
    const analysed = (closeS + 10) * 1000;
    // at fetch time the bar opening at closeS - 15m was still forming: its OHLC is a partial snapshot
    const candles = zig(80, M15, closeS - M15, 0.5);
    const input = prepareAnalysisInput("BTCUSDT", "15m", ser("15m", candles, fetched), analysed);
    expect(input.forming_bar_excluded).toBe(true);
    expect(input.last_closed_open_ts).toBe(closeS - 2 * M15);
    expect(input.closed_bars).toBe(79);
    // pre-fix behaviour (cut at the analysis clock) would have accepted all 80 bars
    const naive = prepareAnalysisInput("BTCUSDT", "15m", { ...ser("15m", candles), fetched_at_ms: Number.NaN as unknown as number }, analysed);
    expect(naive.closed_bars).toBe(80);
  });

  it("a snapshot fetched AFTER the close keeps that bar (the cut never drops truly closed bars)", () => {
    const closeS = cur(M15);
    const candles = zig(80, M15, closeS - M15, 0.5);
    const input = prepareAnalysisInput("BTCUSDT", "15m", ser("15m", candles, (closeS + 1) * 1000), (closeS + 30) * 1000);
    expect(input.closed_bars).toBe(80);
    expect(input.forming_bar_excluded).toBe(false);
  });
});

describe("role / evidence validation", () => {
  const leg = (tf: string, step: number, drift = 0.8) => buildBundleFromInput(prepareAnalysisInput("BTCUSDT", tf, ser(tf, zig(120, step, cur(step) - step, drift)), NOW), undefined, NOW);

  it("the aligned zig-zag uptrend in all three roles is ALIGNED long", () => {
    const m = buildMtf(leg("4h", H4), leg("1h", H1), leg("15m", M15), NOW);
    expect(m.verdict).toBe("ALIGNED");
    expect([m.macro_bias, m.context_bias, m.trigger_bias]).toEqual(["long", "long", "long"]);
  });

  it("a 1h bundle in the 4H macro role is MISMATCH -> UNAVAILABLE (never silently accepted)", () => {
    const m = buildMtf(leg("1h", H1), leg("1h", H1), leg("15m", M15), NOW);
    expect(m.verdict).toBe("UNAVAILABLE");
    expect(m.components[0]).toMatchObject({ role: "macro", timeframe: "1h", state: "MISMATCH" });
    expect(m.macro_bias).toBeNull();
  });

  it("a series of the wrong timeframe fed to buildMtfAsOf is refused at the input contract", () => {
    const r = buildMtfAsOf("BTCUSDT", { macro: ser("1h", zig(120, H1, cur(H1) - H1, 0.8)), context: null, trigger: null }, NOW);
    expect(r.parts[0].bundle).toBeNull();
    expect(r.parts[0].input.reason).toMatch(/identity mismatch/);
    expect(r.mtf.verdict).toBe("UNAVAILABLE");
  });

  it("an undetermined component trend yields INSUFFICIENT, not a neutral vote", () => {
    const ramp: Candle[] = Array.from({ length: 120 }, (_, i) => {
      const c = 100 + i;
      return { t: cur(M15) - (120 - i) * M15, o: c - 0.5, h: c + 0.5, l: c - 1, c, v: 1 };
    });
    const trig = buildBundleFromInput(prepareAnalysisInput("BTCUSDT", "15m", ser("15m", ramp), NOW), undefined, NOW)!;
    expect(trig.structure.trend).toBe("undetermined");
    const m = buildMtf(leg("4h", H4), leg("1h", H1), trig, NOW);
    expect(m.verdict).toBe("INSUFFICIENT");
    expect(m.trigger_bias).toBeNull();
  });

  it("conflicting directions are CONFLICT/PARTIAL, never ALIGNED", () => {
    const m = buildMtf(leg("4h", H4), leg("1h", H1, -0.8), leg("15m", M15), NOW);
    expect(["CONFLICT", "PARTIAL"]).toContain(m.verdict);
  });

  it("buildMtf is deterministic for the same inputs and as-of instant", () => {
    const a = buildMtf(leg("4h", H4), leg("1h", H1), leg("15m", M15), NOW);
    const b = buildMtf(leg("4h", H4), leg("1h", H1), leg("15m", M15), NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("legacy (non-contract) bundles never claim verified freshness", () => {
    const b = (tf: string, step: number) => buildBundle({ symbol: "BTCUSDT", timeframe: tf, candles: zig(80, step, 1_700_000_000, 0.8), nowMs: NOW });
    expect(buildMtf(b("4h", H4), b("1h", H1), b("15m", M15), NOW).freshness_verified).toBe(false);
  });
});
