/**
 * Shared loaders for API analysis producers (Task 03). Every route builds
 * bundles through the analysis-input contract, so symbol/TF identity,
 * closed-bar policy and source freshness are enforced in ONE place.
 */
import { candleManager } from "../market/candles";
import { sharedStore } from "../market/store";
import type { TimeframeId } from "../domain/timeframes";
import { prepareAnalysisInput, type AnalysisInput } from "./input";
import { buildArtifactsFromInput, type AnalysisBundle, type BundleSeries } from "./bundle";
import { buildMtfAsOf, MTF_ROLE_TF, type MtfResult } from "./mtf";
import type { CandleSeries } from "../domain/types";

export interface LoadedTf {
  timeframe: TimeframeId;
  input: AnalysisInput;
  bundle: AnalysisBundle | null;
  /** canonical per-bar series of the SAME computation (chart overlay only) */
  series?: BundleSeries | null;
  /** fetch error, when the venue request failed (never hidden as "no data") */
  error: string | null;
}

export async function loadTf(symbol: string, tf: TimeframeId, nowMs?: number): Promise<LoadedTf> {
  try {
    const series = await candleManager.ensureSeries(symbol, tf);
    // ONE evaluation instant, taken after the fetch, for the closed-bar cut
    // AND the metadata ages (same discipline as loadMtf / buildMtfAsOf)
    const now = nowMs ?? Date.now();
    const input = prepareAnalysisInput(symbol, tf, series, now);
    const art = buildArtifactsFromInput(input, sharedStore.getStats(symbol), now);
    return { timeframe: tf, input, bundle: art?.bundle ?? null, series: art?.series ?? null, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const input = prepareAnalysisInput(symbol, tf, null, nowMs ?? Date.now());
    return { timeframe: tf, input: { ...input, reason: `fetch failed: ${msg}` }, bundle: null, error: msg };
  }
}

/**
 * Load the core hierarchy and synthesize it through the PURE as-of builder, so
 * the production path and the causality tests execute the same code.
 */
export async function loadMtf(symbol: string): Promise<{ mtf: MtfResult; parts: LoadedTf[] }> {
  const roles = ["macro", "context", "trigger"] as const;
  const fetched = await Promise.all(roles.map(async (role) => {
    try {
      return { series: (await candleManager.ensureSeries(symbol, MTF_ROLE_TF[role])) as CandleSeries | null, error: null as string | null };
    } catch (err) {
      return { series: null, error: err instanceof Error ? err.message : String(err) };
    }
  }));
  // one evaluation instant for every component, taken AFTER all fetches
  const nowMs = Date.now();
  const { mtf, parts } = buildMtfAsOf(symbol, { macro: fetched[0].series, context: fetched[1].series, trigger: fetched[2].series }, nowMs, sharedStore.getStats(symbol));
  return {
    mtf,
    parts: parts.map((p, i) => ({
      timeframe: p.timeframe as TimeframeId,
      input: fetched[i].error !== null ? { ...p.input, reason: `fetch failed: ${fetched[i].error}` } : p.input,
      bundle: p.bundle,
      error: fetched[i].error,
    })),
  };
}
