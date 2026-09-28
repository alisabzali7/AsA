/**
 * TEAM 05 — Task 4: live signal orchestration, end-to-end integration and
 * delivery provenance.
 *
 * Finding pinned here: before T4, `scanSymbol` / `publishSignal` had NO
 * production caller (the engine only ran `expireStaleSignals` + the outbox
 * drain). The runtime trigger is now the EXISTING `candle.closed` event
 * (emitted by the candle manager when the engine's close-refresh observes a
 * new closed bar), attached by `startLiveSignalScanner()` in `MarketEngine.start`.
 *
 * Canonical path exercised with REAL repository abstractions:
 *   candle.closed → runLiveScan → scanSymbol (real evaluateRuntime / risk /
 *   portfolio / psychology / score / admission) → publishSignal (final risk
 *   boundary, exactly-once) → telegram_outbox → deliverOutboxRow (real
 *   claim/lease + sub-step progress; Telegram HTTP stubbed at global fetch)
 *
 * The only upstream seam replaced is the empirical PROMOTION gate for ONE
 * synthetic strategy id (`STR-T4-LIVE` → LIVE_ADVISORY_ONLY) — no shipped
 * strategy is live-eligible, and live admission legitimately requires it. A
 * second synthetic id (`STR-T4-UNPROMOTED`) goes through the REAL gate and is
 * refused, proving the gate is still authoritative on this path.
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi, type MockInstance } from "vitest";
import fs from "node:fs";
import { syntheticMarket } from "./fixtures/publication-opportunity";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-live-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "123456789";
process.env.TELEGRAM_DRY_RUN = "0"; // real send mode — the HTTP transport is stubbed

const syntheticRuntimes = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/lib/strategy/runtime", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/strategy/runtime")>();
  return {
    ...mod,
    getRuntimeStrategy: (id: string) => syntheticRuntimes.get(id) as ReturnType<typeof mod.getRuntimeStrategy> ?? mod.getRuntimeStrategy(id),
  };
});

vi.mock("../src/lib/backtest/promotion", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/backtest/promotion")>();
  return {
    ...mod,
    promotedRuntimeStatus: (id: string) => (id === "STR-T4-LIVE" ? "LIVE_ADVISORY_ONLY" : mod.promotedRuntimeStatus(id)),
  };
});

vi.mock("../src/lib/risk/policy", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/risk/policy")>();
  const source = mod.selectableRiskPolicies().find((policy) => policy.policy_id === "RISK-DAILY-5PCT")!;
  const testOnlyPolicy = {
    ...source,
    selection_status: "SELECTED" as const,
    selected_by: "operator_pref" as const,
    selection_reason: "TEST ONLY: production source-completeness gate bypassed for scanner lifecycle coverage",
    policy_version: mod.RISK_POLICY_VERSION,
    source_completeness: mod.riskPolicyEligibility(source).source_completeness,
  };
  return { ...mod, getProductionRiskPolicy: () => testOnlyPolicy };
});

// The publication lifecycle needs one active psychology policy so it can
// exercise the real gate while isolating delivery. This synthetic, complete
// test source is not RAW_4 and cannot affect production eligibility.
vi.mock("../src/lib/brain/corpus-manifest", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/brain/corpus-manifest")>();
  return {
    ...mod,
    sourceCompletenessFor: (fileId: string) => fileId === "TEST-LIVE-PSYCHOLOGY" ? "COMPLETE" : mod.sourceCompletenessFor(fileId),
  };
});
vi.mock("../src/lib/brain/policies", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/brain/policies")>();
  return {
    ...mod,
    buildPsychologyPolicies: () => [{
      policy_id: "PSY-DAILY-LOSS",
      canonical_name: "Test-only daily loss stop",
      description: "TEST ONLY synthetic policy for publication lifecycle coverage",
      effect: "BLOCK" as const,
      score_penalty: 0,
      trigger_condition: "daily_loss_pct >= risk_policy.daily_loss_limit_pct",
      source_refs: [{ file: "TEST-LIVE-PSYCHOLOGY", start_line: 1, end_line: 1, quote: "test-only fixture" }],
      source_status: "SOURCE_VERIFIED" as const,
      runtime_status: "LIVE_ADVISORY_ONLY" as const,
      user_overridable: false,
    }],
  };
});

// Test-only measured context keeps this integration test focused on the
// publication transaction. Production has no account-currency PnL source and
// therefore remains UNKNOWN unless the real gate context can establish it.
vi.mock("../src/lib/pipeline/live-gates", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/pipeline/live-gates")>();
  return {
    ...mod,
    loadLiveGateContext: (_repo: unknown, _nowMs: number, opts: { daily_loss_limit_pct: number | null }) => ({
      psychology: {
        declared_state: "ok" as const,
        journal_coverage: "COMPLETE" as const,
        consecutive_losses: 0,
        minutes_since_last_loss: 60,
        daily_loss_pct: 0,
        trades_today: 0,
        max_trades_per_day: null,
        cooldown_min: null,
        checklist_completed: true,
        security_checklist_completed: true,
        standards_declared: true,
        unreviewed_closed_trades: 0,
        distance_from_entry_zone_atr: 0,
        daily_loss_limit_pct: opts.daily_loss_limit_pct,
      },
      open_risks: [],
      daily_realized_loss: 0,
      period_realized_loss: 0,
      daily_loss_reason: "test fixture provides an explicit measurement",
      open_book_reason: "test fixture provides an explicit empty measured book",
    }),
  };
});

type Repo = import("../src/db/repo").Repo;
type OutboxRow = import("../src/db/repo").OutboxRow;
type CandleSeries = import("../src/lib/domain/types").CandleSeries;
type Candle = import("../src/lib/domain/types").Candle;
type StrategyRuntimeDefinition = import("../src/lib/strategy/runtime").StrategyRuntimeDefinition;
type RuleDefinition = import("../src/lib/rules/engine").RuleDefinition;
type LiveScan = typeof import("../src/lib/pipeline/live-scan");
type Provenance = typeof import("../src/lib/pipeline/provenance");
type Telegram = typeof import("../src/lib/notify/telegram");
type Events = typeof import("../src/lib/events");
type Rules = typeof import("../src/lib/rules/engine");
type Features = typeof import("../src/lib/features/types");
type CandleManager = typeof import("../src/lib/market/candles").candleManager;

let repo: Repo;
let closeRepo: () => void;
let live: LiveScan;
let prov: Provenance;
let tg: Telegram;
let eventBus: Events["eventBus"];
let MapFeatureBag: Rules["MapFeatureBag"];
let okFeature: Features["okFeature"];
let ensureSeriesSpy: MockInstance<CandleManager["ensureSeries"]>;

let photoCalls = 0;
let textCalls = 0;
let photoResults: boolean[] = [];
let textResults: boolean[] = [];
type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let origFetch: FetchImpl;

const H = 3600;
/** last CLOSED hourly bar open time (seconds) — fresh for a 1h strategy (2-bar staleness) */
function lastClosedHourSec(): number {
  return Math.floor(Date.now() / 1000 / H) * H - H;
}

