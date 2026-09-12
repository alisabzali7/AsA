/**
 * Multi-timeframe context — core hierarchy 4H macro / 1H context / 15M
 * trigger with an explicit alignment classification. Deterministic.
 */
import type { AnalysisBundle } from "./bundle";

export type MtfVerdict = "ALIGNED" | "PARTIAL" | "CONFLICT" | "INSUFFICIENT";

export interface MtfResult {
  verdict: MtfVerdict;
  macro: AnalysisBundle | null;
  context: AnalysisBundle | null;
  trigger: AnalysisBundle | null;
  macro_bias: "long" | "short" | "neutral" | null;
  context_bias: "long" | "short" | "neutral" | null;
  trigger_bias: "long" | "short" | "neutral" | null;
  reason: string;
}

function biasOf(b: AnalysisBundle | null): "long" | "short" | "neutral" | null {
  if (!b || b.bars < 50) return null;
  const s = b.structure;
  if (s.trend === "up") return "long";
  if (s.trend === "down") return "short";
  return "neutral";
}

export function buildMtf(macro: AnalysisBundle | null, context: AnalysisBundle | null, trigger: AnalysisBundle | null): MtfResult {
  const mb = biasOf(macro), cb = biasOf(context), tb = biasOf(trigger);
  let verdict: MtfVerdict;
  let reason: string;
  if (mb === null || cb === null || tb === null) {
    verdict = "INSUFFICIENT";
    reason = "at least one core timeframe lacks ≥50 bars";
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
  return {
    verdict,
    macro: macro,
    context: context,
    trigger: trigger,
    macro_bias: mb,
    context_bias: cb,
    trigger_bias: tb,
    reason,
  };
}
