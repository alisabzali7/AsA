/**
 * Live signal scanner — the RUNTIME TRIGGER for the canonical Team 05 path
 * (T05 T4):
 *
 *   authoritative market state (candle.closed) → scanSymbol (existing
 *   decision/admission) → publishSignal (final risk boundary, exactly-once)
 *   → telegram_outbox → drainOutbox (existing 60s timer)
 *
 * Before this module `scanSymbol` / `publishSignal` had NO production caller:
 * the engine only ran `expireStaleSignals` and the outbox drain, so a running
 * instance could never publish a signal on its own. This module adds the
 * missing link WITHOUT a second scanner, a second publication path or a new
 * polling loop:
 *
 *  - TRIGGER = the existing `candle.closed` event, which the candle manager
 *    emits when the market engine's close-refresh (7s stats sweep →
 *    `scheduleCloseRefreshes` → `enqueueCloseRefresh` → fetch) observes a NEW
 *    closed bar for symbol×timeframe. A scan therefore happens exactly when the
 *    strategy's own timeframe closes — never on a fixed global poll.
 *  - SCOPE = only executable strategies whose declared timeframe equals the
 *    closed bar's timeframe (each strategy declares its own timeframe).
 *  - IDEMPOTENCY = repeated events / overlapping scans for the same
 *    symbol×setup×bar coalesce in-process (dedupe on close time + in-flight
 *    join) AND, independently, `scanSymbol` derives the SAME stable
 *    opportunity id (`idFor` symbol|tf|direction|strategy|anchor) so
 *    `publishSignal` is an idempotent no-op across processes/restarts. Terminal
 *    signals are never resurrected (`publishActionFor`).
 *  - NO decision logic lives here. Blocked decisions stay blocked upstream
 *    (admission → REJECTED → publishSignal never called) and at the final
 *    boundary (publishSignal refuses anything but an explicit risk PASS).
 *
 * Observability: one `scan.completed` event per symbol×setup scan with the
 * honest outcome class and INTERNAL duration (a candle fetch may be part of
 * it — it is never presented as pure compute), plus `liveScanState()` for the
 * status endpoint. Nothing here executes trades. Telegram stays transport-only.
 */
import { eventBus, type AsaEvent, type AsaEventMap } from "../events";
import { sharedStore } from "../market/store";
import { executableStrategies, type StrategyRuntimeDefinition } from "../strategy/runtime";
import { scanSymbol, type ScanOutcome } from "./orchestrator";

export type LiveScanTrigger = AsaEventMap["scan.completed"]["trigger"];
export type LiveScanOutcomeKind = AsaEventMap["scan.completed"]["outcome"];

export interface LiveScanResult {
  symbol: string;
  timeframe: string;
  setup_id: string;
  outcome: LiveScanOutcomeKind;
  reason: string | null;
  opportunity_id: string | null;
  signal_id: string | null;
  duration_ms: number;
}

export interface LiveScanState {
  /** true once startLiveSignalScanner() attached to the event bus */
  subscribed: boolean;
  scans_total: number;
  published_total: number;
  refused_total: number;
  errors_total: number;
  /** currently running symbol×setup scans (no global lock — per-key only) */
  in_flight: number;
  last_scan_ms: number | null;
  last_publish_ms: number | null;
  last_publish_signal_id: string | null;
  last_error: string | null;
}

const state: LiveScanState = {
  subscribed: false,
  scans_total: 0,
  published_total: 0,
  refused_total: 0,
  errors_total: 0,
  in_flight: 0,
  last_scan_ms: null,
  last_publish_ms: null,
  last_publish_signal_id: null,
  last_error: null,
};

/** In-flight coalescing key. Different close times are different scans. */
export function liveScanFlightKey(symbol: string, setupId: string, closeTimeMs?: number | null): string {
  // Different bars MUST NOT join each other: a slow scan of bar A completing
  // after bar B closed used to return A's result for B and drop B. Concurrent
  // identical (symbol, setup, bar) scans still coalesce.
  return `${symbol}|${setupId}|${closeTimeMs ?? "na"}`;
}

