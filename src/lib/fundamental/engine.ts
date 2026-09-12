/**
 * Fundamental/news architecture (master §60, docs/news-connectors.md).
 * NewsSource is a SEPARATE type from MarketDataSource — an auxiliary news
 * provider can never become the source of price/candles/venue metrics.
 * Nothing is invented: with no connector configured the module reports
 * NOT_CONFIGURED. RSS parsing is minimal & defensive (no external parser
 * dependency); ingestion is append-only with deterministic dedupe.
 */
import { NEWS_RSS_URL, NEWS_POLL_MIN } from "../env";
import { getRepo } from "../../db/sqlite";
import type { Repo } from "../../db/repo";
import { isOperationalSymbol } from "../market/operational-universe";
import { eventBus } from "../events";
import type { AppState } from "../domain/types";

export interface RawNewsItem {
  source: string; // connector id
  url: string;
  title: string;
  summary: string;
  publishedMs: number | null;
  guid?: string;
}

export interface NewsConnector {
  id: string;
  name: string;
  source_type: "news" | "events" | "social";
  configured: boolean;
  poll(): Promise<RawNewsItem[]>;
  state(): { state: AppState; reason?: string };
}

export interface StoredNews {
  id: number;
  source: string;
  source_type: string;
  url: string;
  title: string;
  summary: string;
  impact: string;
  related_symbols: string[];
  published_at_ms: number | null;
  ingested_at_ms: number;
}

/* -------------------------------------------------------- impact keywords */
const IMPACT_KEYWORDS: [string, string][] = [
  ["etf", "etf"], ["sec", "regulation"], ["regulator", "regulation"], ["lawsuit", "legal"], ["court", "legal"],
  ["fed", "macro"], ["fomc", "macro"], ["cpi", "macro"], ["inflation", "macro"], ["rate decision", "macro"],
  ["hack", "security"], ["exploit", "security"], ["breach", "security"],
  ["liquidation", "liquidations"], ["delist", "listing"], ["listing", "listing"],
  ["partnership", "adoption"], ["adoption", "adoption"], ["halving", "macro"],
];

export function classifyImpact(title: string, summary: string): string {
  const hay = `${title} ${summary}`.toLowerCase();
  for (const [kw, tag] of IMPACT_KEYWORDS) if (hay.includes(kw)) return tag;
  return "general";
}

export function matchSymbols(title: string, summary: string): string[] {
  const hay = `${title} ${summary}`.toUpperCase();
  const out: string[] = [];
  for (const s of ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "TRX", "ADA", "LINK", "AVAX", "DOT", "LTC", "UNI", "ATOM", "XLM", "NEAR", "APT", "ARB", "OP", "SUI", "HBAR", "INJ", "FET", "FIL", "ICP", "AAVE", "ALGO", "BCH", "ETC", "ZEC", "SAND", "CAKE", "VET", "DASH", "KSM", "QNT", "ENA", "ONDO", "WLD", "NOT", "PAXG", "TRUMP", "BAND", "APE", "HYPE", "ASTER", "1000PEPE", "1000SHIB"]) {
    if (hay.includes(s)) {
      const full = s === "1000PEPE" ? "1000PEPEUSDT" : s === "1000SHIB" ? "1000SHIBUSDT" : `${s}USDT`;
      if (isOperationalSymbol(full)) out.push(full);
    }
  }
  return [...new Set(out)];
}

/* ------------------------------------------------------------ RSS helper */
/** Minimal, defensive RSS 2.0 / Atom parser (no external deps). */
export function parseRss(xml: string, sourceUrl: string): RawNewsItem[] {
  const items: RawNewsItem[] = [];
  const entryRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const node = (block: string, tag: string): string | null => {
    const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (!m) return null;
    return m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .trim();
  };
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[2];
    const title = node(block, "title");
    if (!title) continue;
    const link = node(block, "link") ?? node(block, "guid") ?? "";
    const guid = node(block, "guid") ?? link;
    const pubRaw = node(block, "pubDate") ?? node(block, "published") ?? node(block, "updated");
    const pubMs = pubRaw ? Date.parse(pubRaw) : NaN;
    const summary = node(block, "description") ?? node(block, "summary") ?? "";
    items.push({
      source: sourceUrl,
      url: link,
      title: title.slice(0, 500),
      summary: summary.slice(0, 2000),
      publishedMs: Number.isFinite(pubMs) ? pubMs : null,
      guid: guid.slice(0, 300),
    });
  }
  return items;
}

