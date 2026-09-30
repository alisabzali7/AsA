/**
 * BACKEND_FREEZE.md must describe the code that actually ships.
 *
 * `BACKEND_FREEZE.md` is the frozen backend contract other documents, reports
 * and reviewers quote. Its "Counts (authoritative)" line used to claim
 * **7 executable setups**, while `src/lib/strategy/runtime.ts` has resolved
 * every compiled setup to `RESEARCH_ONLY` for as long as the source contracts
 * have been `INCOMPLETE`. A frozen document that overstates executability is
 * exactly the kind of divergence that turns "advisory, source-blocked" into a
 * reader's "seven runnable strategies".
 *
 * These tests derive the counts from the runtime registry and assert the
 * document states those same numbers, so the two can never drift again.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { listRuntimeStrategies, type RuntimeAvailability } from "../src/lib/strategy/runtime";

const FREEZE_PATH = path.join(process.cwd(), "BACKEND_FREEZE.md");
const freeze = fs.readFileSync(FREEZE_PATH, "utf8");

function availabilityCounts(): Record<RuntimeAvailability, number> {
  const counts: Record<RuntimeAvailability, number> = {
    EXECUTABLE: 0, RESEARCH_ONLY: 0, NON_COMPUTABLE: 0, DISABLED: 0,
  };
  for (const strategy of listRuntimeStrategies()) counts[strategy.availability] += 1;
  return counts;
}

/** Read `<LABEL> setups **N**` out of the authoritative counts paragraph. */
function statedSetupCount(label: string): number | null {
  const match = new RegExp(`${label} setups \\*\\*(\\d+)\\*\\*`).exec(freeze);
  return match ? Number(match[1]) : null;
}

describe("BACKEND_FREEZE.md authoritative counts match the runtime registry", () => {
  const counts = availabilityCounts();
  const total = listRuntimeStrategies().length;

  it("states the compiled setup total", () => {
    expect(new RegExp(`setups \\*\\*${total}\\*\\*`).test(freeze)).toBe(true);
  });

  it("states the distinct runtime strategy total", () => {
    const distinct = new Set(listRuntimeStrategies().map((s) => s.strategy_id)).size;
    expect(new RegExp(`runtime strategies \\*\\*${distinct}\\*\\*`).test(freeze)).toBe(true);
  });

  it.each(["EXECUTABLE", "RESEARCH_ONLY", "NON_COMPUTABLE", "DISABLED"] as RuntimeAvailability[])(
    "states the real %s setup count",
    (availability) => {
      expect(statedSetupCount(availability)).toBe(counts[availability]);
    },
  );

  it("does not claim any executable setup while every source contract is INCOMPLETE", () => {
    // This is the substantive invariant, independent of the document wording:
    // EXECUTABLE requires SOURCE_FAITHFUL, and nothing may shortcut that.
    for (const strategy of listRuntimeStrategies()) {
      if (strategy.availability === "EXECUTABLE") {
        expect(strategy.source_contract_status).toBe("SOURCE_FAITHFUL");
      } else {
        expect(strategy.source_contract_blockers.length).toBeGreaterThan(0);
      }
    }
  });

  it("records why the previously documented count was wrong", () => {
    expect(freeze).toMatch(/Corrected 2026-09-30/);
    expect(freeze).toMatch(/source-faithful and/i);
  });
});
