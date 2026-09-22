/**
 * AUDIT REGRESSION TESTS — one test per P0/P1 defect found and fixed in the
 * final forensic backend audit. Every test here pins a defect that was
 * actually present in the handed-off repository, so it can never silently
 * regress.
 *
 * Covered defects:
 *   P0-1  /api/market/matrix read `outcome.markets` (undefined) — endpoint 503
 *         on every request; failed discovery was masked.
 *   P0-1b /api/market/sync-status assigned DiscoveryOutcome into the snapshot
 *         variable — TypeError (500) after a cold-cache discovery; failure
 *         statuses discarded.
 *   P0-4  history_sync.last_sync_ms was stamped on FAILED syncs and exposed as
 *         last_successful_sync_ms.
 *   P0-7  backtest swallowed syncHistory failures and could label stored data
 *         as fresh; dataMode "fixture" mislabeled TTT-store provenance.
 *   P1-2  outbox FAILED rows were never retried (transient outage = stranded
 *         advisory).
 *   P1-6  expireStaleSignals mutated updated_ms while paginating over
 *         updated_ms DESC — stale signals could be skipped for a cycle.
 *   P1-9  liveEligibleStrategies() exposed executable-but-unvalidated
 *         strategies as live-eligible.
 *
 * NOTE on isolation: env-dependent paths are set BEFORE any src module is
 * dynamically imported, so every store in this file lives in a temp dir.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-audit-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
process.env.TTT_API_BASE = "https://apiv2.thetruetrade.io";
delete process.env.ASA_API_TOKEN; // development mode: mutation guard open

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let origFetch: FetchImpl;
beforeAll(() => {
  origFetch = globalThis.fetch as FetchImpl;
});
afterAll(() => {
  globalThis.fetch = origFetch as typeof globalThis.fetch;
  vi.unstubAllGlobals();
  fs.rmSync(TMP, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ─────────────── P0-4: history failure transparency ─────────────── */

