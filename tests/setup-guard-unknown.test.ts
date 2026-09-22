/**
 * Decision-boundary regression (Team 03): a guard stage (filter/invalidation)
 * whose rules are UNKNOWN must fold into the setup outcome.
 *
 * Invariant (src/lib/rules/engine.ts): "A setup containing any UNKNOWN
 * required rule is itself UNKNOWN, so missing data can never masquerade as a
 * satisfied or rejected condition." evaluateSetup used to fold only
 * REQUIRED_ORDER stages plus filter-FAIL and invalidation-PASS, so
 * filter-UNKNOWN and invalidation-UNKNOWN silently vanished into PASS —
 * technically insufficient evidence transformed into a positive decision at
 * the final confluence.
 */
import { describe, expect, it } from "vitest";
import { evaluateSetup, type SetupDefinition } from "../src/lib/rules/setup";
import { MapFeatureBag, type RuleDefinition } from "../src/lib/rules/engine";
import { okFeature, invalidFeature } from "../src/lib/features/types";
import { abcdBaseSetup } from "../src/lib/strategy/compiled/harmonic-abcd";

function rule(over: Partial<RuleDefinition> & { kind: RuleDefinition["kind"] }): RuleDefinition {
  return {
    id: "R-OK",
    description: "d",
    source_text: "s",
    source_refs: [],
    source_status: "SOURCE_VERIFIED",
    empirical_status: "UNTESTED",
    feature_dependencies: ["FTR-OK"],
    operator: "AND",
    timeframe: "1h",
    direction: "long",
    unresolved: [],
    version: "1.0.0",
    predicates: [{ expr: "always", requires: ["FTR-OK"], test: () => ({ ok: true, detail: "ok" }) }],
    ...over,
  };
}

function def(rules: RuleDefinition[]): SetupDefinition {
  return {
    setup_id: "SET-GUARD",
    strategy_id: "STR-GUARD",
    name: "guard probe",
    direction: "long",
    timeframe: "1h",
    source_refs: [],
    version: "1.0.0",
    rules,
  };
}

const REQUIRED_KINDS = ["context", "location", "structure", "trigger", "confirmation"] as const;
const requiredPassing = () => REQUIRED_KINDS.map((kind) => rule({ id: `R-${kind}`, kind }));

const greenBag = () =>
  MapFeatureBag.from([["FTR-OK", okFeature("FTR-OK", "1h", 1, 1, 1, "1.0.0", ["x"])]]);

