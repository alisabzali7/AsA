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

export interface FeatureValue<T = number> {
  feature_id: string;
  value: T | null;
  /** false when the value must not be used for decisions */
  valid: boolean;
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
