/**
 * MarketEngine — boots at server start and owns every live loop (docs):
 *  - catalog load (GET /futures/markets) once at boot
 *  - universe stats sweep (~7s, ONE request for the dynamic TTT universe)
 *  - focus lanes: trades (~8s), orderbook (~20s), funding-history (30min)
 *  - candle backfill (144 core series) + per-close refresh
 *  - scheduler health hook, OI snapshot ring, health aggregation
 *
 * TASK 1: every loop below is a pure CALLER. It states LANE INTENT on the client
 * call and nothing else — the shared TTT transport (ttt/http.ts) performs the
 * single scheduler admission, once per network attempt (retries included), and
 * owns all 429 accounting. The engine no longer acquires budget or calls
 * note429() itself, so there is exactly one admission point for TTT traffic.
 */
import { sharedStore } from "./store";
import { candleManager } from "./candles";
import { tttClient } from "../ttt/client";
import { cachedCatalog } from "./catalog";
import { PRIORITY, activeScheduler, schedulerStats, type SchedulerStats } from "../ttt/scheduler";
import { eventBus } from "../events";
import { operationalUniverse, refreshOperationalUniverse, universeSource, universeState } from "./operational-universe";
import { CORE_TFS, getTimeframe, isTimeframe, type TimeframeId } from "../domain/timeframes";
import { executableStrategies } from "../strategy/runtime";
import { getRepo } from "../../db/sqlite";
import { recordOiSnapshot } from "../psychology/engine";
import { startNewsPolling, newsState } from "../fundamental/engine";
import { startRetentionJob, runRetention } from "../retention";
import { telegramStateLive, probeTelegram, drainOutbox } from "../notify/telegram";
import { providerStatuses } from "../ai";
import { expireStaleSignals } from "../pipeline/orchestrator";
import { startLiveSignalScanner, stopLiveSignalScanner, liveScanState, type LiveScanState } from "../pipeline/live-scan";
import type { AppState, SymbolStats } from "../domain/types";
import { num } from "./store";
import { TTT_RATE_PER_MIN } from "../env";

interface LoopState {
  running: boolean;
  lastOkAtMs: number | null;
  consecutiveErrors: number;
  lastError: string | null;
}

export interface EngineStatus {
  booted: boolean;
  boot_ms: number;
  phase: "idle" | "starting" | "running";
  health: { market: AppState; reason?: string };
  last_stats_sweep_ms: number | null;
  stats_age_ms: number | null;
  live: { live: number; total: number };
  scheduler: SchedulerStats;
  candles: { queueDepth: number; fetchedTotal: number };
  catalog_symbols: number;
  ai: unknown;
  telegram: unknown;
  /** T05 T4: live scanner (candle.closed → scanSymbol → publishSignal) */
  live_scan: LiveScanState;
  news: unknown;
  storage: string;
  uptime_ms: number;
  ttt_errors: number;
  errors_recent: unknown[];
}

const STATS_INTERVAL_MS = 7_000;
const TAPE_INTERVAL_MS = 8_000;
const BOOK_INTERVAL_MS = 20_000;
const FUNDING_INTERVAL_MS = 30 * 60_000;
const RECOVER_INTERVAL_MS = 30_000;
const OUTBOX_INTERVAL_MS = 60_000;
const HEALTH_INTERVAL_MS = 15_000;

export class MarketEngine {
  private timers: ReturnType<typeof setInterval>[] = [];
  bootedAtMs: number | null = null;
  private statsLoop: LoopState = { running: false, lastOkAtMs: null, consecutiveErrors: 0, lastError: null };
  private tapeLoop: LoopState = { running: false, lastOkAtMs: null, consecutiveErrors: 0, lastError: null };
  private bookLoop: LoopState = { running: false, lastOkAtMs: null, consecutiveErrors: 0, lastError: null };
  private bootPhase: "idle" | "starting" | "running" = "idle";
  private marketHealth: AppState = "CONNECTING";
  private lastHealthEvent: string | null = null;
  private lastFundingLaneAtMs = 0;