describe("P0-4 history sync failure transparency", () => {
  it("a FAILED sync updates last_attempt_ms + last_error but NEVER last_successful_sync_ms", async () => {
    globalThis.fetch = (async () => jsonRes({}, 500)) as FetchImpl;
    const { syncHistory, getHistoryStore, closeHistoryStore } = await import("../src/lib/market/history-store");
    try {
      // seed a prior successful row by hand
      const store = getHistoryStore();
      const t0 = Date.now() - 100_000;
      store.putSync({
        symbol: "TESTUSDT", timeframe: "1h",
        earliest_ts: 1, latest_ts: 2, bar_count: 10,
        completion_state: "COMPLETE_TO_TTT_BOUNDARY", gap_count: 0,
        dataset_fingerprint: "seed", last_sync_ms: t0, last_attempt_ms: t0,
        last_successful_sync_ms: t0, boundary_proof: "TTT_NO_DATA", boundary_proof_ms: t0,
        last_error: null, retrieval_version: "1.1.0", source: "ttt",
      });

      const before = store.syncRow("TESTUSDT", "1h")!;
      const r = await syncHistory("TESTUSDT", "1h", { full: true });
      const after = store.syncRow("TESTUSDT", "1h")!;

      expect(r.sync_succeeded).toBe(false);
      expect(after.last_attempt_ms).toBeGreaterThanOrEqual(before.last_attempt_ms);
      expect(after.last_successful_sync_ms).toBe(before.last_successful_sync_ms); // NOT moved
      expect(after.last_error).toBeTruthy();
      expect(r.meta.completion_state).toBe("UNAVAILABLE");
    } finally {
      closeHistoryStore();
    }
  });

  it("a SUCCESSFUL sync moves last_successful_sync_ms and clears last_error", async () => {
    // serve three chunks of valid 1h candles, then no_data (the boundary)
    const base = Math.floor(Date.now() / 1000 / 3600) * 3600;
    const bars = (n: number, from: number) => ({
      s: "ok",
      t: Array.from({ length: n }, (_, i) => from + i * 3600),
      o: Array.from({ length: n }, () => 100),
      h: Array.from({ length: n }, () => 101),
      l: Array.from({ length: n }, () => 99),
      c: Array.from({ length: n }, () => 100),
      v: Array.from({ length: n }, () => 10),
    });
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) return jsonRes(bars(5, base - 5 * 3600));
      return jsonRes({ s: "no_data" });
    }) as FetchImpl;
    const { syncHistory, getHistoryStore, closeHistoryStore } = await import("../src/lib/market/history-store");
    try {
      const r = await syncHistory("OKUSDT", "1h", { full: true });
      const row = getHistoryStore().syncRow("OKUSDT", "1h")!;
      expect(r.sync_succeeded).toBe(true);
      expect(row.last_successful_sync_ms).toBeGreaterThan(0);
      expect(row.last_error).toBeNull();
      expect(row.bar_count).toBe(5);
    } finally {
      closeHistoryStore();
    }
  });

  it("an old database without the new columns is migrated (attempt seeded, success only for clean rows)", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { HistoryStore } = await import("../src/lib/market/history-store");
    const legacyPath = path.join(TMP, `legacy-${Date.now()}.db`);
    const db = new Database(legacyPath);
    db.exec(`CREATE TABLE history_sync (
      symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
      earliest_ts INTEGER, latest_ts INTEGER, bar_count INTEGER NOT NULL DEFAULT 0,
      completion_state TEXT NOT NULL DEFAULT 'PARTIAL',
      gap_count INTEGER NOT NULL DEFAULT 0,
      dataset_fingerprint TEXT NOT NULL DEFAULT '',
      last_sync_ms INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, retrieval_version TEXT NOT NULL DEFAULT '1.0.0',
      source TEXT NOT NULL DEFAULT 'ttt',
      PRIMARY KEY (symbol, timeframe));`);
    db.prepare("INSERT INTO history_sync (symbol,timeframe,bar_count,last_sync_ms,last_error) VALUES ('OLDUSDT','1h',50,12345,NULL)").run();
    db.prepare("INSERT INTO history_sync (symbol,timeframe,bar_count,last_sync_ms,last_error) VALUES ('BADUSDT','1h',0,12346,'TTT HTTP 500')").run();
    db.close();
    const store = new HistoryStore(legacyPath);
    const ok = store.syncRow("OLDUSDT", "1h")!;
    const bad = store.syncRow("BADUSDT", "1h")!;
    expect(ok.last_attempt_ms).toBe(12345);
    expect(ok.last_successful_sync_ms).toBe(12345); // clean row: trusted
    expect(bad.last_attempt_ms).toBe(12346);
    expect(bad.last_successful_sync_ms).toBe(0); // errored row: NOT trusted
    store.close();
  });
});

/* ─────────────── P0-7: backtest freshness honesty ─────────────── */

describe("P0-7 backtest data-freshness contract", () => {
  it("a thrown sync failure produces an explicit stored-data warning, never silence", async () => {
    const { describeFreshSync } = await import("../src/lib/backtest/data-freshness");
    const d = describeFreshSync(null, new Error("TTT timeout after 30000ms"));
    expect(d.fresh_sync_status).toBe("failed");
    expect(d.used_stored_data_after_failed_sync).toBe(true);
    expect(d.warning).toContain("fresh history sync FAILED");
    expect(d.warning).toContain("PREVIOUSLY STORED TTT data");
  });

  it("a successful sync is reported as succeeded with no stored-data warning", async () => {
    const { describeFreshSync } = await import("../src/lib/backtest/data-freshness");
    const d = describeFreshSync(
      { sync_succeeded: true, last_successful_sync_ms: 123 } as never,
      null,
    );
    expect(d.fresh_sync_status).toBe("succeeded");
    expect(d.used_stored_data_after_failed_sync).toBe(false);
    expect(d.warning).toBeNull();
  });

  it("a completed-but-unavailable sync is a FAILURE, not success", async () => {
    const { describeFreshSync } = await import("../src/lib/backtest/data-freshness");
    const d = describeFreshSync(
      { sync_succeeded: false, last_successful_sync_ms: null, meta: { reason: "TTT HTTP 503", completion_state: "UNAVAILABLE" } } as never,
      null,
    );
    expect(d.fresh_sync_status).toBe("failed");
    expect(d.fresh_sync_error).toContain("503");
  });

  it("runBacktest surfaces the freshness contract in warnings AND lineage", async () => {
    const { runBacktest } = await import("../src/lib/backtest/engine");
    const candles = Array.from({ length: 200 }, (_, i) => ({
      t: 1_700_000_000 + i * 3600, o: 100, h: 101, l: 99, c: 100, v: 10,
    }));
    const out = runBacktest({
      strategyId: "SET-STR-RAW-2-803", // 1h short, min_bars 120
      symbol: "BTCUSDT",
      candles,
      dataMode: "ttt",
      dataFreshness: {
        fresh_sync_status: "failed",
        fresh_sync_error: "TTT timeout",
        last_successful_sync_ms: 1,
        used_stored_data_after_failed_sync: true,
        warning: "fresh history sync FAILED (TTT timeout) — the backtest ran on PREVIOUSLY STORED TTT data",
      },
    });
    expect(out.warnings.some((w) => w.includes("PREVIOUSLY STORED TTT data"))).toBe(true);
    const lineage = out.lineage as Record<string, unknown>;
    const df = lineage.data_freshness as Record<string, unknown>;
    expect(df.fresh_sync_status).toBe("failed");
    expect(df.used_stored_data_after_failed_sync).toBe(true);
  });
});

