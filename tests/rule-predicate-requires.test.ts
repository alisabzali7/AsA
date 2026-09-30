/**
 * Decision-truth regression (Team 02): a predicate whose declared `requires`
 * feature cannot be measured is UNDECIDABLE, and an undecidable predicate must
 * never be reported as a measured FALSE.
 *
 * `RulePredicate.requires` is documented in src/lib/rules/engine.ts as "features
 * that MUST be valid for this predicate to be meaningful", but the evaluator
 * only checked the RULE-level `feature_dependencies` and then ran every
 * predicate regardless. A predicate reading an invalid feature therefore
 * returned `ok:false` ("no pin bar", "no level/close to compare") and the rule
 * reported FAIL — "the condition was measured and is not met" — for a condition
 * that was never measured. That is the exact inversion the truth contract
 * forbids.
 *
 * Two repairs are pinned here:
 *   1. evaluateRule gates EACH predicate on its own `requires` and combines
 *      with three-valued logic (AND: a measured false decides; OR: a measured
 *      true decides; UNKNOWN only when nothing decides).
 *   2. every compiled rule declares the features its predicates read, so the
 *      closure graph and the Brain `required_features` row are complete.
 */
import { describe, expect, it } from "vitest";
import { evaluateRule, MapFeatureBag, type RuleDefinition } from "../src/lib/rules/engine";
import { invalidFeature, okFeature } from "../src/lib/features/types";
import { COMPILED_STRATEGIES } from "../src/lib/strategy/compiled";
import { detectLevelTouch, detectPinbar, detectRejectionAt, type PriceLevel } from "../src/lib/features/detectors";

type Predicate = RuleDefinition["predicates"][number];

const pred = (expr: string, requires: string[], result: boolean | null): Predicate => ({
  expr,
  requires,
  test: () => {
    if (result === null) throw new Error("predicate must not run while a required feature is unavailable");
    return { ok: result, detail: expr };
  },
});

function rule(over: Partial<RuleDefinition>): RuleDefinition {
  return {
    id: "R-T",
    description: "test rule",
    source_text: "test",
    source_refs: [],
    source_status: "SOURCE_VERIFIED",
    empirical_status: "UNTESTED",
    feature_dependencies: ["FTR-OK"],
    operator: "AND",
    timeframe: "1h",
    direction: "long",
    kind: "confirmation",
    unresolved: [],
    version: "1.0.0",
    predicates: [pred("p", ["FTR-OK"], true)],
    ...over,
  };
}

const bag = (entries: [string, ReturnType<typeof okFeature> | ReturnType<typeof invalidFeature>][]) =>
  MapFeatureBag.from(entries);

const ok = (id: string) => okFeature(id, "1h", 1, 1, 1, "1.0.0", ["x"]);
const bad = (id: string) => invalidFeature(id, "1h", "UNAVAILABLE", "window input corrupt", "1.0.0", ["candles"]);

describe("predicate-level `requires` is enforced (missing data is never a measured FAIL)", () => {
  it("a predicate whose required feature is invalid yields rule UNKNOWN, not FAIL", () => {
    const r = rule({
      feature_dependencies: ["FTR-OK"],
      predicates: [pred("reads FTR-GONE", ["FTR-GONE"], null)],
    });
    const ev = evaluateRule(r, bag([["FTR-OK", ok("FTR-OK")]]));
    expect(ev.outcome).toBe("UNKNOWN");
    expect(ev.predicate_results[0].ok).toBeNull();
    expect(ev.predicate_results[0].detail).toMatch(/required feature\(s\) unavailable: FTR-GONE/);
    expect(ev.missing_features.join(" ")).toMatch(/FTR-GONE/);
  });

  it("an INVALID (not merely absent) required feature is also undecidable", () => {
    const r = rule({ predicates: [pred("reads FTR-BAD", ["FTR-BAD"], null)] });
    const ev = evaluateRule(r, bag([["FTR-OK", ok("FTR-OK")], ["FTR-BAD", bad("FTR-BAD")]]));
    expect(ev.outcome).toBe("UNKNOWN");
  });

  it("a present-but-empty measurement still decides: ABSENT is data, not missing data", () => {
    // okFeature(value null) = valid:true, value:null (feature measured, nothing found)
    const empty = okFeature("FTR-NONE", "1h", null, 1, 1, "1.0.0", ["x"]);
    const r = rule({ predicates: [pred("nothing found", ["FTR-NONE"], false)] });
    const ev = evaluateRule(r, bag([["FTR-OK", ok("FTR-OK")], ["FTR-NONE", empty]]));
    expect(ev.outcome).toBe("FAIL");
    expect(ev.predicate_results[0].ok).toBe(false);
  });

  it("three-valued AND: a measured false decides even when another branch is undecidable", () => {
    const r = rule({
      operator: "AND",
      predicates: [pred("false", ["FTR-OK"], false), pred("undecidable", ["FTR-GONE"], null)],
    });
    const ev = evaluateRule(r, bag([["FTR-OK", ok("FTR-OK")]]));
    expect(ev.outcome).toBe("FAIL");
  });

  it("three-valued OR: a measured true decides even when another branch is undecidable", () => {
    const r = rule({
      operator: "OR",
      predicates: [pred("true", ["FTR-OK"], true), pred("undecidable", ["FTR-GONE"], null)],
    });
    const ev = evaluateRule(r, bag([["FTR-OK", ok("FTR-OK")]]));
    expect(ev.outcome).toBe("PASS");
  });

  it("three-valued OR: false + undecidable is UNKNOWN (the classic silent-FAIL case)", () => {
    const r = rule({
      operator: "OR",
      predicates: [pred("false", ["FTR-OK"], false), pred("undecidable", ["FTR-GONE"], null)],
    });
    const ev = evaluateRule(r, bag([["FTR-OK", ok("FTR-OK")]]));
    expect(ev.outcome).toBe("UNKNOWN");
  });

  it("a predicate that THROWS still makes the whole rule UNKNOWN regardless of the operator", () => {
    const r = rule({
      operator: "OR",
      predicates: [
        pred("true", ["FTR-OK"], true),
        { expr: "boom", requires: ["FTR-OK"], test: () => { throw new Error("bug"); } },
      ],
    });
    const ev = evaluateRule(r, bag([["FTR-OK", ok("FTR-OK")]]));
    expect(ev.outcome).toBe("UNKNOWN");
    expect(ev.predicate_results.map((p) => p.ok)).toEqual([true, null]);
  });
});

