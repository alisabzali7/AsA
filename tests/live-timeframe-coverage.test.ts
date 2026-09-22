/**
 * TEAM 05 — Task 5: production-timeframe runtime completeness, restart
 * catch-up and deterministic-poison handling.
 *
 * Root cause pinned (1d gap): `MarketEngine.scheduleCloseRefreshes` watched
 * ONLY `CORE_TFS` (4h/1h/15m) although the engine backfills "1d" at boot and
 * one executable strategy (STR-RAW-2-581) declares "1d". No close refresh →
 * no `candle.closed` → the 1d strategy was unreachable by the live scanner.
 * Now the watched set is `closeWatchTimeframes()` = CORE_TFS ∪ every
 * executable strategy's declared timeframe.
 *
 * These tests drive the REAL engine method + REAL CandleManager close
 * detection + REAL event bus + REAL live scanner; the only stubs are the TTT
 * transport (`tttClient.getUdfHistory/getDailyCandles`), the rate scheduler,
 * and the promotion gate for one synthetic strategy id (as in T4).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-tfcov-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "123456789";
process.env.TELEGRAM_DRY_RUN = "0";

vi.mock("../src/lib/backtest/promotion", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/backtest/promotion")>();
  return { ...mod, promotedRuntimeStatus: (id: string) => (id === "STR-T5-LIVE" ? "LIVE_ADVISORY_ONLY" : mod.promotedRuntimeStatus(id)) };
});

type Repo = import("../src/db/repo").Repo;
type Candle = import("../src/lib/domain/types").Candle;
type CandleSeries = import("../src/lib/domain/types").CandleSeries;
type TimeframeId = import("../src/lib/domain/timeframes").TimeframeId;
type StrategyRuntimeDefinition = import("../src/lib/strategy/runtime").StrategyRuntimeDefinition;
type RuleDefinition = import("../src/lib/rules/engine").RuleDefinition;

let repo: Repo;
let closeRepo: () => void;
let engine: typeof import("../src/lib/market/engine");
let candles: typeof import("../src/lib/market/candles");
let store: typeof import("../src/lib/market/store");
let live: typeof import("../src/lib/pipeline/live-scan");
let tg: typeof import("../src/lib/notify/telegram");
let eventBus: typeof import("../src/lib/events").eventBus;
let timeframes: typeof import("../src/lib/domain/timeframes");
let MapFeatureBag: typeof import("../src/lib/rules/engine").MapFeatureBag;
let okFeature: typeof import("../src/lib/features/types").okFeature;
let setUniverse: (s: string[] | null) => void;

/** venue fixture: newest CLOSED bar open time per symbol×tf (seconds) */
const venueLast = new Map<string, number>();
let udfCalls: { symbol: string; resolution: string }[] = [];

function tfSec(tf: TimeframeId): number {
  return timeframes.getTimeframe(tf)!.minutes * 60;
}
/**
 * Open time of the CURRENT (newest) bar for tf, UTC-aligned. Repository
 * convention (engine.scheduleCloseRefreshes + CandleManager.fetch): a venue
 * series ends with the bar that is currently forming; a NEW newest-bar open
 * time is the close instant of the previous bar and is what `candle.closed`
 * reports as `close_time_ms`.
 */
function lastClosedOpenSec(tf: TimeframeId, nowMs = Date.now()): number {
  const p = tfSec(tf);
  return Math.floor(nowMs / 1000 / p) * p;
}
function fixture(symbol: string, tf: TimeframeId, lastOpenSec: number, n = 200, lastClose = 100): CandleSeries {
  const p = tfSec(tf);
  const cs: Candle[] = Array.from({ length: n }, (_, i) => {
    const t = lastOpenSec - (n - 1 - i) * p;
    const base = lastClose + ((i % 5) - 2) * 0.2;
    return { t, o: base, h: base + 0.5, l: base - 0.5, c: i === n - 1 ? lastClose : base, v: 10 };
  });
  return { symbol, timeframe: tf, candles: cs, native: true, source: "ttt", fetched_at_ms: Date.now(), closed_count: n } as CandleSeries;
}

