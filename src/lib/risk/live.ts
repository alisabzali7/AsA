/** Server-owned input assembly shared by scan and final publication.
 * Caller-supplied verdicts never replace evaluation against current policy,
 * preferences and venue constraints. This calculates advice, never execution.
 */
import { getRepo } from "../../db/sqlite";
import { isOperationalSymbol, universeState } from "../market/operational-universe";
import { sharedStore } from "../market/store";
import { getRiskPrefs } from "../prefs";
import { getProductionRiskPolicy } from "./policy";
import { evaluateRisk } from "./engine";

export function evaluateLiveRisk(symbol: string, direction: "long" | "short", entry: number, stop: number, target: number | null) {
  const meta = sharedStore.catalog.get(symbol);
  const policy = getProductionRiskPolicy();
  const rp = getRiskPrefs();
  const result = evaluateRisk({
    symbol, direction, entry, stop, target, equity: rp.equity,
    riskPerTradePct: policy.risk_per_trade_pct ?? rp.perTradePct,
    maxLeverage: policy.max_leverage ?? rp.maxLeverage,
    venueMaxLeverage: meta?.maxLeverage ?? null,
    maintenanceMarginRate: meta?.maintenanceMarginRate ?? null,
    takerFeeCoefficient: meta?.takerFeeCoefficient ?? null,
    tickSize: meta?.tickSize ?? null, qtyStep: meta?.stepSize ?? null,
    minQty: meta?.minQty ?? null, minNotional: meta?.minNotional ?? null,
  });
  // No incomplete numeric risk assessment may authorize live publication.
  // Research/backtest callers keep the engine's explicit unenforced accounting.
  const blocks: string[] = result.unenforced.map(reason => `live risk incomplete: ${reason}`);
  if (universeState() !== "READY" || !isOperationalSymbol(symbol)) blocks.push("TTT discovery unavailable/stale or symbol not currently operational");
  if (!meta || meta.isActive !== true) blocks.push("current TTT instrument metadata unavailable/inactive");
  for (const key of ["tickSize", "stepSize", "maxLeverage", "maintenanceMarginRate", "takerFeeCoefficient"] as const) {
    if (meta?.[key] == null) blocks.push(`TTT ${key} UNAVAILABLE — live risk cannot certify this constraint`);
  }
  // Stored malformed preferences must not become a permissive fallback/clamp.
  // Missing overrides legitimately use server-declared environment defaults.
  for (const [key, min, max] of [["equity", 1, 1e9], ["perTradePct", 0.1, 50], ["maxLeverage", 1, 50]] as const) {
    const raw = getRepo().configGet(`pref.risk.${key}`);
    if (raw !== null && (raw.trim() === "" || !Number.isFinite(Number(raw)) || Number(raw) < min || Number(raw) > max))
      blocks.push(`stored risk ${key} malformed/out of range`);
  }
  if (policy.runtime_status === "DISABLED" || policy.selection_reason.includes("does not match")) blocks.push("selected risk policy invalid/disabled");
  return blocks.length ? { ...result, verdict: "block" as const, reasons: [...result.reasons, ...blocks] } : result;
}
