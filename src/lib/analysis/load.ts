/**
 * Shared loaders for API analysis producers (Task 03). Every route builds
 * bundles through the analysis-input contract, so symbol/TF identity,
 * closed-bar policy and source freshness are enforced in ONE place.
 */
import { candleManager } from "../market/candles";
import { sharedStore } from "../market/store";
import type { TimeframeId } from "../domain/timeframes";
import { prepareAnalysisInput, type AnalysisInput } from "./input";
import { buildBundleFromInput, type AnalysisBundle } from "./bundle";
import { buildMtf, type MtfResult } from "./mtf";

export interface LoadedTf {
  timeframe: TimeframeId;
  input: AnalysisInput;
  bundle: AnalysisBundle | null;
  /** fetch error, when the venue request failed (never hidden as "no data") */
  error: string | null;
}

export async function loadTf(symbol: string, tf: TimeframeId, nowMs?: number): Promise<LoadedTf> {
  try {
    const series = await candleManager.ensureSeries(symbol, tf);
    const input = prepareAnalysisInput(symbol, tf, series, nowMs ?? Date.now());
    return { timeframe: tf, input, bundle: buildBundleFromInput(input, sharedStore.getStats(symbol)), error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const input = prepareAnalysisInput(symbol, tf, null, nowMs ?? Date.now());
    return { timeframe: tf, input: { ...input, reason: `fetch failed: ${msg}` }, bundle: null, error: msg };
  }
}

export async function loadMtf(symbol: string): Promise<{ mtf: MtfResult; parts: LoadedTf[] }> {
  const nowMs = Date.now();
  const parts = await Promise.all((["4h", "1h", "15m"] as const).map((tf) => loadTf(symbol, tf, nowMs)));
  return { mtf: buildMtf(parts[0].bundle, parts[1].bundle, parts[2].bundle), parts };
}
