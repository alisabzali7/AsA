/**
 * Chart quick-range model (render contract, adapter).
 *
 * Regression anchor: the 1D/5D/1M/3M/ALL buttons all ran `fitContent()`, so
 * five controls did exactly one thing and "1D" silently showed the whole loaded
 * history. The range model must (a) set a REAL window derived from the
 * authoritative timeframe model, and (b) tell the UI when the requested window
 * is only partly covered by stored bars, so the button can be labelled honestly
 * instead of pretending.
 */
import { describe, expect, it } from "vitest";
import {
  CHART_RANGES,
  barBounds,
  barStepSeconds,
  rangePartial,
  visibleRangeFor,
} from "../src/lib/chart/adapter";

const bar = (t: number) => ({ t });
const HOUR = 3600;

describe("barStepSeconds", () => {
  it("measures the bar step from the series the server returned", () => {
    expect(barStepSeconds([bar(0), bar(900), bar(1800)])).toBe(900);
  });
  it("survives a gap: the minimum positive difference is the true step", () => {
    expect(barStepSeconds([bar(0), bar(900), bar(900 + 5 * 900)])).toBe(900);
  });
  it("returns null rather than guessing when fewer than two bars exist", () => {
    expect(barStepSeconds([bar(0)])).toBeNull();
    expect(barStepSeconds([])).toBeNull();
  });
});

describe("barBounds", () => {
  it("spans durable history plus the live window", () => {
    expect(barBounds([bar(0), bar(HOUR)], [bar(2 * HOUR)])).toEqual({ earliest: 0, latest: 2 * HOUR });
  });
  it("returns null when no bar is loaded", () => {
    expect(barBounds([], [])).toBeNull();
  });
  it("ignores non-finite timestamps instead of poisoning the bounds", () => {
    expect(barBounds([bar(Number.NaN), bar(HOUR)])).toEqual({ earliest: HOUR, latest: HOUR });
  });
});

describe("visibleRangeFor", () => {
  // a real ascending series: 15m bars, 30h span
  const history = [bar(0), bar(900), bar(1800)];
  const live = [bar(2700)];

  it("sets a window that ends one measured bar past the newest bar", () => {
    const bars = [...history, ...live];
    const r = visibleRangeFor({ id: "1D", seconds: 86_400 }, bars)!;
    expect(r.from).toBe(2700 - 86_400);
    expect(r.to).toBe(2700 + 900);
  });

  it("ALL means fitContent — no synthetic window is invented", () => {
    expect(visibleRangeFor({ id: "ALL", seconds: null }, [...history, ...live])).toBeNull();
  });

  it("has no window without bars", () => {
    expect(visibleRangeFor({ id: "1D", seconds: 86_400 }, [])).toBeNull();
  });

  it("still sets a window when the step cannot be measured (single bar)", () => {
    const r = visibleRangeFor({ id: "1D", seconds: 86_400 }, [bar(30 * HOUR)])!;
    expect(r.from).toBe(30 * HOUR - 86_400);
    expect(r.to).toBe(30 * HOUR);
  });

  it("every quick range is expressed in seconds", () => {
    expect(CHART_RANGES.map((r) => r.id)).toEqual(["1D", "5D", "1M", "3M", "ALL"]);
    for (const r of CHART_RANGES) expect(r.seconds === null || r.seconds > 0).toBe(true);
  });
});

describe("rangePartial", () => {
  it("is false when stored history covers the window", () => {
    // 100 days of bars fully cover a 90-day window
    expect(rangePartial({ id: "3M", seconds: 90 * 86_400 }, [bar(0), bar(100 * 86_400)])).toBe(false);
  });

  it("is true when the oldest stored bar is newer than the window", () => {
    // only ~2 days stored, a 5-day window reaches back past the oldest bar
    const bars = [bar(50 * HOUR), bar(100 * HOUR)];
    expect(rangePartial({ id: "5D", seconds: 5 * 86_400 }, bars)).toBe(true);
    // the same bars DO cover a 1-day window
    expect(rangePartial({ id: "1D", seconds: 86_400 }, bars)).toBe(false);
  });

  it("ALL is never partial", () => {
    expect(rangePartial({ id: "ALL", seconds: null }, [bar(0), bar(1)])).toBe(false);
  });

  it("is false with no bars rather than claiming a partial window", () => {
    expect(rangePartial({ id: "1D", seconds: 86_400 }, [])).toBe(false);
  });
});
