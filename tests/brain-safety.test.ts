/**
 * Safety + semantics regression tests required by the master prompt.
 *
 * These guard the invariants that make AsA safe to run: no execution surface,
 * exact 48-symbol universe, TONUSDT permanently excluded, score never called a
 * probability, risk determinism, psychology hard blocks, and portfolio gating.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { UNIVERSE, isUniverseSymbol } from "../src/lib/domain/universe";
import { evaluatePortfolio } from "../src/lib/risk/portfolio";
import { evaluatePsychologyGate, defaultPsychologyState } from "../src/lib/psychology/gate";
import { buildPsychologyPolicies, buildRiskPolicies } from "../src/lib/brain/policies";
import { computeScore, admitOpportunity, SCORE_DISCLAIMER } from "../src/lib/brain/score";

/** Walk the whole source tree once so scans are cheap. */
function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = sourceFiles();

describe("market universe", () => {
  it("is exactly 48 symbols", () => {
    expect(UNIVERSE).toHaveLength(48);
    expect(new Set(UNIVERSE).size).toBe(48);
  });

  it("excludes TONUSDT completely", () => {
    expect(UNIVERSE).not.toContain("TONUSDT");
    expect(isUniverseSymbol("TONUSDT")).toBe(false);
  });

  it("contains no TONUSDT reference in any tradable source path", () => {
    const offenders = FILES.filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      // allow explicit exclusion documentation, reject actual usage
      return /TONUSDT/.test(src) && !/exclud|never|not in|TONUSDT is/i.test(src);
    });
    expect(offenders).toEqual([]);
  });
});

