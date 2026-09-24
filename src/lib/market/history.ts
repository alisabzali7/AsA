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
 * BOUNDARY PROOF RULE (forensic task: no false boundary proof):
 *
 *   NO PROGRESS != NO DATA != TTT BOUNDARY
 *
 * The ONLY evidence that may prove the earliest boundary is an EXPLICIT
 * upstream `s:"no_data"` for a probe window strictly older than every bar the
 * walk already holds. Everything else is a stall, not a proof:
 *   - a chunk that adds no new bar (pure overlap / identical window)
 *   - a successful chunk whose timestamps do not advance
 *   - an `s:"ok"` response carrying zero bars
 *   - duplicates, or a venue that ignores the requested window
 * Those outcomes stop the walk honestly (NO_PROGRESS / AMBIGUOUS_EMPTY) and
 * leave the boundary UNPROVEN.
 *
 * Nothing is ever fabricated: a missing interval is reported as a gap, never
 * filled with a synthetic candle.
 */
import { createHash } from "node:crypto";
import type { Candle } from "../domain/types";
import { getTimeframe, type TimeframeId } from "../domain/timeframes";
import { parseUdfHistory } from "../ttt/udf";
import { tttRequest, TttHttpError } from "../ttt/http";
import { PRIORITY } from "../ttt/scheduler";

/** Venue response cap. A TRANSPORT constant, never a retention limit. */
export const TTT_MAX_BARS_PER_REQUEST = 5000;
/** Safety bound on chunk walks so a pathological loop cannot run forever. */
export const MAX_CHUNKS_PER_SYNC = 40;

export type CompletionState =
  /** the walk obtained explicit upstream evidence (TTT s:"no_data") */
  | "COMPLETE_TO_TTT_BOUNDARY"
  /** walked, holds usable bars, but NO explicit boundary evidence was obtained */
  | "PARTIAL"
  /** the venue explicitly answered s:"no_data" */
  | "NO_DATA"
  /** the walk could not reach the venue (transport/HTTP failure) */
  | "UNAVAILABLE"
  /** usable bars with genuine missing intervals (quality fact, not traversal) */
  | "GAPPED"
  // AUDIT FIX (mandate bug 5): HTTP 200 s:"ok" with zero bars is NOT the
  // explicit no-data boundary. It gets its own state so it can never be
  // conflated with a proven complete walk.
  | "AMBIGUOUS_EMPTY"
  // FORENSIC TASK (no false boundary proof): the walk stopped because the venue
  // made no progress — a chunk added no new bar, or the cursor could not advance
  // strictly backwards. NO-PROGRESS IS NOT A BOUNDARY: the dataset is usable but
  // the earliest edge is UNPROVEN, so this state can never mean "complete".
  | "NO_PROGRESS"
  // A response was received but is not a usable UDF payload (structurally
  // invalid JSON, wrong content-type, empty body, s other than ok/no_data).
  // This is NOT transport failure and NOT an explicit no_data.
  | "INVALID_RESPONSE";

/**
 * Why a walk stopped. Distinct from completion_state: PARTIAL covers both
 * "the caller asked us to stop at `from`" and "the safety chunk limit fired",
 * and those are different facts.
 */
