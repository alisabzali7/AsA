/**
 * UDF history normalization + integrity (master §51/§52).
 * Pure functions over raw UDF arrays, heavily unit-tested.
 * Behaviour verified against live TTT responses:
 *  - timestamps are epoch SECONDS aligned to the timeframe open;
 *  - the venue occasionally repeats the final timestamp (observed
 *    2026-09-05: two bars with identical last ts) -> dedupe, LAST wins;
 *  - HTTP 200 with s:"no_data" must NOT be treated as an empty series.
 */
import type { Candle } from "../domain/types";
import { ohlcvDefect } from "../domain/candle-validity";

export interface UdfNormalizeMeta {
  received: number;
  dropped_duplicates: number;
  dropped_invalid: number;
  /** subset of dropped_invalid: bars opening after the current forming bar */
  dropped_future: number;
  gaps: number;
  min_ts: number;
  max_ts: number;
  ok: boolean;
  no_data: boolean;
  reason?: string;
}

export interface UdfNormalized {
  candles: Candle[];
  meta: UdfNormalizeMeta;
}

/**
 * STRICT numeric parse (Task 03). `Number(null)`, `Number("")`,
 * `Number(false)` and `Number([])` are all 0 — the old parser therefore turned
 * an all-null row into a zero-price candle that passed the OHLC check. Only
 * finite numbers and non-empty numeric strings are accepted.
 */
function strictNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

export function parseUdfHistory(
  raw: unknown,
  tfMinutes: number,
  nowMs: number = Date.now(),
): UdfNormalized {
  if (!raw || typeof raw !== "object") return empty("payload is not an object");
  const r = raw as { s?: unknown; t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown; v?: unknown };
  if (r.s === "no_data") return { candles: [], meta: { received: 0, dropped_duplicates: 0, dropped_invalid: 0, dropped_future: 0, gaps: 0, min_ts: 0, max_ts: 0, ok: true, no_data: true } };
  if (r.s !== "ok") return empty(`s=${JSON.stringify(r.s)}`);

  const t = r.t, o = r.o, h = r.h, l = r.l, c = r.c, v = r.v;
  if (!Array.isArray(t) || !Array.isArray(o) || !Array.isArray(h) || !Array.isArray(l) || !Array.isArray(c) || !Array.isArray(v)) {
    return empty("missing OHLCV arrays");
  }
  const n = t.length;
  if (n === 0) return { candles: [], meta: { received: 0, dropped_duplicates: 0, dropped_invalid: 0, dropped_future: 0, gaps: 0, min_ts: 0, max_ts: 0, ok: true, no_data: false } };
  if (![o.length, h.length, l.length, c.length, v.length].every((x) => x === n)) {
    return empty("OHLCV array length mismatch");
  }

  const stepSec = tfMinutes * 60;
  const out: Candle[] = [];
  let dropped_invalid = 0;
  let dropped_duplicates = 0;
  let dropped_future = 0;
  let gaps = 0;
  let prevTs = -Infinity;
  // the newest bar that may legitimately exist is the one currently forming
  const maxOpenSec = Math.floor(nowMs / 1000 / stepSec) * stepSec;
  for (let i = 0; i < n; i++) {
    const ts = strictNum(t[i]);
    const oo = strictNum(o[i]), hh = strictNum(h[i]), ll = strictNum(l[i]), cc = strictNum(c[i]), vv = strictNum(v[i]);
    if (!Number.isFinite(ts) || ts <= 0 || !Number.isInteger(ts)) {
      dropped_invalid++;
      continue;
    }
    // canonical bar rule (domain/candle-validity): finite OHLCV, prices > 0,
    // volume ≥ 0, high/low bound open/close. Checked before the time rules,
    // exactly as the inline checks it replaces (same drop counting).
    if (ohlcvDefect({ o: oo, h: hh, l: ll, c: cc, v: vv }) !== null) {
      dropped_invalid++;
      continue;
    }
    // bars are aligned to the timeframe open (UTC); a misaligned stamp is not a bar of this timeframe
    if (ts % stepSec !== 0) {
      dropped_invalid++;
      continue;
    }
    // a bar opening AFTER the current forming bar cannot exist yet
    if (ts > maxOpenSec) {
      dropped_invalid++;
      dropped_future++;
      continue;
    }
    if (ts === prevTs && out.length > 0) {
      // duplicate timestamp (observed venue behaviour: repeated final ts):
      // LAST occurrence wins — it is the freshest state of that instant.
      dropped_duplicates++;
      out[out.length - 1] = { t: ts, o: oo, h: hh, l: ll, c: cc, v: vv };
      continue;
    }
    if (ts < prevTs) {
      // strictly out-of-order row cannot be placed without corrupting order
      dropped_invalid++;
      continue;
    }
    if (prevTs > 0 && ts - prevTs > stepSec * 1.5) gaps++;
    prevTs = ts;
    out.push({ t: ts, o: oo, h: hh, l: ll, c: cc, v: vv });
  }
  return {
    candles: out,
    meta: {
      received: n,
      dropped_duplicates,
      dropped_invalid,
      dropped_future,
      gaps,
      min_ts: out.length ? out[0].t : 0,
      max_ts: out.length ? out[out.length - 1].t : 0,
      ok: true,
      no_data: false,
    },
  };
}

function empty(reason: string): UdfNormalized {
  return { candles: [], meta: { received: 0, dropped_duplicates: 0, dropped_invalid: 0, dropped_future: 0, gaps: 0, min_ts: 0, max_ts: 0, ok: false, no_data: false, reason } };
}

/**
 * Labeled 8H->1D aggregation — FALLBACK ONLY, never the primary 1D path.
 * TTT serves native 1D (verified), so this is used exclusively when a native
 * request fails. Aggregates only COMPLETE UTC days (all three 8h candles
 * closed) => no future-bar leakage and no partially-formed daily candle.
 */
export function derive1DFrom8h(candles8h: Candle[]): { candles: Candle[]; source_tf: "8h"; daysUsed: number } {
  const DAY = 86400;
  const byDay = new Map<number, Candle[]>();
  for (const c of candles8h) {
    const day = Math.floor(c.t / DAY) * DAY;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(c);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const out: Candle[] = [];
  let daysUsed = 0;
  for (const day of days) {
    const bars = byDay.get(day)!.sort((a, b) => a.t - b.t);
    // complete day = 3 aligned 8h bars (86400/28800); partial day skipped
    if (bars.length < 3) continue;
    if (bars[0].t !== day) continue;
    if (bars[bars.length - 1].t + 28800 !== day + DAY) continue;
    out.push({
      t: day,
      o: bars[0].o,
      h: Math.max(...bars.map((b) => b.h)),
      l: Math.min(...bars.map((b) => b.l)),
      c: bars[bars.length - 1].c,
      v: bars.reduce((s, b) => s + b.v, 0),
    });
    daysUsed++;
  }
  return { candles: out, source_tf: "8h", daysUsed };
}