/** symbol|setup|bar -> in-flight scan (concurrent identical scans join it) */
const inFlight = new Map<string, Promise<LiveScanResult>>();
/** symbol|setup_id -> close_time_ms already scanned (duplicate event guard) */
const lastClose = new Map<string, number>();
let unsubscribe: (() => void) | null = null;

export function liveScanState(): LiveScanState {
  return { ...state, in_flight: inFlight.size };
}

/** Honest outcome class for one ScanOutcome (no interpretation beyond the contract). */
export function classifyScanOutcome(o: ScanOutcome): { outcome: LiveScanOutcomeKind; reason: string | null } {
  if (!o.evaluated) return { outcome: "not_evaluated", reason: o.reason ?? null };
  if (!o.opportunity) return { outcome: "no_opportunity", reason: o.reason ?? null };
  if (o.opportunity.state !== "READY") {
    return { outcome: "not_ready", reason: `${o.opportunity.state}: ${o.opportunity.blocked_factors.join("; ") || o.reason || "not admitted"}` };
  }
  if (!o.publish) return { outcome: "not_ready", reason: "READY but publication boundary not reached (non-live mode)" };
  if (o.publish.published) {
    return o.publish.reason.startsWith("already published")
      ? { outcome: "already_published", reason: o.publish.reason }
      : { outcome: "published", reason: o.publish.reason };
  }
  return { outcome: "publish_refused", reason: o.publish.reason };
}

/**
 * Scan ONE symbol against ONE strategy setup through the canonical pipeline.
 * Concurrent calls for the same symbol×setup join the in-flight scan;
 * different symbols/setups run independently.
 */
