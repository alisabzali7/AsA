/**
 * ANALYSIS API ERROR SEMANTICS (Task 09).
 *
 * One machine-readable taxonomy for every technical-analysis producer route,
 * so a consumer never has to parse a human `reason`/`error` string to learn
 * WHY evidence is missing. HTTP status codes are unchanged from before; this
 * adds `error_class` next to them.
 *
 *   INVALID_REQUEST           unknown symbol / unsupported timeframe (4xx)
 *   MARKET_SOURCE_UNAVAILABLE operational universe not discovered yet (503)
 *   UPSTREAM_FAILURE          the venue request failed (502). Whether it is
 *                             temporary is NOT known to the code, so it is not
 *                             labelled "temporary".
 *   NO_DATA                   series missing (503) or no bar has closed yet (200)
 *   INVALID_SOURCE_DATA       series refused (502): non-finite/duplicate/out-of-
 *                             order/future open times or an invalid bar
 *                             (analysis/input INVALID_SERIES)
 *   INSUFFICIENT_HISTORY      bundle exists, but listed fields are in warmup
 *                             (reported via `insufficient_history`, ok:true)
 *   IDENTITY_MISMATCH         the store returned a series whose symbol/tf
 *                             differs from the request (500 — server fault;
 *                             Task 10: was folded into INTERNAL_ERROR at 200)
 *   INTERNAL_ERROR            unexpected exception (500; no stack leaked)
 */
import type { AnalysisInput } from "./input";
import type { AnalysisBundle } from "./bundle";
import { STRUCTURE_PARAMS } from "./structure";

export type AnalysisErrorClass =
  | "INVALID_REQUEST"
  | "MARKET_SOURCE_UNAVAILABLE"
  | "UPSTREAM_FAILURE"
  | "NO_DATA"
  | "INVALID_SOURCE_DATA"
  | "INSUFFICIENT_HISTORY"
  | "IDENTITY_MISMATCH"
  | "INTERNAL_ERROR";

/** error class of a prepared input (null = analysable) */
export function inputErrorClass(input: AnalysisInput, fetchError: string | null): AnalysisErrorClass | null {
  if (fetchError !== null) return "UPSTREAM_FAILURE";
  switch (input.reason_code) {
    case "OK": return null;
    case "SERIES_UNAVAILABLE":
    case "NO_CLOSED_BARS": return "NO_DATA";
    case "INVALID_SERIES": return "INVALID_SOURCE_DATA";
    case "UNSUPPORTED_TIMEFRAME": return "INVALID_REQUEST";
    case "IDENTITY_MISMATCH": return "IDENTITY_MISMATCH";
  }
}

/**
 * Truthful HTTP status of a prepared input (absolute-final). One table, used
 * by the analysis route and pinned by tests:
 *   upstream fetch failed   → 502 UPSTREAM_FAILURE
 *   IDENTITY_MISMATCH       → 500 (server fault: the store returned another series)
 *   INVALID_SERIES          → 502 INVALID_SOURCE_DATA (refused source data)
 *   SERIES_UNAVAILABLE      → 503 NO_DATA (nothing in the store)
 *   UNSUPPORTED_TIMEFRAME   → 400 INVALID_REQUEST
 *   NO_CLOSED_BARS          → 200 available:false (legitimate "not yet")
 *   OK                      → 200
 * AFTER_AS_OF is not an input state: the API has no as-of parameter; it is an
 * MTF COMPONENT state (analysis/mtf buildMtf) reported inside a 200 body.
 * UNVERIFIABLE_LEGACY_RECORD is a chart-evidence state (charts route header
 * X-Snapshot-Check), never an analysis input state.
 */
export function inputHttpStatus(input: AnalysisInput, fetchError: string | null): number {
  if (fetchError !== null) return 502;
  switch (input.reason_code) {
    case "OK": return 200;
    case "NO_CLOSED_BARS": return 200;
    case "IDENTITY_MISMATCH": return 500;
    case "INVALID_SERIES": return 502;
    case "SERIES_UNAVAILABLE": return 503;
    case "UNSUPPORTED_TIMEFRAME": return 400;
  }
}

/** bundle fields still in warmup ("structure" when below the structure minimum) */
export function insufficientHistory(b: AnalysisBundle): string[] {
  const out: string[] = (Object.keys(b.indicator_status) as (keyof AnalysisBundle["indicator_status"])[])
    .filter((k) => b.indicator_status[k].state === "INSUFFICIENT_HISTORY");
  if (b.bars < STRUCTURE_PARAMS.min_structure_bars) out.push("structure");
  return out;
}

/** 500 body for an unexpected exception: class + message, never a stack */
export function internalErrorBody(err: unknown): { ok: false; error_class: "INTERNAL_ERROR"; error: string } {
  return { ok: false, error_class: "INTERNAL_ERROR", error: err instanceof Error ? err.message : String(err) };
}
