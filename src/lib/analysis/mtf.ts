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
 * Before, a stale 4H series (or a series left over from another symbol) could
 * still produce ALIGNED, because only bar counts were checked.
 */
import type { AnalysisBundle } from "./bundle";

export type MtfVerdict = "ALIGNED" | "PARTIAL" | "CONFLICT" | "INSUFFICIENT" | "STALE" | "UNAVAILABLE";
export type MtfComponentState = "OK" | "UNAVAILABLE" | "INSUFFICIENT" | "STALE";

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
}

function componentOf(role: MtfComponent["role"], b: AnalysisBundle | null): MtfComponent {
  if (!b) return { role, timeframe: null, state: "UNAVAILABLE", bars: 0, native: null, derived_source_tf: null, source_ts_ms: null, data_age_ms: null, freshness: "UNAVAILABLE" };
  const p = b.provenance;
  const state: MtfComponentState = b.bars < MIN_MTF_BARS ? "INSUFFICIENT" : p.freshness === "STALE" ? "STALE" : "OK";
  return {
    role, timeframe: b.timeframe, state, bars: b.bars, native: p.native, derived_source_tf: p.derived_source_tf ?? null,
    source_ts_ms: p.source_ts_ms ?? null, data_age_ms: p.data_age_ms ?? null, freshness: p.freshness ?? "UNAVAILABLE",
  };
}

function biasOf(b: AnalysisBundle | null, c: MtfComponent): "long" | "short" | "neutral" | null {
  if (!b || c.state !== "OK") return null;
  const s = b.structure;
  if (s.trend === "up") return "long";
  if (s.trend === "down") return "short";
  return "neutral";
}

export function buildMtf(macro: AnalysisBundle | null, context: AnalysisBundle | null, trigger: AnalysisBundle | null): MtfResult {
  const comps = [componentOf("macro", macro), componentOf("context", context), componentOf("trigger", trigger)];
  const present = [macro, context, trigger].filter((b): b is AnalysisBundle => b !== null);
  const symbols = new Set(present.map((b) => b.symbol));
  const symbolMismatch = symbols.size > 1;

  const mb = biasOf(macro, comps[0]), cb = biasOf(context, comps[1]), tb = biasOf(trigger, comps[2]);
  const byState = (s: MtfComponentState) => comps.filter((c) => c.state === s).map((c) => `${c.role}${c.timeframe ? `(${c.timeframe})` : ""}`);

  let verdict: MtfVerdict;
  let reason: string;
  if (symbolMismatch) {
    verdict = "UNAVAILABLE";
    reason = `components describe different symbols (${[...symbols].join(", ")}) — refusing cross-symbol MTF`;
  } else if (byState("UNAVAILABLE").length) {
    verdict = "UNAVAILABLE";
    reason = `no closed-bar data for ${byState("UNAVAILABLE").join(", ")}`;
  } else if (byState("INSUFFICIENT").length) {
    verdict = "INSUFFICIENT";
    reason = `at least one core timeframe lacks ≥${MIN_MTF_BARS} bars: ${byState("INSUFFICIENT").join(", ")}`;
  } else if (byState("STALE").length) {
    verdict = "STALE";
    reason = `stale core timeframe(s): ${byState("STALE").join(", ")} — no alignment asserted on stale data`;
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
  };
}
