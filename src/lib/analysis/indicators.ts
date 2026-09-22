/**
 * Deterministic technical indicators over canonical candles.
 * Pure functions; no state; suitable for live + backtest + tests.
 *
 * Hardened contracts (Task 07):
 * - Period validity: period must be a positive integer (>= 1). Invalid periods yield safe null arrays.
 * - Non-finite input protection: any non-finite input value (NaN, Infinity, -Infinity) yields safe null arrays.
 * - Output length invariant: exactly matches input length across all inputs.
 * - Zero denominator / edge safety: preserves Wilder RSI and True Range canonical semantics.
 */
import type { Candle } from "../domain/types";

function isValidPeriod(period: number): boolean {
  return Number.isInteger(period) && period >= 1;
}

function hasNonFiniteNumbers(arr: number[]): boolean {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) return true;
  }
  return false;
}

function hasNonFiniteCandleOhlc(candles: Candle[]): boolean {
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (
      !c ||
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

export function ema(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (!isValidPeriod(period) || hasNonFiniteNumbers(values) || n < period) {
    return out;
  }

  const k = 2 / (period + 1);
  let prev: number | null = null;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (i < period) {
      sum += values[i];
      if (i === period - 1) {
        prev = sum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = values[i] * k + (prev as number) * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function lastEma(values: number[], period: number): number | null {
  const e = ema(values, period);
  for (let i = e.length - 1; i >= 0; i--) {
    if (e[i] !== null) return e[i];
  }
  return null;
}

/** Wilder RSI. Returns array aligned to input (null until warmup). */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (!isValidPeriod(period) || hasNonFiniteNumbers(closes) || n <= period) {
    return out;
  }

  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  out[period] = (avgG === 0 && avgL === 0) ? 50 : avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = (avgG === 0 && avgL === 0) ? 50 : avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

export function atr(candles: Candle[], period = 14): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (!isValidPeriod(period) || hasNonFiniteCandleOhlc(candles) || n <= period) {
    return out;
  }

  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  let prev = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i + 1] = prev;
  }
  return out;
}

export function rollingMax(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (!isValidPeriod(period) || hasNonFiniteNumbers(values) || n < period) {
    return out;
  }

  const dq: number[] = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && values[dq[dq.length - 1]] <= values[i]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - period) dq.shift();
    if (i >= period - 1) out[i] = values[dq[0]];
  }
  return out;
}

export function rollingMin(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (!isValidPeriod(period) || hasNonFiniteNumbers(values) || n < period) {
    return out;
  }

  const dq: number[] = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && values[dq[dq.length - 1]] >= values[i]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - period) dq.shift();
    if (i >= period - 1) out[i] = values[dq[0]];
  }
  return out;
}
