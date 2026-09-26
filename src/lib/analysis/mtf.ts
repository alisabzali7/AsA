/**
 * Multi-timeframe context — core hierarchy 4H macro / 1H context / 15M
 * trigger with an explicit, EVIDENCE-BASED classification. Deterministic.
 *
 * Verdict precedence (Task 03). An alignment verdict is only computed once the
 * evidence supports one:
 *   UNAVAILABLE  - a component is missing, or components describe different symbols
 *   INSUFFICIENT - a component has < MIN_MTF_BARS closed bars
 *   STALE        - a component's last closed bar is older than its staleness budget
 *   ALIGNED / PARTIAL / CONFLICT - bias comparison over fresh, sufficient data
 *
 * Task 09 consumer-safety additions:
 *   - a cross-symbol refusal also NULLS every bias (a bias belonging to
 *     another symbol must never be readable next to an UNAVAILABLE verdict);
 *   - each component reports `as_of_t`, `knowable_at_ms` (close instant of
 *     its last closed bar) and the bundle `input_fingerprint`;
 *   - when an evaluation instant is supplied, a component that only became
 *     knowable AFTER it is refused (state AFTER_AS_OF → verdict UNAVAILABLE):
 *     pre-built bundles cannot smuggle lookahead into an as-of MTF.
 *   Per-component biases outside ALIGNED/PARTIAL/CONFLICT remain the factual
 *   trend of that single component; consumers must read `verdict` first.
 *
 * Before, a stale 4H series (or a series left over from another symbol) could
 * still produce ALIGNED, because only bar counts were checked.
 */
import type { CandleSeries, SymbolStats } from "../domain/types";
import { buildBundleFromInput, type AnalysisBundle } from "./bundle";
import { prepareAnalysisInput, tfSeconds, type AnalysisInput } from "./input";

/**
 * MTF ROLES ARE TECHNICAL, NOT DECISIONS. macro/context/trigger name the
 * repository's core hierarchy (4H/1H/15M, ASA_IMPLEMENTATION_CONTRACT_v1
 * "Timeframes"). The verdict describes agreement of TECHNICAL trend states;
 * it is not an entry, a direction to trade or a score.
 */
export const MTF_ROLE_TF = { macro: "4h", context: "1h", trigger: "15m" } as const;

export type MtfVerdict = "ALIGNED" | "PARTIAL" | "CONFLICT" | "INSUFFICIENT" | "STALE" | "UNAVAILABLE";
export type MtfComponentState = "OK" | "UNAVAILABLE" | "INSUFFICIENT" | "STALE" | "MISMATCH" | "AFTER_AS_OF";

export const MIN_MTF_BARS = 50;

export interface MtfComponent {
  role: "macro" | "context" | "trigger";
  timeframe: string | null;
  state: MtfComponentState;
  bars: number;
  native: boolean | null;
  derived_source_tf: string | null;
  source_ts_ms: number | null;
  data_age_ms: number | null;
  freshness: string;
  /** open time (epoch s) of the component's last closed bar */
  as_of_t: number | null;
  /** close instant (epoch ms) of that bar = when its values became knowable */
  knowable_at_ms: number | null;
  /** bundle snapshot identity (provenance.input_fingerprint) */
  input_fingerprint: string | null;
}

export interface MtfResult {
  verdict: MtfVerdict;
  macro: AnalysisBundle | null;
  context: AnalysisBundle | null;
  trigger: AnalysisBundle | null;
  macro_bias: "long" | "short" | "neutral" | null;
  context_bias: "long" | "short" | "neutral" | null;
  trigger_bias: "long" | "short" | "neutral" | null;
  reason: string;
  symbol: string | null;
  components: MtfComponent[];
  /** true only when every component carried a measured source freshness */
  freshness_verified: boolean;
  /** roles whose series is DERIVED (never native venue data) */
  derived_components: string[];
  /** oldest component source timestamp — the MTF is only as fresh as this */
  oldest_source_ts_ms: number | null;
  /**
   * the single evaluation instant every component was cut at (closed-bar
   * boundary); null when the caller supplied pre-built bundles.
   */
  as_of_ms: number | null;
}