/* ─────────────── P1-2: outbox retry semantics ─────────────── */

describe("P1-2 outbox retries FAILED rows", () => {
  it("drainOutbox retries a FAILED row with attempts left and never a DEAD row", async () => {
    const rows: Record<number, { id: number; state: string; attempts: number; error: string | null; payload_json: string; kind: string; created_ms: number; sent_ms: number | null }> = {
      1: { id: 1, state: "FAILED", attempts: 1, error: "provider did not accept", payload_json: JSON.stringify({ kind: "system", generated_at_ms: 1 }), kind: "system", created_ms: 1, sent_ms: null },
      2: { id: 2, state: "DEAD", attempts: 5, error: "max attempts reached", payload_json: JSON.stringify({ kind: "system", generated_at_ms: 2 }), kind: "system", created_ms: 2, sent_ms: null },
    };
    const repo = {
      outboxRetryable: (limit: number) => Object.values(rows).filter((r) => ["QUEUED", "FAILED"].includes(r.state) && r.attempts < 5).slice(0, limit),
      outboxList: () => Object.values(rows),
      outboxMark: (id: number, state: string, error: string | null = null) => {
        const r = rows[id];
        r.state = state;
        r.error = error;
        if (state === "SENT") r.sent_ms = Date.now();
        else r.attempts++;
      },
    };
    const { drainOutbox } = await import("../src/lib/notify/telegram");
    const r = await drainOutbox(repo as never);
    // telegram is NOT configured in tests -> the retry is attempted and fails again
    expect(r.attempted).toBe(1); // only the FAILED row, NOT the DEAD one
    expect(r.retried_failed).toBe(1);
    expect(rows[1].state).toBe("FAILED");
    expect(rows[1].attempts).toBe(2); // retried
    expect(rows[2].state).toBe("DEAD"); // untouched
    expect(rows[2].attempts).toBe(5);
  });
});

/* ─────────────── P1-6: stale signal expiry pagination ─────────────── */

describe("P1-6 expireStaleSignals expires every stale signal despite pagination", () => {
  it("two-phase walk: updates during pagination cannot skip rows", async () => {
    const { expireStaleSignals } = await import("../src/lib/pipeline/orchestrator");
    const now = Date.now();
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `sig-${i}`, state: "published", symbol: "BTCUSDT", timeframe: "1h",
      direction: "long", score: 90, strategy_id: "s", opp_id: null,
      payload_json: "{}", created_ms: now - 7200_000, updated_ms: now - 7200_000,
    }));
    // page ordering is updated_ms DESC — the exact condition under which the
    // old single-phase implementation skipped rows mid-walk.
    const repo = {
      signalPage: (limit: number, offset: number) =>
        [...rows].sort((a, b) => b.updated_ms - a.updated_ms).slice(offset, offset + limit),
      signalUpdate: (u: { id: string; state: string }) => {
        const r = rows.find((x) => x.id === u.id);
        if (r) { r.state = u.state; r.updated_ms = Date.now(); }
      },
    };
    const n = expireStaleSignals(60 * 60_000, repo as never);
    expect(n).toBe(1200);
    expect(rows.every((r) => r.state === "expired")).toBe(true);
  });
});

/* ─────────────── P1-9: executable ≠ live-eligible ─────────────── */