function series(symbol: string, lastClose = 100): CandleSeries {
  const end = lastClosedHourSec();
  const candles: Candle[] = Array.from({ length: 200 }, (_, i) => {
    const t = end - (199 - i) * H;
    const base = lastClose + ((i % 5) - 2) * 0.2;
    return { t, o: base, h: base + 0.5, l: base - 0.5, c: i === 199 ? lastClose : base, v: 10 };
  });
  return { symbol, timeframe: "1h", candles, native: true, source: "ttt", fetched_at_ms: Date.now(), closed_count: candles.length } as CandleSeries;
}

const SRC = [{ file: "t4.txt", start_line: 1, end_line: 1, text: "test rule" }];

function rule(id: string, kind: RuleDefinition["kind"]): RuleDefinition {
  return {
    id, description: id, source_text: "t", source_refs: SRC as never, source_status: "SOURCE_VERIFIED",
    empirical_status: "UNTESTED", feature_dependencies: ["FTR-T4"], operator: "AND", timeframe: "1h",
    direction: "long", kind, unresolved: [], version: "1.0.0",
    predicates: [{ expr: "FTR-T4 > 0", requires: ["FTR-T4"], test: () => ({ ok: true, detail: "ok" }) }],
  };
}

/**
 * Synthetic EXECUTABLE 1h long strategy. `levelsMode` decides the decision:
 *  - "pass" : entry=close, stop 2% below, target 6% above (R:R 3) → risk PASS
 *  - "block": stop ABOVE entry for a long → the REAL risk engine BLOCKs
 */
function strategy(strategyId: string, setupId: string, levelsMode: "pass" | "block"): StrategyRuntimeDefinition {
  const setupDef = {
    setup_id: setupId, strategy_id: strategyId, name: `T4 ${setupId}`, direction: "long" as const, timeframe: "1h",
    source_refs: SRC as never, version: "1.0.0",
    rules: [rule(`${setupId}-CTX`, "context"), rule(`${setupId}-LOC`, "location"), rule(`${setupId}-STR`, "structure"),
      rule(`${setupId}-TRG`, "trigger"), rule(`${setupId}-CONF`, "confirmation")],
  };
  const definition: StrategyRuntimeDefinition = {
    strategy_id: strategyId, setup_id: setupId, name: `T4 ${setupId}`, family: "test", direction: "long", timeframe: "1h",
    min_bars: 120, availability: "EXECUTABLE", blocked_reason: null,
    source_contract_status: "SOURCE_FAITHFUL", source_contract_blockers: [], strategy_version: "1.0.0", version: "1.0.0",
    rule_ids: setupDef.rules.map((r) => r.id), rule_versions: [...new Set(setupDef.rules.map((r) => r.version))], source_refs: SRC as never,
    impl: {
      strategy_id: strategyId, setup_id: setupId, name: `T4 ${setupId}`, family: "test", direction: "long", timeframe: "1h", min_bars: 120,
      build: (c, tf) => MapFeatureBag.from([["FTR-T4", okFeature("FTR-T4", tf, 1, c[c.length - 1]?.t ?? 0, c.length, "1.0.0", ["candles"])]]),
      setup: () => setupDef,
      levels: (c) => {
        const px = c[c.length - 1].c;
        return levelsMode === "pass"
          ? { entry: px, stop: px * 0.98, targets: [px * 1.06], invalidation: px * 0.97, level_assumptions: ["test levels"] }
          : { entry: px, stop: px * 1.02, targets: [px * 1.06], invalidation: px * 0.97, level_assumptions: ["test levels (stop on wrong side)"] };
      },
    },
  };
  syntheticRuntimes.set(setupId, definition);
  return definition;
}