function componentOf(role: MtfComponent["role"], b: AnalysisBundle | null, asOfMs: number | null): MtfComponent {
  if (!b) return { role, timeframe: null, state: "UNAVAILABLE", bars: 0, native: null, derived_source_tf: null, source_ts_ms: null, data_age_ms: null, freshness: "UNAVAILABLE", as_of_t: null, knowable_at_ms: null, input_fingerprint: null };
  const p = b.provenance;
  const step = tfSeconds(b.timeframe);
  const knowable = b.as_of_t !== null && step !== null ? (b.as_of_t + step) * 1000 : null;
  const state: MtfComponentState = b.timeframe !== MTF_ROLE_TF[role] ? "MISMATCH"
    : asOfMs !== null && knowable !== null && knowable > asOfMs ? "AFTER_AS_OF"
    : b.bars < MIN_MTF_BARS ? "INSUFFICIENT" : p.freshness === "STALE" ? "STALE" : "OK";
  return {
    role, timeframe: b.timeframe, state, bars: b.bars, native: p.native, derived_source_tf: p.derived_source_tf ?? null,
    source_ts_ms: p.source_ts_ms ?? null, data_age_ms: p.data_age_ms ?? null, freshness: p.freshness ?? "UNAVAILABLE",
    as_of_t: b.as_of_t, knowable_at_ms: knowable, input_fingerprint: p.input_fingerprint ?? null,
  };
}

function biasOf(b: AnalysisBundle | null, c: MtfComponent): "long" | "short" | "neutral" | null {
  if (!b || c.state !== "OK") return null;
  const s = b.structure;
  if (s.trend === "up") return "long";
  if (s.trend === "down") return "short";
  if (s.trend === "range") return "neutral";
  // "undetermined" is missing evidence, never a neutral reading
  return null;
}

