/**
 * Opportunity scanner + permanent no-execution invariant (Phase 2 §21, §22).
 *
 * The no-execution test is intentionally strict and runs on every CI pass: it
 * scans the whole source tree for execution verbs and asserts the transport
 * physically refuses unsafe HTTP methods.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Candle } from "../src/lib/domain/types";
import { parseUdfHistory } from "../src/lib/ttt/udf";
import { scanForOpportunities } from "../src/lib/pipeline/brain-scanner";
import { buildPsychologyPolicies, buildRiskPolicies } from "../src/lib/brain/policies";
import { tttRequest } from "../src/lib/ttt/http";
import { COMPILED_STRATEGY_IDS } from "../src/lib/strategy/compiled";

const POLICY = buildRiskPolicies().find((p) => p.policy_id === "RISK-ASA-CONSERVATIVE-DEFAULT")!;
const PSYCH = buildPsychologyPolicies();
const hasReplay = fs.existsSync("tests/fixtures/replay/BTCUSDT-60.json");

function load(file: string, tfMin: number): Candle[] {
  const j = JSON.parse(fs.readFileSync(`tests/fixtures/replay/${file}`, "utf8"));
  return parseUdfHistory(j, tfMin).candles;
}

function baseInput(series: Map<string, Map<string, Candle[]>>, over: Record<string, unknown> = {}) {
  return {
    series,
    equity: 10_000,
    riskPolicy: POLICY,
    psychologyPolicies: PSYCH,
    psychologyState: {
      declared_state: "ok" as const, consecutive_losses: 0, minutes_since_last_loss: null,
      daily_loss_pct: 0, trades_today: 0, max_trades_per_day: 5, cooldown_min: 60,
      checklist_completed: true, security_checklist_completed: true, standards_declared: true,
      unreviewed_closed_trades: 0, distance_from_entry_zone_atr: null, daily_loss_limit_pct: 5,
    },
    empiricalStatus: Object.fromEntries(COMPILED_STRATEGY_IDS.map((id) => [id, "BACKTESTED" as const])),
    runtimeStatus: Object.fromEntries(COMPILED_STRATEGY_IDS.map((id) => [id, "CANDIDATE"])),
    scoreThreshold: 85,
    maxStalenessMs: 15 * 60_000,
    now: Date.now(),
    ...over,
  };
}

describe.runIf(hasReplay)("opportunity scanner", () => {
  const candles = () => load("BTCUSDT-60.json", 60);
  const series = () => new Map([["BTCUSDT", new Map([["1h", candles()], ["1d", candles()]])]]);

  it("evaluates candidates and explains every rejection", () => {
    const r = scanForOpportunities(baseInput(series()));
    expect(r.evaluated_candidates).toBeGreaterThan(0);
    for (const c of [...r.admitted, ...r.rejected]) {
      expect(c.admission_reasons.length + (c.admitted ? 1 : 0)).toBeGreaterThan(0);
      if (!c.admitted) expect(c.admission_reasons.length).toBeGreaterThan(0);
      expect(c.score).not.toBeNull();
      expect(c.score!.disclaimer).toContain("NOT a probability");
    }
  });

  it("refuses symbols outside the operational TTT universe", () => {
    const s = new Map([["TONUSDT", new Map([["1h", candles()]])]]);
    const r = scanForOpportunities(baseInput(s));
    expect(r.admitted).toEqual([]);
    expect(r.evaluated_candidates).toBe(0);
    expect(r.skipped[0].reason).toContain("operational TTT universe");
  });

  it("stale data blocks admission", () => {
    const r = scanForOpportunities(baseInput(series(), { now: Date.now() + 90 * 24 * 3600_000 }));
    expect(r.admitted).toEqual([]);
    const anyStale = r.rejected.some((c) => c.admission_reasons.join(" ").includes("stale"));
    expect(anyStale).toBe(true);
  });

  it("a DISABLED strategy can never be admitted", () => {
    const r = scanForOpportunities(baseInput(series(), {
      runtimeStatus: Object.fromEntries(COMPILED_STRATEGY_IDS.map((id) => [id, "DISABLED"])),
      scoreThreshold: 0,
    }));
    expect(r.admitted).toEqual([]);
    expect(r.rejected.some((c) => c.admission_reasons.join(" ").includes("DISABLED"))).toBe(true);
  });

  it("a psychology hard block vetoes admission even at threshold 0", () => {
    const r = scanForOpportunities(baseInput(series(), {
      scoreThreshold: 0,
      psychologyState: {
        declared_state: "tilted" as const, consecutive_losses: 0, minutes_since_last_loss: null,
        daily_loss_pct: 0, trades_today: 0, max_trades_per_day: 5, cooldown_min: 60,
        checklist_completed: true, security_checklist_completed: true, standards_declared: true,
        unreviewed_closed_trades: 0, distance_from_entry_zone_atr: null, daily_loss_limit_pct: 5,
      },
    }));
    expect(r.admitted).toEqual([]);
    expect(r.rejected.some((c) => c.psychology?.verdict === "block")).toBe(true);
  });

  it("insufficient bars are skipped before any detector runs", () => {
    const s = new Map([["BTCUSDT", new Map([["1h", candles().slice(0, 20)]])]]);
    const r = scanForOpportunities(baseInput(s));
    expect(r.evaluated_candidates).toBe(0);
    expect(r.skipped.some((x) => x.reason.includes("needs"))).toBe(true);
  });

  it("score breakdown accounts for every component", () => {
    const r = scanForOpportunities(baseInput(series(), { scoreThreshold: 0 }));
    const c = [...r.admitted, ...r.rejected][0];
    expect(c.score!.breakdown.length).toBe(9);
    const declared = c.score!.breakdown.reduce((a, b) => a + b.weight, 0);
    expect(declared).toBe(100);
  });
});

describe("PERMANENT INVARIANT: no execution capability", () => {
  function sourceFiles(dir = "src"): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...sourceFiles(p));
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  // Word-boundary patterns: a simulation variable like `openPositions` in the
  // backtest engine is NOT an execution call, so the needle must be precise.
  const EXECUTION_PATTERNS: RegExp[] = [
    /\/futures\/order/, /\bplaceOrder\b/, /\bcreateOrder\b/, /\bcancelOrder\b/,
    /\bclosePosition\b/, /\bmodifyPosition\b/, /\bsetLeverage\b/, /\baddMargin\b/,
    /\/transfer\b/, /\/withdraw\b/, /\bsubmitOrder\b/, /\bopenPosition\s*\(/,
  ];

  it("no source file performs an execution call", () => {
    const hits: string[] = [];
    for (const f of sourceFiles()) {
      // the central safety assertion enumerates forbidden verbs to detect them
      if (f.includes("safety/no-execution")) continue;
      const src = fs.readFileSync(f, "utf8");
      for (const pat of EXECUTION_PATTERNS) {
        if (!pat.test(src)) continue;
        for (const line of src.split("\n")) {
          if (!pat.test(line)) continue;
          // documentation of the prohibition is allowed; a real call is not
          if (/never|not implement|forbidden|refus|prohibit|no order|\*|\/\/|expect\(|EXECUTION_PATTERNS/i.test(line)) continue;
          hits.push(`${f}: ${line.trim().slice(0, 100)}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("the TTT transport rejects every unsafe HTTP method at runtime", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(
        tttRequest("/futures/markets/stats", { method: method as never, retries: 0 }),
      ).rejects.toThrow(/unsafe method/i);
    }
  });

  it("the transport only permits GET and HEAD in its type surface", () => {
    const src = fs.readFileSync("src/lib/ttt/http.ts", "utf8");
    expect(src).toMatch(/export type HttpMethod = "GET" \| "HEAD"/);
  });

  it("no compiled strategy exposes an execution hook", () => {
    const src = fs.readFileSync("src/lib/strategy/compiled/index.ts", "utf8");
    expect(src).not.toMatch(/execute|placeOrder|submit/i);
  });
});