const SRC = [{ file: "t5.txt", start_line: 1, end_line: 1, text: "test rule" }];
function rule(id: string, kind: RuleDefinition["kind"], tf: string): RuleDefinition {
  return {
    id, description: id, source_text: "t", source_refs: SRC as never, source_status: "SOURCE_VERIFIED", empirical_status: "UNTESTED",
    feature_dependencies: ["FTR-T5"], operator: "AND", timeframe: tf, direction: "long", kind, unresolved: [], version: "1.0.0",
    predicates: [{ expr: "FTR-T5 > 0", requires: ["FTR-T5"], test: () => ({ ok: true, detail: "ok" }) }],
  };
}
/** synthetic EXECUTABLE long strategy on `tf` whose levels yield a real risk PASS */
function strategyOn(tf: TimeframeId, mode: "pass" | "block" = "pass"): StrategyRuntimeDefinition {
  const setupId = `SET-T5-${tf}${mode === "block" ? "-BLOCK" : ""}`;
  const setupDef = {
    setup_id: setupId, strategy_id: "STR-T5-LIVE", name: setupId, direction: "long" as const, timeframe: tf, source_refs: SRC as never, version: "1.0.0",
    rules: (["context", "location", "structure", "trigger", "confirmation"] as const).map((k) => rule(`${setupId}-${k}`, k, tf)),
  };
  return {
    strategy_id: "STR-T5-LIVE", setup_id: setupId, name: setupId, family: "test", direction: "long", timeframe: tf, min_bars: 120,
    availability: "EXECUTABLE", blocked_reason: null, version: "1.0.0", rule_ids: setupDef.rules.map((r) => r.id), source_refs: SRC as never,
    impl: {
      strategy_id: "STR-T5-LIVE", setup_id: setupId, name: setupId, family: "test", direction: "long", timeframe: tf, min_bars: 120,
      build: (c, t) => MapFeatureBag.from([["FTR-T5", okFeature("FTR-T5", t, 1, c[c.length - 1]?.t ?? 0, c.length, "1.0.0", ["candles"])]]),
      setup: () => setupDef,
      levels: (c) => {
        const px = c[c.length - 1].c;
        return mode === "pass"
          ? { entry: px, stop: px * 0.98, targets: [px * 1.06], invalidation: px * 0.97, level_assumptions: ["test"] }
          : { entry: px, stop: px * 1.02, targets: [px * 1.06], invalidation: px * 0.97, level_assumptions: ["test (stop wrong side)"] };
      },
    },
  };
}

type ScanEv = { type: string; symbol: string; timeframe: string; outcome: string; trigger: string; reason: string | null; opportunity_id: string | null };
/** typed view over the ring buffer for scan.completed / candle.closed lookups */
function evs(): ScanEv[] {
  return eventBus.recent(300) as unknown as ScanEv[];
}

const PRODUCTION_TFS: TimeframeId[] = ["5m", "15m", "30m", "45m", "1h", "2h", "4h", "8h", "1d"];

