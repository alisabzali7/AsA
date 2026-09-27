/**
 * DIVERGENCE — technical evidence only, PARTIALLY SPECIFIED (Team 02 recovery).
 *
 * What the source defines (RAW_1:889-912, VERIFIED):
 *   regular bearish — price HH while the indicator makes LH       (RAW_1:891)
 *   regular bullish — price LL while the indicator makes HL       (RAW_1:892)
 *   hidden bullish  — price HL while the indicator makes LL       (RAW_1:912)
 *   "healthy market" — price and indicator agree → NOT divergence (RAW_1:797)
 *   indicators: RSI and MACD (lines + histogram)                 (RAW_1:768)
 *
 * What the source does NOT define (kept explicit, never invented):
 *   - hidden bearish: not stated in the corpus                    → NOT_IN_SOURCE
 *   - MACD parameters: never stated; MACD is not implemented      → UNKNOWN
 *   - "full confirmation" (RSI + MACD lines + histogram, RAW_1:787)
 *     and the MACD colour-cycle rule (RAW_1:794) need MACD        → UNKNOWN
 *   - pivot pairing / lookback: not stated                        → ENGINEERING:
 *     consecutive confirmed fractal swings of the same kind, RSI read at the
 *     pivot bars.
 *
 * Causality: a divergence is knowable only when its SECOND pivot is confirmed
 * (`confirmed_index`), never at the pivot bar itself.
 *
 * Output is evidence for downstream consumers. It carries no direction to
 * trade, entry, score or probability.
 */
import type { Candle } from "../domain/types";
import type { SwingPoint } from "./structure";

export const DIVERGENCE_VERSION = "1.0.0";

export type DivergenceKind = "regular_bullish" | "regular_bearish" | "hidden_bullish";

export interface DivergencePoint { index: number; t: number; price: number; value: number }

export interface DivergenceEvent {
  kind: DivergenceKind;
  indicator: "RSI14";
  from: DivergencePoint;
  to: DivergencePoint;
  confirmed_index: number;
  confirmed_t: number;
}

export interface DivergenceResult {
  version: string;
  spec_status: "PARTIAL";
  indicator: "RSI14";
  /** most recent first-confirmed last, ascending by confirmation, at most 5 */
  events: DivergenceEvent[];
  unsupported: {
    hidden_bearish: "NOT_IN_SOURCE";
    macd_confirmation: "UNKNOWN";
    macd_cycle_rule: "UNKNOWN";
  };
  pairing: "ENGINEERING: consecutive confirmed fractal swings of the same kind; RSI read at pivot bars";
  reason: string;
}

export function detectRsiDivergences(candles: Candle[], swings: SwingPoint[], rsi14: (number | null)[], maxEvents = 5): DivergenceResult {
  const out: DivergenceEvent[] = [];
  const point = (s: SwingPoint): DivergencePoint | null => {
    const v = rsi14[s.index];
    return v === null || v === undefined || !Number.isFinite(v) ? null : { index: s.index, t: s.t, price: s.price, value: v };
  };
  for (const kind of ["high", "low"] as const) {
    const list = swings.filter((s) => s.kind === kind);
    for (let i = 1; i < list.length; i++) {
      const a = point(list[i - 1]), b = point(list[i]);
      if (!a || !b) continue;
      let k: DivergenceKind | null = null;
      if (kind === "high" && b.price > a.price && b.value < a.value) k = "regular_bearish";
      else if (kind === "low" && b.price < a.price && b.value > a.value) k = "regular_bullish";
      else if (kind === "low" && b.price > a.price && b.value < a.value) k = "hidden_bullish";
      if (k) out.push({ kind: k, indicator: "RSI14", from: a, to: b, confirmed_index: list[i].confirmed_index, confirmed_t: list[i].confirmed_t });
    }
  }
  out.sort((x, y) => x.confirmed_index - y.confirmed_index || x.to.index - y.to.index || x.kind.localeCompare(y.kind));
  const events = out.slice(-maxEvents);
  return {
    version: DIVERGENCE_VERSION,
    spec_status: "PARTIAL",
    indicator: "RSI14",
    events,
    unsupported: { hidden_bearish: "NOT_IN_SOURCE", macd_confirmation: "UNKNOWN", macd_cycle_rule: "UNKNOWN" },
    pairing: "ENGINEERING: consecutive confirmed fractal swings of the same kind; RSI read at pivot bars",
    reason: events.length ? `${out.length} RSI divergences in window (showing ${events.length}); MACD confirmation UNKNOWN` : "no RSI divergence between consecutive confirmed swings",
  };
}
