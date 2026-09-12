/**
 * Central environment/config. All env access happens HERE (plus scripts).
 * Nothing else in the app reads process.env, so keys/URLs cannot scatter.
 * Server-only module: importing it from client code throws immediately.
 */
import { config as loadDotenv } from "dotenv";

// Match Next.js file precedence so `next dev`, vitest and scripts all see the
// same values: .env.local wins over .env. Neither file is ever committed.
loadDotenv({ path: ".env", quiet: true });
loadDotenv({ path: ".env.local", override: true, quiet: true });

if (typeof window !== "undefined") {
  throw new Error("[env] config module imported on the client — env is server-only");
}

function str(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v.trim();
}
function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const TTT_BASE_URL = str("TTT_API_BASE", "https://apiv2.thetruetrade.io");
export const TTT_API_KEY = str("TTT_API_KEY");
export const TTT_API_SECRET = str("TTT_API_SECRET");
export const TTT_HAS_KEY = TTT_API_KEY.length > 0 && TTT_API_SECRET.length > 0;
/** requests/minute budget shared by every TTT consumer */
export const TTT_RATE_PER_MIN = Math.max(1, num("TTT_RATE_PER_MIN", 24));

export const OLLAMA_URL = str("OLLAMA_URL");
export const OPENAI_BASE_URL = str("OPENAI_BASE_URL");
export const OPENAI_API_KEY = str("OPENAI_API_KEY");
export const AI_OLLAMA_MODEL = str("AI_OLLAMA_MODEL", "qwen2.5:3b");
export const AI_OPENAI_MODEL = str("AI_OPENAI_MODEL", "gpt-4o-mini");
export type AiMode = "auto" | "heuristic" | "ollama" | "openai";
export const AI_DEFAULT_PROVIDER = (["auto", "heuristic", "ollama", "openai"].includes(
  str("AI_DEFAULT_PROVIDER", "auto"),
)
  ? str("AI_DEFAULT_PROVIDER", "auto")
  : "auto") as AiMode;

export const NEWS_RSS_URL = str("NEWS_RSS_URL");
export const NEWS_POLL_MIN = Math.max(5, num("NEWS_POLL_MIN", 30));
export const RETENTION_NEWS_DAYS = Math.max(7, num("RETENTION_NEWS_DAYS", 30));
export const RETENTION_JOB_MIN = 30;

export const TELEGRAM_BOT_TOKEN = str("TELEGRAM_BOT_TOKEN");
export const TELEGRAM_CHAT_ID = str("TELEGRAM_CHAT_ID");
export const TELEGRAM_CONFIGURED =
  TELEGRAM_BOT_TOKEN.length > 0 && TELEGRAM_CHAT_ID.length > 0;
/** DRY_RUN=true keeps outbox rows unsent even when configured (default true). */
export const TELEGRAM_DRY_RUN = num("TELEGRAM_DRY_RUN", 1) === 1;

export const ASA_DB_PATH = str("ASA_DB_PATH", "./asa-data/asa.db");
/** Brain (corpus knowledge) DB — deliberately SEPARATE from runtime state so a
 *  runtime wipe can never destroy source provenance. */
export const ASA_BRAIN_DB_PATH = str("ASA_BRAIN_DB_PATH", "./asa-data/brain.db");
/** Immutable RAW corpus location (read-only; ingester never writes here). */
export const ASA_CORPUS_DIR = str("ASA_CORPUS_DIR", "./knowledge/raw");
/** Market history DB — separate so a runtime wipe cannot destroy a backfill. */
export const ASA_HISTORY_DB_PATH = str("ASA_HISTORY_DB_PATH", "./asa-data/history.db");

export const ASA_API_TOKEN = str("ASA_API_TOKEN");

export const ASA_RISK_ACCOUNT_EQUITY = Math.max(1, num("ASA_RISK_ACCOUNT_EQUITY", 10000));
export const ASA_RISK_PER_TRADE_PCT = Math.min(50, Math.max(0.1, num("ASA_RISK_PER_TRADE_PCT", 1)));
export const ASA_RISK_MAX_LEVERAGE = Math.min(50, Math.max(1, num("ASA_RISK_MAX_LEVERAGE", 5)));

export const ASA_PUBLIC_URL = str("ASA_PUBLIC_URL", "http://localhost:3000");
// AUDIT FIX (P2): the advisory admission threshold was read directly from
// process.env inside getScoreThreshold() with no registration here, so the
// System config surface could not show it and its default was undocumented.
export const ASA_SCORE_THRESHOLD = Math.min(100, Math.max(0, num("ASA_SCORE_THRESHOLD", 85)));
export const ASA_LOG_LEVEL = str("ASA_LOG_LEVEL", "info");

export const APP_VERSION = "6.0.0";

/** Masked settings summary for the System surface — NEVER includes secret values. */
export function maskedConfig() {
  return {
    version: APP_VERSION,
    ttt: {
      base: TTT_BASE_URL,
      key: TTT_HAS_KEY ? "CONFIGURED" : "NOT_CONFIGURED",
      rate_per_min: TTT_RATE_PER_MIN,
    },
    ai: {
      default_provider: AI_DEFAULT_PROVIDER,
      ollama: OLLAMA_URL ? "CONFIGURED" : "NOT_CONFIGURED",
      openai: OPENAI_API_KEY ? "CONFIGURED" : "NOT_CONFIGURED",
    },
    news: { rss: NEWS_RSS_URL ? "CONFIGURED" : "NOT_CONFIGURED", poll_min: NEWS_POLL_MIN },
    telegram: TELEGRAM_CONFIGURED ? "CONFIGURED" : "NOT_CONFIGURED",
    db_path: ASA_DB_PATH,
    risk: {
      equity: ASA_RISK_ACCOUNT_EQUITY,
      per_trade_pct: ASA_RISK_PER_TRADE_PCT,
      max_leverage: ASA_RISK_MAX_LEVERAGE,
    },
    advisory: { score_threshold: ASA_SCORE_THRESHOLD },
    api_token: ASA_API_TOKEN ? "CONFIGURED" : "NOT_CONFIGURED",
  };
}
