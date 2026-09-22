/**
 * COGNITIVE CORE INVARIANT — ONLY PASS SETUPS MAY BE ADMITTED.
 *
 * Regression coverage for the confirmed defect this task closes:
 * the shared admission contract (`admitOpportunity`) had NO setup input, so
 * the brain scanner could produce `admitted === true` while
 * `setup_outcome !== "PASS"` whenever the score/risk/portfolio/psychology/
 * runtime gates happened to permit it (reproduced on the production scanner
 * path: SET-RAW-4-2449, setup FAIL, fresh data, all other gates green).
 *
 * The fix lives at the decision/admission boundary — one authoritative
 * contract in `src/lib/brain/score.ts`:
 *
 *   admitted === true  =>  setup_verdict === PASS
 *   setup ∈ {FAIL, UNKNOWN, BLOCKED}  =>  admitted === false
 *
 * No score penalty, no magic threshold, no rule changes — a hard gate whose
 * rejection reason names the exact verdict, so UNKNOWN stays distinguishable
 * from FAIL and BLOCKED in every explanation.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { admitOpportunity, type AdmissionInput } from "../src/lib/brain/score";
import type { RuleOutcome } from "../src/lib/rules/engine";

/** Otherwise-perfect admission inputs: every non-setup gate green. */
function perfect(over: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    setup_verdict: "PASS",
    score: 95,
    threshold: 85,
    data_quality_ok: true,
    stale: false,
    risk_verdict: "pass",
    portfolio_verdict: "pass",
    psychology_verdict: "pass",
    strategy_runtime_status: "LIVE_ADVISORY_ONLY",
    unresolved_contradiction: false,
    unknown_required_fields: [],
    ...over,
  };
}

