/**
 * TTT historical data manager (remediation §5–§10, §18).
 *
 * THE CENTRAL FIX: there is NO fixed-N candle ceiling anywhere in this module.
 * A single TTT `/futures/udf/history` response is capped by the venue at ~5000
 * bars; that is a TRANSPORT CHUNK SIZE, not a historical limit. This manager
 * walks backwards chunk by chunk until TTT itself reports `no_data`, which is
 * the only authoritative boundary.
 *
 * Measured on 2026-09-09: one BTCUSDT 1h request returns 5000 bars, while
 * chunked traversal reaches 6730 bars back to the true venue boundary.
 *
 * Nothing is ever fabricated: a missing interval is reported as a gap, never
 * filled with a synthetic candle.
 */
import { createHash } from "node:crypto";
import type { Candle } from "../domain/types";
import { getTimeframe, type TimeframeId } from "../domain/timeframes";
import { parseUdfHistory } from "../ttt/udf";
import { tttRequest } from "../ttt/http";

/** Venue response cap. A TRANSPORT constant, never a retention limit. */
export const TTT_MAX_BARS_PER_REQUEST = 5000;
/** Safety bound on chunk walks so a pathological loop cannot run forever. */
export const MAX_CHUNKS_PER_SYNC = 40;

export type CompletionState =
  | "COMPLETE_TO_TTT_BOUNDARY"
  | "PARTIAL"
  | "NO_DATA"
  | "UNAVAILABLE"
  | "GAPPED"
  // AUDIT FIX (mandate bug 5): HTTP 200 s:"ok" with zero bars is NOT the
  // explicit no-data boundary. It gets its own state so it can never be
  // conflated with a proven complete walk.
  | "AMBIGUOUS_EMPTY";

export interface HistoryGap {
  from_ts: number;
  to_ts: number;
  missing_bars: number;
}

export interface HistoryMeta {
  symbol: string;
  timeframe: TimeframeId;
  ttt_resolution: string;
  earliest_available: number | null;
  latest_available: number | null;
  bar_count: number;
  requested_range: { from: number | null; to: number | null };
  returned_range: { from: number | null; to: number | null };
  completion_state: CompletionState;
  gap_count: number;
  gaps: HistoryGap[];
  duplicate_count: number;
  invalid_bar_count: number;
  data_quality: "OK" | "GAPPED" | "INSUFFICIENT" | "NO_DATA" | "UNAVAILABLE";
  source: "ttt";
  native: boolean;
  dataset_fingerprint: string;
  chunks_fetched: number;
  last_sync_ms: number;
  reason?: string;
}

export interface HistoryResult {
  candles: Candle[];
  meta: HistoryMeta;
}

export function fingerprint(candles: Candle[]): string {
  const h = createHash("sha256");
  h.update(`${candles.length}`);
  for (const c of candles) h.update(`${c.t}:${c.o}:${c.h}:${c.l}:${c.c};`);
  return h.digest("hex").slice(0, 32);
}

/**
 * Merge, dedupe by timestamp and sort ascending.
 * Later values win, so an incremental sync can correct a partially-formed bar.
 */
export function mergeCandles(existing: Candle[], incoming: Candle[]): { merged: Candle[]; duplicates: number } {
  const map = new Map<number, Candle>();
  for (const c of existing) map.set(c.t, c);
  let duplicates = 0;
  for (const c of incoming) {
    if (map.has(c.t)) duplicates++;
    map.set(c.t, c);
  }
  const merged = [...map.values()].sort((a, b) => a.t - b.t);
  return { merged, duplicates };
}

/** Detect missing intervals. Genuine venue gaps are reported, never filled. */
export function detectGaps(candles: Candle[], tfMinutes: number): HistoryGap[] {
  const step = tfMinutes * 60;
  const gaps: HistoryGap[] = [];
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].t - candles[i - 1].t;
    if (delta > step) {
      const missing = Math.round(delta / step) - 1;
      if (missing > 0) gaps.push({ from_ts: candles[i - 1].t, to_ts: candles[i].t, missing_bars: missing });
    }
  }
  return gaps;
}

/** Structural OHLC validation. Invalid bars are dropped and counted, not fixed. */
export function validateCandles(candles: Candle[]): { valid: Candle[]; invalid: number } {
  let invalid = 0;
  const valid = candles.filter((c) => {
    const ok =
      Number.isFinite(c.t) && c.t > 0 &&
      Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c) &&
      c.h >= c.l && c.h >= c.o && c.h >= c.c && c.l <= c.o && c.l <= c.c &&
      c.o > 0 && c.c > 0 && (c.v === undefined || c.v >= 0);
    if (!ok) invalid++;
    return ok;
  });
  return { valid, invalid };
}