describe("no execution capability exists", () => {
  // Precise needles: "/order" alone would match the read-only "/orderbook"
  // market-data endpoint, which is legitimately used.
  const FORBIDDEN = [
    "/futures/order", "placeOrder", "cancelOrder", "closePosition", "createOrder",
    "/positions/close", "setLeverage", "/transfer", "/withdraw", "modifyPosition",
  ];

  it("no source file calls an execution endpoint", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      // the central safety assertion enumerates forbidden verbs in order to
      // DETECT them; scanning it would be self-referential
      if (f.includes("safety/no-execution")) continue;
      const src = fs.readFileSync(f, "utf8");
      for (const needle of FORBIDDEN) {
        if (!src.includes(needle)) continue;
        // permit mentions inside comments/strings that document the prohibition
        const lines = src.split("\n").filter((l) => l.includes(needle));
        const real = lines.filter(
          (l) => !/never|not implement|forbidden|refus|prohibit|no order|\*|\/\//i.test(l),
        );
        if (real.length) hits.push(`${f}: ${real[0].trim().slice(0, 100)}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the TTT transport refuses non-safe HTTP methods", () => {
    const http = fs.readFileSync("src/lib/ttt/http.ts", "utf8");
    expect(http).toMatch(/method !== "GET" && method !== "HEAD"/);
    expect(http).toMatch(/unsafe method/);
  });
});

describe("score is not a probability", () => {
  it("the canonical disclaimer says so explicitly", () => {
    expect(SCORE_DISCLAIMER).toMatch(/NOT a probability/i);
  });

  it("every score result carries the disclaimer", () => {
    const r = computeScore({ components: { technical_confluence: { achieved: 1, reason: "x", evidence_kind: "MEASURED" } } });
    expect(r.disclaimer).toBe(SCORE_DISCLAIMER);
  });

  it("no source file describes a score as a percentage likelihood", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      // score.ts defines the disclaimer itself ("NOT a probability"), so scan
      // line-by-line and ignore lines that are explicitly denying the framing.
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        if (/not a probability|never a probability|is not a probability/i.test(line)) continue;
        if (/(\d+%\s*(likely|probability|chance))|score.*probability of winning/i.test(line)) {
          bad.push(`${f}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("reports unknown components instead of silently scoring them zero-weight", () => {
    const r = computeScore({
      components: {
        technical_confluence: { achieved: 1, reason: "all aligned", evidence_kind: "MEASURED" },
        market_regime: { achieved: null, reason: "regime undetermined", evidence_kind: "UNKNOWN" },
      },
    });
    expect(r.unknown_factors.length).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(r.max_possible);
    // normalized over evaluable weight only
    expect(r.score_of_evaluable).toBeGreaterThan(0);
  });
});

describe("opportunity admission gates", () => {
  const base = {
    setup_verdict: "PASS" as const,
    score: 90, threshold: 85, data_quality_ok: true, stale: false,
    risk_verdict: "pass" as const, portfolio_verdict: "pass" as const,
    psychology_verdict: "pass" as const, strategy_runtime_status: "LIVE_ADVISORY_ONLY",
    unresolved_contradiction: false, unknown_required_fields: [] as string[],
  };

  it("admits only when every gate passes", () => {
    expect(admitOpportunity(base).admitted).toBe(true);
  });

  it("stale data can never produce an opportunity", () => {
    const r = admitOpportunity({ ...base, stale: true });
    expect(r.admitted).toBe(false);
    expect(r.reasons.join(" ")).toContain("stale");
  });

  it("a DISABLED strategy can never produce an opportunity even at score 100", () => {
    const r = admitOpportunity({ ...base, score: 100, strategy_runtime_status: "DISABLED" });
    expect(r.admitted).toBe(false);
    expect(r.reasons.join(" ")).toContain("DISABLED");
  });

  it("risk or psychology blocks veto a high score", () => {
    expect(admitOpportunity({ ...base, risk_verdict: "block" }).admitted).toBe(false);
    expect(admitOpportunity({ ...base, psychology_verdict: "block" }).admitted).toBe(false);
    expect(admitOpportunity({ ...base, portfolio_verdict: "block" }).admitted).toBe(false);
  });

  it("unknown required fields veto admission", () => {
    const r = admitOpportunity({ ...base, unknown_required_fields: ["stop"] });
    expect(r.admitted).toBe(false);
    expect(r.reasons.join(" ")).toContain("stop");
  });

  it("every rejection is explainable", () => {
    const r = admitOpportunity({ ...base, score: 10, stale: true, risk_verdict: "block" });
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
    for (const reason of r.reasons) expect(reason.length).toBeGreaterThan(5);
  });
});

describe("portfolio risk engine", () => {
  const policy = buildRiskPolicies().find((p) => p.policy_id === "RISK-ASA-CONSERVATIVE-DEFAULT")!;

  it("blocks when the daily loss limit is already reached", () => {
    const r = evaluatePortfolio({
      equity: 10_000, policy, open_risks: [],
      daily_realized_loss: 500, // 5% of 10k == the limit
      period_realized_loss: 0,
      candidate: { symbol: "BTCUSDT", risk_amount: 100, direction: "long" },
    });
    expect(r.verdict).toBe("block");
    expect(r.reasons.join(" ")).toContain("daily loss limit reached");
  });

  it("blocks when portfolio heat would exceed the account ceiling", () => {
    const r = evaluatePortfolio({
      equity: 10_000, policy,
      open_risks: Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}USDT`, risk_amount: 100, direction: "long" as const })),
      daily_realized_loss: 0, period_realized_loss: 0,
      candidate: { symbol: "BTCUSDT", risk_amount: 300, direction: "long" },
    });
    expect(r.verdict).toBe("block");
    expect(r.reasons.join(" ")).toContain("portfolio heat");
  });

  it("blocks an opposing position in the same symbol", () => {
    const r = evaluatePortfolio({
      equity: 10_000, policy,
      open_risks: [{ symbol: "BTCUSDT", risk_amount: 50, direction: "short" }],
      daily_realized_loss: 0, period_realized_loss: 0,
      candidate: { symbol: "BTCUSDT", risk_amount: 50, direction: "long" },
    });
    expect(r.verdict).toBe("block");
    expect(r.reasons.join(" ")).toContain("opposing");
  });

  it("passes a compliant trade and shows the arithmetic", () => {
    const r = evaluatePortfolio({
      equity: 10_000, policy, open_risks: [],
      daily_realized_loss: 0, period_realized_loss: 0,
      candidate: { symbol: "BTCUSDT", risk_amount: 100, direction: "long" },
    });
    expect(r.verdict).toBe("pass");
    expect(r.lines.length).toBeGreaterThan(4);
    expect(r.numbers.heat_after_candidate_pct).toBe(1);
  });

  it("never invents a limit the policy does not state — it reports it unenforced", () => {
    const sparse = { ...policy, daily_loss_limit_pct: null, max_account_risk_pct: null, max_concurrent_positions: null };
    const r = evaluatePortfolio({
      equity: 10_000, policy: sparse, open_risks: [],
      daily_realized_loss: 9_000, period_realized_loss: 0,
      candidate: { symbol: "BTCUSDT", risk_amount: 100, direction: "long" },
    });
    // huge loss but no stated limit -> not blocked, and explicitly declared
    expect(r.verdict).toBe("pass");
    expect(r.unenforced.join(" ")).toContain("daily_loss_limit_pct not specified");
  });

  it("is deterministic for identical input", () => {
    const mk = () => evaluatePortfolio({
      equity: 10_000, policy, open_risks: [{ symbol: "ETHUSDT", risk_amount: 100, direction: "long" }],
      daily_realized_loss: 100, period_realized_loss: 200,
      candidate: { symbol: "BTCUSDT", risk_amount: 100, direction: "long" },
    });
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
  });
});

describe("psychology hard blocks", () => {
  const policies = buildPsychologyPolicies();

  it("blocks revenge trading after consecutive losses inside the cooldown", () => {
    const r = evaluatePsychologyGate(policies, {
      ...defaultPsychologyState(), consecutive_losses: 3, minutes_since_last_loss: 5, cooldown_min: 60,
    });
    expect(r.verdict).toBe("block");
    expect(r.blocks.some((b) => b.policy_id === "PSY-REVENGE")).toBe(true);
  });

  it("blocks on a user-declared unfit state without diagnosing anything", () => {
    const r = evaluatePsychologyGate(policies, { ...defaultPsychologyState(), declared_state: "tilted" });
    expect(r.verdict).toBe("block");
    const block = r.blocks.find((b) => b.policy_id === "PSY-EMOTIONAL-STATE")!;
    expect(block.reason).toContain("does not diagnose");
  });

  it("reports an unevaluated guard rather than pretending it passed", () => {
    const r = evaluatePsychologyGate(policies, { ...defaultPsychologyState(), daily_loss_limit_pct: null });
    const skipped = r.not_evaluated.find((n) => n.policy_id === "PSY-DAILY-LOSS")!;
    expect(skipped.reason).toContain("guard inactive, not satisfied");
  });

  it("applies score penalties for chasing rather than blocking", () => {
    const r = evaluatePsychologyGate(policies, {
      ...defaultPsychologyState(), declared_state: "ok", distance_from_entry_zone_atr: 3,
    });
    expect(r.score_penalty).toBeGreaterThan(0);
    expect(r.penalties.some((p) => p.policy_id === "PSY-CHASE")).toBe(true);
    expect(r.blocks.some((b) => b.policy_id === "PSY-CHASE")).toBe(false);
  });

  it("blocks when the daily loss limit is hit", () => {
    const r = evaluatePsychologyGate(policies, {
      ...defaultPsychologyState(), declared_state: "ok", daily_loss_pct: 5, daily_loss_limit_pct: 5,
    });
    expect(r.blocks.some((b) => b.policy_id === "PSY-DAILY-LOSS")).toBe(true);
  });
});
