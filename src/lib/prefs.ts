/**
 * User preferences (server-persisted in DB config kv) layered over env
 * defaults. A UI setting changes the DB pref — never source code.
 */
import { getRepo } from "@/db/sqlite";
import { ASA_RISK_ACCOUNT_EQUITY, ASA_RISK_PER_TRADE_PCT, ASA_RISK_MAX_LEVERAGE, AI_DEFAULT_PROVIDER, type AiMode } from "./env";

export interface RiskPrefs {
  equity: number;
  perTradePct: number;
  maxLeverage: number;
  source: "env" | "db";
}

export function getRiskPrefs(): RiskPrefs {
  try {
    const repo = getRepo();
    const eq = repo.configGet("pref.risk.equity");
    const pt = repo.configGet("pref.risk.perTradePct");
    const ml = repo.configGet("pref.risk.maxLeverage");
    const n = (v: string | null, fb: number, lo: number, hi: number) => {
      if (v === null) return fb;
      const x = Number(v);
      return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fb;
    };
    return {
      equity: n(eq, ASA_RISK_ACCOUNT_EQUITY, 1, 1e9),
      perTradePct: n(pt, ASA_RISK_PER_TRADE_PCT, 0.1, 50),
      maxLeverage: n(ml, ASA_RISK_MAX_LEVERAGE, 1, 50),
      source: eq || pt || ml ? "db" : "env",
    };
  } catch {
    return { equity: ASA_RISK_ACCOUNT_EQUITY, perTradePct: ASA_RISK_PER_TRADE_PCT, maxLeverage: ASA_RISK_MAX_LEVERAGE, source: "env" };
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
