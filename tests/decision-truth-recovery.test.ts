/**
 * TEAM 01 / Task 04 — Decision → Opportunity → Risk → Signal → Scanner →
 * Outbox → API truth recovery.
 *
 * Each case pins a verified pre-fix defect:
 *   1. missing risk coerced to a MEASURED block / admission "block"
 *   2. unavailable daily PnL / open book coerced to 0 / []
 *   3. live psychology ignored the human journal (consecutive losses = 0)
 *   4. published advisories never counted toward portfolio concurrency
 *   5. expireStaleSignals used 60min updated_ms, expiring a fresh 1d signal
 *   6. overlapping scans of different bars joined the older in-flight scan
 *   7. chart evidence could render under a mismatched symbol/timeframe
 *   8. GET /api/opportunities presented freshness READY as if admitted
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-t04-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");

import { admitOpportunity } from "../src/lib/brain/score";
import { evaluatePortfolio } from "../src/lib/risk/portfolio";
import { buildRiskPolicies, buildPsychologyPolicies } from "../src/lib/brain/policies";
import { evaluatePsychologyGate } from "../src/lib/psychology/gate";
import { psychologyStateFromJournal, advisoryOpenRisks } from "../src/lib/pipeline/live-gates";
import { scoreFromEvaluation } from "../src/lib/pipeline/scoring";
import { chartEvidenceMatches, type ChartEvidence } from "../src/lib/chart/evidence";
import { opportunityFreshness } from "../src/lib/pipeline/freshness";
import { liveScanFlightKey } from "../src/lib/pipeline/live-scan";
import type { JournalRow, SignalRow } from "../src/db/repo";
import type { OpportunityPayload } from "../src/lib/pipeline/orchestrator";

const POLICY = buildRiskPolicies().find((p) => p.policy_id === "RISK-ASA-CONSERVATIVE-DEFAULT")!;

function perfectAdmit(over: Record<string, unknown> = {}) {
  return admitOpportunity({
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
  } as never);
}

describe("admission — unavailable is not pass and not a silent block-shaped lie", () => {
  it("missing risk is UNAVAILABLE and cannot be admitted", () => {
    const r = perfectAdmit({ risk_verdict: "unavailable" });
    expect(r.admitted).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/UNAVAILABLE/);
    expect(r.reasons.join(" ")).not.toMatch(/risk engine BLOCK/);
  });

  it("derived market truth cannot be admitted as native", () => {
    const r = perfectAdmit({ derived_market_truth: true });
    expect(r.admitted).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/derived series/);
  });

  it("an explicit risk BLOCK remains distinguishable from UNAVAILABLE", () => {
    const blocked = perfectAdmit({ risk_verdict: "block" });
    const missing = perfectAdmit({ risk_verdict: "unavailable" });
    expect(blocked.reasons.join(" ")).toMatch(/BLOCK/);
    expect(missing.reasons.join(" ")).toMatch(/UNAVAILABLE/);
    expect(blocked.reasons).not.toEqual(missing.reasons);
  });
});

describe("score — unevaluated risk is UNKNOWN, not a measured block", () => {
  const ev = {
    setup: { stages: [], passed_rules: [], failed_rules: [], unknown_rules: [], blocked_rules: [] },
    rr: 2,
    levels: { entry: null, stop: null, targets: [], invalidation: null, level_assumptions: [] },
    symbol: "BTCUSDT",
    timeframe: "1h",
    direction: "long" as const,
    strategy_id: "S",
    setup_id: "SET",
    bar_time: 1,
  };
  it("riskEvaluated=false yields achieved null / UNKNOWN, not MEASURED 0", () => {
    const s = scoreFromEvaluation(ev as never, {
      riskPass: false,
      riskEvaluated: false,
      psychReady: true,
      psychPenalty: 0,
      bars: 200,
      stale: false,
      contradictions: [],
    });
    const q = s.breakdown.find((c) => c.key === "risk_quality")!;
    expect(q.achieved).toBeNull();
    expect(q.evidence_kind).toBe("UNKNOWN");
    expect(s.unknown_factors.join(" ")).toMatch(/risk engine not evaluated/i);
  });
});

describe("portfolio — null measurements are not zero", () => {
  it("null daily_realized_loss does not exhaust the daily budget", () => {
    const r = evaluatePortfolio({
      equity: 10_000,
      policy: POLICY,
      open_risks: [],
      daily_realized_loss: null,
      period_realized_loss: null,
      candidate: { symbol: "BTCUSDT", risk_amount: 100, direction: "long" },
    });
    expect(r.verdict).toBe("pass");
    expect(r.numbers.daily_loss_used_pct).toBeNull();
    expect(r.unenforced.join(" ")).toMatch(/daily realized loss UNAVAILABLE/);
    expect(r.reasons.join(" ")).not.toMatch(/daily loss limit reached/);
  });

  it("measured daily loss of 0 is still a real zero (limit not reached)", () => {
    const r = evaluatePortfolio({
      equity: 10_000,
      policy: POLICY,
      open_risks: [],
      daily_realized_loss: 0,
      period_realized_loss: 0,
      candidate: { symbol: "BTCUSDT", risk_amount: 100, direction: "long" },
    });
    expect(r.verdict).toBe("pass");
    expect(r.numbers.daily_loss_used_pct).toBe(0);
    expect(r.unenforced.join(" ")).not.toMatch(/daily realized loss UNAVAILABLE/);
  });

  it("null open book does not pass concurrency as if holding 0 positions", () => {
    const r = evaluatePortfolio({
      equity: 10_000,
      policy: POLICY,
      open_risks: null,
      daily_realized_loss: 0,
      period_realized_loss: 0,
      candidate: { symbol: "BTCUSDT", risk_amount: 100, direction: "long" },
    });
    expect(r.numbers.concurrent_positions).toBeNull();
    expect(r.numbers.open_risk_total).toBeNull();
    expect(r.unenforced.join(" ")).toMatch(/open advisory book UNAVAILABLE/);
  });

  it("a measured book at the concurrency cap still blocks", () => {
    const r = evaluatePortfolio({
      equity: 10_000,
      policy: POLICY,
      open_risks: Array.from({ length: 5 }, (_, i) => ({ symbol: `S${i}USDT`, risk_amount: 50, direction: "long" as const })),
      daily_realized_loss: 0,
      period_realized_loss: 0,
      candidate: { symbol: "BTCUSDT", risk_amount: 50, direction: "long" },
    });
    expect(r.verdict).toBe("block");
    expect(r.reasons.join(" ")).toMatch(/concurrency limit/);
  });

  it("null candidate notional is not treated as 0 risk", () => {
    const r = evaluatePortfolio({
      equity: 10_000,
      policy: POLICY,
      open_risks: [],
      daily_realized_loss: 0,
      period_realized_loss: 0,
      candidate: { symbol: "BTCUSDT", risk_amount: null, direction: "long" },
    });
    expect(r.unenforced.join(" ")).toMatch(/candidate risk_amount UNAVAILABLE/);
  });
});

describe("psychology — journaled losses are measured, not defaulted to 0", () => {
  it("three consecutive negative R-multiples produce a revenge BLOCK", () => {
    const now = Date.now();
    const journal: JournalRow[] = [3, 2, 1].map((n) => ({
      id: n, created_ms: now - n * 60_000, updated_ms: now, symbol: "BTCUSDT",
      direction: "long", notes: "", opp_id: null, r_multiple: -1,
    }));
    const st = psychologyStateFromJournal(journal, now, { daily_loss_limit_pct: 5 });
    expect(st.consecutive_losses).toBe(3);
    expect(st.minutes_since_last_loss).not.toBeNull();
    const gate = evaluatePsychologyGate(buildPsychologyPolicies(), st);
    expect(gate.verdict).toBe("block");
    expect(gate.blocks.some((b) => b.policy_id === "PSY-REVENGE")).toBe(true);
  });

  it("a missing R-multiple breaks the streak rather than counting as a win or a loss", () => {
    const now = Date.now();
    const journal: JournalRow[] = [
      { id: 1, created_ms: now, updated_ms: now, symbol: "BTCUSDT", direction: "long", notes: "", opp_id: null, r_multiple: null },
      { id: 2, created_ms: now - 1, updated_ms: now, symbol: "BTCUSDT", direction: "long", notes: "", opp_id: null, r_multiple: -1 },
    ];
    const st = psychologyStateFromJournal(journal, now, { daily_loss_limit_pct: 5 });
    expect(st.consecutive_losses).toBe(0);
  });
});

describe("advisory open book — published signals are measured exposure", () => {
  it("excludes expired / terminal / self rows and keeps symbol identity", () => {
    const now = Date.now();
    const mk = (over: Partial<SignalRow> & { id: string; symbol: string }): SignalRow => ({
      state: "published", timeframe: "1h", direction: "long", score: 90, strategy_id: "S",
      opp_id: over.id, payload_json: JSON.stringify({ anchor_close_ms: now - 60_000, timeframe: "1h", risk: { numbers: { risk_notional: 100 } } }),
      created_ms: now, updated_ms: now, outbox_id: 1, ...over,
    });
    const rows: SignalRow[] = [
      mk({ id: "sig-a", symbol: "BTCUSDT", opp_id: "a" }),
      mk({ id: "sig-b", symbol: "ETHUSDT", opp_id: "b", direction: "short" }),
      mk({ id: "sig-old", symbol: "SOLUSDT", opp_id: "old", payload_json: JSON.stringify({ anchor_close_ms: now - 10 * 3_600_000, timeframe: "1h" }) }),
      mk({ id: "sig-dead", symbol: "XRPUSDT", opp_id: "dead", state: "expired" }),
    ];
    const book = advisoryOpenRisks(rows, now, "a");
    expect(book.map((r) => r.symbol).sort()).toEqual(["ETHUSDT"]);
    expect(book[0].direction).toBe("short");
    expect(book.some((r) => r.symbol === "BTCUSDT")).toBe(false); // self excluded
    expect(book.some((r) => r.symbol === "SOLUSDT")).toBe(false); // stale anchor
    expect(book.some((r) => r.symbol === "XRPUSDT")).toBe(false); // terminal
  });
});

describe("chart evidence identity", () => {
  const ev: ChartEvidence = {
    symbol: "BTCUSDT", timeframe: "1h", strategy_id: "S", setup_id: "SET",
    direction: "long", bar_time: 1, annotations: [], rules: [], score: 90,
    score_semantics: "s", assumptions: [], lineage_complete: true,
  };
  it("rejects cross-symbol and cross-timeframe reuse", () => {
    expect(chartEvidenceMatches(ev, { symbol: "BTCUSDT", timeframe: "1h", direction: "long" })).toBe(true);
    expect(chartEvidenceMatches(ev, { symbol: "ETHUSDT", timeframe: "1h" })).toBe(false);
    expect(chartEvidenceMatches(ev, { symbol: "BTCUSDT", timeframe: "15m" })).toBe(false);
    expect(chartEvidenceMatches(ev, { symbol: "BTCUSDT", timeframe: "1h", direction: "short" })).toBe(false);
  });
});

describe("freshness vs retrieval time", () => {
  const T0 = 1_788_000_000_000;
  it("a 1d anchor 2h later is still READY (4-bar window), never 60min-expired", () => {
    expect(opportunityFreshness(T0, T0 + 2 * 3_600_000, "1d").state).toBe("READY");
  });
  it("a 1h anchor 5h later is EXPIRED", () => {
    expect(opportunityFreshness(T0, T0 + 5 * 3_600_000, "1h").state).toBe("EXPIRED");
  });
});

describe("persistence / API — sqlite-backed", () => {
  let repo: import("../src/db/repo").Repo;
  let closeRepo: () => void;
  let expireStaleSignals: (maxAgeMs?: number, r?: import("../src/db/repo").Repo) => number;
  let publishSignal: (o: OpportunityPayload) => { id: string; published: boolean; reason: string };
  let idFor: (symbol: string, tf: string, direction: string, strategyId: string, anchorSec: number) => string;
  let loadLiveGateContext: typeof import("../src/lib/pipeline/live-gates").loadLiveGateContext;
  let getOpportunities: (req: Request) => Promise<Response>;
  let getSignal: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

  beforeAll(async () => {
    const sqlite = await import("../src/db/sqlite");
    repo = sqlite.getRepo();
    closeRepo = sqlite.closeRepo;
    const orch = await import("../src/lib/pipeline/orchestrator");
    expireStaleSignals = orch.expireStaleSignals as typeof expireStaleSignals;
    publishSignal = orch.publishSignal;
    idFor = orch.idFor;
    loadLiveGateContext = (await import("../src/lib/pipeline/live-gates")).loadLiveGateContext;
    getOpportunities = (await import("../src/app/api/opportunities/route")).GET as typeof getOpportunities;
    getSignal = (await import("../src/app/api/signals/[id]/route")).GET as typeof getSignal;
  });
  afterAll(() => {
    closeRepo();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  function opp(over: Partial<OpportunityPayload> = {}): OpportunityPayload {
    const id = over.id ?? `opp-${Math.random().toString(16).slice(2)}`;
    return {
      id, symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 90, setup: "s", thesis: "t",
      entry_zone: null, invalidation: null, stop: null, targets: [], rr: null, strategy_id: "STR-T04",
      mode: "live", state: "READY", anchor_ts_ms: Date.now(), anchor_close_ms: Date.now(), freshness_ms: 0,
      evidence: [], contradictions: [], score_breakdown: null, positive_factors: [], negative_factors: [],
      blocked_factors: [], unknown_factors: [], source_refs: [],
      data_quality: { bars: 200, stale: false, age_ms: 0, state: "FRESH" },
      psychology: null, portfolio: null, setup_id: "SET-T04", score_semantics: "s", chart_evidence: null,
      risk: { verdict: "pass", reasons: ["ok"], numbers: { risk_notional: 100 } }, ai: null,
      provenance: { generated_at_ms: Date.now(), data: { series_fetched_ms: Date.now(), stats_fetched_ms: null, native_1d: true, candles: { macro: null, context: null, trigger: 200 } } },
      ...over,
    };
  }

  it("expireStaleSignals (production path) keeps a 1d signal whose anchor is 2h old", () => {
    const now = Date.now();
    const o = opp({ id: "opp-1d", timeframe: "1d", symbol: "BTCUSDT", anchor_close_ms: now - 2 * 3_600_000 });
    const pub = publishSignal(o);
    expect(pub.published).toBe(true);
    const n = expireStaleSignals(undefined, repo);
    const row = repo.signalByOpp("opp-1d")!;
    expect(row.state).toBe("published");
    expect(n).toBe(0);
  });

  it("expireStaleSignals (production path) expires a 1h signal whose anchor is 5h old — not because updated_ms is old", () => {
    const now = Date.now();
    const o = opp({
      id: "opp-1h-old", timeframe: "1h", symbol: "ETHUSDT",
      anchor_close_ms: now - 5 * 3_600_000,
    });
    expect(publishSignal(o).published).toBe(true);
    repo.signalUpdate({ id: "sig-opp-1h-old", updated_ms: now }); // recent write must NOT keep it alive
    const n = expireStaleSignals(undefined, repo);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(repo.signalByOpp("opp-1h-old")!.state).toBe("expired");
  });

  it("loadLiveGateContext never reports daily PnL as 0 when the journal only has R-multiples", () => {
    repo.journalAdd({
      created_ms: Date.now(), updated_ms: Date.now(), symbol: "BTCUSDT", direction: "long",
      notes: "loss", opp_id: null, r_multiple: -1.5,
    });
    const ctx = loadLiveGateContext(repo, Date.now(), { daily_loss_limit_pct: 5 });
    expect(ctx.daily_realized_loss).toBeNull();
    expect(ctx.period_realized_loss).toBeNull();
    expect(ctx.psychology.consecutive_losses).toBeGreaterThanOrEqual(1);
    expect(ctx.daily_loss_reason).toMatch(/UNAVAILABLE/);
  });

  it("GET /api/opportunities does not mark a REJECTED row actionable just because the anchor is fresh", async () => {
    const now = Date.now();
    repo.opportunityUpsert({
      id: "rej-1", symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 90,
      state: "REJECTED", mode: "live", strategy_id: "STR-T04",
      payload_json: JSON.stringify({
        state: "REJECTED", anchor_close_ms: now - 60_000, blocked_factors: ["risk engine BLOCK"],
      }),
      created_ms: now, updated_ms: now,
    });
    const res = await getOpportunities(new Request("http://asa.local/api/opportunities?limit=50"));
    const body = await res.json() as { items: Array<{ id: string; state: string; fresh: string; actionable: boolean }> };
    const row = body.items.find((i) => i.id === "rej-1")!;
    expect(row.state).toBe("REJECTED");
    expect(row.fresh).toBe("READY");
    expect(row.actionable).toBe(false);
  });

  it("GET /api/signals/{id} returns live delivery provenance and 404s unknowns", async () => {
    const o = opp({ id: "opp-api", symbol: "BNBUSDT" });
    expect(publishSignal(o).published).toBe(true);
    const ok = await getSignal(new Request("http://asa.local/api/signals/sig-opp-api"), { params: Promise.resolve({ id: "sig-opp-api" }) });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { ok: boolean; item: { delivery: { delivery_state: string }; state: string } };
    expect(body.ok).toBe(true);
    expect(body.item.state).toBe("published");
    expect(body.item.delivery.delivery_state).toBe("QUEUED");
    const miss = await getSignal(new Request("http://asa.local/api/signals/nope"), { params: Promise.resolve({ id: "nope" }) });
    expect(miss.status).toBe(404);
    const missBody = await miss.json() as { ok: boolean };
    expect(missBody.ok).toBe(false);
  });

  it("idFor is deterministic across restarts (same event → same opportunity id)", () => {
    const a = idFor("BTCUSDT", "1h", "long", "SET-X", 1_700_000_000);
    const b = idFor("BTCUSDT", "1h", "long", "SET-X", 1_700_000_000);
    const c = idFor("ETHUSDT", "1h", "long", "SET-X", 1_700_000_000);
    const d = idFor("BTCUSDT", "15m", "long", "SET-X", 1_700_000_000);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});

describe("live scanner — different bars do not join an in-flight scan", () => {
  it("flight key includes close time so bar B is not coalesced into bar A", async () => {
    const { liveScanFlightKey } = await import("../src/lib/pipeline/live-scan");
    const a = liveScanFlightKey("BTCUSDT", "SET-1", 1_000);
    const a2 = liveScanFlightKey("BTCUSDT", "SET-1", 1_000);
    const b = liveScanFlightKey("BTCUSDT", "SET-1", 2_000);
    const eth = liveScanFlightKey("ETHUSDT", "SET-1", 1_000);
    const tf = liveScanFlightKey("BTCUSDT", "SET-2", 1_000);
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
    expect(a).not.toBe(eth);
    expect(a).not.toBe(tf);
  });
});
