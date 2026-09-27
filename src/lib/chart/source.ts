/** Stable reference to the exact OHLCV input used for a decision, not a copy. */
import { createHash } from "node:crypto";
import type { Candle } from "../domain/types";

export interface ChartSource {
  from_s: number;
  to_s: number;
  bars: number;
  sha256: string;
}
export function chartSource(candles: Candle[]): ChartSource {
  return {
    from_s: candles[0]?.t ?? 0, to_s: candles.at(-1)?.t ?? 0, bars: candles.length,
    sha256: createHash("sha256").update(JSON.stringify(candles.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]))).digest("hex"),
  };
}
export function validChartSource(source: ChartSource | null | undefined, anchorSec: number): source is ChartSource {
  return !!source && Number.isFinite(source.from_s) && source.from_s > 0 && source.to_s === anchorSec
    && source.from_s <= source.to_s && Number.isInteger(source.bars) && source.bars > 0
    && typeof source.sha256 === "string" && /^[0-9a-f]{64}$/.test(source.sha256);
}
export function verifiedChartCandles(candles: Candle[], source: ChartSource): Candle[] {
  if (!validChartSource(source, source?.to_s)) return [];
  const selected = candles.filter((c) => c.t >= source.from_s && c.t <= source.to_s);
  const observed = chartSource(selected);
  return observed.bars === source.bars && observed.sha256 === source.sha256 ? selected : [];
}
