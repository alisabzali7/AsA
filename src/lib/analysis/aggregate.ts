/**
 * Higher-timeframe aggregation (closure §L).
 *
 * NO-LOOKAHEAD: only COMPLETE buckets are emitted. The bucket currently being
 * formed is dropped, because including it would leak information about a bar
 * that has not closed yet.
 *
 * Provenance: series built this way are DERIVED, never NATIVE. Callers must
 * label them accordingly so the UI never presents an aggregate as venue data.
 *
 * Hardened contract (Task 08):
 * - Minutes parameter must be an integer >= 1. Invalid minutes yield [].
 * - Non-finite candle fields yield [].
 */
import type { Candle } from "../domain/types";

function hasNonFiniteCandles(candles: Candle[]): boolean {
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (
      !c ||
      !Number.isFinite(c.t) ||
      !Number.isFinite(c.o) ||
      !Number.isFinite(c.h) ||
      !Number.isFinite(c.l) ||
      !Number.isFinite(c.c)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Aggregate ascending closed candles into `minutes`-sized buckets.
 * A bucket is emitted only when the following candle starts a new bucket,
 * which guarantees the forming bucket is never returned.
 */
export function aggregateClosed(candles: Candle[], minutes: number): Candle[] {
  if (
    candles.length === 0 ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    hasNonFiniteCandles(candles)
  ) {
    return [];
  }

  const step = minutes * 60;
  const out: Candle[] = [];
  let bucketStart = Math.floor(candles[0].t / step) * step;
  let o = candles[0].o, h = candles[0].h, l = candles[0].l, c = candles[0].c, v = candles[0].v;
  let started = false;

  for (const k of candles) {
    const b = Math.floor(k.t / step) * step;
    if (!started) {
      bucketStart = b; o = k.o; h = k.h; l = k.l; c = k.c; v = k.v; started = true;
      continue;
    }
    if (b === bucketStart) {
      h = Math.max(h, k.h);
      l = Math.min(l, k.l);
      c = k.c;
      v += k.v;
    } else {
      out.push({ t: bucketStart, o, h, l, c, v });
      bucketStart = b; o = k.o; h = k.h; l = k.l; c = k.c; v = k.v;
    }
  }
  // the final (still-forming) bucket is intentionally NOT emitted
  return out;
}
