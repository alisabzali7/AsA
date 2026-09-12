/**
 * Candle series manager: bounded backfill + per-close refresh + on-demand
 * loads with request coalescing, all inside the shared TTT rate budget.
 * History targets: 15m 700 / 1h 800 / 4h 900 (docs), others per timeframe
 * table; 1D native (verified) 320 bars. On-demand TFs fetched lazily.
 */
import { sharedStore, type MarketStore } from "./store";
import { tttClient } from "../ttt/client";
import { sharedScheduler } from "../ttt/scheduler";
import { getTimeframe, type TimeframeId } from "../domain/timeframes";
import { isOperationalSymbol, operationalUniverse } from "./operational-universe";
import type { CandleSeries } from "../domain/types";
import { eventBus } from "../events";
import { getHistoryStore } from "./history-store";
import { TTT_MAX_BARS_PER_REQUEST } from "./history";

interface QueueItem {
  symbol: string;
  tf: TimeframeId;
  priority: 0 | 1 | 2 | 3;
  why: "backfill" | "close" | "ondemand";
}

export class CandleManager {
  private store: MarketStore;
  private queue: QueueItem[] = [];
  private working = false;
  private inFlight = new Map<string, Promise<CandleSeries | null>>();
  /** bars we want per TF after trimming */
  private targetBars = new Map<TimeframeId, number>();
  private fetchedTotal = 0;

  constructor(store: MarketStore) {
    this.store = store;
  }

  setTarget(tf: TimeframeId, bars: number): void {
    this.targetBars.set(tf, bars);
  }

  stats() {
    return { queueDepth: this.queue.length, fetchedTotal: this.fetchedTotal, working: this.working };
  }

  /** Fill backfill work for all universe symbols for the given TFs. */
  enqueueBackfill(tfs: TimeframeId[], priority: 0 | 1 | 2 | 3 = 2): void {
    const focus = this.store.focusSymbol;
    const ordered = [focus, ...operationalUniverse().filter((s) => s !== focus)];
    for (const tf of tfs) {
      for (const symbol of ordered) {
        if (this.hasFreshEnough(symbol, tf, tf === "15m" || tf === "1h" || tf === "4h" ? 25 : 45)) continue;
        this.push({ symbol, tf, priority: symbol === focus ? 0 : priority, why: "backfill" });
      }
    }
    this.pump();
  }

  /** Schedule a refresh because a new candle closed on `tf` for `symbol`. */
  enqueueCloseRefresh(symbol: string, tf: TimeframeId): void {
    this.push({ symbol, tf, priority: symbol === this.store.focusSymbol ? 1 : 2, why: "close" });
    this.pump();
  }

  private push(item: QueueItem): void {
    const key = item.symbol + item.tf;
    if (this.queue.some((q) => q.symbol + q.tf === key)) return;
    this.queue.push(item);
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  private hasFreshEnough(symbol: string, tf: TimeframeId, maxAgeSec: number): boolean {
    const s = this.store.getSeries(symbol, tf);
    if (!s || s.candles.length < 50) return false;
    const ageSec = (Date.now() - s.fetched_at_ms) / 1000;
    return ageSec < maxAgeSec;
  }

  /** Single worker: process queue items sequentially, bounded by rate budget. */
  private pump(): void {
    if (this.working) return;
    this.working = true;
    void (async () => {
      try {
        while (this.queue.length > 0) {
          const item = this.queue.shift()!;
          // AUDIT FIX (P2): the pump used to keep a SECOND in-flight map keyed
          // `symbol+tf` while fetch() coalesces on `symbol+tf:target` — two
          // different key spaces that never matched, so the pump's check was
          // dead and cross-path requests duplicated venue calls. The pump now
          // relies on fetch()'s own coalescing (same key space) instead of
          // double-tracking.
          try {
            await this.fetch(item.symbol, item.tf);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/429/.test(msg) && !/rate_limited/.test(msg)) {
              this.store.recordError("candle", `udf ${item.symbol}@${item.tf}`, msg);
            }
          }
        }
      } finally {
        this.working = false;
      }
    })();
  }

