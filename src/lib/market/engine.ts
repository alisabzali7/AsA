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
import { isOperationalSymbol, operationalUniverse, refreshOperationalUniverse, universeSource, universeState, type RefreshResult } from "./operational-universe";
import { CORE_TFS, getTimeframe, isTimeframe, type TimeframeId } from "../domain/timeframes";
import { executableStrategies } from "../strategy/runtime";
import { getRepo } from "../../db/sqlite";
import { recordOiSnapshot } from "../psychology/engine";
import { startNewsPolling, stopNewsPolling, newsState } from "../fundamental/engine";
import { startRetentionJob, stopRetentionJob, runRetention } from "../retention";
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
  universe: { source: string; state: string; count: number };
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
  private lastFundingSymbol: string | null = null;
  private retentionKickoff: ReturnType<typeof setTimeout> | null = null;

  /**
   * Idempotent boot. Resolves once the runtime loops are attached.
   *
   * Startup is deliberately fail-soft for TTT: discovery/stats may be
   * unavailable at process boot, but that must not prevent the recovery loops
   * from starting. Fatal local initialization failures (for example SQLite
   * open/migration) still fail closed and leave the engine idle for a retry.
   */
  async start(): Promise<void> {
    if (this.bootPhase !== "idle") return;
    this.bootPhase = "starting";
    this.bootedAtMs = Date.now();
    try {
      // repo warm-up (durable tables). A local persistence failure is fatal:
      // without it the runtime cannot safely persist opportunities/history.
      getRepo();
      this.configureCandleTargets();

      // 0) DISCOVERY FIRST (remediation P0-1): the operational universe must be
      //    resolved from TTT BEFORE catalog ingestion, the stats sweep or the
      //    backfill loop run. A discovery outage is recorded, not thrown; the
      //    stats/discovery loops below keep retrying so boot-time TTT downtime
      //    can recover without a process restart.
      await this.refreshDiscovery(true, "boot");

      // 1) first stats sweep is attempted before the loops are attached, but a
      //    transient TTT failure must not abort boot. `sweepStats` records its
      //    own error and leaves health CONNECTING/STALE rather than inventing
      //    readiness.
      await this.sweepStats();

      // 2) background candle backfill (core + strategy timeframes) — non-blocking.
      //    If discovery was not ready at boot this queues nothing; the stats
      //    recovery path and the periodic discovery loop both enqueue once a
      //    real universe exists.
      candleManager.enqueueBackfill(closeWatchTimeframes());

      // 3) periodic loops. These must be attached even after an initial TTT
      //    failure; otherwise a transient venue outage at process boot becomes a
      //    permanent market outage until a manual restart/request retry.
      this.interval("stats", STATS_INTERVAL_MS, () => this.sweepStats());
      this.interval("tape", TAPE_INTERVAL_MS, () => this.sweepTape());
      this.interval("book", BOOK_INTERVAL_MS, () => this.sweepBook());
      // health hook only: the scheduler is timer/event driven and never needs
      // this tick to make progress (no polling loop anywhere)
      this.interval("recover", RECOVER_INTERVAL_MS, () => activeScheduler().recover());
      // probe the notifier before draining so state is measured, never assumed
      this.interval("outbox", OUTBOX_INTERVAL_MS, async () => { await probeTelegram(); await drainOutbox(); });
      this.interval("signals", 10 * 60_000, () => { expireStaleSignals(); });
      // T05 T4: the live signal path. Event-driven off the SAME candle-close
      // detection this engine already runs (scheduleCloseRefreshes → fetch →
      // candle.closed); no extra polling loop. Idempotent to attach.
      startLiveSignalScanner();
      this.interval("health", HEALTH_INTERVAL_MS, () => this.publishHealth());
      // periodic re-discovery: post-boot listings are ingested into the catalog
      // and queued for candles through the SAME discovery/catalog path.
      this.interval("discovery", 10 * 60_000, async () => { await this.refreshDiscovery(true, "periodic"); });
      // funding history lane for the focus symbol (30 min cadence + immediate).
      this.interval("funding", FUNDING_INTERVAL_MS, () => this.fundingLane());
      void this.fundingLane();
      // housekeeping: news poll + retention + outbox flush at boot
      startNewsPolling();
      this.retentionKickoff = setTimeout(() => { try { runRetention(); } catch { /* logged inside */ } }, 45_000);
      startRetentionJob();
      this.bootPhase = "running";
      eventBus.emit("system", {
        message: `engine booted: catalog ${sharedStore.catalog.size}/${operationalUniverse().length} operational symbols (source: ${universeSource()}, state: ${universeState()}); first stats sweep attempted`,
        level: "info",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sharedStore.recordError("boot", "start", msg);
      this.stop();
      this.bootPhase = "idle";
      this.bootedAtMs = null;
      throw err;
    }
  }

  private configureCandleTargets(): void {
    for (const tf of CORE_TFS) candleManager.setTarget(tf, tf === "15m" ? 700 : tf === "1h" ? 800 : 900);
    candleManager.setTarget("1d", 320);
  }

  /**
   * Refresh TTT discovery, ingest the matching catalog snapshot, repair focus
   * if the previous symbol disappeared, and queue initial history for newly
   * available symbols. This is the ONE runtime discovery/catalog transition:
   * boot, recovery after TTT downtime, and periodic listing refresh all use it.
   */
  private async refreshDiscovery(force: boolean, reason: "boot" | "stats-recovery" | "periodic"): Promise<RefreshResult> {
    const before = operationalUniverse().join("|");
    const disc = await refreshOperationalUniverse(force);
    if (disc.error) {
      sharedStore.recordError("discovery", "/futures/markets", `market discovery failed (${reason}): ${disc.error}; universe state=${universeState()}`);
      return disc;
    }

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

    if (disc.symbols.length > 0 && !isOperationalSymbol(sharedStore.focusSymbol)) {
      sharedStore.setFocus(disc.symbols[0]);
    }

    const after = operationalUniverse().join("|");
    if (after !== before || reason === "boot") {
      candleManager.enqueueBackfill(closeWatchTimeframes());
    }

    eventBus.emit("system", {
      message: `catalog ingested for ${catalogN}/${operationalUniverse().length} operational symbols (source: ${universeSource()}, state: ${universeState()}, reason: ${reason})`,
      level: "info",
    });
    return disc;
  }

  private interval(name: string, ms: number, fn: () => void | Promise<void>): void {
    const t = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((err) => {
          sharedStore.recordError("loop", name, err instanceof Error ? err.message : String(err));
        });
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
      if (universeState() === "NOT_READY" || universeState() === "NETWORK_FAILURE" || universeState() === "INVALID_RESPONSE") {
        await this.refreshDiscovery(false, "stats-recovery");
      }
      const universe = operationalUniverse();
      if (universe.length === 0) {
        throw new Error(`operational universe is ${universeState()} (no symbols available for stats sweep)`);
      }

      // lane intent only (Task 1): admission is charged by the transport
      const { rows, provenance } = await tttClient.getStats(PRIORITY.SWEEP);
      const now = Date.now();
      let updated = 0;
      let measuredPrices = 0;
      const universeSet = new Set(universe);
      for (const r of rows) {
        if (!universeSet.has(r.symbol)) continue; // excludes TONUSDT etc.
        const lastPrice = fin(num(r.lastPrice)) ? num(r.lastPrice) : null;
        const markPrice = fin(num(r.markPrice)) ? num(r.markPrice) : null;
        const indexPrice = fin(num(r.indexPrice)) ? num(r.indexPrice) : null;
        const statsRow: SymbolStats = {
          symbol: r.symbol,
          lastPrice,
          markPrice,
          indexPrice,
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
        if (lastPrice !== null) measuredPrices++;
        if (fin(statsRow.openInterest ?? NaN)) recordOiSnapshot(r.symbol, statsRow.openInterest as number);
        updated++;
      }
      if (updated === 0) {
        throw new Error(`TTT stats response contained no rows for the ${universe.length}-symbol operational universe`);
      }
      if (measuredPrices === 0) {
        throw new Error(`TTT stats response contained ${updated} operational row(s) but no finite lastPrice measurements`);
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
      if (!isOperationalSymbol(symbol)) {
        throw new Error(`focus symbol ${symbol} is not ready in the operational universe (state=${universeState()})`);
      }
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
      if (!isOperationalSymbol(symbol)) {
        throw new Error(`focus symbol ${symbol} is not ready in the operational universe (state=${universeState()})`);
      }
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
    const symbol = sharedStore.focusSymbol;
    if (this.lastFundingSymbol === symbol && Date.now() - this.lastFundingLaneAtMs < FUNDING_INTERVAL_MS - 30_000) return;
    try {
      if (!isOperationalSymbol(symbol)) {
        throw new Error(`focus symbol ${symbol} is not ready in the operational universe (state=${universeState()})`);
      }
      const { page, provenance } = await tttClient.getFundingHistory(symbol, 1, PRIORITY.SWEEP);
      sharedStore.fundingHistory = { symbol, page, provenance };
      const stats = sharedStore.getStats(symbol);
      eventBus.emit("funding.updated", { symbol, rate: stats?.fundingRate ?? null });
      this.lastFundingLaneAtMs = Date.now();
      this.lastFundingSymbol = symbol;
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
      universe: { source: universeSource(), state: universeState(), count: operationalUniverse().length },
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
    if (this.retentionKickoff) {
      clearTimeout(this.retentionKickoff);
      this.retentionKickoff = null;
    }
    stopLiveSignalScanner();
    stopNewsPolling();
    stopRetentionJob();
    this.bootPhase = "idle";
    this.bootedAtMs = null;
    this.statsLoop.running = false;
    this.tapeLoop.running = false;
    this.bookLoop.running = false;
  }

  isRunning(): boolean {
    return this.bootPhase === "running";
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