export function dedupeKey(source: string, guid: string | undefined, title: string): string {
  const raw = `${source}|${guid ?? ""}|${title}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `sha1-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/* ------------------------------------------------------ connectors */
/**
 * Connector health (closure §X): CONNECTED must mean a REAL recent successful
 * exchange with the provider, not merely that a URL is configured. We therefore
 * track last_attempt / last_success / last_item / last_error and derive state
 * from observed behaviour.
 */
export interface ConnectorHealth {
  last_attempt_ms: number | null;
  last_success_ms: number | null;
  last_item_ms: number | null;
  last_error: string | null;
  consecutive_failures: number;
}

/** A success older than this makes the connector DEGRADED rather than CONNECTED. */
export const NEWS_SUCCESS_TTL_MS = 3 * 60 * 60_000;

export class GenericRssConnector implements NewsConnector {
  id = "generic-rss";
  name = "Generic RSS (single feed URL — no event calendar, no social connectors)";
  source_type = "news" as const;
  configured: boolean;
  health: ConnectorHealth = {
    last_attempt_ms: null, last_success_ms: null, last_item_ms: null,
    last_error: null, consecutive_failures: 0,
  };

  constructor(private url: string) {
    this.configured = url.length > 0;
  }

  state(): { state: AppState; reason?: string } {
    if (!this.configured) return { state: "NOT_CONFIGURED", reason: "set NEWS_RSS_URL to enable" };
    if (this.health.last_success_ms === null) {
      return this.health.last_attempt_ms === null
        ? { state: "CONNECTING", reason: "configured but not yet polled — never reported as connected on configuration alone" }
        : { state: "ERROR", reason: `no successful poll yet; last error: ${this.health.last_error ?? "unknown"}` };
    }
    const age = Date.now() - this.health.last_success_ms;
    if (age > NEWS_SUCCESS_TTL_MS) {
      return { state: "DEGRADED", reason: `last successful poll was ${Math.round(age / 60_000)} min ago (> ${NEWS_SUCCESS_TTL_MS / 60_000} min)` };
    }
    return { state: "CONNECTED" };
  }

  async poll(): Promise<RawNewsItem[]> {
    if (!this.configured) return [];
    this.health.last_attempt_ms = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(this.url, { signal: ctrl.signal, headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
      if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > 5_000_000) throw new Error("RSS payload too large");
      const items = parseRss(text, this.url);
      this.health.last_success_ms = Date.now();
      this.health.last_error = null;
      this.health.consecutive_failures = 0;
      if (items.length) this.health.last_item_ms = Date.now();
      return items;
    } catch (err) {
      this.health.last_error = err instanceof Error ? err.message : String(err);
      this.health.consecutive_failures++;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const connectors: NewsConnector[] = [new GenericRssConnector(NEWS_RSS_URL)];

export function newsState(): {
  state: AppState; reason?: string; last_poll_ms: number | null; items_stored: number;
  last_attempt_ms: number | null; last_success_ms: number | null; last_item_ms: number | null;
  last_error: string | null; capability: string;
} {
  const anyConfigured = connectors.some((c) => c.configured);
  let last_poll_ms: number | null = null;
  try {
    const news = getRepo().newsList({ days: 30, limit: 1 });
    if (news.length) last_poll_ms = news[0].ingested_ms;
  } catch {
    /* repo may be unavailable in early boot */
  }
  const capability = "generic RSS only — no economic-event calendar and no social/X connector exist in this build";

  if (!anyConfigured) {
    return {
      state: "NOT_CONFIGURED", reason: "no news connector configured (NEWS_RSS_URL empty)",
      last_poll_ms: null, items_stored: countNews(),
      last_attempt_ms: null, last_success_ms: null, last_item_ms: null, last_error: null, capability,
    };
  }
  // Aggregate: the healthiest configured connector determines the state.
  const rss = connectors.find((c) => c instanceof GenericRssConnector) as GenericRssConnector | undefined;
  const st = rss ? rss.state() : { state: "UNAVAILABLE" as AppState, reason: "no connector instance" };
  return {
    state: st.state,
    reason: st.reason,
    last_poll_ms,
    items_stored: countNews(),
    last_attempt_ms: rss?.health.last_attempt_ms ?? null,
    last_success_ms: rss?.health.last_success_ms ?? null,
    last_item_ms: rss?.health.last_item_ms ?? null,
    last_error: rss?.health.last_error ?? null,
    capability,
  };
}

export function countNews(): number {
  try {
    return getRepo().newsList({ days: 30, limit: 5000 }).length;
  } catch {
    return 0;
  }
}

/** Ingest connector items (append-only + dedupe). Returns inserted count.
 *  `repo` is injectable so callers/tests can target a specific store instead
 *  of the app-wide singleton (which is the default in production). */
export function ingestNews(items: RawNewsItem[], repo: Repo = getRepo()): { inserted: number; skipped: number } {
  let inserted = 0, skipped = 0;
  for (const it of items) {
    const key = dedupeKey(it.source, it.guid, it.title);
    const impact = classifyImpact(it.title, it.summary);
    const symbols = matchSymbols(it.title, it.summary);
    const res = repo.newsUpsert({
      dedupe_key: key,
      source: it.source,
      source_type: "news",
      url: it.url,
      title: it.title,
      summary: it.summary,
      impact,
      symbols_json: JSON.stringify(symbols),
      published_ms: it.publishedMs,
      ingested_ms: Date.now(),
    });
    if (res.inserted) inserted++; else skipped++;
  }
  if (inserted > 0) eventBus.emit("news.created", { id: String(Date.now()), title: `${inserted} items ingested` });
  return { inserted, skipped };
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** Poll loop — only active when a connector is configured. */
export function startNewsPolling(onPoll?: (r: { inserted: number; skipped: number }) => void): void {
  if (pollTimer) return;
  const tick = async () => {
    try {
      const anyConfigured = connectors.some((c) => c.configured);
      if (!anyConfigured) return;
      for (const c of connectors) {
        if (!c.configured) continue;
        const items = await c.poll();
        if (items.length) {
          const r = ingestNews(items);
          onPoll?.(r);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      eventBus.emit("system", { message: `news poll failed: ${msg}`, level: "warn" });
    }
  };
  // first run shortly after boot, then every NEWS_POLL_MIN minutes
  pollTimer = setTimeout(() => {
    void tick();
    pollTimer = setInterval(() => void tick(), NEWS_POLL_MIN * 60_000);
  }, 45_000);
}

export function stopNewsPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
