/**
 * Retention policy tests (30d window; append-only inside; audited runs)
 * + fundamental connector basics (RSS parse, dedupe, classification).
 * Uses a temp SQLite file (no app DB touched).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteRepo } from "../src/db/sqlite";
import type { Repo } from "../src/db/repo";
import { parseRss, dedupeKey, classifyImpact, matchSymbols, ingestNews } from "../src/lib/fundamental/engine";

let repo: Repo;
let dbPath: string;
beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `asa-test-${Date.now()}.db`);
  repo = new SqliteRepo(dbPath);
});
afterAll(() => {
  repo.close();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

const DAY = 86_400_000;

describe("news retention (30d rolling window)", () => {
  it("stores items append-only with deterministic dedupe", () => {
    const item = { source: "test", url: "https://example.com/1", title: "Bitcoin ETF volume surges", summary: "x", publishedMs: Date.now() - 2 * DAY, guid: "g1" };
    const r1 = repo.newsUpsert({ dedupe_key: dedupeKey(item.source, item.guid, item.title), source: "test", source_type: "news", url: item.url, title: item.title, summary: item.summary, impact: "etf", symbols_json: JSON.stringify(matchSymbols(item.title, "")), published_ms: item.publishedMs, ingested_ms: Date.now() });
    const r2 = repo.newsUpsert({ dedupe_key: dedupeKey(item.source, item.guid, item.title), source: "test", source_type: "news", url: item.url, title: item.title, summary: item.summary, impact: "etf", symbols_json: "[]", published_ms: item.publishedMs, ingested_ms: Date.now() });
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false); // idempotent
    expect(repo.newsList({ days: 30, limit: 10 }).length).toBe(1);
  });

  it("deletes ONLY rows older than the window and logs an audit row", () => {
    const now = Date.now();
    const old = { source: "test", url: "https://e.com/old", title: "old news", summary: "", publishedMs: now - 45 * DAY, guid: "g-old" };
    const fresh = { source: "test", url: "https://e.com/new", title: "fresh news", summary: "", publishedMs: now - 1 * DAY, guid: "g-new" };
    repo.newsUpsert({ dedupe_key: dedupeKey(old.source, old.guid, old.title), source: old.source, source_type: "news", url: old.url, title: old.title, summary: old.summary, impact: "general", symbols_json: "[]", published_ms: old.publishedMs, ingested_ms: now - 40 * DAY });
    repo.newsUpsert({ dedupe_key: dedupeKey(fresh.source, fresh.guid, fresh.title), source: fresh.source, source_type: "news", url: fresh.url, title: fresh.title, summary: fresh.summary, impact: "general", symbols_json: "[]", published_ms: fresh.publishedMs, ingested_ms: now - 1 * DAY });
    const cutoff = now - 30 * DAY;
    const deleted = repo.newsDeleteOlderThan(cutoff);
    repo.retentionLog({ ran_ms: now, table_name: "news_events", deleted, cutoff_ms: cutoff, ok: 1, note: "test run" });
    expect(deleted).toBe(1); // exactly the 40-day-old row
    const rest = repo.newsList({ days: 30, limit: 100 });
    expect(rest.every((n) => n.title !== "old news")).toBe(true);
    expect(rest.some((n) => n.title === "fresh news")).toBe(true); // inside window survives
    const runs = repo.retentionRuns(10);
    expect(runs[0].table_name).toBe("news_events");
    expect(runs[0].deleted).toBe(1);
    expect(runs[0].ok).toBe(1);
  });
});

describe("RSS parsing (defensive, no external parser)", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>SEC approves spot ETF</title><link>https://e.com/a</link><guid>abc</guid><pubDate>Tue, 03 Sep 2026 10:00:00 GMT</pubDate><description>Regulator decision &amp; market reaction</description></item>
  <item><title><![CDATA[Bitcoin <b>surges</b> after CPI]]></title><link>https://e.com/b</link><guid>def</guid><pubDate>Wed, 04 Sep 2026 08:30:00 GMT</pubDate></item>
  <item><title>No date item</title><link>https://e.com/c</link><guid>ghi</guid></item>
</channel></rss>`;

  it("parses titles/links/guids/dates and strips tags/CDATA/entities", () => {
    const items = parseRss(xml, "https://feed.example/x");
    expect(items.length).toBe(3);
    expect(items[0].title).toBe("SEC approves spot ETF");
    expect(items[1].title).toBe("Bitcoin surges after CPI");
    expect(items[0].summary).toContain("Regulator decision & market reaction");
    expect(items[0].publishedMs).not.toBeNull();
    expect(items[2].publishedMs).toBeNull();
    expect(items[0].guid).toBe("abc");
  });

  it("classifies impact and matches universe symbols", () => {
    expect(classifyImpact("SEC approves", "")).toBe("regulation");
    expect(classifyImpact("FOMC rate decision today", "")).toBe("macro");
    expect(classifyImpact("exchange hack", "")).toBe("security");
    expect(classifyImpact("ordinary headline", "")).toBe("general");
    const syms = matchSymbols("Bitcoin ETF news affects BTC and ETH", "");
    expect(syms).toContain("BTCUSDT");
    expect(syms).toContain("ETHUSDT");
    expect(syms.length).toBe(2);
    // TON can never leak from matching
    expect(matchSymbols("TON ecosystem grows", "").includes("TONUSDT")).toBe(false);
  });

  it("ingestNews is deduplicating and reports inserted/skipped", () => {
    const items = parseRss(xml, "https://feed.example/x").slice(0, 2);
    // repo injected: hermetic store, never the app-wide singleton
    const first = ingestNews(items, repo);
    expect(first.inserted).toBe(2);
    const second = ingestNews(items, repo);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
  });
});