export type HistoryStopCause =
  | "explicit_no_data"
  | "explicit_lower_bound"
  | "chunk_limit"
  | "ambiguous_empty"
  | "overlap"
  | "stalled_cursor"
  | "transport_failure"
  | "invalid_response"
  | "unsupported_timeframe"
  | "no_evidence";

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
  /**
   * The EXPLICIT upstream boundary evidence observed by THIS walk, or null when
   * none was observed. `"TTT_NO_DATA"` is the only value that may ever back a
   * COMPLETE_TO_TTT_BOUNDARY claim — it is never inferred from an absence of
   * bars, an overlap, or a stall.
   */
  boundary_evidence: "TTT_NO_DATA" | null;
  /**
   * Why THIS walk stopped. Never inferred as a boundary. `null` only on a
   * constructed meta that did not walk (the skip path fills its own value).
   */
  stop_cause: HistoryStopCause | null;
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
      c.o > 0 && c.c > 0 && c.l > 0 && (c.v === undefined || c.v >= 0);
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
): Promise<{ candles: Candle[]; noData: boolean; ok: boolean; invalid: boolean; reason?: string }> {
  const path = `/futures/udf/history?symbol=${encodeURIComponent(symbol)}&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${to}`;
  try {
    // Background backfill lane (3): a long chunk walk must never outrank focus
    // or sweep traffic. Admission is charged by the transport per attempt — the
    // walk does not pre-acquire anything.
    const res = await tttRequest<unknown>(path, {
      timeoutMs: 30_000,
      retries: 2,
      priority: PRIORITY.BACKFILL,
    });
    const parsed = parseUdfHistory(res.data, tfMinutes);
    if (!parsed.meta.ok) {
      // HTTP 200 with a body that is not a usable UDF payload. Dropping
      // `meta.reason` here used to leave lastError unset, and the walk then
      // classified the chunk as NO_DATA — an explicit venue boundary the
      // venue never stated.
      return {
        candles: [],
        noData: false,
        ok: false,
        invalid: true,
        reason: parsed.meta.reason ?? "structurally invalid UDF payload",
      };
    }
    if (parsed.meta.received > 0 && parsed.candles.length === 0) {
      // Task 03: every row was rejected by normalization. That is a corrupt
      // payload — neither an explicit no_data nor an empty success.
      return {
        candles: [], noData: false, ok: false, invalid: true,
        reason: `all ${parsed.meta.received} UDF row(s) rejected by normalization (invalid=${parsed.meta.dropped_invalid}, future=${parsed.meta.dropped_future})`,
      };
    }
    return { candles: parsed.candles, noData: parsed.meta.no_data === true, ok: true, invalid: false };
  } catch (err) {
    const invalid = err instanceof TttHttpError && err.kind === "invalid_response";
    return {
      candles: [],
      noData: false,
      ok: false,
      invalid,
      reason: err instanceof Error ? err.message : String(err),
    };
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
 *   - TTT returns an EXPLICIT `no_data` for a window strictly older than every
 *     bar already held (the only authoritative boundary -> COMPLETE_TO_TTT_BOUNDARY), or
 *   - an explicit `from` is satisfied (-> PARTIAL), or
 *   - the chunk safety bound is hit (-> PARTIAL, reported honestly), or
 *   - the venue makes no progress (-> NO_PROGRESS: no proof of any kind).
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
    last_sync_ms: Date.now(), boundary_evidence: null, stop_cause: null, ...over,
  });

  if (!spec) {
    return { candles: [], meta: baseMeta({ reason: `unsupported timeframe '${timeframe}'`, stop_cause: "unsupported_timeframe" }) };
  }

  const stepSec = spec.minutes * 60;
  const chunkSpan = TTT_MAX_BARS_PER_REQUEST * stepSec;

  let all: Candle[] = opts.seed ? [...opts.seed] : [];
  let duplicates = 0;
  let cursorTo = to;
  let chunks = 0;
  let boundaryEvidence: "TTT_NO_DATA" | null = null;
  let lastError: string | undefined;
  let ambiguousEmpty = false;
  let noProgress = false;
  let invalidResponse = false;
  let stopCause: HistoryStopCause | null = null;

  while (chunks < maxChunks) {
    const chunkFrom = opts.from !== undefined
      ? Math.max(opts.from, cursorTo - chunkSpan)
      : cursorTo - chunkSpan;

    const res = await fetchChunk(symbol, spec.tttResolution, chunkFrom, cursorTo, spec.minutes);
    chunks++;

    if (res.noData) {
      // EXPLICIT, AUTHORITATIVE boundary signal — the ONE admissible evidence.
      // It only counts when the probe asked for a window strictly OLDER than
      // every bar this walk already holds ("there is nothing below what you
      // have"). A no_data for a window that overlaps bars we hold is not a
      // statement about the earliest edge, so it is refused.
      const probeIsOlderThanKnownData = all.length === 0 || cursorTo < all[0].t;
      if (probeIsOlderThanKnownData) {
        boundaryEvidence = "TTT_NO_DATA";
        stopCause = "explicit_no_data";
      } else {
        noProgress = true;
        stopCause = "overlap";
        lastError = `TTT answered s:"no_data" for a window that overlaps already-held bars; earliest boundary not proven`;
      }
      break;
    }
    if (!res.ok) {
      lastError = res.reason ?? (res.invalid ? "invalid response" : "upstream request failed");
      if (res.invalid) {
        invalidResponse = true;
        stopCause = "invalid_response";
      } else {
        stopCause = "transport_failure";
      }
      break;
    }
    // AUDIT FIX (mandate bug 5): an s:"ok" response with zero candles is an
    // ambiguous empty-success: it stops the walk (there is nothing to merge)
    // but it must NOT be recorded as COMPLETE_TO_TTT_BOUNDARY.
    if (res.candles.length === 0) { ambiguousEmpty = true; break; }

    const before = all.length;
    const m = mergeCandles(all, res.candles);
    all = m.merged;
    duplicates += m.duplicates;

    // FORENSIC FIX (no false boundary proof): a chunk that adds NO new bar is
    // pure OVERLAP / a repeated window. It says nothing about where the venue's
    // history ends, so it can never be a boundary. Stop, unproven.
    if (all.length === before) {
      noProgress = true;
      stopCause = "overlap";
      lastError = `TTT chunk added no new bar (overlap/no-progress); earliest boundary not proven`;
      break;
    }

    const oldest = all[0].t;
    if (opts.from !== undefined && oldest <= opts.from) {
      stopCause = "explicit_lower_bound";
      break;
    }

    // step the cursor strictly before the oldest bar we now hold
    const nextTo = oldest - stepSec;
    if (nextTo >= cursorTo) {
      // FORENSIC FIX: the cursor cannot advance strictly backwards (the venue
      // returned no bar older than the current cursor). A stalled cursor is NOT
      // a boundary — the earliest edge remains UNPROVEN.
      noProgress = true;
      stopCause = "stalled_cursor";
      lastError = `TTT chunk returned no bar older than the cursor (stalled walk); earliest boundary not proven`;
      break;
    }
    cursorTo = nextTo;
  }

  if (stopCause === null && ambiguousEmpty) stopCause = "ambiguous_empty";
  if (stopCause === null && chunks >= maxChunks) stopCause = "chunk_limit";

  const { valid, invalid } = validateCandles(all);
  const gaps = detectGaps(valid, spec.minutes);

  let completion: CompletionState;
  let quality: HistoryMeta["data_quality"];
  if (valid.length === 0) {
    if (invalidResponse) {
      // Corrupt / structurally invalid payload. Never NO_DATA (that claims the
      // venue said s:"no_data") and never a silent success.
      completion = "INVALID_RESPONSE";
      quality = "UNAVAILABLE";
    } else if (lastError) {
      completion = "UNAVAILABLE";
      quality = "UNAVAILABLE";
    } else if (ambiguousEmpty) {
      // venue answered 200 s:"ok" but returned zero bars and we hold nothing:
      // NOT the same as the explicit no-data boundary.
      completion = "AMBIGUOUS_EMPTY";
      quality = "INSUFFICIENT";
    } else if (boundaryEvidence === "TTT_NO_DATA") {
      completion = "NO_DATA";
      quality = "NO_DATA";
    } else {
      // Never asked, or stopped with no evidence. Do not invent no_data.
      completion = "UNAVAILABLE";
      quality = "UNAVAILABLE";
      if (!lastError) lastError = "history walk produced no venue evidence";
      if (!stopCause) stopCause = "no_evidence";
    }
  } else if (gaps.length > 0) {
    // GAPPED describes DATA QUALITY, not traversal. We still record whether the
    // walk reached the venue boundary so a later backfill can clear it.
    completion = "GAPPED";
    quality = "GAPPED";
  } else if (boundaryEvidence === "TTT_NO_DATA") {
    // the ONLY path to a boundary claim: explicit upstream evidence
    completion = "COMPLETE_TO_TTT_BOUNDARY";
    quality = "OK";
  } else if (noProgress) {
    // overlap / stall: usable bars, UNPROVEN earliest edge
    completion = "NO_PROGRESS";
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
      boundary_evidence: boundaryEvidence,
      stop_cause: stopCause,
      reason: lastError,
    }),
  };
}