const LIVE_OK = () => strategy("STR-T4-LIVE", "SET-T4-LIVE", "pass");
const LIVE_RISK_BLOCK = () => strategy("STR-T4-LIVE", "SET-T4-RISKBLOCK", "block");
const UNPROMOTED = () => strategy("STR-T4-UNPROMOTED", "SET-T4-UNPROMOTED", "pass");

function outboxRowsFor(oppId: string): OutboxRow[] {
  return repo.outboxList("ALL", 500).filter((r) => r.kind === "signal")
    .filter((r) => (JSON.parse(r.payload_json) as { opportunity_id?: string }).opportunity_id === oppId);
}

beforeAll(async () => {
  origFetch = globalThis.fetch as FetchImpl;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/sendPhoto")) {
      photoCalls += 1;
      const ok = photoResults.length > 0 ? photoResults.shift()! : true;
      return new Response(JSON.stringify({ ok, result: ok ? { message_id: 1000 + photoCalls } : undefined }), { status: ok ? 200 : 502, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/sendMessage")) {
      textCalls += 1;
      const ok = textResults.length > 0 ? textResults.shift()! : true;
      return new Response(JSON.stringify({ ok, result: ok ? { message_id: 2000 + textCalls } : undefined }), { status: ok ? 200 : 502, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: false, description: `unexpected URL in test: ${url}` }), { status: 500 });
  }) as FetchImpl;

  const sqlite = await import("../src/db/sqlite");
  repo = sqlite.getRepo();
  closeRepo = sqlite.closeRepo;
  live = await import("../src/lib/pipeline/live-scan");
  prov = await import("../src/lib/pipeline/provenance");
  tg = await import("../src/lib/notify/telegram");
  eventBus = (await import("../src/lib/events")).eventBus;
  MapFeatureBag = (await import("../src/lib/rules/engine")).MapFeatureBag;
  okFeature = (await import("../src/lib/features/types")).okFeature;
  const candles = await import("../src/lib/market/candles");
  // authoritative market state seam: the series a candle.closed event refers to
  const store = (await import("../src/lib/market/store")).sharedStore;
  const universe = await import("../src/lib/market/operational-universe");
  ensureSeriesSpy = vi.spyOn(candles.candleManager, "ensureSeries").mockImplementation(async (symbol: string) => { store.catalog.set(symbol, syntheticMarket(symbol)); universe.__setOperationalUniverse([...store.catalog.keys()]); return series(symbol); });
});

afterAll(() => {
  live.stopLiveSignalScanner();
  vi.restoreAllMocks();
  globalThis.fetch = origFetch as typeof globalThis.fetch;
  closeRepo();
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  photoCalls = 0; textCalls = 0; photoResults = []; textResults = [];
  live.resetLiveScanDedupe();
  // Select explicit source-backed test risk inputs; production does not choose a default.
  repo.configSet("pref.risk.policyId", "RISK-DAILY-5PCT");
  repo.configSet("pref.risk.equity", "10000");
  repo.configSet("pref.risk.perTradePct", "1");
  repo.configSet("pref.risk.maxLeverage", "5");
  // Isolate each case from the advisory open book of previous cases. Concurrency
  // / heat of still-published signals is covered in decision-truth-recovery.
  for (const s of repo.signalList(500)) {
    if (s.state === "published" || s.state === "qualified") repo.signalUpdate({ id: s.id, state: "expired" });
  }
});

