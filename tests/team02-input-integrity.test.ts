/**
 * Team 02 absolute-final: adversarial INPUT INTEGRITY matrix.
 *
 * Every raw series shape either
 *   (a) is VALID-but-degenerate → analysable, the bundle carries no NaN/Inf
 *       and every missing value is null with a stated reason; or
 *   (b) is INVALID → refused at the canonical boundary (reason_code
 *       INVALID_SERIES → API error_class INVALID_SOURCE_DATA), no bundle is
 *       ever built from it, no bar is repaired, skipped or zero-filled.
 * The bar rules mirror the venue normaliser (src/lib/ttt/udf.ts) so derived,
 * stored and replayed series cannot bypass them.
 */
import { describe, expect, it } from "vitest";
import type { Candle, CandleSeries } from "../src/lib/domain/types";
import { prepareAnalysisInput, barViolation, timestampViolation } from "../src/lib/analysis/input";
import { buildArtifactsFromInput } from "../src/lib/analysis/bundle";
import { inputErrorClass, inputHttpStatus } from "../src/lib/analysis/errors";
import { buildChartOverlay } from "../src/lib/chart/technical";

const STEP = 3600;
const NOW_SEC = 1_790_000_000 - (1_790_000_000 % STEP) + 600; // 10 min into a forming 1h bar
const FORMING_OPEN = Math.floor(NOW_SEC / STEP) * STEP;

/** closes → closed bars ending right before the forming bar, plus the forming bar */
function series(closes: number[], opts: { forming?: boolean; volume?: (i: number) => number } = {}): CandleSeries {
  const n = closes.length;
  const t0 = FORMING_OPEN - n * STEP;
  const candles: Candle[] = closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { t: t0 + i * STEP, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: opts.volume ? opts.volume(i) : 1000 + (i % 7) * 10 };
  });
  if (opts.forming !== false && n > 0) {
    const last = closes[n - 1];
    candles.push({ t: FORMING_OPEN, o: last, h: last * 1.002, l: last * 0.998, c: last * 1.001, v: 12 });
  }
  return { symbol: "ADVUSDT", timeframe: "1h", candles, native: true, source: "ttt" as CandleSeries["source"], fetched_at_ms: NOW_SEC * 1000 };
}

