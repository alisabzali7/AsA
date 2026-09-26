/**
 * Team 02 absolute-final: CLOSED-BAR CAUSALITY at the exact boundary.
 *
 * For each MTF role timeframe (15m trigger, 1h context, 4h macro) a bar B
 * opening at O closes at C = O + period. Contract:
 *   eval C − 1 ms → B is NOT closed (last closed = B − 1); its values are not knowable
 *   eval C        → B IS closed (knowable_at = C exactly)
 *   eval C + 1 ms → B IS closed
 *   observed (fetched) at C − 1 ms, evaluated at C + 1 ms → B is NOT closed:
 *     the snapshot saw B mid-bar, so its values are a forming snapshot.
 * The MTF produced at each instant never contains a component knowable after
 * the evaluation instant, and a pre-built bundle knowable at C is refused
 * (AFTER_AS_OF) at C − 1 ms.
 */
import { describe, expect, it } from "vitest";
import type { Candle, CandleSeries } from "../src/lib/domain/types";
import { prepareAnalysisInput } from "../src/lib/analysis/input";
import { buildArtifactsFromInput } from "../src/lib/analysis/bundle";
import { buildMtf, buildMtfAsOf } from "../src/lib/analysis/mtf";

const PERIOD: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400 };
// a 4H boundary is also a 1H and a 15M boundary: one instant tests all three
const C_SEC = 1_790_006_400 - (1_790_006_400 % 14400) + 14400; // a 4h close

function seriesFor(symbol: string, tf: string, lastOpenSec: number, fetchedMs: number, n = 150): CandleSeries {
  const step = PERIOD[tf];
  // prices are a pure function of the bar's open time, so one bar has the
  // same values in every window that contains it
  const px = (k: number) => 100 + 5 * Math.sin(k / 11) + (k % 1000) * 0.005;
  const candles: Candle[] = Array.from({ length: n }, (_, i) => {
    const t = lastOpenSec - (n - 1 - i) * step;
    const k = t / step;
    const c = px(k);
    const o = (c + px(k - 1)) / 2;
    return { t, o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c, v: 100 + (k % 50) };
  });
  return { symbol, timeframe: tf, candles, native: true, source: "ttt" as CandleSeries["source"], fetched_at_ms: fetchedMs };
}

for (const tf of ["15m", "1h", "4h"] as const) {
  const step = PERIOD[tf];
  const O = C_SEC - step; // bar B
  // the venue series observed at eval time ends with the bar forming AT eval
  const at = (evalMs: number, fetchedMs = evalMs) => {
    const lastOpen = Math.floor(fetchedMs / 1000 / step) * step;
    return prepareAnalysisInput("CAUSUSDT", tf, seriesFor("CAUSUSDT", tf, lastOpen, fetchedMs), evalMs);
  };

  describe(`${tf} close boundary`, () => {
    it("C − 1 ms: bar B not closed; last closed bar is B − 1; knowable ≤ eval", () => {
      const evalMs = C_SEC * 1000 - 1;
      const inp = at(evalMs);
      expect(inp.reason_code).toBe("OK");
      expect(inp.last_closed_open_ts).toBe(O - step);
      expect(inp.source_ts_ms).toBe(O * 1000);
      expect(inp.source_ts_ms!).toBeLessThanOrEqual(evalMs);
      expect(inp.candles.some((k) => k.t === O)).toBe(false);
    });

    it("C exactly: bar B is closed and knowable at C", () => {
      const evalMs = C_SEC * 1000;
      const inp = at(evalMs);
      expect(inp.last_closed_open_ts).toBe(O);
      expect(inp.source_ts_ms).toBe(C_SEC * 1000);
      const art = buildArtifactsFromInput(inp, undefined, evalMs)!;
      expect(art.bundle.as_of_t).toBe(O);
    });

    it("C + 1 ms: bar B is closed", () => {
      const inp = at(C_SEC * 1000 + 1);
      expect(inp.last_closed_open_ts).toBe(O);
    });

    it("observed at C − 1 ms, evaluated at C + 1 ms: B was a forming snapshot → excluded", () => {
      const inp = at(C_SEC * 1000 + 1, C_SEC * 1000 - 1);
      expect(inp.last_closed_open_ts).toBe(O - step);
      expect(inp.candles.some((k) => k.t === O)).toBe(false);
    });

    it("the closed window at C − 1 ms is a strict prefix of the window at C (no value revision)", () => {
      const before = at(C_SEC * 1000 - 1);
      const after = at(C_SEC * 1000);
      // same bars up to B − 1 (the venue series at C also contains B as closed)
      const byT = new Map(after.candles.map((k) => [k.t, k]));
      const overlap = before.candles.filter((k) => byT.has(k.t));
      expect(overlap.length).toBeGreaterThan(100);
      for (const k of overlap) expect(byT.get(k.t)).toEqual(k);
      expect(after.candles[after.candles.length - 1].t).toBe(O);
      expect(before.candles[before.candles.length - 1].t).toBe(O - step);
    });
  });
}

describe("MTF at the 4h close ±1 ms: no component newer than the evaluation instant", () => {
  const mtfAt = (evalMs: number) => {
    const s = (tf: string) => seriesFor("CAUSUSDT", tf, Math.floor(evalMs / 1000 / PERIOD[tf]) * PERIOD[tf], evalMs);
    return buildMtfAsOf("CAUSUSDT", { macro: s("4h"), context: s("1h"), trigger: s("15m") }, evalMs).mtf;
  };
  for (const [label, evalMs] of [["C − 1 ms", C_SEC * 1000 - 1], ["C", C_SEC * 1000], ["C + 1 ms", C_SEC * 1000 + 1]] as const) {
    it(label, () => {
      const m = mtfAt(evalMs);
      for (const c of m.components) {
        expect(c.knowable_at_ms, `${label} ${c.role}`).not.toBeNull();
        expect(c.knowable_at_ms!, `${label} ${c.role}`).toBeLessThanOrEqual(evalMs);
      }
      const macro = m.components.find((c) => c.role === "macro")!;
      expect(macro.as_of_t).toBe(evalMs < C_SEC * 1000 ? C_SEC - 2 * 14400 : C_SEC - 14400);
    });
  }

  it("bundles knowable at C are refused at C − 1 ms (AFTER_AS_OF) and accepted at C", () => {
    const m = mtfAt(C_SEC * 1000);
    const late = buildMtf(m.macro, m.context, m.trigger, C_SEC * 1000 - 1);
    expect(late.verdict).toBe("UNAVAILABLE");
    expect(late.components.every((c) => c.state === "AFTER_AS_OF")).toBe(true);
    expect(buildMtf(m.macro, m.context, m.trigger, C_SEC * 1000).components.every((c) => c.state !== "AFTER_AS_OF")).toBe(true);
  });
});