describe("T05 T4 runtime path: candle.closed → scanSymbol → publishSignal → outbox", () => {
  it("Case 1 — a legitimate live decision is published with full provenance (decision → signal → outbox)", async () => {
    const before = eventBus.recent(300).length;
    const [r] = await live.runLiveScan("BTCUSDT", "1h", "manual", { strategies: [LIVE_OK()] });
    expect(r.outcome, r.reason ?? "").toBe("published");
    expect(r.opportunity_id).toBeTruthy();
    expect(r.signal_id).toBe(`sig-${r.opportunity_id}`);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);

    // opportunity → decision (READY, explicit risk PASS from the real engine)
    const opp = repo.opportunityGet(r.opportunity_id!)!;
    expect(opp.state).toBe("READY");
    const decision = JSON.parse(opp.payload_json) as { risk: { verdict: string }; mode: string; timeframe: string };
    expect(decision.risk.verdict).toBe("pass");
    expect(decision.mode).toBe("live");
    expect(decision.timeframe).toBe("1h");

    // signal → outbox linkage written in the SAME publication act
    const sig = repo.signalByOpp(r.opportunity_id!)!;
    expect(sig.id).toBe(r.signal_id);
    expect(sig.state).toBe("published");
    expect(sig.outbox_id).not.toBeNull();
    const rows = outboxRowsFor(r.opportunity_id!);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(sig.outbox_id);
    expect(rows[0].state).toBe("QUEUED");
    const payload = JSON.parse(rows[0].payload_json) as Record<string, unknown>;
    expect(payload.advisory_only).toBe(true);
    expect(payload.opportunity_id).toBe(r.opportunity_id);

    // delivery view answers "which outbox item / is it queued / when published"
    const d = prov.signalDelivery(repo, sig);
    expect(d.link).toBe("outbox_id");
    expect(d.delivery_state).toBe("QUEUED");
    expect(d.attempts).toBe(0);
    expect(d.sent_ms).toBeNull();
    expect(d.queued_ms).toBe(rows[0].created_ms);

    // observability: one scan.completed with the honest outcome
    const evs = eventBus.recent(300).slice(before).filter((e) => e.type === "scan.completed");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ symbol: "BTCUSDT", timeframe: "1h", setup_id: "SET-T4-LIVE", trigger: "manual", outcome: "published" });
    expect(live.liveScanState().published_total).toBeGreaterThanOrEqual(1);
  });

  it("Case 2 — a risk-BLOCKED decision reaches the runtime boundary and yields NO TRADE: no signal, no outbox row", async () => {
    const [r] = await live.runLiveScan("ETHUSDT", "1h", "manual", { strategies: [LIVE_RISK_BLOCK()] });
    expect(r.outcome).toBe("not_ready");
    expect(r.reason).toMatch(/REJECTED/);
    expect(r.reason).toMatch(/risk engine BLOCK/);
    expect(r.signal_id).toBeNull();
    const opp = repo.opportunityGet(r.opportunity_id!)!;
    expect(opp.state).toBe("REJECTED");
    expect((JSON.parse(opp.payload_json) as { risk: { verdict: string } }).risk.verdict).toBe("block");
    expect(repo.signalByOpp(r.opportunity_id!)).toBeNull();
    expect(outboxRowsFor(r.opportunity_id!)).toHaveLength(0);
  });

  it("Case 2b — a strategy the REAL promotion gate has not promoted is never published live", async () => {
    const [r] = await live.runLiveScan("ETHUSDT", "1h", "manual", { strategies: [UNPROMOTED()] });
    expect(r.outcome).toBe("not_ready");
    expect(r.reason).toMatch(/promotion gate reports/);
    expect(repo.signalByOpp(r.opportunity_id!)).toBeNull();
    expect(outboxRowsFor(r.opportunity_id!)).toHaveLength(0);
  });

  it("Case 2c — publishSignal is the FINAL boundary: a READY decision whose risk was tampered to block is refused (no outbox row)", async () => {
    const orch = await import("../src/lib/pipeline/orchestrator");
    const [r] = await live.runLiveScan("SOLUSDT", "1h", "manual", { strategies: [LIVE_OK()] });
    expect(r.outcome).toBe("published");
    const opp = JSON.parse(repo.opportunityGet(r.opportunity_id!)!.payload_json) as import("../src/lib/pipeline/orchestrator").OpportunityPayload;
    // simulate a forged/blocked decision presented to the publication boundary for a NEW opportunity id
    const forged = { ...opp, id: `${opp.id}-forged`, risk: { verdict: "block", reasons: ["forced"], numbers: {} } };
    const res = orch.publishSignal(forged);
    expect(res.published).toBe(false);
    expect(res.reason).toMatch(/only an explicit PASS may be published/);
    expect(outboxRowsFor(forged.id)).toHaveLength(0);
  });

  it("Case 3 — repeated triggers for the same opportunity produce ONE signal and ONE outbox row", async () => {
    const a = await live.runLiveScan("BNBUSDT", "1h", "manual", { strategies: [LIVE_OK()] });
    const b = await live.runLiveScan("BNBUSDT", "1h", "manual", { strategies: [LIVE_OK()] });
    const c = await live.runLiveScan("BNBUSDT", "1h", "candle.closed", { strategies: [LIVE_OK()], close_time_ms: lastClosedHourSec() * 1000 });
    expect(a[0].outcome).toBe("published");
    expect(b[0].outcome).toBe("already_published");
    expect(c[0].outcome).toBe("already_published");
    expect(new Set([a[0].opportunity_id, b[0].opportunity_id, c[0].opportunity_id]).size).toBe(1);
    expect(repo.outboxList("ALL", 500).filter((r) => (JSON.parse(r.payload_json) as { symbol?: string }).symbol === "BNBUSDT")).toHaveLength(1);
    expect(repo.signalList(500).filter((s) => s.symbol === "BNBUSDT")).toHaveLength(1);
  });

  it("Case 3b — concurrent scans of one symbol×setup join a single in-flight scan; different symbols run independently", async () => {
    const s = LIVE_OK();
    const [x, y, z] = await Promise.all([
      live.runLiveScanFor("XRPUSDT", s, "manual"),
      live.runLiveScanFor("XRPUSDT", s, "manual"),
      live.runLiveScanFor("ADAUSDT", s, "manual"),
    ]);
    expect(x).toBe(y); // same promise result object — one scan, one publication
    expect(x.outcome).toBe("published");
    expect(z.outcome).toBe("published");
    expect(z.opportunity_id).not.toBe(x.opportunity_id);
    expect(outboxRowsFor(x.opportunity_id!)).toHaveLength(1);
    expect(outboxRowsFor(z.opportunity_id!)).toHaveLength(1);
  });

  it("Case 4 — a terminal signal is never resurrected by a later trigger (and no new outbox row appears)", async () => {
    for (const terminal of ["expired", "invalidated", "closed", "archived", "blocked_by_risk"]) {
      // Independent logical signals: terminal states are immutable, not test reset switches.
      const st = strategy("STR-T4-LIVE", `SET-TERMINAL-${terminal}`, "pass");
      const [r] = await live.runLiveScan("DOGEUSDT", "1h", "manual", { strategies: [st] });
      expect(r.outcome).toBe("published");
      const sig = repo.signalByOpp(r.opportunity_id!)!;
      repo.signalUpdate({ id: sig.id, state: terminal });
      const [again] = await live.runLiveScan("DOGEUSDT", "1h", "manual", { strategies: [st] });
      expect(again.outcome).toBe("publish_refused");
      expect(repo.opportunityGet(r.opportunity_id!)?.state).toBe("REJECTED");
      expect(again.reason).toMatch(new RegExp(`existing signal is ${terminal} \\(terminal\\)`));
      expect(repo.signalByOpp(r.opportunity_id!)!.state).toBe(terminal);
      expect(outboxRowsFor(r.opportunity_id!)).toHaveLength(1);
      // provenance survives: the terminal signal still points at its original outbox row
      expect(repo.signalByOpp(r.opportunity_id!)!.outbox_id).toBe(sig.outbox_id);
    }
    expect(eventBus.recent(300).filter((e) => e.type === "signal.publish.refused").length).toBeGreaterThanOrEqual(5);
  });

  it("Case 5 + 6 — delivery linkage is truthful across FAILED → retry (partial progress) → SENT", async () => {
    const [r] = await live.runLiveScan("LTCUSDT", "1h", "manual", { strategies: [LIVE_OK()] });
    expect(r.outcome).toBe("published");
    const sig = repo.signalByOpp(r.opportunity_id!)!;
    const row = repo.outboxGet(sig.outbox_id!)!;
    expect(prov.signalDelivery(repo, sig).delivery_state).toBe("QUEUED");

    // cycle 1: photo accepted, text refused → FAILED, still linked, partial progress visible
    textResults = [false];
    const c1 = await tg.deliverOutboxRow(row, repo);
    expect(c1.ok).toBe(false);
    let d = prov.signalDelivery(repo, repo.signalByOpp(r.opportunity_id!)!);
    expect(d.outbox_id).toBe(row.id);
    expect(d.link).toBe("outbox_id");
    expect(d.delivery_state).toBe("FAILED");
    expect(d.attempts).toBe(1);
    expect(d.error).toMatch(/text not delivered/);
    expect(d.progress).toMatchObject({ photo_required: true, photo_sent: true, text_sent: false, photo_message_id: 1001 });
    expect(d.sent_ms).toBeNull();
    expect(photoCalls).toBe(1);
    expect(textCalls).toBe(1);
    // the decision/signal itself is untouched by the transport failure
    expect(repo.signalByOpp(r.opportunity_id!)!.state).toBe("published");
    expect(repo.opportunityGet(r.opportunity_id!)!.state).toBe("READY");

    // cycle 2 (retry of the SAME row, as the drain would do — it is retryable): resumes — photo NOT re-sent — and completes
    expect(repo.outboxRetryable(500).map((x) => x.id)).toContain(row.id);
    const c2 = await tg.deliverOutboxRow(repo.outboxGet(row.id)!, repo);
    expect(c2.ok).toBe(true);
    d = prov.signalDelivery(repo, repo.signalByOpp(r.opportunity_id!)!);
    expect(d.outbox_id).toBe(row.id); // SAME logical outbox item across the retry
    expect(d.delivery_state).toBe("SENT");
    expect(d.attempts).toBe(2);
    expect(d.progress).toMatchObject({ photo_required: true, photo_sent: true, text_sent: true, photo_message_id: 1001, text_message_id: 2002 });
    expect(d.sent_ms).not.toBeNull();
    expect(photoCalls).toBe(1);
    expect(textCalls).toBe(2);
    expect(outboxRowsFor(r.opportunity_id!)).toHaveLength(1);
  });

  it("Case 5b — SENDING is reported only while an unexpired claim is held; expired/absent claims report the row state", () => {
    const now = Date.now();
    const base = { id: 1, kind: "signal", payload_json: "{}", attempts: 0, error: null, created_ms: now, sent_ms: null } as OutboxRow;
    expect(prov.deliveryStateOf(null)).toBe("UNLINKED");
    expect(prov.deliveryStateOf({ ...base, state: "QUEUED", claimed_by: "w", claim_ms: now, claim_expires_ms: now + 60_000 }, now)).toBe("SENDING");
    expect(prov.deliveryStateOf({ ...base, state: "FAILED", claimed_by: "w", claim_ms: now - 10, claim_expires_ms: now - 1 }, now)).toBe("FAILED");
    expect(prov.deliveryStateOf({ ...base, state: "QUEUED", claimed_by: null, claim_ms: null, claim_expires_ms: null }, now)).toBe("QUEUED");
    expect(prov.deliveryStateOf({ ...base, state: "DEAD", claimed_by: "w", claim_ms: now, claim_expires_ms: now + 60_000 }, now)).toBe("DEAD");
    expect(prov.deliveryStateOf({ ...base, state: "SENT", claimed_by: null, claim_ms: null, claim_expires_ms: null }, now)).toBe("SENT");
  });

  it("Case 5c — legacy signals (published before outbox_id existed) resolve their outbox row by payload match, never by fabrication", () => {
    const now = Date.now();
    const oid = repo.outboxEnqueue("signal", { kind: "signal", opportunity_id: "opp-legacy-1", generated_at_ms: now });
    repo.signalInsert({ id: "sig-opp-legacy-1", state: "published", symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 90,
      strategy_id: "STR-T4-LIVE", opp_id: "opp-legacy-1", payload_json: "{}", created_ms: now, updated_ms: now, outbox_id: null });
    const d = prov.signalDelivery(repo, repo.signalByOpp("opp-legacy-1")!);
    expect(d.link).toBe("legacy_payload_match");
    expect(d.outbox_id).toBe(oid);
    expect(d.delivery_state).toBe("QUEUED");

    repo.signalInsert({ id: "sig-opp-orphan", state: "candidate", symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 1,
      strategy_id: "STR-T4-LIVE", opp_id: "opp-orphan", payload_json: "{}", created_ms: now, updated_ms: now, outbox_id: null });
    const o = prov.signalDelivery(repo, repo.signalByOpp("opp-orphan")!);
    expect(o.delivery_state).toBe("UNLINKED");
    expect(o.outbox_id).toBeNull();
    expect(o.sent_ms).toBeNull();
  });

  it("Case 7 — runtime re-entry: repeated scanner start, duplicate candle.closed events and a dedupe reset never duplicate signal/outbox state", async () => {
    const off1 = live.startLiveSignalScanner({ strategies: () => [LIVE_OK()] });
    const off2 = live.startLiveSignalScanner({ strategies: () => [LIVE_OK()] });
    expect(off2).toBe(off1); // idempotent attach — one subscription
    expect(live.liveScanState().subscribed).toBe(true);

    const closeMs = lastClosedHourSec() * 1000;
    const scansBefore = live.liveScanState().scans_total;
    const callsBefore = ensureSeriesSpy.mock.calls.length;
    // duplicate delivery of the SAME bar-close event (event-driven path)
    eventBus.emit("candle.closed", { symbol: "AVAXUSDT", timeframe: "1h", close_time_ms: closeMs });
    eventBus.emit("candle.closed", { symbol: "AVAXUSDT", timeframe: "1h", close_time_ms: closeMs });
    // a timeframe no strategy trades → nothing scanned, nothing fabricated
    eventBus.emit("candle.closed", { symbol: "AVAXUSDT", timeframe: "15m", close_time_ms: closeMs });
    await vi.waitFor(() => expect(live.liveScanState().in_flight).toBe(0));
    await vi.waitFor(() => expect(live.liveScanState().scans_total).toBe(scansBefore + 1));
    expect(ensureSeriesSpy.mock.calls.length - callsBefore).toBe(1);

    const sig = repo.signalList(500).find((s) => s.symbol === "AVAXUSDT")!;
    expect(sig.state).toBe("published");
    expect(outboxRowsFor(sig.opp_id!)).toHaveLength(1);

    // "restart": in-process dedupe is gone, the persisted lifecycle still guards
    live.resetLiveScanDedupe();
    eventBus.emit("candle.closed", { symbol: "AVAXUSDT", timeframe: "1h", close_time_ms: closeMs });
    await vi.waitFor(() => expect(live.liveScanState().scans_total).toBe(scansBefore + 2));
    expect(repo.signalList(500).filter((s) => s.symbol === "AVAXUSDT")).toHaveLength(1);
    expect(outboxRowsFor(sig.opp_id!)).toHaveLength(1);
    const last = eventBus.recent(300).filter((e) => e.type === "scan.completed").pop() as { outcome: string; trigger: string };
    expect(last.trigger).toBe("candle.closed");
    expect(last.outcome).toBe("already_published");

    live.stopLiveSignalScanner();
    expect(live.liveScanState().subscribed).toBe(false);
    // detached: a further event is ignored
    eventBus.emit("candle.closed", { symbol: "AVAXUSDT", timeframe: "1h", close_time_ms: closeMs + 3_600_000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(live.liveScanState().scans_total).toBe(scansBefore + 2);
  });

  it("scan errors are reported as outcome=error with the reason — never as a publication and never as a decision", async () => {
    ensureSeriesSpy.mockRejectedValueOnce(new Error("TTT unavailable (test)"));
    const [r] = await live.runLiveScan("TRXUSDT", "1h", "manual", { strategies: [LIVE_OK()] });
    expect(r.outcome).toBe("error");
    expect(r.reason).toMatch(/TTT unavailable/);
    expect(repo.signalList(500).filter((s) => s.symbol === "TRXUSDT")).toHaveLength(0);
    expect(live.liveScanState().last_error).toMatch(/TTT unavailable/);
  });

  it("schema migration: an existing database without signals.outbox_id gains the column and keeps its rows (idempotent)", async () => {
    const { SqliteRepo } = await import("../src/db/sqlite");
    const Database = (await import("better-sqlite3")).default;
    const file = path.join(TMP, "legacy-signals.db");
    const raw = new Database(file);
    raw.exec(`CREATE TABLE signals (id TEXT PRIMARY KEY, state TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
      direction TEXT NOT NULL, score REAL NOT NULL, strategy_id TEXT NOT NULL, opp_id TEXT, payload_json TEXT NOT NULL,
      created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);`);
    raw.prepare("INSERT INTO signals VALUES ('sig-old','published','BTCUSDT','1h','long',80,'S','opp-old','{}',1,1)").run();
    raw.close();
    const r1 = new SqliteRepo(file);
    const cols = () => new Set((new Database(file, { readonly: true }).prepare("PRAGMA table_info(signals)").all() as { name: string }[]).map((c) => c.name));
    expect(cols().has("outbox_id")).toBe(true);
    const old = r1.signalByOpp("opp-old")!;
    expect(old.state).toBe("published");
    expect(old.outbox_id).toBeNull();
    const r2 = new SqliteRepo(file); // reopen: no error, no duplicate column
    expect(r2.signalByOpp("opp-old")!.id).toBe("sig-old");
    const migr = new Database(file, { readonly: true }).prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[];
    expect(migr.map((m) => m.version)).toEqual([1, 2, 3, 4]);
  });
});

