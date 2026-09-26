/**
 * Team 02 — every `detector` reference in the primitive registry must resolve
 * to a real exported function. Pre-recovery 8 references pointed at modules or
 * symbols that do not exist (analysis/candles, analysis/fib, analysis/regime,
 * indicators:macd, indicators:momentum, structure:range …), which made
 * unimplemented primitives look implemented.
 */
import { describe, it, expect } from "vitest";
import { buildPrimitives } from "../src/lib/brain/primitives";

const MODULES: Record<string, () => Promise<Record<string, unknown>>> = {
  "analysis/structure": () => import("../src/lib/analysis/structure"),
  "analysis/indicators": () => import("../src/lib/analysis/indicators"),
  "analysis/momentum": () => import("../src/lib/analysis/momentum"),
  "analysis/divergence": () => import("../src/lib/analysis/divergence"),
  "features/detectors": () => import("../src/lib/features/detectors"),
  "ttt/client": () => import("../src/lib/ttt/client"),
};

describe("primitive registry detector references", () => {
  it("each non-null detector is `module:export` and the export exists", async () => {
    const bad: string[] = [];
    for (const p of buildPrimitives()) {
      if (p.detector === null) continue;
      const [mod, sym] = p.detector.split(":");
      const load = MODULES[mod];
      if (!load) { bad.push(`${p.primitive_id}: unknown module ${mod}`); continue; }
      const m = await load();
      const direct = m[sym];
      // ttt/client exports a client object whose methods are the detectors
      const viaClient = (m.tttClient as Record<string, unknown> | undefined)?.[sym];
      if (typeof direct !== "function" && typeof viaClient !== "function") bad.push(`${p.primitive_id}: ${p.detector} not found`);
    }
    expect(bad).toEqual([]);
  });

  it("unimplemented primitives stay null (MACD, Ichimoku, range-region, harmonic, rejection block)", () => {
    const byId = new Map(buildPrimitives().map((p) => [p.primitive_id, p]));
    for (const id of ["PRM-MACD", "PRM-ICHIMOKU", "PRM-RANGE", "PRM-HARMONIC", "PRM-RB"]) expect(byId.get(id)!.detector).toBeNull();
  });
});
