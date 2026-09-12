/**
 * Strategy ontology — maps the many source aliases onto a SMALL canonical set
 * of families (governance J: avoid strategy explosion).
 *
 * Source naming is preserved as aliases on the StrategyRecord; families exist
 * so that dozens of named variants reuse the same primitives/features instead
 * of spawning dozens of engines.
 */
import type { StrategyFamily } from "./types";

const FAMILY_RULES: { family: StrategyFamily; needles: string[] }[] = [
  { family: "smc-ob", needles: ["اردر بلاک", "order block", "اسمارت مانی", "smart money", "smc", "رجکشن بلاک", "rejection block", "ob"] },
  { family: "market-structure", needles: ["choch", "چنج", "bos", "شکست ساختار", "ساختار بازار", "qm", "کوازimodo", "کوازیمودو"] },
  { family: "harmonic", needles: ["هارمونیک", "harmonic", "ab=cd", "گارتلی", "پروانه", "خفاش"] },
  { family: "divergence", needles: ["دایورجنس", "divergence", "واگرایی"] },
  { family: "breakout", needles: ["بریک اوت", "breakout", "شکست", "رنج شکنی"] },
  { family: "pullback", needles: ["پولبک", "pullback", "اصلاح", "ریتریس", "retrace"] },
  { family: "level-reaction", needles: ["حمایت", "مقاومت", "support", "resistance", "prz", "اعداد رند", "سطوح", "sentimental"] },
  { family: "reversal", needles: ["بازگشت", "reversal", "اشباع", "overbought", "oversold", "پین بار", "pinbar"] },
  { family: "momentum-continuation", needles: ["مومنتوم", "momentum", "ادامه روند", "continuation"] },
  { family: "trend-following", needles: ["روند", "trend", "موج سواری", "wave surfing", "ایچیموکو", "ichimoku", "مووینگ", "moving average"] },
  { family: "multi-indicator", needles: ["rsi", "macd", "ترکیب", "combined", "r.p.c", "cloud test"] },
  { family: "process-layer", needles: ["روانشناسی", "psychology", "امنیت", "security", "ژورنال", "review", "mindset", "ذهنی", "infinite game", "چک لیست", "استاندارد"] },
];

/**
 * Choose a canonical family from the strategy name plus any block text.
 * Order matters: the most specific families are tested first so a
 * "RSI divergence order block" resolves to smc-ob rather than multi-indicator.
 */
export function canonicalFamilyFor(name: string, extra = ""): StrategyFamily {
  // The NAME is authoritative. Block text is only a fallback, because a body
  // that merely mentions "شکست" (break) while describing an emergency exit
  // would otherwise misfile a level-reaction setup as a breakout.
  const primary = name.toLowerCase();
  for (const r of FAMILY_RULES) {
    if (r.needles.some((n) => primary.includes(n))) return r.family;
  }
  const secondary = extra.toLowerCase();
  for (const r of FAMILY_RULES) {
    if (r.needles.some((n) => secondary.includes(n))) return r.family;
  }
  return "discretionary-framework";
}

export const ALL_FAMILIES: StrategyFamily[] = [
  "trend-following", "reversal", "breakout", "pullback", "level-reaction",
  "momentum-continuation", "divergence", "harmonic", "market-structure",
  "smc-ob", "multi-indicator", "discretionary-framework", "process-layer",
];