export function buildMtf(macro: AnalysisBundle | null, context: AnalysisBundle | null, trigger: AnalysisBundle | null, asOfMs: number | null = null): MtfResult {
  const comps = [componentOf("macro", macro, asOfMs), componentOf("context", context, asOfMs), componentOf("trigger", trigger, asOfMs)];
  const present = [macro, context, trigger].filter((b): b is AnalysisBundle => b !== null);
  const symbols = new Set(present.map((b) => b.symbol));
  const symbolMismatch = symbols.size > 1;

  // a cross-symbol set exposes NO bias at all (see header)
  const mb = symbolMismatch ? null : biasOf(macro, comps[0]);
  const cb = symbolMismatch ? null : biasOf(context, comps[1]);
  const tb = symbolMismatch ? null : biasOf(trigger, comps[2]);
  const byState = (s: MtfComponentState) => comps.filter((c) => c.state === s).map((c) => `${c.role}${c.timeframe ? `(${c.timeframe})` : ""}`);

  let verdict: MtfVerdict;
  let reason: string;
  if (symbolMismatch) {
    verdict = "UNAVAILABLE";
    reason = `components describe different symbols (${[...symbols].join(", ")}) — refusing cross-symbol MTF`;
  } else if (byState("MISMATCH").length) {
    verdict = "UNAVAILABLE";
    reason = `role/timeframe mismatch: ${byState("MISMATCH").join(", ")} (expected macro=4h, context=1h, trigger=15m)`;
  } else if (byState("AFTER_AS_OF").length) {
    verdict = "UNAVAILABLE";
    reason = `component(s) knowable only after the evaluation instant: ${byState("AFTER_AS_OF").join(", ")} — lookahead refused`;
  } else if (byState("UNAVAILABLE").length) {
    verdict = "UNAVAILABLE";
    reason = `no closed-bar data for ${byState("UNAVAILABLE").join(", ")}`;
  } else if (byState("INSUFFICIENT").length) {
    verdict = "INSUFFICIENT";
    reason = `at least one core timeframe lacks ≥${MIN_MTF_BARS} bars: ${byState("INSUFFICIENT").join(", ")}`;
  } else if (byState("STALE").length) {
    verdict = "STALE";
    reason = `stale core timeframe(s): ${byState("STALE").join(", ")} — no alignment asserted on stale data`;
  } else if (mb === null || cb === null || tb === null) {
    const und = comps.filter((c, i) => [mb, cb, tb][i] === null).map((c) => `${c.role}(${c.timeframe})`);
    verdict = "INSUFFICIENT";
    reason = `technical trend undetermined for ${und.join(", ")} — no alignment asserted without structure`;
  } else if (mb !== "neutral" && mb === cb && cb === tb) {
    verdict = "ALIGNED";
    reason = `4H/1H/15M all ${mb}`;
  } else if (mb === "neutral" || cb === "neutral" || tb === "neutral") {
    verdict = "PARTIAL";
    reason = "one core timeframe neutral";
  } else if (mb === cb) {
    verdict = "PARTIAL";
    reason = "4H and 1H agree; 15M disagrees (wait for trigger alignment)";
  } else if (mb === tb) {
    verdict = "PARTIAL";
    reason = "4H and 15M agree against 1H context";
  } else {
    verdict = "CONFLICT";
    reason = "timeframes disagree — no setup";
  }

  const freshnessVerified = comps.every((c) => c.freshness === "FRESH");
  const derived = comps.filter((c) => c.native === false).map((c) => c.role);
  if (!freshnessVerified && (verdict === "ALIGNED" || verdict === "PARTIAL" || verdict === "CONFLICT")) {
    reason += " (source freshness NOT VERIFIED for every component)";
  }
  if (derived.length) reason += ` (derived series: ${derived.join(", ")})`;
  const ts = comps.map((c) => c.source_ts_ms).filter((v): v is number => v !== null);

  return {
    verdict,
    macro,
    context,
    trigger,
    macro_bias: mb,
    context_bias: cb,
    trigger_bias: tb,
    reason,
    symbol: symbols.size === 1 ? [...symbols][0] : null,
    components: comps,
    freshness_verified: freshnessVerified,
    derived_components: derived,
    oldest_source_ts_ms: ts.length === comps.length ? Math.min(...ts) : null,
    as_of_ms: asOfMs,
  };
}

export interface MtfPart {
  role: MtfComponent["role"];
  timeframe: string;
  input: AnalysisInput;
  bundle: AnalysisBundle | null;
}

/**
 * PURE as-of MTF synthesis — the causality seam.
 *
 * Every component is cut at the SAME instant `nowMs` by the analysis-input
 * contract: a higher-timeframe bar contributes only once `open + period <=
 * nowMs`, so a 4H bar that is still forming can never inform a 15M reading
 * taken inside it (tests/team02-mtf-causality.test.ts).
 */
export function buildMtfAsOf(
  symbol: string,
  series: { macro: CandleSeries | null | undefined; context: CandleSeries | null | undefined; trigger: CandleSeries | null | undefined },
  nowMs: number,
  stats?: SymbolStats,
): { mtf: MtfResult; parts: MtfPart[] } {
  const roles = ["macro", "context", "trigger"] as const;
  const parts: MtfPart[] = roles.map((role) => {
    const tf = MTF_ROLE_TF[role];
    const input = prepareAnalysisInput(symbol, tf, series[role], nowMs);
    return { role, timeframe: tf, input, bundle: buildBundleFromInput(input, stats, nowMs) };
  });
  return { mtf: buildMtf(parts[0].bundle, parts[1].bundle, parts[2].bundle, nowMs), parts };
}