describe("T05 recovery: event acknowledgement", () => {
  it("a failed scan does not acknowledge the bar; replay can recover", async () => {
    const close = lastClosedHourSec() * 1000;
    const st = strategy("STR-T4-LIVE", "SET-RECOVER-ERROR", "pass");
    ensureSeriesSpy.mockRejectedValueOnce(new Error("transient market outage"));
    const [failed] = await live.runLiveScan("LTCUSDT", "1h", "candle.closed", { strategies: [st], close_time_ms: close });
    expect(failed.outcome).toBe("error");
    const replay = await live.runLiveScan("LTCUSDT", "1h", "candle.closed", { strategies: [st], close_time_ms: close });
    expect(replay).toHaveLength(1);
    expect(replay[0].outcome).toBe("published");
  });
  it("out-of-order older events cannot regress a completed watermark", async () => {
    const close = lastClosedHourSec() * 1000;
    const st = strategy("STR-T4-LIVE", "SET-ORDERED", "pass");
    await live.runLiveScan("LTCUSDT", "1h", "candle.closed", { strategies: [st], close_time_ms: close });
    const count = ensureSeriesSpy.mock.calls.length;
    expect(await live.runLiveScan("LTCUSDT", "1h", "candle.closed", { strategies: [st], close_time_ms: close - 3600_000 })).toEqual([]);
    expect(ensureSeriesSpy.mock.calls.length).toBe(count);
  });
});