export function runLiveScanFor(
  symbol: string,
  strategy: StrategyRuntimeDefinition,
  trigger: LiveScanTrigger,
  opts: { close_time_ms?: number | null; forceRefresh?: boolean } = {},
): Promise<LiveScanResult> {
  const key = liveScanFlightKey(symbol, strategy.setup_id, opts.close_time_ms);
  const joined = inFlight.get(key);
  if (joined) return joined;

  const startedAt = Date.now();
  const p = (async (): Promise<LiveScanResult> => {
    const base = { symbol, timeframe: strategy.timeframe, setup_id: strategy.setup_id };
    let result: LiveScanResult;
    try {
      const out = await scanSymbol(symbol, strategy, "live", { forceRefresh: opts.forceRefresh ?? false });
      const cls = classifyScanOutcome(out);
      result = {
        ...base,
        outcome: cls.outcome,
        reason: cls.reason,
        opportunity_id: out.opportunity?.id ?? null,
        signal_id: out.publish?.id ?? null,
        duration_ms: Date.now() - startedAt,
      };
      if (cls.outcome === "published") {
        state.published_total++;
        state.last_publish_ms = Date.now();
        state.last_publish_signal_id = result.signal_id;
      } else if (cls.outcome === "publish_refused") {
        state.refused_total++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.errors_total++;
      state.last_error = msg;
      result = { ...base, outcome: "error", reason: msg, opportunity_id: null, signal_id: null, duration_ms: Date.now() - startedAt };
    }
    state.scans_total++;
    state.last_scan_ms = Date.now();
    if (opts.close_time_ms != null) lastClose.set(`${symbol}|${strategy.setup_id}`, opts.close_time_ms);
    eventBus.emit("scan.completed", {
      symbol,
      timeframe: strategy.timeframe,
      setup_id: strategy.setup_id,
      trigger,
      outcome: result.outcome,
      reason: result.reason,
      opportunity_id: result.opportunity_id,
      duration_ms: result.duration_ms,
    });
    return result;
  })();
  inFlight.set(key, p);
  void p.finally(() => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  return p;
}

/**
 * Scan one symbol×timeframe against every executable strategy declared on
 * that timeframe. `close_time_ms` (from candle.closed) dedupes repeated events
 * for the same bar. Returns the per-setup results (empty when no strategy
 * trades that timeframe — nothing is scanned, nothing is fabricated).
 */
export async function runLiveScan(
  symbol: string,
  timeframe: string,
  trigger: LiveScanTrigger,
  opts: { close_time_ms?: number | null; strategies?: StrategyRuntimeDefinition[]; forceRefresh?: boolean } = {},
): Promise<LiveScanResult[]> {
  const strategies = (opts.strategies ?? executableStrategies()).filter((s) => s.timeframe === timeframe);
  const jobs: Promise<LiveScanResult>[] = [];
  for (const strategy of strategies) {
    const dedupeKey = `${symbol}|${strategy.setup_id}`;
    const flight = liveScanFlightKey(symbol, strategy.setup_id, opts.close_time_ms);
    if (opts.close_time_ms != null && lastClose.get(dedupeKey) === opts.close_time_ms && !inFlight.has(flight)) continue; // same bar already scanned
    jobs.push(runLiveScanFor(symbol, strategy, trigger, { close_time_ms: opts.close_time_ms, forceRefresh: opts.forceRefresh }));
  }
  return Promise.all(jobs);
}

/**
 * Attach the live scanner to the existing event sources:
 *
 *  - `candle.closed` — a NEW bar was observed for a series already in memory
 *    (the engine's close-refresh path). Primary trigger.
 *  - `candles.updated` — a series was (re)stored by ANY fetch path, including
 *    the boot backfill. T05 T5 restart correctness: after a restart the first
 *    fetch of every series has no previous copy, so `candle.closed` cannot
 *    fire until the NEXT bar boundary (≤1 h for 1h strategies, ≤24 h for 1d).
 *    The scanner therefore also treats the first sighting of a bar per
 *    symbol×setup as a trigger. It is NOT a poll: it reacts to stores the
 *    engine already performs, reads the in-memory series (no venue call), and
 *    dedupes on the newest bar's open time — a series re-stored with the same
 *    newest bar is ignored, and a bar already handled via `candle.closed`
 *    joins/skips. Stale data cannot leak: `scanSymbol` applies its own 2-bar
 *    staleness gate and the persisted lifecycle keeps publication idempotent.
 *
 * Idempotent: a second call (HMR re-import, repeated engine boot) does not add
 * a second subscription. Returns the detach function.
 */
export function startLiveSignalScanner(
  opts: { strategies?: () => StrategyRuntimeDefinition[] } = {},
): () => void {
  if (unsubscribe) return unsubscribe;
  const listener = (e: AsaEvent): void => {
    if (e.type === "candle.closed") {
      const ev = e as AsaEvent<"candle.closed">;
      void runLiveScan(ev.symbol, ev.timeframe, "candle.closed", {
        close_time_ms: ev.close_time_ms,
        strategies: opts.strategies?.(),
      });
      return;
    }
    if (e.type === "candles.updated") {
      const ev = e as AsaEvent<"candles.updated">;
      const strategies = (opts.strategies?.() ?? executableStrategies()).filter((s) => s.timeframe === ev.timeframe);
      if (strategies.length === 0) return; // no executable strategy trades this timeframe — nothing to do
      // Deferred one tick: the candle manager emits `candles.updated` (store)
      // immediately followed by `candle.closed` (boundary) for the same fetch.
      // Letting the boundary event run first keeps it the recorded trigger;
      // this handler then simply joins that in-flight scan.
      setImmediate(() => {
        const series = sharedStore.getSeries(ev.symbol, ev.timeframe);
        const last = series?.candles[series.candles.length - 1];
        if (!last) return;
        const barMs = last.t * 1000;
        // only when this bar is NEW for at least one setup (dedupe key = newest bar open time)
        if (strategies.every((s) => lastClose.get(`${ev.symbol}|${s.setup_id}`) === barMs)) return;
        void runLiveScan(ev.symbol, ev.timeframe, "candles.updated", { close_time_ms: barMs, strategies });
      });
    }
  };
  const off = eventBus.subscribe(listener);
  state.subscribed = true;
  unsubscribe = () => {
    off();
    unsubscribe = null;
    state.subscribed = false;
  };
  eventBus.emit("system", { message: "live signal scanner attached to candle.closed + candles.updated (scanSymbol → publishSignal → outbox)", level: "info" });
  return unsubscribe;
}

/** Detach the scanner (engine stop / tests). Safe when not started. */
export function stopLiveSignalScanner(): void {
  unsubscribe?.();
}

/** Test/ops helper: forget in-process dedupe state (persistence idempotency still holds). */
export function resetLiveScanDedupe(): void {
  lastClose.clear();
}