beforeAll(async () => {
  const sqlite = await import("../src/db/sqlite");
  repo = sqlite.getRepo();
  closeRepo = sqlite.closeRepo;
  timeframes = await import("../src/lib/domain/timeframes");
  const ttt = await import("../src/lib/ttt/client");
  const sched = await import("../src/lib/ttt/scheduler");
  const ou = await import("../src/lib/market/operational-universe");
  setUniverse = ou.__setOperationalUniverse;
  setUniverse(["BTCUSDT", "ETHUSDT"]);
  // TTT transport seam: serve the fixture keyed by symbol×tf, newest bar from `venueLast`
  vi.spyOn(sched.sharedScheduler, "acquire").mockResolvedValue(undefined);
  vi.spyOn(ttt.tttClient, "getUdfHistory").mockImplementation(async (q: { symbol: string; resolution: string; tfMinutes: number }) => {
    udfCalls.push({ symbol: q.symbol, resolution: q.resolution });
    const tf = timeframes.TIMEFRAMES.find((t) => t.minutes === q.tfMinutes)!.id;
    const last = venueLast.get(`${q.symbol}|${tf}`) ?? lastClosedOpenSec(tf);
    return { series: fixture(q.symbol, tf, last), no_data: false } as never;
  });
  vi.spyOn(ttt.tttClient, "getDailyCandles").mockImplementation(async (symbol: string) => {
    udfCalls.push({ symbol, resolution: "1D" });
    return fixture(symbol, "1d", venueLast.get(`${symbol}|1d`) ?? lastClosedOpenSec("1d"));
  });
  engine = await import("../src/lib/market/engine");
  candles = await import("../src/lib/market/candles");
  store = await import("../src/lib/market/store");
  live = await import("../src/lib/pipeline/live-scan");
  tg = await import("../src/lib/notify/telegram");
  eventBus = (await import("../src/lib/events")).eventBus;
  MapFeatureBag = (await import("../src/lib/rules/engine")).MapFeatureBag;
  okFeature = (await import("../src/lib/features/types")).okFeature;
  // Telegram transport: accept everything (delivery is not the subject here)
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
});

afterAll(() => {
  live.stopLiveSignalScanner();
  vi.restoreAllMocks();
  setUniverse(null);
  closeRepo();
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  udfCalls = [];
  live.stopLiveSignalScanner(); // each test attaches its own strategy list
  live.resetLiveScanDedupe();
});

/** run the engine's private close detector (real code) */
function scheduleCloseRefreshes(): void {
  (engine.marketEngine as unknown as { scheduleCloseRefreshes: () => void }).scheduleCloseRefreshes();
}
async function drainCandleQueue(): Promise<void> {
  await vi.waitFor(() => expect(candles.candleManager.stats().queueDepth).toBe(0));
  await vi.waitFor(() => expect(candles.candleManager.stats().working).toBe(false));
}