  /** Idempotent boot. Resolves after catalog + first stats sweep. */
  async start(): Promise<void> {
    if (this.bootPhase !== "idle") return;
    this.bootPhase = "starting";
    this.bootedAtMs = Date.now();
    try {
      // repo warm-up (durable tables)
      getRepo();
      // 0) DISCOVERY FIRST (remediation P0-1): the operational universe must be
      //    resolved from TTT BEFORE catalog ingestion, the stats sweep or the
      //    backfill loop run, otherwise a newly listed market would be filtered
      //    out by a stale symbol list before it could ever be registered.
      const disc = await refreshOperationalUniverse(true);
      if (disc.error) {
        sharedStore.recordError("boot", "/futures/markets", `market discovery failed: ${disc.error}; universe state=${universeState()}`);
      }
      // 1) catalog — AUDIT FIX (P1): ingested from the SAME discovery snapshot
      //    resolved above. The previous code issued a second /futures/markets
      //    request at boot (double-fetch) and recorded a SUCCESS message
      //    through recordError, inflating the TTT error counters shown by
      //    /api/system/status and /api/system/logs.
      const snap = cachedCatalog();
      const catalogN = sharedStore.ingestCatalog(
        (snap?.markets ?? []).map((m) => ({
          symbol: m.symbol,
          baseAsset: m.base_asset,
          quoteAsset: m.quote_asset,
          category: m.category,
          name: m.display_name,
          tickSize: m.constraints.tick_size,
          stepSize: m.constraints.step_size,
          maxLeverage: m.constraints.max_leverage,
          maintenanceMarginRate: m.constraints.maintenance_margin_rate,
          makerFeeCoefficient: m.constraints.maker_fee,
          takerFeeCoefficient: m.constraints.taker_fee,
          isActive: m.status === "ACTIVE",
        })),
      );
      eventBus.emit("system", {
        message: `catalog ingested for ${catalogN}/${operationalUniverse().length} operational symbols (source: ${universeSource()}, state: ${universeState()})`,
        level: "info",
      });
      // 2) first stats sweep (blocking so first snapshot is real)
      await this.sweepStats();
      // 3) kick background candle backfill (144 core series) — non-blocking
      for (const tf of CORE_TFS) candleManager.setTarget(tf, tf === "15m" ? 700 : tf === "1h" ? 800 : 900);
      candleManager.setTarget("1d", 320);
      candleManager.enqueueBackfill(closeWatchTimeframes());
      // 4) periodic loops
      this.interval("stats", STATS_INTERVAL_MS, () => this.sweepStats());
      this.interval("tape", TAPE_INTERVAL_MS, () => this.sweepTape());
      this.interval("book", BOOK_INTERVAL_MS, () => this.sweepBook());
      // health hook only: the scheduler is timer/event driven and never needs
      // this tick to make progress (no polling loop anywhere)
      this.interval("recover", RECOVER_INTERVAL_MS, () => activeScheduler().recover());
      // probe the notifier before draining so state is measured, never assumed
      this.interval("outbox", OUTBOX_INTERVAL_MS, () => void probeTelegram().then(() => drainOutbox()));
      this.interval("signals", 10 * 60_000, () => { void expireStaleSignals(); });
      // T05 T4: the live signal path. Event-driven off the SAME candle-close
      // detection this engine already runs (scheduleCloseRefreshes → fetch →
      // candle.closed); no extra polling loop. Idempotent to attach.
      startLiveSignalScanner();
      this.interval("health", HEALTH_INTERVAL_MS, () => this.publishHealth());
      // periodic re-discovery: a contract listed after boot joins the
      // operational universe without a code change or a restart
      this.interval("discovery", 10 * 60_000, () => void refreshOperationalUniverse(true));
      // funding history lane for the focus symbol (30 min cadence)
      void this.fundingLane();
      // housekeeping: news poll + retention + outbox flush at boot
      startNewsPolling();
      setTimeout(() => { try { runRetention(); } catch { /* logged inside */ } }, 45_000);
      startRetentionJob();
      this.bootPhase = "running";
      eventBus.emit("system", { message: `engine booted: catalog ${catalogN}/${operationalUniverse().length} operational symbols (source: ${universeSource()}), first stats sweep OK`, level: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sharedStore.recordError("boot", "start", msg);
      // keep booted=false so health shows ERROR but the server stays up
      this.bootPhase = "idle";
      throw err;
    }
  }

  private interval(name: string, ms: number, fn: () => void | Promise<void>): void {
    const t = setInterval(() => {
      try {
        void fn();
      } catch (err) {
        sharedStore.recordError("loop", name, err instanceof Error ? err.message : String(err));
      }
    }, ms);
    this.timers.push(t);
  }

  private markLoop(loop: LoopState, ok: boolean, err?: string): void {
    loop.running = false;
    if (ok) {
      loop.lastOkAtMs = Date.now();
      loop.consecutiveErrors = 0;
      loop.lastError = null;
    } else {
      loop.consecutiveErrors++;
      loop.lastError = err ?? "unknown";
    }
  }

  /** Universe stats sweep: ONE request covers the whole DYNAMIC operational universe. */
  private async sweepStats(): Promise<void> {
    if (this.statsLoop.running) return;
    this.statsLoop.running = true;
    try {
      // lane intent only (Task 1): admission is charged by the transport
      const { rows, provenance } = await tttClient.getStats(PRIORITY.SWEEP);
      const now = Date.now();
      let updated = 0;
      for (const r of rows) {
        if (!operationalUniverse().includes(r.symbol)) continue; // excludes TONUSDT etc.
        const statsRow: SymbolStats = {
          symbol: r.symbol,
          lastPrice: fin(num(r.lastPrice)) ? num(r.lastPrice) : null,
          markPrice: fin(num(r.markPrice)) ? num(r.markPrice) : null,
          indexPrice: fin(num(r.indexPrice)) ? num(r.indexPrice) : null,
          fundingRate: fin(num(r.fundingRate)) ? num(r.fundingRate) : null,
          nextFundingTimeMs: r.nextFundingTime ? Date.parse(r.nextFundingTime) || null : null,
          fundingIntervalHours: r.fundingIntervalHours ?? null,
          change24hPct: fin(num(r.change24hPct)) ? num(r.change24hPct) * 100 : null, // upstream observed as fraction
          high24h: fin(num(r.high24h)) ? num(r.high24h) : null,
          low24h: fin(num(r.low24h)) ? num(r.low24h) : null,
          volume24hQuote: fin(num(r.volume24hQuote)) ? num(r.volume24hQuote) : null,
          openInterest: fin(num(r.openInterest)) ? num(r.openInterest) : null,
          openValue: fin(num(r.openValue)) ? num(r.openValue) : null,
          provenance,
        };
        sharedStore.ingestStats(statsRow);
        if (fin(statsRow.openInterest ?? NaN)) recordOiSnapshot(r.symbol, statsRow.openInterest as number);
        updated++;
      }
      sharedStore.lastStatsSweepAtMs = now;
      this.markLoop(this.statsLoop, true);
      const ages = sharedStore.liveRows().map((x) => x.age_ms ?? 1e12);
      const maxAge = Math.max(0, ...ages);
      eventBus.emit("market.stats.updated", { symbols: updated, max_age_ms: maxAge });
      // focus symbol price event
      const focus = sharedStore.getStats(sharedStore.focusSymbol);
      eventBus.emit("price.updated", { symbol: sharedStore.focusSymbol, price: focus?.lastPrice ?? null, age_ms: focus ? Date.now() - focus.provenance.fetched_at_ms : -1 });
      // close-refresh scheduling for core timeframes
      this.scheduleCloseRefreshes();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 429 accounting belongs to the transport (http.ts); the loop only reports.
      sharedStore.recordError("stats", "/futures/markets/stats", msg);
      this.markLoop(this.statsLoop, false, msg);
    }
  }

  /**
   * Detect closed candles per symbol and schedule refreshes.
   *
   * T05 T5: the watched set is `closeWatchTimeframes()` — the core hierarchy
   * PLUS every timeframe an executable strategy declares (today that adds
   * "1d"). Before, only CORE_TFS were watched, so the 1d series (backfilled at
   * boot) never produced a `candle.closed` and the 1d strategy could never be
   * scanned live. Boundary math is unchanged: `floor((now-grace)/tfMs)` is the
   * open time of the CURRENT bar in UTC-aligned venue time (1d bars are
   * UTC-midnight aligned — pinned by tests/universe-tf `tfStartMs("1d")`), so
   * a refresh is requested only once a new bar must exist and the event fires
   * once per new bar (the candle manager compares newest-bar open times).
   */
  private scheduleCloseRefreshes(): void {
    const nowMs = Date.now();
    const watch = closeWatchTimeframes();
    for (const symbol of operationalUniverse()) {
      for (const tf of watch) {
        const series = sharedStore.getSeries(symbol, tf);
        if (!series || series.candles.length === 0) continue;
        const tfMs = tfMsOf(tf);
        const expectedLastClosed = Math.floor((nowMs - 5_000) / tfMs) * tfMs; // grace
        const actualLast = series.candles[series.candles.length - 1].t * 1000;
        if (actualLast < expectedLastClosed) {
          candleManager.enqueueCloseRefresh(symbol, tf);
        }
      }
    }
  }

  /** Focus tape lane: fastest price updates for the focused symbol. */
  private async sweepTape(): Promise<void> {
    if (this.tapeLoop.running) return;
    this.tapeLoop.running = true;
    const symbol = sharedStore.focusSymbol;
    try {
      const { book, provenance } = await tttClient.getTrades(symbol, PRIORITY.REFRESH);
      const prints = (book.trades ?? []).map((tr) => ({
        symbol,
        price: num(tr.price),
        size: num(tr.size),
        side: tr.side === "ASK" || tr.side === "BID" ? tr.side : ("UNKNOWN" as const),
        side_semantics: "UNVERIFIED" as const,
        ts_ms: tr.timestamp,
        provenance,
      })).filter((p) => fin(p.price));
      sharedStore.tape = prints;
      sharedStore.tapeFetchedAtMs = Date.now();
      const last = prints[prints.length - 1];
      if (last && last.price > 0) {
        // tape price is fresher than the stats sweep for the focus symbol
        const stats = sharedStore.getStats(symbol);
        if (stats) {
          sharedStore.ingestStats({ ...stats, lastPrice: last.price, provenance: { ...provenance, endpoint: "/futures/markets/trades" } });
        }
        eventBus.emit("price.updated", { symbol, price: last.price, age_ms: Date.now() - provenance.fetched_at_ms });
      }
      eventBus.emit("trade.received", { symbol, count: prints.length });
      this.markLoop(this.tapeLoop, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sharedStore.recordError("tape", "/futures/markets/trades", msg);
      this.markLoop(this.tapeLoop, false, msg);
    }
  }

  /** Focus orderbook lane. */
  private async sweepBook(): Promise<void> {
    if (this.bookLoop.running) return;
    this.bookLoop.running = true;
    const symbol = sharedStore.focusSymbol;
    try {
      const { book, provenance } = await tttClient.getOrderBook(symbol, undefined, PRIORITY.REFRESH);
      const bids = (book.bids ?? []).slice(0, 25).map((b) => ({ price: num(b.price), size: num(b.size) })).filter((b) => fin(b.price));
      const asks = (book.asks ?? []).slice(0, 25).map((a) => ({ price: num(a.price), size: num(a.size) })).filter((a) => fin(a.price));
      const bestBid = bids.length ? bids[bids.length - 1].price : null; // ascending
      const bestAsk = asks.length ? asks[0].price : null; // ascending
      sharedStore.orderBook = {
        symbol,
        bids,
        asks,
        depthDecimal: typeof book.depthDecimal === "number" ? book.depthDecimal : null,
        spreadAbs: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
        spreadPct: bestBid !== null && bestAsk !== null && bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : null,
        provenance,
      };
      sharedStore.orderBookFetchedAtMs = Date.now();
      eventBus.emit("orderbook.updated", { symbol, asks: asks.length, bids: bids.length });
      this.markLoop(this.bookLoop, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sharedStore.recordError("book", "/futures/markets/orderbook", msg);
      this.markLoop(this.bookLoop, false, msg);
    }
  }

  /** Funding history for the focus symbol every 30 minutes (durable-ish). */
  private async fundingLane(): Promise<void> {
    if (Date.now() - this.lastFundingLaneAtMs < FUNDING_INTERVAL_MS - 30_000) return;
    const symbol = sharedStore.focusSymbol;
    try {
      const { page, provenance } = await tttClient.getFundingHistory(symbol, 1, PRIORITY.SWEEP);
      sharedStore.fundingHistory = { symbol, page, provenance };
      const stats = sharedStore.getStats(symbol);
      eventBus.emit("funding.updated", { symbol, rate: stats?.fundingRate ?? null });
      this.lastFundingLaneAtMs = Date.now();
    } catch (err) {
      sharedStore.recordError("funding", "/futures/markets/funding-history", err instanceof Error ? err.message : String(err));
    }
  }

  private publishHealth(): void {
    const health = this.computeHealth();
    const key = JSON.stringify(health);
    if (key !== this.lastHealthEvent) {
      this.lastHealthEvent = key;
      eventBus.emit("system.health.changed", { state: health.market, reason: health.reason });
    }
  }

  computeHealth(): { market: AppState; reason?: string } {
    const age = sharedStore.lastStatsSweepAtMs === null ? null : Date.now() - sharedStore.lastStatsSweepAtMs;
    if (age === null) return { market: "CONNECTING", reason: "first stats sweep pending" };
    if (age < 30_000) return { market: "LIVE", reason: `stats age ${(age / 1000).toFixed(0)}s` };
    if (age < 120_000) return { market: "STALE", reason: `last stats ${(age / 1000).toFixed(0)}s ago` };
    if (age < 600_000) return { market: "DEGRADED", reason: `TTT unreachable since ${(age / 1000).toFixed(0)}s` };
    return { market: "UNAVAILABLE", reason: "no successful stats sweep for >10 min" };
  }

  async status(): Promise<EngineStatus> {
    const health = this.computeHealth();
    const candleStats = candleManager.stats();
    const ages = sharedStore.liveRows().map((x) => x.age_ms ?? 1e12);
    const maxAge = ages.length ? Math.max(...ages) : null;
    const storageOk = true; // repo opened at boot; failures would throw
    return {
      booted: this.bootPhase === "running",
      boot_ms: this.bootedAtMs ? Date.now() - this.bootedAtMs : 0,
      phase: this.bootPhase,
      health,
      last_stats_sweep_ms: sharedStore.lastStatsSweepAtMs,
      stats_age_ms: sharedStore.lastStatsSweepAtMs === null ? null : Date.now() - sharedStore.lastStatsSweepAtMs,
      live: sharedStore.liveSymbolCount(),
      scheduler: schedulerStats(),
      candles: { queueDepth: candleStats.queueDepth, fetchedTotal: candleStats.fetchedTotal },
      catalog_symbols: sharedStore.catalog.size,
      ai: await providerStatuses(),
      telegram: await telegramStateLive(),
      live_scan: liveScanState(),
      news: newsState(),
      storage: storageOk ? "OK" : "ERROR",
      uptime_ms: this.bootedAtMs ? Date.now() - this.bootedAtMs : 0,
      ttt_errors: sharedStore.tttErrors.length,
      errors_recent: sharedStore.tttErrors.slice(-10),
    };
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    stopLiveSignalScanner();
  }
}

function fin(v: number): boolean {
  return Number.isFinite(v) && v !== null;
}
/** Bar period from the ONE timeframe registry (no second table of periods). */
function tfMsOf(tf: TimeframeId): number {
  return getTimeframe(tf)!.minutes * 60_000;
}

/**
 * Timeframes whose bar closes the engine watches: the core hierarchy plus the
 * declared timeframe of every EXECUTABLE strategy (T05 T5). Deterministic,
 * de-duplicated, derived from the strategy registry — never a hand-kept list.
 * Exported for tests; the strategy registry is read-only here.
 */
export function closeWatchTimeframes(): TimeframeId[] {
  const set = new Set<TimeframeId>(CORE_TFS);
  for (const s of executableStrategies()) if (isTimeframe(s.timeframe)) set.add(s.timeframe);
  return [...set];
}

export const marketEngine = new MarketEngine();
export { TTT_RATE_PER_MIN };
export type { TimeframeId };