describe("P1-9 executable strategies are never presented as live-eligible", () => {
  it("executableStrategyCandidates returns EXECUTABLE strategies only", async () => {
    const { executableStrategyCandidates } = await import("../src/lib/strategy/registry");
    const all = executableStrategyCandidates();
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) {
      expect(s.availability).toBe("EXECUTABLE");
      expect(s.impl).not.toBeNull();
    }
  });

  it("runtimeStatusFor fails CLOSED without empirical experiments (no strategy is live)", async () => {
    const { runtimeStatusFor, listStrategiesSummary } = await import("../src/lib/pipeline/orchestrator");
    for (const s of listStrategiesSummary()) {
      expect(["DISABLED", "CANDIDATE", "PAPER", "LIVE_ADVISORY_ONLY"]).toContain(runtimeStatusFor(s.strategy_id));
      if (s.executable) {
        // with an empty experiments store, nothing may claim live eligibility
        expect(runtimeStatusFor(s.strategy_id)).not.toBe("LIVE_ADVISORY_ONLY");
      }
    }
    const summary = listStrategiesSummary();
    expect(summary.every((s) => s.live_eligible === false)).toBe(true);
    expect(summary.every((s) => typeof s.executable === "boolean")).toBe(true);
  });

  it("the old misleading function name is gone from the registry", async () => {
    const fsMod = await import("node:fs");
    const src = fsMod.readFileSync("src/lib/strategy/registry.ts", "utf8");
    expect(src).not.toMatch(/export function liveEligibleStrategies/);
  });
});

/* ─────────────── P0-1: matrix + sync-status route fixes ─────────────── */

