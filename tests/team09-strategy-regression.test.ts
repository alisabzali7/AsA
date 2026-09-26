/**
 * Task 09 — strategy regression across the detector repairs (DET-1/2/3,
 * STRUCT-1). The baseline JSON was captured from the unmodified detectors
 * BEFORE the repairs; every compiled strategy, every decision bar, four
 * deterministic synthetic series, fixed clock. Version strings are excluded
 * from the digest, so this proves the SEMANTIC outputs (outcomes, feature
 * values, levels, rr) are byte-identical on finite data.
 *
 * Task 10 re-baseline (deliberate, 4 of 28 digests): FTR-ABCD's `slope_cd`
 * held the BC-leg slope under the CD name; it is now `slope_bc` (same value)
 * with `slope_cd: null`, and the SLOPE rule's expr/detail say "BC (proxy)".
 * Only STR-RAW-4-2425 digests moved; regression-counts.json (captured from
 * the pre-Task-10 baseline) proves evaluated/passes are unchanged everywhere.
 */
import { describe, it, expect } from "vitest";
import baseline from "./fixtures/strategy/regression-baseline.json";
import preTask10Counts from "./fixtures/strategy/regression-counts.json";
import { strategyRegression } from "./fixtures/strategy/regression-harness";

describe("Task 09 strategy regression (before/after detector repairs)", () => {
  const now = strategyRegression();
  it("covers every compiled strategy on every series with non-trivial pass counts", () => {
    const b = baseline as Record<string, Record<string, { evaluated: number; passes: number; digest: string }>>;
    expect(Object.keys(now).sort()).toEqual(Object.keys(b).sort());
    let passes = 0;
    for (const s of Object.keys(b)) {
      expect(Object.keys(now[s]).sort()).toEqual(Object.keys(b[s]).sort());
      for (const k of Object.keys(b[s])) passes += b[s][k].passes;
    }
    expect(passes).toBeGreaterThan(100);
  });
  it("Task 10 relabel changed no decision: evaluated/passes equal the pre-Task-10 counts", () => {
    const c = preTask10Counts as unknown as Record<string, Record<string, [number, number]>>;
    for (const s of Object.keys(c)) for (const k of Object.keys(c[s])) {
      expect([now[s][k].evaluated, now[s][k].passes], `${s} ${k}`).toEqual(c[s][k]);
    }
  });
  it("every (series, strategy) digest is identical to the pre-repair baseline", () => {
    expect(now).toEqual(baseline);
  });
});