describe("guard-stage UNKNOWN folds into the setup outcome — never PASS", () => {
  it("an UNKNOWN filter must not fold away while every required stage PASSes", () => {
    const d = def([
      ...requiredPassing(),
      rule({
        id: "R-FILTER",
        kind: "filter",
        feature_dependencies: ["FTR-COND"],
        predicates: [{ expr: "cond", requires: ["FTR-COND"], test: () => ({ ok: true, detail: "ok" }) }],
      }),
    ]);
    const bag = MapFeatureBag.from([
      ["FTR-OK", okFeature("FTR-OK", "1h", 1, 1, 1, "1.0.0", ["x"])],
      ["FTR-COND", invalidFeature("FTR-COND", "1h", "INSUFFICIENT_BARS", "no data", "1.0.0")],
    ]);
    const ev = evaluateSetup(d, bag);
    expect(ev.outcome, "UNKNOWN evidence must outrank a green pipeline").toBe("UNKNOWN");
    expect(ev.explanation).toMatch(/filter/);
    expect(ev.unknown_rules).toContain("R-FILTER");
  });

  it("an UNKNOWN invalidation must not fold away while every required stage PASSes", () => {
    const d = def([
      ...requiredPassing(),
      rule({
        id: "R-INVAL",
        kind: "invalidation",
        feature_dependencies: ["FTR-VOID"],
        predicates: [{ expr: "void", requires: ["FTR-VOID"], test: () => ({ ok: true, detail: "ok" }) }],
      }),
    ]);
    const bag = MapFeatureBag.from([
      ["FTR-OK", okFeature("FTR-OK", "1h", 1, 1, 1, "1.0.0", ["x"])],
      ["FTR-VOID", invalidFeature("FTR-VOID", "1h", "STALE", "no data", "1.0.0")],
    ]);
    const ev = evaluateSetup(d, bag);
    expect(ev.outcome).toBe("UNKNOWN");
    expect(ev.explanation).toMatch(/invalidation/);
  });

  /* Production artifact: the real compiled ABCD setup. Its required stages
   * depend only on FTR-STRUCT-BIAS + FTR-ABCD; the exclusion filter alone
   * depends on FTR-VOL-REGIME — an independent detector whose feature can be
   * invalid while every required feature is valid (evaluateRule contract:
   * insufficient bars / stale / unavailable ⇒ UNKNOWN, never guessed). */
  const abcdBag = (vol: "ok" | "invalid") =>
    MapFeatureBag.from([
      ["FTR-STRUCT-BIAS", okFeature("FTR-STRUCT-BIAS", "1h", { bias: "HH_HL" }, 1, 100, "1.0.0", ["candles"])],
      [
        "FTR-ABCD",
        okFeature(
          "FTR-ABCD",
          "1h",
          {
            direction: "bearish",
            a: 100,
            b: 110,
            c: 105,
            d_projected: 115,
            ab: 10,
            cd: 10,
            correction_frac: 0.6,
            slope_ab: 1,
            slope_cd: 0.8,
            deep_correction: true,
          },
          1,
          100,
          "1.0.0",
          ["FTR-SWINGS"],
        ),
      ],
      [
        "FTR-VOL-REGIME",
        vol === "ok"
          ? okFeature("FTR-VOL-REGIME", "1h", { state: "NEUTRAL", atr: 2, atr_avg: 1 }, 1, 100, "1.0.0", ["candles"])
          : invalidFeature("FTR-VOL-REGIME", "1h", "INSUFFICIENT_BARS", "regime window unsatisfied", "1.0.0"),
      ],
    ]);

  it("real ABCD setup: green pipeline + cleared filter is PASS (craft control)", () => {
    const ev = evaluateSetup(abcdBaseSetup(), abcdBag("ok"));
    expect(ev.outcome).toBe("PASS");
  });

  it("real ABCD setup: independent VOL-REGIME invalidity can never read as PASS", () => {
    const ev = evaluateSetup(abcdBaseSetup(), abcdBag("invalid"));
    expect(ev.outcome, "unevaluated exclusion must not become positive evidence").toBe("UNKNOWN");
    expect(ev.explanation).toMatch(/filter/);
    // determinism: identical inputs produce an identical decision surface
    const ev2 = evaluateSetup(abcdBaseSetup(), abcdBag("invalid"));
    expect(ev2.outcome).toBe(ev.outcome);
    expect(ev2.explanation).toBe(ev.explanation);
  });

  it("preserves guard polarity: filter FAIL blocks, fired invalidation voids, clear guards pass", () => {
    const filterFail = def([
      ...requiredPassing(),
      rule({
        id: "R-FILTER",
        kind: "filter",
        feature_dependencies: ["FTR-OK"],
        predicates: [{ expr: "cond", requires: ["FTR-OK"], test: () => ({ ok: false, detail: "forbidden" }) }],
      }),
    ]);
    expect(evaluateSetup(filterFail, greenBag()).outcome).toBe("BLOCKED");

    const invalidationFired = def([
      ...requiredPassing(),
      rule({
        id: "R-INVAL",
        kind: "invalidation",
        feature_dependencies: ["FTR-OK"],
        predicates: [{ expr: "void", requires: ["FTR-OK"], test: () => ({ ok: true, detail: "true" }) }],
      }),
    ]);
    expect(evaluateSetup(invalidationFired, greenBag()).outcome).toBe("BLOCKED");

    const invalidationClear = def([
      ...requiredPassing(),
      rule({
        id: "R-INVAL",
        kind: "invalidation",
        feature_dependencies: ["FTR-OK"],
        predicates: [{ expr: "void", requires: ["FTR-OK"], test: () => ({ ok: false, detail: "false" }) }],
      }),
    ]);
    expect(evaluateSetup(invalidationClear, greenBag()).outcome).toBe("PASS");
  });
});
