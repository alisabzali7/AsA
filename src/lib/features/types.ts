/**
 * Feature detector contract (Phase 2 §2).
 *
 * Every deterministic trading concept produces a FeatureValue carrying its own
 * provenance and validity. A detector NEVER returns a bare number: an absent
 * or unreliable measurement must be representable, so downstream rules can say
 * "UNKNOWN because X" instead of silently treating missing data as false.
 *
 * `detector_version` is part of the experiment fingerprint: changing a
 * detector's semantics MUST bump its version so historical backtests remain
 * interpretable.
 */
import type { SourceRef } from "../brain/types";

export type DataQuality = "OK" | "INSUFFICIENT_BARS" | "STALE" | "UNAVAILABLE";

/**
 * Team 02 absolute-final: the four detector outcome states, explicit so an
 * "OK" data quality is never read as "OK result". Derived from (valid,
 * data_quality, value) by the two constructors below — metadata only, it
 * never changes `valid` or any rule outcome.
 *   VALUE             valid, computed, value present
 *   ABSENT            valid, computed, nothing found (e.g. "no ABCD pattern")
 *                     → a rule predicate FAILs on it
 *   UNDEFINED_ON_DATA not valid: data fine but the feature's math is undefined
 *                     on it (zero-range candle, no fractal swings, flat prior
 *                     bodies) → dependent rules are UNKNOWN (never FAIL/PASS)
 *   UNAVAILABLE       not valid: input insufficient / non-finite / gated
 *                     → dependent rules are UNKNOWN
 */
export type FeatureState = "VALUE" | "ABSENT" | "UNDEFINED_ON_DATA" | "UNAVAILABLE";

export function featureStateOf(valid: boolean, quality: DataQuality, value: unknown): FeatureState {
  if (valid) return value === null || value === undefined ? "ABSENT" : "VALUE";
  return quality === "OK" ? "UNDEFINED_ON_DATA" : "UNAVAILABLE";
}

export interface FeatureValue<T = number> {
  feature_id: string;
  value: T | null;
  /** explicit outcome state (see FeatureState) */
  state: FeatureState;
  /** false when the value must not be used for decisions */
  valid: boolean;
  /**
   * Quality of the INPUT data, not presence of the feature. `valid:false`
   * with `data_quality:"OK"` means the data was fine but the feature is
   * absent/undefined on it (e.g. "no fractal swings", "zero-range candle").
   * Consumers MUST gate on `valid`, never on `data_quality`.
   */
  data_quality: DataQuality;
  reason: string;
  timeframe: string;
  /** epoch seconds of the last CLOSED candle used */
  timestamp: number | null;
  inputs: string[];
  bars_used: number;
  detector_version: string;
  source_refs: SourceRef[];
}

export function invalidFeature<T>(
  feature_id: string,
  timeframe: string,
  quality: DataQuality,
  reason: string,
  version: string,
  inputs: string[] = [],
): FeatureValue<T> {
  return {
    feature_id,
    value: null,
    valid: false,
    state: featureStateOf(false, quality, null),
    data_quality: quality,
    reason,
    timeframe,
    timestamp: null,
    inputs,
    bars_used: 0,
    detector_version: version,
    source_refs: [],
  };
}

export function okFeature<T>(
  feature_id: string,
  timeframe: string,
  value: T,
  timestamp: number,
  bars: number,
  version: string,
  inputs: string[],
  reason = "computed",
  source_refs: SourceRef[] = [],
): FeatureValue<T> {
  return {
    feature_id,
    value,
    valid: true,
    state: featureStateOf(true, "OK", value),
    data_quality: "OK",
    reason,
    timeframe,
    timestamp,
    inputs,
    bars_used: bars,
    detector_version: version,
    source_refs,
  };
}
