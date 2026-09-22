/**
 * Typed in-process event bus (docs/architecture taxonomy) feeding SSE.
 * The engine emits domain events; the SSE hub relays them to browsers.
 */
import type { AppState } from "./domain/types";

export type AsaEventType =
  | "system.health.changed"
  | "market.stats.updated"
  | "price.updated"
  | "candles.updated"
  | "candle.closed"
  | "trade.received"
  | "orderbook.updated"
  | "funding.updated"
  | "analysis.updated"
  | "ai.state"
  | "opportunity.created"
  | "opportunity.updated"
  | "signal.created"
  | "signal.publish.refused"
  | "scan.completed"
  | "news.created"
  | "backtest.completed"
  | "system";

export interface AsaEventBase<T extends AsaEventType> {
  type: T;
  ts: number;
}
export interface AsaEventMap {
  "system.health.changed": { state: AppState; reason?: string };
  "market.stats.updated": { symbols: number; max_age_ms: number };
  "price.updated": { symbol: string; price: number | null; age_ms: number };
  "candles.updated": { symbol: string; timeframe: string; bars: number };
  "candle.closed": { symbol: string; timeframe: string; close_time_ms: number };
  "trade.received": { symbol: string; count: number };
  "orderbook.updated": { symbol: string; asks: number; bids: number };
  "funding.updated": { symbol: string; rate: number | null };
  "analysis.updated": { symbol: string; timeframe: string };
  "ai.state": { state: string; provider?: string };
  "opportunity.created": { id: string; symbol: string };
  "opportunity.updated": { id: string; state: string };
  "signal.created": { id: string; symbol: string; state: string };
  /** T05 T4: a READY live decision reached publishSignal and was refused (exact reason) */
  "signal.publish.refused": { id: string; symbol: string; opportunity_id: string; reason: string };
  /**
   * T05 T4: one live scan (symbol x strategy setup) finished. `outcome` is the
   * honest result class; `duration_ms` is INTERNAL wall time of scanSymbol
   * (includes the candle fetch when one happened — see `reason`).
   */
  "scan.completed": {
    symbol: string;
    timeframe: string;
    setup_id: string;
    /** candle.closed = bar boundary; candles.updated = first sighting of a bar after (re)start / other fetch paths; manual = API/test */
    trigger: "candle.closed" | "candles.updated" | "manual";
    outcome: "published" | "already_published" | "publish_refused" | "not_ready" | "no_opportunity" | "not_evaluated" | "error";
    reason: string | null;
    opportunity_id: string | null;
    duration_ms: number;
  };
  "news.created": { id: string; title: string };
  "backtest.completed": { jobId: string };
  system: { message: string; level: "info" | "warn" | "error" };
}
export type AsaEvent<K extends AsaEventType = AsaEventType> = AsaEventBase<K> & AsaEventMap[K];

type Listener = (e: AsaEvent) => void;

class EventBus {
  private listeners = new Set<Listener>();
  private ring: AsaEvent[] = [];

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit<K extends AsaEventType>(type: K, payload: AsaEventMap[K]): void {
    const e = { type, ts: Date.now(), ...payload } as AsaEvent;
    this.ring.push(e);
    if (this.ring.length > 300) this.ring.shift();
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* listener errors never break the bus */
      }
    }
  }

  recent(limit = 100): AsaEvent[] {
    return this.ring.slice(-limit);
  }
}

export const eventBus = new EventBus();
