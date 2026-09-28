/**
 * User preferences (server-persisted in DB config kv) layered over env
 * defaults. A UI setting changes the DB pref — never source code.
 */
import { getRepo } from "@/db/sqlite";
import { ASA_RISK_ACCOUNT_EQUITY, ASA_RISK_PER_TRADE_PCT, ASA_RISK_MAX_LEVERAGE, AI_DEFAULT_PROVIDER, type AiMode } from "./env";

export interface RiskPrefs {
  equity: number | null;
  perTradePct: number | null;
  maxLeverage: number | null;
  source: "env" | "db" | "mixed" | "unconfigured";
  configured: { equity: boolean; perTradePct: boolean; maxLeverage: boolean };
}

export function getRiskPrefs(): RiskPrefs {
  const parse = (raw: string | null, env: number | null, lo: number, hi: number): { value: number | null; source: "db" | "env" | "unconfigured" } => {
    if (raw !== null) {
      const n = Number(raw);
      return Number.isFinite(n) && n >= lo && n <= hi
        ? { value: n, source: "db" }
        : { value: null, source: "db" };
    }
    if (env !== null && Number.isFinite(env) && env >= lo && env <= hi) return { value: env, source: "env" };
    return { value: null, source: "unconfigured" };
  };

  try {
    const repo = getRepo();
    const equity = parse(repo.configGet("pref.risk.equity"), ASA_RISK_ACCOUNT_EQUITY, 1, 1e9);
    const perTrade = parse(repo.configGet("pref.risk.perTradePct"), ASA_RISK_PER_TRADE_PCT, 0.1, 50);
    const leverage = parse(repo.configGet("pref.risk.maxLeverage"), ASA_RISK_MAX_LEVERAGE, 1, 50);
    const sources = [equity.source, perTrade.source, leverage.source];
    const unique = new Set(sources);
    return {
      equity: equity.value,
      perTradePct: perTrade.value,
      maxLeverage: leverage.value,
      source: unique.size === 1 ? (sources[0] as RiskPrefs["source"]) : unique.size === 2 && !unique.has("unconfigured") ? "mixed" : "unconfigured",
      configured: { equity: equity.value !== null, perTradePct: perTrade.value !== null, maxLeverage: leverage.value !== null },
    };
  } catch {
    const equity = parse(null, ASA_RISK_ACCOUNT_EQUITY, 1, 1e9);
    const perTrade = parse(null, ASA_RISK_PER_TRADE_PCT, 0.1, 50);
    const leverage = parse(null, ASA_RISK_MAX_LEVERAGE, 1, 50);
    return {
      equity: equity.value,
      perTradePct: perTrade.value,
      maxLeverage: leverage.value,
      source: "unconfigured",
      configured: { equity: equity.value !== null, perTradePct: perTrade.value !== null, maxLeverage: leverage.value !== null },
    };
  }
}

export function getAiProviderPref(): AiMode {
  try {
    const v = getRepo().configGet("pref.ai.provider");
    if (v === "auto" || v === "heuristic" || v === "ollama" || v === "openai") return v;
  } catch {
    /* fall through */
  }
  return AI_DEFAULT_PROVIDER;
}