describe("T05 T5 — production timeframe close-event coverage", () => {
  it("closeWatchTimeframes() = core hierarchy ∪ every executable strategy timeframe (includes 1d from STR-RAW-2-581)", async () => {
    const { executableStrategies } = await import("../src/lib/strategy/runtime");
    const watch = engine.closeWatchTimeframes();
    for (const tf of timeframes.CORE_TFS) expect(watch).toContain(tf);
    for (const s of executableStrategies()) expect(watch, `${s.setup_id} declares ${s.timeframe}`).toContain(s.timeframe);
    expect(watch).toContain("1d");
    expect(new Set(watch).size).toBe(watch.length);
  });

  it("every production timeframe has a correct close boundary and (when a series is watched) yields ONE candle.closed per new bar — 1d explicitly", async () => {
    // Only watched tfs are close-detected by the engine; for unwatched ones we
    // still verify the manager emits candle.closed from a refresh (the
    // mechanism is timeframe-agnostic) — the table in the report states which
    // are engine-watched.
    const watched = new Set(engine.closeWatchTimeframes());
    const symbol = "BTCUSDT";
    for (const tf of PRODUCTION_TFS) {
      const prevOpen = lastClosedOpenSec(tf) - tfSec(tf); // series is one bar behind the venue
      store.sharedStore.putSeries(fixture(symbol, tf, prevOpen));
      const closed: number[] = [];
      const off = eventBus.subscribe((raw) => {
        const e = raw as unknown as ScanEv & { close_time_ms: number };
        if (e.type === "candle.closed" && e.symbol === symbol && e.timeframe === tf) closed.push(e.close_time_ms);
      });
      udfCalls = [];
      if (watched.has(tf)) {
        scheduleCloseRefreshes();
        scheduleCloseRefreshes(); // repeated sweep before the fetch lands must not double-queue
      } else {
        candles.candleManager.enqueueCloseRefresh(symbol, tf);
      }
      await drainCandleQueue();
      expect(closed, `${tf}: exactly one close event`).toEqual([lastClosedOpenSec(tf) * 1000]);
      // boundary correctness: the emitted bar open is aligned to the timeframe period (UTC-aligned for 1d)
      expect(closed[0] % (tfSec(tf) * 1000)).toBe(0);
      if (tf === "1d") expect(new Date(closed[0]).toISOString()).toMatch(/T00:00:00\.000Z$/);
      // a further sweep with an up-to-date series schedules nothing and emits nothing
      udfCalls = [];
      scheduleCloseRefreshes();
      await drainCandleQueue();
      expect(udfCalls.filter((c) => c.symbol === symbol)).toHaveLength(0);
      expect(closed).toHaveLength(1);
      off();
    }
  });

  it("premature: while the current 1d bar is still forming, no 1d refresh is scheduled and no close is emitted", async () => {
    const symbol = "ETHUSDT";
    store.sharedStore.putSeries(fixture(symbol, "1d", lastClosedOpenSec("1d"))); // already holds today's forming bar
    const closed: unknown[] = [];
    const off = eventBus.subscribe((raw) => { const e = raw as unknown as ScanEv; if (e.type === "candle.closed" && e.timeframe === "1d" && e.symbol === symbol) closed.push(e); });
    udfCalls = [];
    scheduleCloseRefreshes();
    await drainCandleQueue();
    expect(udfCalls.filter((c) => c.symbol === symbol && c.resolution === "1D")).toHaveLength(0);
    expect(closed).toHaveLength(0);
    off();
  });

  it("1d end-to-end: engine close detection → candle.closed → live scanner → scanSymbol → publishSignal → outbox (exactly once for one close)", async () => {
    const symbol = "BTCUSDT";
    const s1d = strategyOn("1d");
    const prevOpen = lastClosedOpenSec("1d") - 86400;
    store.sharedStore.putSeries(fixture(symbol, "1d", prevOpen)); // yesterday's series already in memory (pre-restart state)
    live.startLiveSignalScanner({ strategies: () => [s1d] });
    const scansBefore = live.liveScanState().scans_total;
    scheduleCloseRefreshes();
    await drainCandleQueue();
    await vi.waitFor(() => expect(live.liveScanState().scans_total).toBe(scansBefore + 1));
    await vi.waitFor(() => expect(live.liveScanState().in_flight).toBe(0));
    const last = evs().filter((e) => e.type === "scan.completed" && e.timeframe === "1d").pop()!;
    expect(last.symbol).toBe(symbol);
    expect(last.trigger).toBe("candle.closed");
    expect(last.outcome).toBe("published");
    const sigs = repo.signalList(500).filter((s) => s.symbol === symbol && s.timeframe === "1d");
    expect(sigs).toHaveLength(1);
    expect(sigs[0].outbox_id).not.toBeNull();
    const oppPayload = JSON.parse(repo.opportunityGet(sigs[0].opp_id!)!.payload_json) as { timeframe: string; risk: { verdict: string }; anchor_close_ms: number };
    expect(oppPayload.timeframe).toBe("1d");
    expect(oppPayload.risk.verdict).toBe("pass");
    expect(oppPayload.anchor_close_ms).toBe(lastClosedOpenSec("1d") * 1000);

    // replayed close event for the SAME 1d bar → no second scan, no second signal/outbox row
    eventBus.emit("candle.closed", { symbol, timeframe: "1d", close_time_ms: lastClosedOpenSec("1d") * 1000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(live.liveScanState().scans_total).toBe(scansBefore + 1);
    expect(repo.signalList(500).filter((s) => s.symbol === symbol && s.timeframe === "1d")).toHaveLength(1);
    expect(repo.outboxList("ALL", 500).filter((r) => (JSON.parse(r.payload_json) as { opportunity_id?: string }).opportunity_id === sigs[0].opp_id)).toHaveLength(1);
    live.stopLiveSignalScanner();
  });

  it("1d blocked decision through the same close path → REJECTED, no signal, no outbox row", async () => {
    const symbol = "ETHUSDT";
    store.sharedStore.putSeries(fixture(symbol, "1d", lastClosedOpenSec("1d") - 86400));
    live.startLiveSignalScanner({ strategies: () => [strategyOn("1d", "block")] });
    const scansBefore = live.liveScanState().scans_total;
    scheduleCloseRefreshes();
    await drainCandleQueue();
    await vi.waitFor(() => expect(live.liveScanState().scans_total).toBe(scansBefore + 1));
    const last = evs().filter((e) => e.type === "scan.completed" && e.symbol === symbol && e.timeframe === "1d").pop()!;
    expect(last.outcome).toBe("not_ready");
    expect(last.reason).toMatch(/risk engine BLOCK/);
    expect(repo.opportunityGet(last.opportunity_id!)!.state).toBe("REJECTED");
    expect(repo.signalByOpp(last.opportunity_id!)).toBeNull();
    live.stopLiveSignalScanner();
  });
});

describe("T05 T5 — restart / first-sighting catch-up (no poll)", () => {
  it("after a restart the FIRST stored series (candles.updated, no previous copy) triggers one scan; re-stores of the same bar and unrelated timeframes do not", async () => {
    const symbol = "ETHUSDT";
    const s1h = strategyOn("1h");
    // simulate restart: no in-memory series for this symbol×tf, no dedupe state
    store.sharedStore.putSeries({ ...fixture(symbol, "1h", lastClosedOpenSec("1h")), candles: [] } as CandleSeries);
    live.startLiveSignalScanner({ strategies: () => [s1h] });
    const scansBefore = live.liveScanState().scans_total;
    udfCalls = [];
    // the boot backfill path: a fetch with NO usable previous copy → candles.updated only (candle.closed cannot fire)
    await candles.candleManager.fetch(symbol, "1h");
    await vi.waitFor(() => expect(live.liveScanState().scans_total).toBe(scansBefore + 1));
    await vi.waitFor(() => expect(live.liveScanState().in_flight).toBe(0));
    const ev = evs().filter((e) => e.type === "scan.completed" && e.symbol === symbol && e.timeframe === "1h").pop()!;
    expect(ev.trigger).toBe("candles.updated");
    expect(ev.outcome).toBe("published");
    expect(udfCalls.filter((c) => c.symbol === symbol)).toHaveLength(1); // the scan reused the stored series — no extra venue call

    // same newest bar re-stored (e.g. a 45s cache refresh) → ignored
    await candles.candleManager.fetch(symbol, "1h");
    // a timeframe with no executable strategy → ignored
    store.sharedStore.putSeries(fixture(symbol, "15m", lastClosedOpenSec("15m")));
    await new Promise((r) => setTimeout(r, 30));
    expect(live.liveScanState().scans_total).toBe(scansBefore + 1);
    expect(repo.signalList(500).filter((s) => s.symbol === symbol && s.timeframe === "1h")).toHaveLength(1);

    // "second restart": dedupe cleared, persisted lifecycle still guarantees one logical signal
    live.resetLiveScanDedupe();
    await candles.candleManager.fetch(symbol, "1h");
    await vi.waitFor(() => expect(live.liveScanState().scans_total).toBe(scansBefore + 2));
    const again = evs().filter((e) => e.type === "scan.completed" && e.symbol === symbol && e.timeframe === "1h").pop()!;
    expect(again.outcome).toBe("already_published");
    expect(repo.signalList(500).filter((s) => s.symbol === symbol && s.timeframe === "1h")).toHaveLength(1);
    live.stopLiveSignalScanner();
  });

  it("a stale first sighting (venue series ends more than 2 bars ago) is scanned but never published — the data-freshness gate holds", async () => {
    const symbol = "BTCUSDT";
    venueLast.set(`${symbol}|2h`, lastClosedOpenSec("2h") - 5 * tfSec("2h"));
    live.startLiveSignalScanner({ strategies: () => [strategyOn("2h")] });
    const scansBefore = live.liveScanState().scans_total;
    await candles.candleManager.fetch(symbol, "2h");
    await vi.waitFor(() => expect(live.liveScanState().scans_total).toBe(scansBefore + 1));
    const ev = evs().filter((e) => e.type === "scan.completed" && e.symbol === symbol && e.timeframe === "2h").pop()!;
    expect(ev.outcome).toBe("not_ready");
    expect(ev.reason).toMatch(/stale/);
    expect(repo.signalList(500).filter((s) => s.symbol === symbol && s.timeframe === "2h")).toHaveLength(0);
    venueLast.delete(`${symbol}|2h`);
    live.stopLiveSignalScanner();
  });
});

describe("T05 T5 — pre-transport error classification (transient vs deterministic poison)", () => {
  it("a parseable-but-malformed payload (deterministic formatting failure) is DEAD with attempts 0 — no infinite retry, no provider request", async () => {
    let calls = 0;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ ok: true }), { status: 200 }); }) as typeof fetch;
    // targets is an array-like object without join → `targets.join` throws identically on every retry
    const id = repo.outboxEnqueue("signal", { kind: "signal", symbol: "BTCUSDT", targets: { length: 1 } as unknown as number[], generated_at_ms: Date.now(), opportunity_id: null });
    const r1 = await tg.deliverOutboxRow(repo.outboxGet(id)!, repo);
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/poison payload/);
    const row = repo.outboxGet(id)!;
    expect(row.state).toBe("DEAD");
    expect(row.attempts).toBe(0);
    expect(row.error).toMatch(/cannot be formatted/);
    expect(calls).toBe(0);
    expect(repo.outboxRetryable(500).map((x) => x.id)).not.toContain(id);
    // a JSON `null` payload is equally deterministic
    const id2 = repo.outboxEnqueue("signal", null);
    await tg.deliverOutboxRow(repo.outboxGet(id2)!, repo);
    expect(repo.outboxGet(id2)!.state).toBe("DEAD");
    expect(repo.outboxGet(id2)!.attempts).toBe(0);
    globalThis.fetch = prevFetch;
  });

  it("a transient infrastructure failure before transport stays FAILED + retryable, spends no attempt, and later delivers on the SAME row", async () => {
    const id = repo.outboxEnqueue("signal", { kind: "signal", symbol: "BTCUSDT", timeframe: "1h", targets: [1], generated_at_ms: Date.now(), opportunity_id: null });
    // transient: the repository write of delivery progress fails once (e.g. SQLITE_BUSY)
    const orig = repo.outboxSetPayload.bind(repo);
    let failOnce = true;
    const spy = vi.spyOn(repo, "outboxSetPayload").mockImplementation((rid, json, claim) => {
      if (failOnce) { failOnce = false; throw new Error("SQLITE_BUSY: database is locked (test)"); }
      return orig(rid, json, claim);
    });
    const r1 = await tg.deliverOutboxRow(repo.outboxGet(id)!, repo);
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/SQLITE_BUSY/);
    let row = repo.outboxGet(id)!;
    expect(row.state).toBe("FAILED");
    expect(row.claimed_by).toBeNull(); // claim released
    expect(repo.outboxRetryable(500).map((x) => x.id)).toContain(id);
    const r2 = await tg.deliverOutboxRow(repo.outboxGet(id)!, repo);
    expect(r2.ok).toBe(true);
    row = repo.outboxGet(id)!;
    expect(row.state).toBe("SENT");
    spy.mockRestore();
  });
});
