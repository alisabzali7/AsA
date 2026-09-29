/**
 * Opportunity display contract — the truth rules behind the OPPORTUNITIES
 * surface, in one pure module so the rules are testable.
 *
 * Regression anchor: the dossier used to derive its verdict from
 * `risk.verdict === "pass"`, which painted a REJECTED opportunity READY. A
 * risk-engine PASS is ONE gate — the admission state, the portfolio/account
 * boundary and the psychology gate are independent, and any of them can refuse.
 * These tests pin the rule: the displayed verdict is ALWAYS the stored
 * admission `state`, downgraded by a terminal signal state, never derived from
 * `risk.verdict`.
 */
import { describe, expect, it } from "vitest";
import {
  opportunityBlockers,
  opportunityDisplayState,
  opportunityEngineVerdict,
  opportunityGates,
  opportunityScoreText,
  opportunityScoreSemantics,
  SCORE_NOT_PROBABILITY,
  opportunityVerdictTone,
  type OpportunityRecord,
} from "../src/components/opportunity-view";

const base: OpportunityRecord = {
  id: "opp-1",
  symbol: "BTCUSDT",
  timeframe: "15m",
  direction: "long",
  score: 71,
  state: "READY",
  actionable: true,
  fresh: "LIVE",
};

describe("opportunityDisplayState", () => {
  it("keeps the stored admission state for a READY opportunity", () => {
    expect(opportunityDisplayState(base)).toBe("READY");
  });

  it("keeps REJECTED as REJECTED even when the risk engine passed", () => {
    // the exact shape that produced the fabricated verdict
    const rejected = { ...base, state: "REJECTED", actionable: false, risk: { verdict: "pass", reasons: [] } };
    expect(opportunityDisplayState(rejected)).toBe("REJECTED");
    expect(opportunityVerdictTone(rejected)).toBe("block");
  });

  it("downgrades to a terminal signal state, never upgrades", () => {
    const invalidated = { ...base, signal_state: "invalidated" };
    expect(opportunityDisplayState(invalidated)).toBe("INVALIDATED");
    const published = { ...base, signal_state: "published" };
    expect(opportunityDisplayState(published)).toBe("READY");
  });

  it("never renders an undefined state as READY", () => {
    const unknown = { ...base, state: undefined, actionable: undefined } as unknown as OpportunityRecord;
    expect(opportunityDisplayState(unknown)).toBe("UNAVAILABLE");
  });
});

describe("opportunityEngineVerdict", () => {
  it("reports the admission state, not the engine verdict", () => {
    expect(opportunityEngineVerdict({ ...base, state: "REJECTED", risk: { verdict: "pass", reasons: [] } })).toBe("REJECTED");
  });
});

describe("opportunityGates", () => {
  it("lists every independent boundary, each with its own verdict", () => {
    const gates = opportunityGates({
      ...base,
      state: "REJECTED",
      actionable: false,
      risk: { verdict: "pass", reasons: [] },
      portfolio: { verdict: "block", reasons: ["equity below configured floor"] },
      psychology: { state: "BLOCKED", hard_blocks: ["tilt guard"] },
      data_quality: { state: "DEGRADED" },
    });
    const keys = gates.map((g) => g.key);
    expect(keys).toEqual(["risk", "portfolio", "psychology", "data"]);
    expect(gates.find((g) => g.key === "risk")?.verdict).toBe("PASS");
    expect(gates.find((g) => g.key === "portfolio")?.verdict).toBe("BLOCKED");
    expect(gates.find((g) => g.key === "psychology")?.verdict).toBe("BLOCKED");
    expect(gates.find((g) => g.key === "data")?.verdict).toBe("DEGRADED");
  });

  it("reports an absent gate as UNAVAILABLE, never as a pass", () => {
    const gates = opportunityGates({ ...base });
    expect(gates.every((g) => g.verdict === "UNAVAILABLE")).toBe(true);
  });
});

describe("opportunityBlockers", () => {
  it("names the blocking gate instead of a generic rejection", () => {
    const blockers = opportunityBlockers({
      ...base,
      state: "REJECTED",
      actionable: false,
      portfolio: { verdict: "block", reasons: ["equity below configured floor"] },
    });
    expect(blockers.join(" ")).toContain("portfolio boundary BLOCK");
  });

  it("has nothing to report for an actionable opportunity", () => {
    expect(opportunityBlockers(base)).toEqual([]);
  });
});

describe("score rendering", () => {
  it("never substitutes 0 for a missing score", () => {
    expect(opportunityScoreText(null)).toBe("—");
    expect(opportunityScoreText(undefined)).toBe("—");
    expect(opportunityScoreText(71)).toBe("71");
  });
  it("uses the server's own score semantics when it sends them", () => {
    expect(opportunityScoreSemantics({ ...base, score_semantics: "composite of 6 measured factors" }))
      .toBe("composite of 6 measured factors");
    expect(opportunityScoreSemantics(base)).toBe(SCORE_NOT_PROBABILITY);
  });
});