function nonFinitePaths(v: unknown, p = "$", out: string[] = []): string[] {
  if (typeof v === "number") { if (!Number.isFinite(v)) out.push(p); }
  else if (Array.isArray(v)) v.forEach((x, i) => nonFinitePaths(x, `${p}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) nonFinitePaths(x, `${p}.${k}`, out);
  return out;
}

const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

function analyse(s: CandleSeries) {
  const input = prepareAnalysisInput("ADVUSDT", "1h", s, NOW_SEC * 1000);
  const art = buildArtifactsFromInput(input, undefined, NOW_SEC * 1000);
  return { input, art };
}

describe("VALID-but-degenerate shapes: analysable, finite, honest undefined", () => {
  const cases: Record<string, CandleSeries> = {
    "one closed bar": series([100]),
    "short history (10 bars)": series(range(10, (i) => 100 + i)),
    "flat (zero range) 120 bars": (() => {
      const s = series(range(120, () => 100));
      s.candles = s.candles.map((k) => ({ ...k, o: 100, h: 100, l: 100, c: 100 }));
      return s;
    })(),
    "monotonic up 200": series(range(200, (i) => 100 + i)),
    "monotonic down 200": series(range(200, (i) => 400 - i)),
    "single spike": series(range(200, (i) => (i === 150 ? 300 : 100 + Math.sin(i / 3)))),
    "crash −90%": series(range(200, (i) => (i < 150 ? 100 + Math.sin(i / 3) : 10 + Math.sin(i / 3) * 0.1))),
    "zero volume everywhere": series(range(200, (i) => 100 + Math.sin(i / 3)), { volume: () => 0 }),
    "sub-cent prices": series(range(200, (i) => 0.000123 + Math.sin(i / 5) * 0.00001)),
    "no forming bar (all closed)": series(range(200, (i) => 100 + Math.sin(i / 4)), { forming: false }),
  };
  for (const [name, s] of Object.entries(cases)) {
    it(name, () => {
      const { input, art } = analyse(s);
      expect(input.reason_code).toBe("OK");
      expect(art).not.toBeNull();
      expect(nonFinitePaths(art!.bundle)).toEqual([]);
      expect(nonFinitePaths(art!.series)).toEqual([]);
      // every null indicator explains itself; no hidden 0 sentinel
      for (const [k, st] of Object.entries(art!.bundle.indicator_status)) {
        const val = (art!.bundle.indicators as unknown as Record<string, number | null>)[k];
        if (val === null) {
          expect(st.state, `${name}: ${k}`).not.toBe("OK");
          expect(typeof st.reason, `${name}: ${k} reason`).toBe("string");
        }
      }
      const overlay = buildChartOverlay(art!.bundle, art!.series);
      expect(nonFinitePaths(overlay)).toEqual([]);
    });
  }

  it("a GAP (missing bars) is not an integrity violation — bars are never fabricated to fill it", () => {
    const s = series(range(200, (i) => 100 + Math.sin(i / 3)));
    const gapped = { ...s, candles: [...s.candles.slice(0, 100), ...s.candles.slice(110)] };
    const { input, art } = analyse(gapped);
    expect(input.reason_code).toBe("OK");
    expect(input.closed_bars).toBe(190); // exactly the bars supplied, none invented
    expect(nonFinitePaths(art!.bundle)).toEqual([]);
  });

  it("as-of replay: bars after the EVALUATION instant (but observed) are trimmed, not refused", () => {
    const s = series(range(200, (i) => 100 + Math.sin(i / 3)));
    const asOfMs = (FORMING_OPEN - 10 * STEP) * 1000 + 1; // 10 bars earlier than observation
    const input = prepareAnalysisInput("ADVUSDT", "1h", s, asOfMs);
    expect(input.reason_code).toBe("OK");
    expect(input.candles.every((k) => (k.t + STEP) * 1000 <= asOfMs)).toBe(true);
    expect(input.closed_bars).toBe(190);
  });

  it("forming bar is excluded, flagged, and never counted as closed", () => {
    const { input } = analyse(series(range(50, (i) => 100 + i)));
    expect(input.forming_bar_excluded).toBe(true);
    expect(input.closed_bars).toBe(50);
    expect(input.candles.every((k) => (k.t + STEP) * 1000 <= NOW_SEC * 1000)).toBe(true);
  });
});

describe("INVALID shapes: refused at the boundary, never analysed", () => {
  const base = () => series(range(120, (i) => 100 + Math.sin(i / 3)));
  const mutate = (f: (c: Candle[]) => unknown) => { const s = base(); const c = s.candles.map((k) => ({ ...k })); f(c); return { ...s, candles: c as Candle[] }; };
  const cases: Record<string, CandleSeries> = {
    "duplicate open time": mutate((c) => { c[50].t = c[49].t; }),
    "out-of-order open time": mutate((c) => { const x = c[60].t; c[60].t = c[61].t; c[61].t = x; }),
    "future bar (opens after observation)": mutate((c) => { c.push({ ...c[c.length - 1], t: FORMING_OPEN + STEP }); }),
    "NaN close": mutate((c) => { c[70].c = NaN; }),
    "Infinity high": mutate((c) => { c[70].h = Infinity; }),
    "NaN volume": mutate((c) => { c[70].v = NaN; }),
    "negative volume": mutate((c) => { c[70].v = -1; }),
    "missing volume field": mutate((c) => { delete (c[70] as Partial<Candle>).v; }),
    "missing close field": mutate((c) => { delete (c[70] as Partial<Candle>).c; }),
    "string price (malformed row)": mutate((c) => { (c[70] as unknown as Record<string, unknown>).o = "100"; }),
    "null row": mutate((c) => { (c as unknown[])[70] = null; }),
    "zero price": mutate((c) => { c[70].l = 0; }),
    "negative price": mutate((c) => { c[70].o = -5; }),
    "high below close": mutate((c) => { c[70].h = c[70].c * 0.5; }),
    "low above open": mutate((c) => { c[70].l = Math.max(c[70].o, c[70].c) * 2; c[70].h = c[70].l * 2; }),
    "misaligned open time": mutate((c) => { c[70].t += 60; }),
    "mid-array forming bar (open time in the future, followed by closed bars)": mutate((c) => { c[60].t = FORMING_OPEN + 5 * STEP; }),
  };
  for (const [name, s] of Object.entries(cases)) {
    it(name, () => {
      const { input, art } = analyse(s);
      expect(input.reason_code).toBe("INVALID_SERIES");
      expect(input.candles).toEqual([]);
      expect(input.closed_bars).toBe(0);
      expect(input.freshness).toBe("UNAVAILABLE");
      expect(input.source_ts_ms).toBeNull();
      expect(art).toBeNull();
      expect(inputErrorClass(input, null)).toBe("INVALID_SOURCE_DATA");
    });
  }

  it("candles that are not an array are refused, not coerced", () => {
    const s = { ...base(), candles: null as unknown as Candle[] };
    expect(prepareAnalysisInput("ADVUSDT", "1h", s, NOW_SEC * 1000).reason_code).toBe("INVALID_SERIES");
  });
});

describe("other refusal classes stay distinct", () => {
  it("empty series → NO_CLOSED_BARS (not INVALID, not OK)", () => {
    const s = { ...series([]), candles: [] };
    const input = prepareAnalysisInput("ADVUSDT", "1h", s, NOW_SEC * 1000);
    expect(input.reason_code).toBe("NO_CLOSED_BARS");
    expect(inputErrorClass(input, null)).toBe("NO_DATA");
  });
  it("only the forming bar → NO_CLOSED_BARS", () => {
    const s = series([100]);
    const input = prepareAnalysisInput("ADVUSDT", "1h", { ...s, candles: s.candles.slice(1) }, NOW_SEC * 1000);
    expect(input.reason_code).toBe("NO_CLOSED_BARS");
  });
  it("no series → SERIES_UNAVAILABLE; wrong symbol → IDENTITY_MISMATCH; unknown tf → UNSUPPORTED_TIMEFRAME", () => {
    expect(prepareAnalysisInput("ADVUSDT", "1h", undefined, NOW_SEC * 1000).reason_code).toBe("SERIES_UNAVAILABLE");
    expect(prepareAnalysisInput("OTHERUSDT", "1h", series([1, 2]), NOW_SEC * 1000).reason_code).toBe("IDENTITY_MISMATCH");
    expect(prepareAnalysisInput("ADVUSDT", "7h", { ...series([1, 2]), timeframe: "7h" }, NOW_SEC * 1000).reason_code).toBe("UNSUPPORTED_TIMEFRAME");
  });
  it("mixed native+derived is carried as provenance, not silently merged", () => {
    const s = { ...series(range(30, (i) => 100 + i)), native: false, derived_source_tf: "15m" };
    const input = prepareAnalysisInput("ADVUSDT", "1h", s, NOW_SEC * 1000);
    expect(input.native).toBe(false);
    expect(input.derived_source_tf).toBe("15m");
  });
});

describe("validators are pure and agree with the venue normaliser", () => {
  it("clean bars pass both validators", () => {
    const s = series(range(20, (i) => 100 + i));
    expect(timestampViolation(s.candles)).toBeNull();
    expect(barViolation(s.candles, STEP)).toBeNull();
  });
  it("a zero-range bar (o=h=l=c) is valid", () => {
    expect(barViolation([{ t: FORMING_OPEN, o: 1, h: 1, l: 1, c: 1, v: 0 }], STEP)).toBeNull();
  });
});

describe("API: truthful HTTP status per input class (analysis route table)", () => {
  const at = (s: CandleSeries | undefined, sym = "ADVUSDT", tf = "1h") => prepareAnalysisInput(sym, tf, s, NOW_SEC * 1000);
  const good = series(range(60, (i) => 100 + Math.sin(i)));
  it.each([
    ["OK", at(good), null, 200, null],
    ["NO_CLOSED_BARS", at({ ...good, candles: [] }), null, 200, "NO_DATA"],
    ["SERIES_UNAVAILABLE", at(undefined), null, 503, "NO_DATA"],
    ["INVALID_SERIES", at({ ...good, candles: good.candles.map((k, i) => (i === 3 ? { ...k, c: NaN } : k)) }), null, 502, "INVALID_SOURCE_DATA"],
    ["IDENTITY_MISMATCH", at(good, "OTHERUSDT"), null, 500, "IDENTITY_MISMATCH"],
    ["UNSUPPORTED_TIMEFRAME", at({ ...good, timeframe: "7h" }, "ADVUSDT", "7h"), null, 400, "INVALID_REQUEST"],
    ["upstream failure", at(undefined), "TLS reset", 502, "UPSTREAM_FAILURE"],
  ] as const)("%s → HTTP %s", (_n, input, fetchErr, status, cls) => {
    expect(inputHttpStatus(input, fetchErr)).toBe(status);
    expect(inputErrorClass(input, fetchErr)).toBe(cls);
  });
});