describe("P0-1 /api/market/matrix and /api/market/sync-status", () => {
  const fixtureMarkets = [
    { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", category: "Layer1", name: "Bitcoin", tickSize: "0.1", stepSize: "0.000001", maxLeverage: 150, maintenanceMarginRate: "0.1", makerFeeCoefficient: "0.0004", takerFeeCoefficient: "0.0004", isActive: true, precisions: ["0.1", "1"], leverageTiers: [] },
    { symbol: "ETHUSDT", baseAsset: "ETH", quoteAsset: "USDT", category: "Layer1", name: "Ethereum", tickSize: "0.01", stepSize: "0.001", maxLeverage: 100, maintenanceMarginRate: "0.1", makerFeeCoefficient: "0.0004", takerFeeCoefficient: "0.0004", isActive: true, precisions: ["0.01", "1"], leverageTiers: [] },
    { symbol: "TONUSDT", baseAsset: "TON", quoteAsset: "USDT", category: "Layer1", name: "Toncoin", tickSize: "0.001", stepSize: "0.01", maxLeverage: 50, maintenanceMarginRate: "0.1", makerFeeCoefficient: "0.0004", takerFeeCoefficient: "0.0004", isActive: true, precisions: ["0.001", "1"], leverageTiers: [] },
  ];

  afterEach(async () => {
    const { __resetCatalogCache } = await import("../src/lib/market/catalog");
    __resetCatalogCache();
  });

  it("matrix: a successful discovery yields a 200 matrix with eligible markets (endpoint was 503 on EVERY request)", async () => {
    globalThis.fetch = (async () => jsonRes(fixtureMarkets)) as FetchImpl;
    const { GET } = await import("../src/app/api/market/matrix/route");
    const res = await GET(new Request("http://localhost/api/market/matrix"));
    expect(res.status).toBe(200); // the defect: this was 503 on every request
    const body = (await res.json()) as { ok: boolean; counts: { markets: number }; matrix: { symbol: string }[] };
    expect(body.ok).toBe(true);
    expect(body.counts.markets).toBe(2); // TONUSDT excluded
    expect(body.matrix.map((m) => m.symbol).sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("matrix: a discovery failure is a 503 with the reason — never a stale-Data 200", async () => {
    globalThis.fetch = (async () => jsonRes({ errors: [{ message: "boom" }] }, 503)) as FetchImpl;
    const { __resetCatalogCache } = await import("../src/lib/market/catalog");
    __resetCatalogCache();
    const { GET } = await import("../src/app/api/market/matrix/route");
    const res = await GET(new Request("http://localhost/api/market/matrix"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; discovery_status: string };
    expect(body.ok).toBe(false);
    expect(body.discovery_status).toBe("NETWORK_FAILURE");
  });

  it("sync-status: cold-cache discovery answers 200 with real counts (was a 500 TypeError)", async () => {
    globalThis.fetch = (async () => jsonRes(fixtureMarkets)) as FetchImpl;
    const { __resetCatalogCache } = await import("../src/lib/market/catalog");
    __resetCatalogCache();
    const { GET } = await import("../src/app/api/market/sync-status/route");
    const res = await GET();
    expect(res.status).toBe(200); // the defect: cold-cache discovery 500-ed
    const body = (await res.json()) as {
      ok: boolean;
      discovery: { ttt_market_count: number; asa_eligible_count: number; excluded_symbol_leaked_into_catalog: boolean; legacy_regression: { expected: number; still_listed: number } };
      history: { last_attempt_ms: number | null; last_successful_sync_ms: number | null };
    };
    expect(body.ok).toBe(true);
    expect(body.discovery.ttt_market_count).toBe(3); // 2 kept + TON counted in excluded
    expect(body.discovery.asa_eligible_count).toBe(2);
    expect(body.discovery.excluded_symbol_leaked_into_catalog).toBe(false);
    expect(body.discovery.legacy_regression.expected).toBe(48);
    expect(typeof body.history.last_attempt_ms).toBe("number");
  });
});

/* ─────────────── mandate B1/B2: universe + type guard ─────────────── */

describe("audit B1/B2: dynamic universe and type safety", () => {
  it("production code never imports LEGACY_48_REGRESSION_SET as a symbol source", async () => {
    const fsMod = await import("node:fs");
    const pathMod = await import("node:path");
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of fsMod.readdirSync(dir, { withFileTypes: true })) {
        const p = pathMod.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const f of walk("src/lib/market").concat(walk("src/lib/pipeline"))) {
      const src = fsMod.readFileSync(f, "utf8");
      const m = src.match(/import\s*\{([^}]*)\}\s*from\s*"[./]*domain\/universe"/);
      if (!m) continue;
      const names = m[1].split(",").map((x) => x.trim()).filter(Boolean);
      const legacy = names.filter((n) => /LEGACY_(48_REGRESSION_SET|UNIVERSE)|^UNIVERSE$/.test(n));
      if (legacy.length > 0) offenders.push(`${f}: ${legacy.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("isUniverseSymbol is a plain boolean guard — dynamic symbols are NOT LegacyRegressionSymbol", async () => {
    const { isUniverseSymbol, registerDiscoveredSymbols, __resetDiscoveredSymbols, isLegacyRegressionSymbol } = await import("../src/lib/domain/universe");
    __resetDiscoveredSymbols();
    // BTCUSDT is in the legacy regression set
    expect(isUniverseSymbol("BTCUSDT")).toBe(true);
    expect(isLegacyRegressionSymbol("BTCUSDT")).toBe(true);
    // a NEW listing is accepted by the synchronous allow-list only after registration
    expect(isUniverseSymbol("XAUUSDT")).toBe(false);
    registerDiscoveredSymbols(["XAUUSDT"]);
    expect(isUniverseSymbol("XAUUSDT")).toBe(true);
    // …but it is NOT a member of the 48-member regression union type
    expect(isLegacyRegressionSymbol("XAUUSDT")).toBe(false);
    expect(isUniverseSymbol("TONUSDT")).toBe(false);
    __resetDiscoveredSymbols();
  });

  it("operational universe stays EMPTY before discovery — no legacy fallback", async () => {
    const { __setOperationalUniverse, operationalUniverse, universeState } = await import("../src/lib/market/operational-universe");
    const { __resetCatalogCache } = await import("../src/lib/market/catalog");
    __resetCatalogCache();
    __setOperationalUniverse(null);
    expect(operationalUniverse()).toEqual([]);
    expect(universeState()).toBe("NOT_READY");
    __setOperationalUniverse(["BTCUSDT"]);
    expect(operationalUniverse()).toEqual(["BTCUSDT"]);
    __setOperationalUniverse(null);
  });
});

/* ─────────────── D-section: signal idempotency ─────────────── */

describe("audit D: signal idempotency is enforced by the database", () => {
  it("re-publishing the same opportunity yields ONE signal row (UNIQUE opp_id)", async () => {
    const { publishSignal } = await import("../src/lib/pipeline/orchestrator");
    const { getRepo, closeRepo } = await import("../src/db/sqlite");
    try {
      const opp = {
        id: "oppfixed", symbol: "BTCUSDT", timeframe: "1h", direction: "long",
        score: 90, setup: "s", thesis: "t",
        entry_zone: null, invalidation: null, stop: null, targets: [], rr: null,
        strategy_id: "STR-RAW-2-803", mode: "live", state: "READY",
        anchor_ts_ms: 0, anchor_close_ms: Date.now(), freshness_ms: 0,
        evidence: [], contradictions: [], score_breakdown: null,
        positive_factors: [], negative_factors: [], blocked_factors: [], unknown_factors: [],
        source_refs: [], data_quality: { bars: 1, stale: false, age_ms: 0, state: "FRESH" },
        psychology: null, portfolio: null, setup_id: null, score_semantics: "s",
        chart_evidence: null, risk: null, ai: null,
        provenance: { generated_at_ms: 0, data: { series_fetched_ms: 0, stats_fetched_ms: null, native_1d: true, candles: { macro: 0, context: 0, trigger: 0 } } },
      } as never;
      publishSignal(opp);
      publishSignal(opp);
      publishSignal(opp);
      const repo = getRepo();
      const rows = repo.signalList(100).filter((r) => r.opp_id === "oppfixed");
      expect(rows.length).toBe(1);
    } finally {
      closeRepo();
    }
  });
});

/* ─────────────── mandate bug 5: empty-success is NOT the TTT boundary ─────────────── */

describe("mandate 5: HTTP 200 s:ok with zero bars is not COMPLETE_TO_TTT_BOUNDARY", () => {
  it("fetchFullHistory reports AMBIGUOUS_EMPTY for an ok-but-empty venue answer", async () => {
    const { fetchFullHistory } = await import("../src/lib/market/history");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      // s:"ok" with EMPTY arrays — the exact conflation case
      return jsonRes({ s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] });
    }));
    const res = await fetchFullHistory("BTCUSDT", "1h", {});
    expect(res.candles).toEqual([]);
    expect(res.meta.completion_state).toBe("AMBIGUOUS_EMPTY");
    expect(res.meta.data_quality).toBe("INSUFFICIENT");
    expect(res.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(res.meta.completion_state).not.toBe("NO_DATA");
  });

  it("an explicit s:no_data answer IS the authoritative boundary (NO_DATA, not AMBIGUOUS_EMPTY)", async () => {
    const { fetchFullHistory } = await import("../src/lib/market/history");
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ s: "no_data" })));
    const res = await fetchFullHistory("BTCUSDT", "1h", {});
    expect(res.candles).toEqual([]);
    expect(res.meta.completion_state).toBe("NO_DATA");
  });

  it("a walk that stops on empty-success after collecting bars is PARTIAL, never COMPLETE", async () => {
    const { fetchFullHistory } = await import("../src/lib/market/history");
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n === 1) {
        // first chunk: one real bar
        const t = Math.floor(Date.now() / 1000) - 3600;
        return jsonRes({ s: "ok", t: [t], o: [100], h: [101], l: [99], c: [100], v: [10] });
      }
      // older window: venue answers ok but empty — walk must stop WITHOUT proving the boundary
      return jsonRes({ s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] });
    }));
    const res = await fetchFullHistory("BTCUSDT", "1h", {});
    expect(res.candles.length).toBe(1);
    expect(res.meta.completion_state).toBe("PARTIAL");
    expect(res.meta.completion_state).not.toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(res.meta.reason).toMatch(/s:ok response with zero candles/i);
  });

  it("syncHistory does not record a successful sync for an AMBIGUOUS_EMPTY outcome", async () => {
    const { getHistoryStore, syncHistory } = await import("../src/lib/market/history-store");
    const { closeRepo } = await import("../src/db/sqlite");
    try {
      vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] })));
      const store = getHistoryStore();
      const r = await syncHistory("ETHUSDT", "1h", {});
      expect(r.sync_succeeded).toBe(false);
      expect(r.meta.completion_state).toBe("AMBIGUOUS_EMPTY");
      const row = store.syncRow("ETHUSDT", "1h");
      expect(row?.last_successful_sync_ms ?? 0).toBe(0);
      expect(row?.last_attempt_ms ?? 0).toBeGreaterThan(0);
    } finally {
      closeRepo();
    }
  });
});

/* ─────────────── §J: scanner uses the shared scoring contract ─────────────── */

describe("audit §J: brain-scanner scoring cannot drift from the advisory pipeline", () => {
  it("source code: brain-scanner delegates to scoreFromEvaluation (no parallel score math)", async () => {
    const fsMod = await import("node:fs");
    const src = fsMod.readFileSync("src/lib/pipeline/brain-scanner.ts", "utf8");
    expect(src).toContain("scoreFromEvaluation");
    // the duplicated inline component table is gone
    expect(src).not.toContain("strategy_compliance:");
    expect(src).not.toContain("reward_risk_quality:");
  });
});

/* ─────────────── B8: COMPILED_STRATEGIES brain-lineage governance ─────────────── */

describe("audit B8: compiled strategies are governed by Brain lineage", () => {
  const CORPUS = "knowledge/raw";
  const hasCorpus = ["RAW_1.txt", "RAW_2.txt", "RAW_3.txt", "RAW_4.txt", "RAW_5.txt"].every((f) =>
    fs.existsSync(path.join(CORPUS, f)),
  );

  type StrategyRecordT = import("../src/lib/brain/types").StrategyRecord;
  async function buildTempBrain(): Promise<{ dbPath: string; strategies: StrategyRecordT[] }> {
    const { BrainStore } = await import("../src/lib/brain/store");
    const { ingestCorpus } = await import("../src/lib/brain/ingest");
    const dbPath = path.join(TMP, `brain-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new BrainStore(dbPath);
    try {
      const report = ingestCorpus(store, CORPUS);
      expect(report.errors, report.errors.join("; ")).toEqual([]);
      return { dbPath, strategies: store.strategies() };
    } finally {
      store.close();
    }
  }

  it.runIf(hasCorpus)("every compiled strategy binds to a Brain StrategyRecord (id + family + source overlap)", async () => {
    const { verifyCompiledLineage } = await import("../src/lib/strategy/lineage");
    const { strategies } = await buildTempBrain();
    const report = verifyCompiledLineage(strategies);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checked).toBeGreaterThanOrEqual(7);
    expect(report.brain_strategy_ids.length).toBe(6);
  });

  it.runIf(hasCorpus)("a compiled strategy with NO brain record is flagged MISSING_BRAIN_RECORD", async () => {
    const { verifyCompiledLineage } = await import("../src/lib/strategy/lineage");
    const { strategies } = await buildTempBrain();
    const tampered = strategies.filter((s) => s.strategy_id !== "STR-RAW-2-581");
    const report = verifyCompiledLineage(tampered);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.kind)).toContain("MISSING_BRAIN_RECORD");
    expect(report.violations.find((v) => v.kind === "MISSING_BRAIN_RECORD")?.strategy_id).toBe("STR-RAW-2-581");
  });

  it.runIf(hasCorpus)("a family drift between compiled strategy and brain record is flagged", async () => {
    const { verifyCompiledLineage } = await import("../src/lib/strategy/lineage");
    const { strategies } = await buildTempBrain();
    const tampered = strategies.map((s): StrategyRecordT =>
      s.strategy_id === "STR-RAW-4-2425" ? { ...s, family: "level-reaction" as StrategyRecordT["family"] } : s,
    );
    const report = verifyCompiledLineage(tampered);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.kind)).toContain("FAMILY_MISMATCH");
  });

  it.runIf(hasCorpus)("a compiled strategy citing disjoint corpus lines is flagged NO_SOURCE_OVERLAP", async () => {
    const { verifyCompiledLineage } = await import("../src/lib/strategy/lineage");
    const { strategies } = await buildTempBrain();
    const tampered = strategies.map((s) =>
      s.strategy_id === "STR-RAW-2-803"
        ? { ...s, source_refs: s.source_refs.map((r) => ({ ...r, start_line: 99990, end_line: 99999 })) }
        : s,
    );
    const report = verifyCompiledLineage(tampered);
    expect(report.violations.map((v) => v.kind)).toContain("NO_SOURCE_OVERLAP");
  });

  it("an empty brain store flags every compiled strategy (lineage can never silently pass)", async () => {
    const { verifyCompiledLineage } = await import("../src/lib/strategy/lineage");
    const report = verifyCompiledLineage([]);
    expect(report.ok).toBe(false);
    expect(report.violations.every((v) => v.kind === "MISSING_BRAIN_RECORD")).toBe(true);
    expect(report.violations.length).toBe(report.checked);
  });
});

/* ─────────────── B3/B4: discovery → universe propagation semantics ─────────────── */

describe("audit B3/B4: discovery drives the operational universe honestly", () => {
  afterEach(async () => {
    const { __setOperationalUniverse } = await import("../src/lib/market/operational-universe");
    const { __resetCatalogCache } = await import("../src/lib/market/catalog");
    __setOperationalUniverse(null);
    __resetCatalogCache();
  });

  const marketRow = (symbol: string, extra: Record<string, unknown> = {}) => ({
    symbol, baseAsset: symbol.replace("USDT", ""), quoteAsset: "USDT", isActive: true, ...extra,
  });

  it("a VALID empty catalog is ADOPTED — the obsolete snapshot is dropped, never kept, never replaced by legacy", async () => {
    const { __setOperationalUniverse, refreshOperationalUniverse, operationalUniverse, universeState } = await import("../src/lib/market/operational-universe");
    const { __resetCatalogCache } = await import("../src/lib/market/catalog");
    const { LEGACY_UNIVERSE } = await import("../src/lib/domain/universe");

    __setOperationalUniverse(["BTCUSDT", "ETHUSDT"]);
    expect(operationalUniverse()).toEqual(["BTCUSDT", "ETHUSDT"]);

    __resetCatalogCache();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes([]))); // valid empty venue answer
    const r = await refreshOperationalUniverse(true);
    expect(r.state).toBe("VALID_EMPTY");
    expect(operationalUniverse()).toEqual([]);
    expect(universeState()).toBe("VALID_EMPTY");
    // and absolutely no legacy fallback
    expect(operationalUniverse().length).not.toBe(LEGACY_UNIVERSE.length);
  });

  it("a discovery FAILURE preserves the previous snapshot as STALE — not VALID_EMPTY, not legacy", async () => {
    const { __setOperationalUniverse, refreshOperationalUniverse, operationalUniverse, universeState } = await import("../src/lib/market/operational-universe");
    const { __resetCatalogCache } = await import("../src/lib/market/catalog");

    __setOperationalUniverse(["BTCUSDT"]);
    __resetCatalogCache();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const r = await refreshOperationalUniverse(true);
    expect(r.state).toBe("STALE");
    expect(universeState()).toBe("STALE");
    expect(operationalUniverse()).toEqual(["BTCUSDT"]); // preserved, not emptied
    expect(typeof r.error).toBe("string");
  });

  it("a market removed from the venue disappears from the operational universe on the next refresh", async () => {
    const { refreshOperationalUniverse, operationalUniverse } = await import("../src/lib/market/operational-universe");
    const { __resetCatalogCache } = await import("../src/lib/market/catalog");

    __resetCatalogCache();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes([marketRow("AAAUSDT"), marketRow("BBBUSDT")])));
    let r = await refreshOperationalUniverse(true);
    expect(r.state).toBe("READY");
    expect(operationalUniverse()).toEqual(["AAAUSDT", "BBBUSDT"]);

    // venue delists BBBUSDT
    __resetCatalogCache();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes([marketRow("AAAUSDT")])));
    r = await refreshOperationalUniverse(true);
    expect(r.state).toBe("READY");
    expect(operationalUniverse()).toEqual(["AAAUSDT"]);
  });

  it("a newly listed market appears without restart (dynamic adoption)", async () => {
    const { refreshOperationalUniverse, operationalUniverse } = await import("../src/lib/market/operational-universe");
    const { __resetCatalogCache } = await import("../src/lib/market/catalog");

    __resetCatalogCache();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes([marketRow("AAAUSDT")])));
    await refreshOperationalUniverse(true);
    expect(operationalUniverse()).toEqual(["AAAUSDT"]);

    // new listing arrives on the next refresh — same process, no restart
    __resetCatalogCache();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes([marketRow("AAAUSDT"), marketRow("NEWLISTEDUSDT")])));
    await refreshOperationalUniverse(true);
    expect(operationalUniverse()).toEqual(["AAAUSDT", "NEWLISTEDUSDT"]);
  });
});