describe("compiled strategies: every predicate declares what it reads", () => {
  it("predicate `requires` ⊆ rule `feature_dependencies` for every compiled rule", () => {
    const violations: string[] = [];
    for (const strat of COMPILED_STRATEGIES) {
      for (const r of strat.setup().rules) {
        const declared = new Set(r.feature_dependencies);
        for (const p of r.predicates) {
          for (const fid of p.requires) {
            if (!declared.has(fid)) violations.push(`${r.id} reads ${fid} ("${p.expr}") but does not declare it`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("regression (STR-RAW-2-803 R-803-CONF): an unmeasurable pin bar is UNKNOWN, never 'no pin bar'", () => {
    const strat = COMPILED_STRATEGIES.find((s) => s.setup_id === "SET-STR-RAW-2-803")!;
    const candles = Array.from({ length: 140 }, (_, i) => {
      const base = 100 + Math.sin(i / 7) * 2;
      return { t: 1_700_000_000 + i * 3600, o: base, h: base + 1, l: base - 1, c: base + (i % 2 ? 0.4 : -0.4), v: 10 + i };
    });
    const bagFull = strat.build(candles, "1h");
    const conf = strat.setup().rules.find((r) => r.id === "R-803-CONF")!;
    // control: with every feature measurable the rule produces a real verdict
    const control = evaluateRule(conf, bagFull, 1_800_000_000_000);
    expect(["PASS", "FAIL"]).toContain(control.outcome);
    // corrupt the pin-bar branch only; a measured rejection (false) must NOT be
    // turned into a FAIL of a confirmation whose second branch was never measured
    const touched = bagFull.get("FTR-LEVEL-TOUCH")!.value as { level: PriceLevel } | null;
    const bagCorrupt = strat.build(candles, "1h");
    bagCorrupt.set("FTR-PINBAR", invalidFeature("FTR-PINBAR", "1h", "UNAVAILABLE", "window input corrupt", "1.1.0", ["candles"]));
    bagCorrupt.set("FTR-REJECTION", touched
      ? detectRejectionAt(candles, "1h", touched.level.price, touched.level.kind)
      : okFeature("FTR-REJECTION", "1h", { rejected: false, wick_ratio: 0 }, candles[candles.length - 1].t, candles.length, "1.1.0", ["candles"]));
    const ev = evaluateRule(conf, bagCorrupt, 1_800_000_000_000);
    expect(ev.outcome).toBe("UNKNOWN");
    // either gate may be the one that catches it — the rule-level dependency
    // gate (declared deps) or the per-predicate gate — but the explanation must
    // name the unmeasurable feature, never claim the pin bar was measured absent
    expect(ev.explanation).not.toMatch(/no pin bar/);
    expect(ev.explanation).toMatch(/required feature\(s\) unavailable|required features unavailable|not decidable/);
    expect(`${ev.explanation} ${ev.missing_features.join(" ")}`).toMatch(/FTR-PINBAR/);
  });

  it("sanity: the detectors referenced above are the real, causal ones", () => {
    const candles = Array.from({ length: 140 }, (_, i) => {
      const base = 100 + Math.sin(i / 7) * 2;
      return { t: 1_700_000_000 + i * 3600, o: base, h: base + 1, l: base - 1, c: base + (i % 2 ? 0.4 : -0.4), v: 10 + i };
    });
    expect(detectPinbar(candles, "1h").valid).toBe(true);
    const touch = detectLevelTouch(candles, "1h", [{ price: 100, kind: "support", touches: 5, close_density: 1, first_index: 0, last_index: 10 } as unknown as PriceLevel], 2);
    expect(touch.valid).toBe(true);
  });
});