describe("T05 recovery: immutable chart and delivery contract", () => {
  it("does not silently downgrade a required chart; retry resumes chart only after text success", async () => {
    const st = strategy("STR-T4-LIVE", "SET-MISSING-CHART", "pass");
    const [r] = await live.runLiveScan("ADAUSDT", "1h", "manual", { strategies: [st] });
    const row = outboxRowsFor(r.opportunity_id!)[0];
    ensureSeriesSpy.mockResolvedValueOnce(null);
    expect((await tg.deliverOutboxRow(row, repo)).ok).toBe(false);
    const partial = repo.outboxGet(row.id)!;
    expect(partial.state).toBe("FAILED");
    expect(JSON.parse(partial.payload_json).delivery_progress).toMatchObject({ photo_required: true, photo_sent: false, text_sent: true });
    expect(textCalls).toBe(1); expect(photoCalls).toBe(0);
    expect((await tg.deliverOutboxRow(row, repo)).ok).toBe(true); // intentionally stale snapshot
    expect(textCalls).toBe(1); expect(photoCalls).toBe(1);
  });
  it("rescan cannot replace the signal's chart evidence; API and Telegram use the frozen snapshot", async () => {
    const st = strategy("STR-T4-LIVE", "SET-FROZEN-CHART", "pass");
    const [r] = await live.runLiveScan("ADAUSDT", "1h", "manual", { strategies: [st] });
    const opp = repo.opportunityGet(r.opportunity_id!)!;
    const original = JSON.parse(opp.payload_json);
    repo.opportunityUpsert({ ...opp, payload_json: JSON.stringify({ ...original, chart_evidence: { ...original.chart_evidence, symbol: "WRONG" } }) });
    const { __setOperationalUniverse } = await import("../src/lib/market/operational-universe");
    __setOperationalUniverse(["ADAUSDT"]);
    try {
      const { GET } = await import("../src/app/api/charts/[id]/route");
      const response = await GET(new Request(`http://asa.local/api/charts/${r.signal_id}.json`), { params: Promise.resolve({ id: `${r.signal_id}.json` }) });
      expect(response.status).toBe(200);
      const chart = await response.json();
      expect(chart.kind).toBe("signal"); expect(chart.symbol).toBe("ADAUSDT");
      expect(chart.candles.at(-1).t).toBe(original.chart_evidence.bar_time);
      expect((await tg.deliverOutboxRow(outboxRowsFor(r.opportunity_id!)[0], repo)).ok).toBe(true);
      expect(photoCalls).toBe(1);
    } finally { __setOperationalUniverse(null); }
  });
  it("terminal signal is never delivered by a queued stale advisory", async () => {
    const [r] = await live.runLiveScan("ADAUSDT", "1h", "manual", { strategies: [strategy("STR-T4-LIVE", "SET-NO-TERMINAL-SEND", "pass")] });
    const row = outboxRowsFor(r.opportunity_id!)[0];
    repo.signalUpdate({ id: r.signal_id!, state: "invalidated" });
    expect((await tg.deliverOutboxRow(row, repo)).ok).toBe(false);
    expect(repo.outboxGet(row.id)?.state).toBe("DEAD");
    expect(repo.outboxGet(row.id)?.attempts).toBe(0);
    expect(textCalls + photoCalls).toBe(0);
    expect(repo.signalGet(r.signal_id!)?.state).toBe("invalidated");
  });
  it("wrong outbox symbol is poison, never a mismatched text/chart delivery", async () => {
    const [r] = await live.runLiveScan("ADAUSDT", "1h", "manual", { strategies: [strategy("STR-T4-LIVE", "SET-NO-CONTAMINATION", "pass")] });
    const row = outboxRowsFor(r.opportunity_id!)[0];
    repo.outboxSetPayload(row.id, JSON.stringify({ ...JSON.parse(row.payload_json), symbol: "BTCUSDT" }));
    expect((await tg.deliverOutboxRow(row, repo)).ok).toBe(false);
    expect(repo.outboxGet(row.id)?.state).toBe("DEAD");
    expect(textCalls + photoCalls).toBe(0);
  });
});