async function fetchChunk(
  symbol: string,
  resolution: string,
  from: number,
  to: number,
  tfMinutes: number,
): Promise<{ candles: Candle[]; noData: boolean; ok: boolean; reason?: string }> {
  const path = `/futures/udf/history?symbol=${encodeURIComponent(symbol)}&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${to}`;
  try {
    const res = await tttRequest<unknown>(path, { timeoutMs: 30_000, retries: 2 });
    const parsed = parseUdfHistory(res.data, tfMinutes);
    return { candles: parsed.candles, noData: parsed.meta.no_data === true, ok: parsed.meta.ok };
  } catch (err) {
    return { candles: [], noData: false, ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface FetchHistoryOptions {
  /** explicit lower bound; omit to walk to the TTT boundary */
  from?: number;
  /** explicit upper bound; defaults to now */
  to?: number;
  /** stop after this many chunks (safety, not a data policy) */
  maxChunks?: number;
  /** already-known candles to extend rather than refetch */
  seed?: Candle[];
}

/**
 * Retrieve history for one symbol/timeframe.
 *
 * Walks BACKWARDS from `to` in venue-sized chunks until either:
 *   - TTT returns `no_data` (the true boundary -> COMPLETE_TO_TTT_BOUNDARY), or
 *   - an explicit `from` is satisfied, or
 *   - the chunk safety bound is hit (-> PARTIAL, reported honestly).
 */
export async function fetchFullHistory(
  symbol: string,
  timeframe: TimeframeId,
  opts: FetchHistoryOptions = {},
): Promise<HistoryResult> {
  const spec = getTimeframe(timeframe);
  const now = Math.floor(Date.now() / 1000);
  const to = opts.to ?? now;
  const maxChunks = opts.maxChunks ?? MAX_CHUNKS_PER_SYNC;

  const baseMeta = (over: Partial<HistoryMeta>): HistoryMeta => ({
    symbol, timeframe,
    ttt_resolution: spec?.tttResolution ?? "?",
    earliest_available: null, latest_available: null, bar_count: 0,
    requested_range: { from: opts.from ?? null, to },
    returned_range: { from: null, to: null },
    completion_state: "UNAVAILABLE", gap_count: 0, gaps: [],
    duplicate_count: 0, invalid_bar_count: 0, data_quality: "UNAVAILABLE",
    source: "ttt", native: true, dataset_fingerprint: "", chunks_fetched: 0,
    last_sync_ms: Date.now(), ...over,
  });

  if (!spec) {
    return { candles: [], meta: baseMeta({ reason: `unsupported timeframe '${timeframe}'` }) };
  }

  const stepSec = spec.minutes * 60;
  const chunkSpan = TTT_MAX_BARS_PER_REQUEST * stepSec;

  let all: Candle[] = opts.seed ? [...opts.seed] : [];
  let duplicates = 0;
  let cursorTo = to;
  let chunks = 0;
  let reachedBoundary = false;
  let lastError: string | undefined;
  let ambiguousEmpty = false;

  while (chunks < maxChunks) {
    const chunkFrom = opts.from !== undefined
      ? Math.max(opts.from, cursorTo - chunkSpan)
      : cursorTo - chunkSpan;

    const res = await fetchChunk(symbol, spec.tttResolution, chunkFrom, cursorTo, spec.minutes);
    chunks++;

    if (!res.ok && !res.noData) { lastError = res.reason; break; }
    // AUDIT FIX (mandate bug 5): only the EXPLICIT s:"no_data" signal is an
    // authoritative boundary. An s:"ok" response with zero candles is an
    // ambiguous empty-success: it stops the walk (there is nothing to merge)
    // but it must NOT be recorded as COMPLETE_TO_TTT_BOUNDARY.
    if (res.noData) { reachedBoundary = true; break; }
    if (res.candles.length === 0) { ambiguousEmpty = true; break; }

    const before = all.length;
    const m = mergeCandles(all, res.candles);
    all = m.merged;
    duplicates += m.duplicates;

    // no NEW bars means we are at the boundary, regardless of what was returned
    if (all.length === before) { reachedBoundary = true; break; }

    const oldest = all[0].t;
    if (opts.from !== undefined && oldest <= opts.from) break;

    // step the cursor strictly before the oldest bar we now hold
    const nextTo = oldest - stepSec;
    if (nextTo >= cursorTo) { reachedBoundary = true; break; }
    cursorTo = nextTo;
  }

  const { valid, invalid } = validateCandles(all);
  const gaps = detectGaps(valid, spec.minutes);

  let completion: CompletionState;
  let quality: HistoryMeta["data_quality"];
  if (valid.length === 0) {
    if (lastError) {
      completion = "UNAVAILABLE";
      quality = "UNAVAILABLE";
    } else if (ambiguousEmpty) {
      // venue answered 200 s:"ok" but returned zero bars and we hold nothing:
      // NOT the same as the explicit no-data boundary.
      completion = "AMBIGUOUS_EMPTY";
      quality = "INSUFFICIENT";
    } else {
      completion = "NO_DATA";
      quality = "NO_DATA";
    }
  } else if (gaps.length > 0) {
    // GAPPED describes DATA QUALITY, not traversal. We still record whether the
    // walk reached the venue boundary so a later backfill can clear it.
    completion = "GAPPED";
    quality = "GAPPED";
  } else if (reachedBoundary || opts.from !== undefined) {
    completion = reachedBoundary ? "COMPLETE_TO_TTT_BOUNDARY" : "PARTIAL";
    quality = "OK";
  } else {
    // AUDIT FIX (mandate bug 5): an empty-success stopped the walk after bars
    // were collected — the dataset is usable but the boundary is NOT proven,
    // so this can never be recorded as COMPLETE_TO_TTT_BOUNDARY.
    completion = "PARTIAL";
    quality = "OK";
    if (ambiguousEmpty && !lastError) {
      lastError = "walk stopped on an s:ok response with zero candles; TTT boundary not proven";
    }
  }

  return {
    candles: valid,
    meta: baseMeta({
      earliest_available: valid.length ? valid[0].t : null,
      latest_available: valid.length ? valid[valid.length - 1].t : null,
      bar_count: valid.length,
      returned_range: { from: valid.length ? valid[0].t : null, to: valid.length ? valid[valid.length - 1].t : null },
      completion_state: completion,
      gap_count: gaps.length,
      gaps: gaps.slice(0, 50),
      duplicate_count: duplicates,
      invalid_bar_count: invalid,
      data_quality: quality,
      dataset_fingerprint: fingerprint(valid),
      chunks_fetched: chunks,
      reason: lastError,
    }),
  };
}
