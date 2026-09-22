/**
 * OPPORTUNITY FRESHNESS — the READY/EXPIRED boundary must be measured in
 * bars of the OPPORTUNITY'S OWN TIMEFRAME, never a hardcoded 15-minute bar.
 *
 * The defect (Task 3): `opportunityFreshness` implemented the documented
 * "anchor older than 4 bars -> EXPIRED" rule as `4 * 15 * 60_000` — four
 * 15-minute bars — while `scanSymbol` anchors every opportunity on the
 * strategy's OWN timeframe close ("Each strategy declares its OWN timeframe —
 * never hard-coded to 15m"). The compiled production set includes a 1d
 * strategy (STR-RAW-2-581) and five 1h strategies, and admission staleness is
 * already parameterized (`tfStalenessMs(tf)` = 2 bars of that tf). Result: a
 * 1d opportunity of age 2h is admission-fresh (budget 48h) and persisted
 * READY, yet GET /api/opportunities reported fresh=EXPIRED after 60 minutes —
 * a stronger NO than the contract permits.
 *
 * Invariant pinned here:
 *   fresh(age, now, tf) is READY  ⇔  age ≤ 4 bars(tf)
 * with `tfBarMs` derived from the SAME timeframe table as `tfStalenessMs`
 * (one authority, no second table), and 15m semantics byte-identical to the
 * previous behavior (no threshold change for the legacy trigger).
 *
 * ISOLATION: store paths are set BEFORE the orchestrator module is imported
 * (same pattern as tests/conflict-resolution.test.ts).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-freshness-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
delete process.env.ASA_API_TOKEN;

type Orch = typeof import("../src/lib/pipeline/orchestrator");
let ORCH: Orch;

const T0 = 1_788_000_000_000; // deterministic anchor close time
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeAll(async () => {
  ORCH = await import("../src/lib/pipeline/orchestrator");
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("freshness is measured in bars of the opportunity's own timeframe", () => {
  it("a 1d opportunity inside its 4-bar window stays READY (age 2h)", () => {
    // 2h age: admission-fresh for 1d (tfStalenessMs budget = 48h), and well
    // inside 4 bars of 1d (96h). The hardcoded 60-minute window wrongly
    // reported EXPIRED.
    const out = ORCH.opportunityFreshness(T0, T0 + 2 * HOUR, "1d");
    expect(out.state).toBe("READY");
    expect(out.age_ms).toBe(2 * HOUR);
  });

  it("a 1h opportunity inside its 4-bar window stays READY (age 90min)", () => {
    // 90min: admission-fresh for 1h (budget = 2h) and inside 4 bars of 1h (4h).
    // The hardcoded 60-minute window wrongly reported EXPIRED.
    const out = ORCH.opportunityFreshness(T0, T0 + 90 * MIN, "1h");
    expect(out.state).toBe("READY");
    expect(out.age_ms).toBe(90 * MIN);
  });

  it("a 1h opportunity older than 4 bars is EXPIRED (age 5h)", () => {
    // Adversarial half of the fix: parameterizing must NOT become permissive.
    // 5h > 4 bars of 1h → still EXPIRED, even for a maximally good
    // opportunity (freshness takes only anchor/now/tf — score cannot enter).
    const out = ORCH.opportunityFreshness(T0, T0 + 5 * HOUR, "1h");
    expect(out.state).toBe("EXPIRED");
    expect(out.age_ms).toBe(5 * HOUR);
  });

  it("legacy 15m window is unchanged: 59min READY, 61min EXPIRED", () => {
    // Threshold preservation: for the historical 15m trigger the window must
    // remain exactly 4 * 15m = 60 minutes, byte-identical to pre-fix behavior.
    expect(ORCH.opportunityFreshness(T0, T0 + 59 * MIN, "15m").state).toBe("READY");
    expect(ORCH.opportunityFreshness(T0, T0 + 61 * MIN, "15m").state).toBe("EXPIRED");
    // boundary itself: age == window stays READY (age <= 4 bars)
    expect(ORCH.opportunityFreshness(T0, T0 + 60 * MIN, "15m").state).toBe("READY");
  });

  it("an unknown timeframe falls back to the same 15m bar as tfStalenessMs", () => {
    // One authority: the unknown-tf fallback must match admission's table.
    expect(ORCH.opportunityFreshness(T0, T0 + 59 * MIN, "weird-tf").state).toBe("READY");
    expect(ORCH.opportunityFreshness(T0, T0 + 61 * MIN, "weird-tf").state).toBe("EXPIRED");
  });

  it("a null anchor is always EXPIRED", () => {
    expect(ORCH.opportunityFreshness(null, T0, "1d")).toEqual({
      state: "EXPIRED",
      age_ms: null,
    });
    expect(ORCH.opportunityFreshness(null, T0, "15m").state).toBe("EXPIRED");
  });
});

describe("determinism — identical inputs produce identical machine state", () => {
  it("same (anchor, now, tf) twice → identical state and age_ms", () => {
    const a = ORCH.opportunityFreshness(T0, T0 + 90 * MIN, "1h");
    const b = ORCH.opportunityFreshness(T0, T0 + 90 * MIN, "1h");
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const c = ORCH.opportunityFreshness(T0, T0 + 5 * HOUR, "1d");
    const d = ORCH.opportunityFreshness(T0, T0 + 5 * HOUR, "1d");
    expect(JSON.stringify(d)).toBe(JSON.stringify(c));
  });
});

describe("admission staleness contract is untouched (tfStalenessMs)", () => {
  it("keeps exactly 2 bars of each timeframe with the 15m unknown fallback", () => {
    expect(ORCH.tfStalenessMs("15m")).toBe(2 * 15 * MIN);
    expect(ORCH.tfStalenessMs("1h")).toBe(2 * HOUR);
    expect(ORCH.tfStalenessMs("1d")).toBe(48 * HOUR);
    expect(ORCH.tfStalenessMs("unknown-tf")).toBe(2 * 15 * MIN);
  });
});