describe("T05 recovery: source candle revision", () => {
  it("refuses a chart built from revised OHLCV even when symbol/timeframe/anchor still match", async () => {
    const [r] = await live.runLiveScan("ADAUSDT", "1h", "manual", { strategies: [strategy("STR-T4-LIVE", "SET-REVISED-CANDLES", "pass")] });
    const row = outboxRowsFor(r.opportunity_id!)[0];
    const revised = series("ADAUSDT");
    revised.candles[0] = { ...revised.candles[0], v: 999 };
    ensureSeriesSpy.mockResolvedValueOnce(revised);
    expect((await tg.deliverOutboxRow(row, repo)).ok).toBe(false);
    expect(photoCalls).toBe(0);
    expect(repo.outboxGet(row.id)?.state).toBe("FAILED");
    expect(JSON.parse(repo.outboxGet(row.id)!.payload_json).delivery_progress.photo_required).toBe(true);
  });
});

describe("T05 recovery: incomplete historical cache", () => {
  it("refetches a partial cache before declaring the required decision chart unavailable", async () => {
    const [r] = await live.runLiveScan("DOTUSDT", "1h", "manual", { strategies: [strategy("STR-T4-LIVE", "SET-PARTIAL-HISTORY", "pass")] });
    const { getHistoryStore } = await import("../src/lib/market/history-store");
    getHistoryStore().put("DOTUSDT", "1h", series("DOTUSDT").candles.slice(-1));
    expect((await tg.deliverOutboxRow(outboxRowsFor(r.opportunity_id!)[0], repo)).ok).toBe(true);
    expect(photoCalls).toBe(1); expect(textCalls).toBe(1);
  });
});