describe("admission contract — the setup verdict is a REQUIRED hard gate", () => {
  it("Case A — a PASS setup with otherwise valid inputs can still be admitted", () => {
    const r = admitOpportunity(perfect({ setup_verdict: "PASS" }));
    expect(r.admitted).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("Case B — setup FAIL can never be admitted, even at score 100 with every other gate green", () => {
    const r = admitOpportunity(perfect({
      setup_verdict: "FAIL",
      score: 100, threshold: 0, // maximum adversarial pressure on the score
    }));
    expect(r.admitted).toBe(false);
    expect(r.reasons.join(" ")).toContain("FAIL");
    expect(r.reasons.join(" ")).toContain("only a PASS setup");
    // no other gate was violated — the setup verdict alone rejected it
    expect(r.reasons).toHaveLength(1);
  });

  it("Case C — setup UNKNOWN can never be admitted, and the reason preserves UNKNOWN", () => {
    const r = admitOpportunity(perfect({
      setup_verdict: "UNKNOWN",
      score: 100, threshold: 0,
    }));
    expect(r.admitted).toBe(false);
    const joined = r.reasons.join(" ");
    expect(joined).toContain("UNKNOWN");
    // UNKNOWN is NOT collapsed into a FAIL-shaped explanation
    expect(joined).not.toContain("setup outcome FAIL");
    expect(r.reasons).toHaveLength(1);
  });

  it("Case D — setup BLOCKED can never be admitted, and the reason preserves BLOCKED", () => {
    const r = admitOpportunity(perfect({
      setup_verdict: "BLOCKED",
      score: 100, threshold: 0,
    }));
    expect(r.admitted).toBe(false);
    expect(r.reasons.join(" ")).toContain("BLOCKED");
    expect(r.reasons).toHaveLength(1);
  });

  it("the three rejection explanations are mutually distinct (FAIL ≠ UNKNOWN ≠ BLOCKED)", () => {
    const reasonFor = (v: RuleOutcome) => admitOpportunity(perfect({ setup_verdict: v })).reasons[0];
    const fail = reasonFor("FAIL");
    const unknown = reasonFor("UNKNOWN");
    const blocked = reasonFor("BLOCKED");
    expect(new Set([fail, unknown, blocked]).size).toBe(3);
    expect(fail).toContain("FAIL");
    expect(unknown).toContain("UNKNOWN");
    expect(blocked).toContain("BLOCKED");
  });

  it("adversarial: high score + LIVE_ADVISORY_ONLY never overpowers a non-PASS setup", () => {
    for (const verdict of ["FAIL", "UNKNOWN", "BLOCKED"] as const) {
      const r = admitOpportunity(perfect({
        setup_verdict: verdict,
        score: 100, threshold: 85,
        requires_live_eligibility: true, // runtime status itself is live-eligible
      }));
      expect(r.admitted, verdict).toBe(false);
      expect(r.reasons.join(" "), verdict).toContain(verdict);
    }
  });

  it("the gate is a pure deterministic function of its input (reproducible)", () => {
    const input = perfect({ setup_verdict: "UNKNOWN" });
    const a = admitOpportunity(input);
    const b = admitOpportunity(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("Case E — scanner parity: non-PASS setups never reach ScanResult.admitted", () => {
  const hasReplay = fs.existsSync("tests/fixtures/replay/BTCUSDT-60.json");

  it.runIf(hasReplay)(
    "an evaluated non-PASS candidate is rejected with its setup verdict named — even with fresh data, threshold 0 and a live runtime status",
    async () => {
      const { parseUdfHistory } = await import("../src/lib/ttt/udf");
      const { scanForOpportunities } = await import("../src/lib/pipeline/brain-scanner");
      const { __setOperationalUniverse } = await import("../src/lib/market/operational-universe");
      const { buildPsychologyPolicies, buildRiskPolicies } = await import("../src/lib/brain/policies");
      const { COMPILED_STRATEGY_IDS } = await import("../src/lib/strategy/compiled");

      const POLICY = buildRiskPolicies().find((p) => p.policy_id === "RISK-ASA-CONSERVATIVE-DEFAULT")!;
      const raw = JSON.parse(fs.readFileSync("tests/fixtures/replay/BTCUSDT-60.json", "utf8"));
      const candles = parseUdfHistory(raw, 60).candles;
      __setOperationalUniverse(["BTCUSDT"]);
      try {
        const lastBar = candles[candles.length - 1];
        const r = scanForOpportunities({
          series: new Map([["BTCUSDT", new Map([["1h", candles], ["1d", candles]])]]),
          equity: 10_000,
          riskPolicy: POLICY,
          psychologyPolicies: buildPsychologyPolicies(),
          psychologyState: {
            declared_state: "ok", consecutive_losses: 0, minutes_since_last_loss: null,
            daily_loss_pct: 0, trades_today: 0, max_trades_per_day: 5, cooldown_min: 60,
            checklist_completed: true, security_checklist_completed: true, standards_declared: true,
            unreviewed_closed_trades: 0, distance_from_entry_zone_atr: null, daily_loss_limit_pct: 5,
          },
          empiricalStatus: Object.fromEntries(COMPILED_STRATEGY_IDS.map((id) => [id, "BACKTESTED" as const])),
          // adversarial: every strategy live-eligible, zero score threshold
          runtimeStatus: Object.fromEntries(COMPILED_STRATEGY_IDS.map((id) => [id, "LIVE_ADVISORY_ONLY" as const])),
          scoreThreshold: 0,
          maxStalenessMs: 15 * 60_000,
          now: lastBar.t * 1000 + 60_000, // fresh data at the decision bar
        });

        // the defect: pre-fix this fixture ADMITS SET-STR-RAW-4-2449 (setup FAIL)
        expect(r.admitted.every((c) => c.setup_outcome === "PASS")).toBe(true);

        const nonPass = [...r.admitted, ...r.rejected].filter((c) => c.setup_outcome !== "PASS");
        expect(nonPass.length).toBeGreaterThan(0); // the fixture must exercise the gate
        for (const c of nonPass) {
          expect(c.admitted, `${c.setup_id} setup=${c.setup_outcome}`).toBe(false);
          // the rejection NAMES the setup verdict — the gate fired, not a coincidence
          expect(c.admission_reasons.join(" ")).toContain(`setup outcome ${c.setup_outcome}`);
        }
      } finally {
        __setOperationalUniverse(null);
      }
    },
  );
});

describe("Case F — orchestrator and scanner obey the SAME setup admission invariant", () => {
  const sourceFiles = (dir = "src"): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(e.name) ? [p] : [];
    });

  it("every production admitOpportunity call site passes the setup verdict", () => {
    const callers = sourceFiles().filter((f) => fs.readFileSync(f, "utf8").includes("admitOpportunity("));
    expect(callers.length).toBeGreaterThanOrEqual(3); // scanner, orchestrator, backtest runner (+ definition)
    for (const f of callers) {
      const src = fs.readFileSync(f, "utf8");
      if (src.includes("export function admitOpportunity")) continue; // the contract itself
      expect(src, `${f} must pass setup_verdict`).toContain("setup_verdict:");
      expect(src, `${f} must source the verdict from the evaluation`).toContain("setup_verdict: ev.setup.outcome");
    }
  });

  it("both pipeline consumers derive admission from the one shared contract", () => {
    const scanner = fs.readFileSync("src/lib/pipeline/brain-scanner.ts", "utf8");
    const orchestrator = fs.readFileSync("src/lib/pipeline/orchestrator.ts", "utf8");
    for (const [name, src] of [["scanner", scanner], ["orchestrator", orchestrator]] as const) {
      expect(src, name).toContain("admitOpportunity({");
      expect(src, name).toContain("setup_verdict: ev.setup.outcome");
      // no caller re-implements its own setup admission logic
      expect(src, name).not.toMatch(/setup_outcome\s*===?\s*["']PASS["']/);
    }
    // the orchestrator keeps its explicit defense-in-depth early return
    expect(orchestrator).toContain('if (ev.setup.outcome !== "PASS")');
  });

  it("the contract itself hard-codes the PASS requirement (not a caller convention)", () => {
    const score = fs.readFileSync("src/lib/brain/score.ts", "utf8");
    expect(score).toContain('a.setup_verdict !== "PASS"');
    expect(score).toMatch(/setup_verdict: RuleOutcome/); // required by type, not optional
  });
});