  async fetch(symbol: string, tf: TimeframeId, wantBars?: number): Promise<CandleSeries | null> {
    const key = symbol + tf;
    const spec = getTimeframe(tf)!;
    // per-request depth override (backtests want long windows); cached series of
    // a DIFFERENT depth are still replaced (caller chose a different target)
    const defaultTarget = this.targetBars.get(tf) ?? spec.backfillTarget;
    // TTT_MAX_BARS_PER_REQUEST is the venue RESPONSE cap for one request, not a
    // retention policy — deeper history is assembled by the chunked history
    // manager and served from the durable store.
    const target = wantBars !== undefined
      ? Math.min(TTT_MAX_BARS_PER_REQUEST, Math.max(defaultTarget, Math.floor(wantBars)))
      : defaultTarget;
    const keyT = `${key}:${target}`;
    const existing = this.inFlight.get(keyT);
    if (existing) return existing; // coalescing: concurrent callers share one fetch
    const p = this.doFetch(symbol, tf, spec.tttResolution, spec.minutes, target).then((s) => {
      this.fetchedTotal++;
      return s;
    });
    this.inFlight.set(keyT, p);
    try {
      return await p;
    } finally {
      this.inFlight.delete(keyT);
    }
  }

  private async doFetch(symbol: string, tf: TimeframeId, resolution: string, minutes: number, target: number): Promise<CandleSeries | null> {
    await sharedScheduler.acquire(tf === "15m" || tf === "4h" ? 1 : 2);
    const toSec = Math.floor(Date.now() / 1000);
    // request a window slightly wider than the target to survive gaps
    const fromSec = toSec - target * minutes * 60 * 1.05 - 900;
    let series: CandleSeries;
    if (tf === "1d") {
      series = await tttClient.getDailyCandles(symbol, target);
    } else {
      const res = await tttClient.getUdfHistory({
        symbol,
        resolution,
        fromSec,
        toSec,
        countback: Math.min(target + 20, TTT_MAX_BARS_PER_REQUEST),
        tfMinutes: minutes,
      });
      series = res.series;
    }
    // PERSIST EVERYTHING FETCHED BEFORE TRIMMING (remediation §5, §9, §18).
    // The in-memory series is a hot working window; the durable history store
    // is the retention layer. Trimming the RAM copy must never lose history.
    try {
      if (series.candles.length > 0) {
        getHistoryStore().put(symbol, tf, series.candles);
      }
    } catch {
      /* persistence is best-effort here; syncHistory() is the authoritative path */
    }
    // Trim the IN-MEMORY window only (bounded RAM). This is NOT a historical
    // limit: /api/market/history serves the full stored range from disk.
    if (series.candles.length > target) {
      series.candles = series.candles.slice(-target);
    }
    series.timeframe = tf; // canonical id
    series.closed_count = series.candles.length;
    const prev = this.store.getSeries(symbol, tf);
    this.store.putSeries(series);
    this.store.computeCoverage(symbol, tf, series, Date.now());
    // close detection: a NEWEST bar whose open time is older than previous max
    if (prev && prev.candles.length > 0 && series.candles.length > 0) {
      const lastNew = series.candles[series.candles.length - 1].t;
      const lastOld = prev.candles[prev.candles.length - 1].t;
      if (lastNew > lastOld && series.candles.length > 1 && lastNew !== series.candles[0].t) {
        eventBus.emit("candle.closed", { symbol, timeframe: tf, close_time_ms: lastNew * 1000 });
      }
    }
    return series;
  }

  /** On-demand load with coalescing; used by API + analysis paths. */
  async ensureSeries(symbol: string, tf: TimeframeId, force = false, wantBars?: number): Promise<CandleSeries | null> {
    if (!isOperationalSymbol(symbol)) return null;
    const cached = this.store.getSeries(symbol, tf);
    const ageMs = cached ? Date.now() - cached.fetched_at_ms : Infinity;
    if (!force && cached && cached.candles.length > 0 && ageMs < 45_000) return cached;
    return this.fetch(symbol, tf, wantBars);
  }
}

export const candleManager = new CandleManager(sharedStore);
