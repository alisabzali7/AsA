/**
 * Team 02 absolute-final: HARMONIC ABCD correctness, proven INDEPENDENTLY of
 * regression equality (regression proves "unchanged", not "right").
 *
 * Piecewise-linear price paths with hand-placed pivots; every expected number
 * below is hand arithmetic, not a snapshot of detector output.
 * Also proves the CD-slope proxy is labelled (never a fake slope_cd).
 */
import { describe, expect, it } from "vitest";
import type { Candle } from "../src/lib/domain/types";
import { detectABCD } from "../src/lib/features/detectors";
import { COMPILED_STRATEGIES } from "../src/lib/strategy/compiled";
import { buildMachineRuleGraph } from "../src/lib/strategy/rule-graph";

/** vertices [index, price]; linear between them; o=h=l=c (pivots only at vertices) */
function path(vertices: [number, number][]): Candle[] {
  const out: Candle[] = [];
  for (let s = 0; s < vertices.length - 1; s++) {
    const [i0, p0] = vertices[s];
    const [i1, p1] = vertices[s + 1];
    for (let i = i0; i < i1 || (s === vertices.length - 2 && i === i1); i++) {
      const p = p0 + ((p1 - p0) * (i - i0)) / (i1 - i0);
      out.push({ t: 1_700_000_000 + i * 3600, o: p, h: p, l: p, c: p, v: 1 });
    }
  }
  return out;
}

describe("detectABCD: hand-computed values", () => {
  it("bullish shallow: A=100@10, B=120@20, C=110@25 → ab 20, bc 10, 50% (NOT deep: > 50% required), D 130", () => {
    const f = detectABCD(path([[0, 110], [10, 100], [20, 120], [25, 110], [45, 120]]), "1h");
    expect(f.valid).toBe(true);
    const p = f.value!;
    expect(p.direction).toBe("bullish");
    expect([p.a, p.b, p.c]).toEqual([100, 120, 110]);
    expect(p.ab).toBe(20);
    expect(p.cd).toBe(20); // projected (AB = CD construction), not measured
    expect(p.correction_frac).toBe(0.5);
    expect(p.deep_correction).toBe(false);
    expect(p.slope_ab).toBe(2); // 20 / 10 bars
    expect(p.slope_bc).toBe(2); // 10 / 5 bars
    expect(p.slope_cd).toBeNull(); // CD has not formed at C — never a stand-in
    expect(p.d_projected).toBe(130);
  });

  it("bullish deep: C=106@27 → correction 0.7 (deep), slope_bc 14/7 = 2, D 126", () => {
    const p = detectABCD(path([[0, 110], [10, 100], [20, 120], [27, 106], [47, 118]]), "1h").value!;
    expect(p.correction_frac).toBeCloseTo(0.7, 12);
    expect(p.deep_correction).toBe(true);
    expect(p.slope_bc).toBe(2);
    expect(p.d_projected).toBe(126);
  });

  it("bearish mirror: A=200@10, B=180@20, C=190@25 → D 170", () => {
    const p = detectABCD(path([[0, 190], [10, 200], [20, 180], [25, 190], [45, 180]]), "1h").value!;
    expect(p.direction).toBe("bearish");
    expect([p.a, p.b, p.c, p.d_projected]).toEqual([200, 180, 190, 170]);
    expect(p.correction_frac).toBe(0.5);
  });

  it("no lookahead: C is a swing only once CONFIRMED by 2 right bars — exact confirmation instant", () => {
    // 40-bar monotonic lead-in (no pivots), then A=100@40, B=120@50, C=110@55
    const full = path([[0, 150], [40, 100], [50, 120], [55, 110], [75, 120]]);
    const at = (bars: number) => detectABCD(full.slice(0, bars), "1h");
    // bars 0..56: C@55 has ONE right bar → only A, B are swings → no pattern
    expect(at(57).valid).toBe(true);
    expect(at(57).value).toBeNull();
    expect(at(57).reason).toMatch(/fewer than 3 swings/);
    // bars 0..57: C confirmed → the hand pattern, never earlier
    const p = at(58).value!;
    expect([p.a, p.b, p.c, p.d_projected]).toEqual([100, 120, 110, 130]);
    // later bars never revise A/B/C while no new swing forms
    expect([at(70).value!.a, at(70).value!.b, at(70).value!.c]).toEqual([100, 120, 110]);
  });

  it("warmup (< 40 bars) is UNAVAILABLE-by-history, distinct from a computed 'no pattern'", () => {
    const short = detectABCD(path([[0, 110], [10, 100], [20, 120], [25, 110], [30, 112]]), "1h");
    expect(short.valid).toBe(false);
    const flat = detectABCD(path([[0, 100], [60, 100]]), "1h");
    expect(flat.valid).toBe(true);
    expect(flat.value).toBeNull(); // computed: no swings → no pattern (a FAIL input, not UNKNOWN data)
    expect(flat.reason).toMatch(/fewer than 3 swings/);
  });
});

describe("the CD-slope proxy is labelled, never disguised", () => {
  const slopeRules = COMPILED_STRATEGIES.flatMap((s) => s.setup().rules).filter((r) => r.id.endsWith("-SLOPE"));

  it("every ABCD slope rule declares its predicate a PROXY (BC for CD), ENGINEERING_DEFINED", () => {
    expect(slopeRules.length).toBeGreaterThan(0);
    for (const r of slopeRules) {
      expect(r.description).toMatch(/PROXY/);
      for (const p of r.predicates) {
        expect(p.proxy).toEqual(expect.objectContaining({ measured: "FTR-ABCD.slope_bc", stands_for: "FTR-ABCD.slope_cd", classification: "ENGINEERING_DEFINED" }));
        expect(p.expr).toMatch(/slope_bc/);
        expect(p.expr).not.toMatch(/slope_cd/);
      }
    }
  });

  it("the machine rule graph exports the proxy label", () => {
    const g = buildMachineRuleGraph();
    const nodes = g.nodes.filter((n) => n.rule_id.endsWith("-SLOPE"));
    expect(nodes.length).toBe(slopeRules.length);
    for (const n of nodes) expect(n.predicates.every((p) => p.proxy?.classification === "ENGINEERING_DEFINED")).toBe(true);
  });

  it("predicate math on the hand pattern: slope_bc 2 ≤ slope_ab 2 × 1.25 → ok", () => {
    const p = detectABCD(path([[0, 110], [10, 100], [20, 120], [27, 106], [47, 118]]), "1h");
    const bag = new Map([["FTR-ABCD", p]]);
    const r = slopeRules[0];
    const res = r.predicates[0].test(bag as never);
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/proxy/);
  });
});
