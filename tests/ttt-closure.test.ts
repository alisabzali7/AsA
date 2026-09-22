/**
 * Final-closure regressions for TTT transport, history truth, derivation and
 * candle retention. Each case fails if the protection is removed.
 *
 * No network: fetch is stubbed, the rate budget is an injected scheduler, and
 * history persistence is the in-memory double.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { MemoryHistoryStore } from "./fixtures/market/memory-history-store";

const LOCAL = "http://127.0.0.1:9";

function json(body: unknown, status = 200, headers: Record<string, string> = { "Content-Type": "application/json" }): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function bar(t: number) {
  return { s: "ok", t: [t], o: [100], h: [101], l: [99], c: [100], v: [10] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function scheduler() {
  const mod = await import("../src/lib/ttt/scheduler");
  const s = new mod.TttScheduler({ ratePerMin: 100_000, jitter: () => 0 });
  mod.setActiveScheduler(s);
  return { ...mod, s };
}

describe("transport classification pays exactly once and does not follow redirects", () => {
  afterEach(async () => {
    const { setActiveScheduler } = await import("../src/lib/ttt/scheduler");
    setActiveScheduler(null);
  });

  it("a 3xx is a non-retryable client refusal, and fetch is asked not to follow", async () => {
    const { s } = await scheduler();
    const { tttRequest, TttHttpError } = await import("../src/lib/ttt/http");
    const inits: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response(null, { status: 302, headers: { location: "https://evil.example/exfil" } });
    }));

    await expect(tttRequest("/futures/markets", { baseUrl: LOCAL, retries: 2 })).rejects.toSatisfy(
      (e: unknown) => e instanceof TttHttpError && e.kind === "client" && /redirect/.test(e.message),
    );

    expect(inits).toHaveLength(1);
    expect(inits[0].redirect).toBe("manual");
    expect(s.stats().total_grants).toBe(1);
    expect(s.stats().total_429).toBe(0);
  });

  it("an empty GET body is invalid_response, not a successful empty payload, and is not retried", async () => {
    const { s } = await scheduler();
    const { tttRequest, TttHttpError } = await import("../src/lib/ttt/http");
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return new Response("", { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    await expect(tttRequest("/futures/markets", { baseUrl: LOCAL, retries: 2 })).rejects.toSatisfy(
      (e: unknown) => e instanceof TttHttpError && e.kind === "invalid_response",
    );
    expect(calls).toBe(1);
    expect(s.stats().total_grants).toBe(1);
  });

  it("a parsed empty JSON value is a successful response, distinct from a missing body", async () => {
    const { s } = await scheduler();
    const { tttRequest } = await import("../src/lib/ttt/http");
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    const res = await tttRequest<unknown[]>("/futures/markets", { baseUrl: LOCAL });
    expect(res.data).toEqual([]);
    expect(s.stats().total_grants).toBe(1);
  });

  it("credentials and credential headers are refused before admission and before fetch", async () => {
    const { s } = await scheduler();
    const { tttRequest } = await import("../src/lib/ttt/http");
    const fetchMock = vi.fn(async () => json([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(tttRequest("/futures/markets", { baseUrl: LOCAL, apiKey: "k" })).rejects.toThrow(/credential/i);
    await expect(tttRequest("/futures/markets", { baseUrl: LOCAL, apiSecret: "s" })).rejects.toThrow(/credential/i);
    await expect(tttRequest("/futures/markets", { baseUrl: LOCAL, headers: { "X-API-Key": "k" } })).rejects.toThrow(/credential/i);
    await expect(tttRequest("/futures/markets", { baseUrl: LOCAL, headers: { "X-Signature": "sig" } })).rejects.toThrow(/credential/i);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.stats().total_grants).toBe(0);
    expect(s.stats().total_requests).toBe(0);
  });

  it("undefined credentials stay a non-event (the unsigned client call must not throw)", async () => {
    const { s } = await scheduler();
    const { tttRequest } = await import("../src/lib/ttt/http");
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    await expect(tttRequest("/futures/markets", { baseUrl: LOCAL, apiKey: undefined, apiSecret: undefined })).resolves.toMatchObject({ ok: true });
    expect(s.stats().total_grants).toBe(1);
  });

  it("a non-allow-listed host consumes zero tokens and is counted once", async () => {
    const { s } = await scheduler();
    const { tttRequest } = await import("../src/lib/ttt/http");
    const fetchMock = vi.fn(async () => json([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(tttRequest("/futures/markets", { baseUrl: "https://not-ttt.example" })).rejects.toThrow(/allow-list/i);
    await expect(tttRequest("/futures/markets", { baseUrl: "https://not-ttt.example" })).rejects.toThrow(/allow-list/i);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.stats().total_grants).toBe(0);
    expect(s.stats().rejected_non_ttt).toBe(2);
  });

  it("userinfo and cleartext on an approved host never reach the network", async () => {
    const { s } = await scheduler();
    const { tttRequest } = await import("../src/lib/ttt/http");
    const fetchMock = vi.fn(async () => json([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(tttRequest("/x", { baseUrl: "https://user:pass@apiv2.thetruetrade.io" })).rejects.toThrow(/credential/i);
    await expect(tttRequest("/x", { baseUrl: "http://apiv2.thetruetrade.io" })).rejects.toThrow(/https/i);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.stats().total_grants).toBe(0);
    expect(s.stats().rejected_non_ttt).toBe(0);
  });

  it("localhost is refused in production and counted as a non-TTT rejection", async () => {
    const { s } = await scheduler();
    const { tttRequest } = await import("../src/lib/ttt/http");
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      await expect(tttRequest("/x", { baseUrl: LOCAL })).rejects.toThrow(/allow-list/i);
      expect(s.stats().rejected_non_ttt).toBe(1);
      expect(s.stats().total_grants).toBe(0);
    } finally {
      env.NODE_ENV = prev;
    }
  });

  it("an ordinary 4xx is client, one admission, no retry", async () => {
    const { s } = await scheduler();
    const { tttRequest, TttHttpError } = await import("../src/lib/ttt/http");
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return json({ errors: [{ message: "no such symbol" }] }, 404);
    }));
    await expect(tttRequest("/missing", { baseUrl: LOCAL, retries: 2 })).rejects.toSatisfy(
      (e: unknown) => e instanceof TttHttpError && e.kind === "client" && e.status === 404,
    );
    expect(calls).toBe(1);
    expect(s.stats().total_grants).toBe(1);
  });

  it("note429 is recorded before the 429 body is read", () => {
    const http = fs.readFileSync("src/lib/ttt/http.ts", "utf8");
    const note = http.indexOf("scheduler.note429()");
    const body = http.indexOf("await res.text()");
    expect(note).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(note);
    expect(http).toMatch(/redirect:\s*"manual"/);
    const refuse = http.indexOf("refuseCredentials(opts)");
    const acquire = http.indexOf("scheduler.acquire(lane)");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(acquire);
  });
});

describe("history completion does not invent a venue boundary", () => {
  afterEach(async () => {
    const { setActiveScheduler } = await import("../src/lib/ttt/scheduler");
    const { __resetHistoryStore } = await import("../src/lib/market/history-store");
    setActiveScheduler(null);
    __resetHistoryStore();
  });

  it("a structurally invalid UDF payload is INVALID_RESPONSE, not NO_DATA, and is not retried", async () => {
    await scheduler();
    const { fetchFullHistory } = await import("../src/lib/market/history");
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return json({ s: "error", errmsg: "bad payload" });
    }));

    const res = await fetchFullHistory("BTCUSDT", "1h", {});

    expect(calls).toBe(1); // retries:2 on the chunk, but a bad payload is not a transport failure
    expect(res.candles).toEqual([]);
    expect(res.meta.completion_state).toBe("INVALID_RESPONSE");
    expect(res.meta.completion_state).not.toBe("NO_DATA");
    expect(res.meta.boundary_evidence).toBeNull();
    expect(res.meta.stop_cause).toBe("invalid_response");
    expect(res.meta.reason).toBeTruthy();
  });

  it("HTML and malformed JSON are invalid responses, not transport outages and not no_data", async () => {
    await scheduler();
    const { fetchFullHistory } = await import("../src/lib/market/history");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>no</html>", { status: 200, headers: { "Content-Type": "text/html" } })));
    const html = await fetchFullHistory("BTCUSDT", "1h", {});
    expect(html.meta.completion_state).toBe("INVALID_RESPONSE");
    expect(html.meta.stop_cause).toBe("invalid_response");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"s\":\"ok\",\"t\":[", { status: 200, headers: { "Content-Type": "application/json" } })));
    const broken = await fetchFullHistory("ETHUSDT", "1h", {});
    expect(broken.meta.completion_state).toBe("INVALID_RESPONSE");
    expect(broken.meta.completion_state).not.toBe("UNAVAILABLE");
    expect(broken.meta.completion_state).not.toBe("NO_DATA");
  });

  it("maxChunks 0 asks the venue nothing and does not claim NO_DATA", async () => {
    await scheduler();
    const { fetchFullHistory } = await import("../src/lib/market/history");
    const fetchMock = vi.fn(async () => json({ s: "no_data" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchFullHistory("BTCUSDT", "1h", { maxChunks: 0 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.meta.completion_state).toBe("UNAVAILABLE");
    expect(res.meta.completion_state).not.toBe("NO_DATA");
    expect(res.meta.stop_cause).toBe("chunk_limit");
    expect(res.meta.boundary_evidence).toBeNull();
    expect(res.meta.chunks_fetched).toBe(0);
  });

  it("an explicit no_data, a lower bound and a chunk limit are different stop causes", async () => {
    await scheduler();
    const { fetchFullHistory } = await import("../src/lib/market/history");
    const { makeFakeVenue, stubVenue } = await import("./fixtures/market/fake-venue");
    const step = 3600;
    const newest = Math.floor(Date.now() / 1000 / step) * step;

    stubVenue(makeFakeVenue({ stepSec: step, earliest: newest - 4 * step, count: 5 }));
    const proved = await fetchFullHistory("BTCUSDT", "1h", {});
    expect(proved.meta.completion_state).toBe("COMPLETE_TO_TTT_BOUNDARY");
    expect(proved.meta.stop_cause).toBe("explicit_no_data");

    stubVenue(makeFakeVenue({ stepSec: step, earliest: newest - 9 * step, count: 10 }));
    const bounded = await fetchFullHistory("BTCUSDT", "1h", { from: newest - 2 * step });
    expect(bounded.meta.completion_state).toBe("PARTIAL");
    expect(bounded.meta.stop_cause).toBe("explicit_lower_bound");
    expect(bounded.meta.boundary_evidence).toBeNull();

    stubVenue(makeFakeVenue({ stepSec: step, earliest: newest - 20 * step, count: 21 }, { maxBarsPerResponse: 3 }));
    const capped = await fetchFullHistory("BTCUSDT", "1h", { maxChunks: 1 });
    expect(capped.meta.completion_state).toBe("PARTIAL");
    expect(capped.meta.stop_cause).toBe("chunk_limit");
    expect(capped.meta.boundary_evidence).toBeNull();
  });

  it("an invalid payload does not move last_successful_sync_ms", async () => {
    await scheduler();
    const { __setHistoryStore, syncHistory } = await import("../src/lib/market/history-store");
    const store = new MemoryHistoryStore();
    __setHistoryStore(store);
    vi.stubGlobal("fetch", vi.fn(async () => json({ s: "error" })));

    const r = await syncHistory("BTCUSDT", "1h", { full: true });
    const row = store.syncRow("BTCUSDT", "1h")!;

    expect(r.sync_succeeded).toBe(false);
    expect(r.meta.completion_state).toBe("INVALID_RESPONSE");
    expect(row.completion_state).toBe("INVALID_RESPONSE");
    expect(row.last_successful_sync_ms).toBe(0);
    expect(row.last_error).toBeTruthy();
    expect(row.boundary_proof).toBeNull();
  });
});

describe("history route does not paint an empty store as a venue boundary", () => {
  afterEach(async () => {
    const { setActiveScheduler } = await import("../src/lib/ttt/scheduler");
    const { __resetHistoryStore } = await import("../src/lib/market/history-store");
    const { __resetCatalogCache } = await import("../src/lib/market/catalog");
    setActiveScheduler(null);
    __resetHistoryStore();
    __resetCatalogCache();
  });

  function marketFetch(historyBody: unknown) {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/futures/markets")) {
        return json([{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", isActive: true }]);
      }
      return json(historyBody);
    }));
  }

  it("a never-synced series is NOT_SYNCED, not NO_DATA, and the boundary flag is false", async () => {
    await scheduler();
    const { __setHistoryStore } = await import("../src/lib/market/history-store");
    __setHistoryStore(new MemoryHistoryStore());
    marketFetch({ s: "no_data" });
    const { GET } = await import("../src/app/api/market/history/route");

    const res = await GET(new Request("http://localhost/api/market/history?symbol=BTCUSDT&tf=1h"));
    const body = await res.json() as { ok: boolean; metadata: { completion_state: string; earliest_boundary_reached: boolean } };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.metadata.completion_state).toBe("NOT_SYNCED");
    expect(body.metadata.completion_state).not.toBe("NO_DATA");
    expect(body.metadata.earliest_boundary_reached).toBe(false);
  });

  it("a sync that received a bad payload is reported as INVALID_RESPONSE, not a boundary", async () => {
    await scheduler();
    const { __setHistoryStore } = await import("../src/lib/market/history-store");
    __setHistoryStore(new MemoryHistoryStore());
    marketFetch({ s: "error" });
    const { GET } = await import("../src/app/api/market/history/route");

    const res = await GET(new Request("http://localhost/api/market/history?symbol=BTCUSDT&tf=1h&sync=full"));
    const body = await res.json() as { metadata: { completion_state: string; earliest_boundary_reached: boolean; last_error: string | null } };

    expect(body.metadata.completion_state).toBe("INVALID_RESPONSE");
    expect(body.metadata.earliest_boundary_reached).toBe(false);
    expect(body.metadata.last_error).toBeTruthy();
  });

  it("the chart claims a venue boundary only from earliest_boundary_reached", () => {
    const chart = fs.readFileSync("src/components/chart-view.tsx", "utf8");
    expect(chart).toMatch(/earliest_boundary_reached === true/);
    expect(chart).toMatch(/TTT boundary reached/);
    expect(chart).not.toMatch(/exhausted = page\.length === 0/);
    const route = fs.readFileSync("src/app/api/market/history/route.ts", "utf8");
    expect(route).not.toMatch(/completion_state:\s*"NO_DATA"/);
  });
});

describe("derivation is labeled, justified, and never an empty success", () => {
  afterEach(async () => {
    const { setActiveScheduler } = await import("../src/lib/ttt/scheduler");
    setActiveScheduler(null);
  });

  it("a 5xx whose body says unsupported resolution does not derive", async () => {
    await scheduler();
    const { tttClient } = await import("../src/lib/ttt/client");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return json({ errors: [{ message: "unsupported resolution 1D" }] }, 500);
    }));

    await expect(tttClient.getDailyCandles("BTCUSDT", 5)).rejects.toThrow();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("resolution=1D");
    expect(urls.some((u) => u.includes("resolution=480"))).toBe(false);
  });

  it("explicit no_data plus an empty 8h fallback throws instead of returning native:false []", async () => {
    await scheduler();
    const { tttClient } = await import("../src/lib/ttt/client");
    vi.stubGlobal("fetch", vi.fn(async () => json({ s: "no_data" })));

    await expect(tttClient.getDailyCandles("BTCUSDT", 5)).rejects.toThrow(/refusing to emit a derived series/);
  });

  it("a justified 8h derivation is labeled derived and is not native", async () => {
    await scheduler();
    const { tttClient } = await import("../src/lib/ttt/client");
    const day = 1_700_006_400;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("resolution=1D")) return json({ s: "no_data" });
      const t = [day, day + 28_800, day + 57_600];
      return json({ s: "ok", t, o: [1, 2, 3], h: [2, 3, 4], l: [0.5, 1, 2], c: [1.5, 2.5, 3.5], v: [1, 1, 1] });
    }));

    const series = await tttClient.getDailyCandles("BTCUSDT", 5);
    expect(series.native).toBe(false);
    expect(series.derived_source_tf).toBe("8h");
    expect(series.source).toBe("ttt");
    expect(series.candles.length).toBeGreaterThan(0);
    expect(series.timeframe).toBe("1d");
  });
});

describe("candle retention: persist native bars before trim; never persist derived", () => {
  afterEach(async () => {
    const { setActiveScheduler } = await import("../src/lib/ttt/scheduler");
    const { __resetHistoryStore } = await import("../src/lib/market/history-store");
    const { __setOperationalUniverse } = await import("../src/lib/market/operational-universe");
    setActiveScheduler(null);
    __resetHistoryStore();
    __setOperationalUniverse(null);
  });

  it("persists every fetched native bar, then trims only the in-memory window", async () => {
    await scheduler();
    const { __setHistoryStore } = await import("../src/lib/market/history-store");
    const { CandleManager } = await import("../src/lib/market/candles");
    const { MarketStore } = await import("../src/lib/market/store");
    const store = new MemoryHistoryStore();
    __setHistoryStore(store);
    const t0 = Math.floor(Date.now() / 1000 / 3600) * 3600 - 3 * 3600;
    vi.stubGlobal("fetch", vi.fn(async () => json({
      s: "ok",
      t: [t0, t0 + 3600, t0 + 7200, t0 + 10800],
      o: [1, 1, 1, 1], h: [2, 2, 2, 2], l: [0.5, 0.5, 0.5, 0.5], c: [1.5, 1.5, 1.5, 1.5], v: [1, 1, 1, 1],
    })));

    const mgr = new CandleManager(new MarketStore());
    mgr.setTarget("1h", 2);
    const series = await mgr.fetch("BTCUSDT", "1h");

    expect(store.count("BTCUSDT", "1h")).toBe(4);
    expect(series?.candles).toHaveLength(2);
    expect(series?.native).toBe(true);
  });

  it("a failed persist does not trim the only copy of the bars", async () => {
    await scheduler();
    const { __setHistoryStore } = await import("../src/lib/market/history-store");
    const { CandleManager } = await import("../src/lib/market/candles");
    const { MarketStore } = await import("../src/lib/market/store");
    const store = new MemoryHistoryStore();
    store.put = () => { throw new Error("disk full"); };
    __setHistoryStore(store);
    const t0 = Math.floor(Date.now() / 1000 / 3600) * 3600 - 2 * 3600;
    vi.stubGlobal("fetch", vi.fn(async () => json({
      s: "ok",
      t: [t0, t0 + 3600, t0 + 7200],
      o: [1, 1, 1], h: [2, 2, 2], l: [0.5, 0.5, 0.5], c: [1.5, 1.5, 1.5], v: [1, 1, 1],
    })));

    const mem = new MarketStore();
    const mgr = new CandleManager(mem);
    mgr.setTarget("1h", 1);
    const series = await mgr.fetch("BTCUSDT", "1h");

    expect(series?.candles).toHaveLength(3);
    expect(store.count("BTCUSDT", "1h")).toBe(0);
    expect(mem.tttErrors.some((e) => /disk full/.test(e.message))).toBe(true);
  });

  it("a derived 1D series is not written into the durable store", async () => {
    await scheduler();
    const { __setHistoryStore } = await import("../src/lib/market/history-store");
    const { CandleManager } = await import("../src/lib/market/candles");
    const { MarketStore } = await import("../src/lib/market/store");
    const store = new MemoryHistoryStore();
    __setHistoryStore(store);
    const day = 1_700_006_400;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("resolution=1D")) return json({ s: "no_data" });
      const t = [day, day + 28_800, day + 57_600];
      return json({ s: "ok", t, o: [1, 2, 3], h: [2, 3, 4], l: [0.5, 1, 2], c: [1.5, 2.5, 3.5], v: [1, 1, 1] });
    }));

    const mem = new MarketStore();
    const mgr = new CandleManager(mem);
    const series = await mgr.fetch("BTCUSDT", "1d");

    expect(series?.native).toBe(false);
    expect(series?.derived_source_tf).toBe("8h");
    expect(store.putCalls).toEqual([]);
    expect(mem.coverageRow("BTCUSDT", "1d")?.native_or_derived).toBe("DERIVED");
  });

  it("a later more urgent queue intent upgrades the queued lane instead of being dropped", async () => {
    const { s } = await scheduler();
    const { __setOperationalUniverse } = await import("../src/lib/market/operational-universe");
    const { PRIORITY } = await import("../src/lib/ttt/scheduler");
    const { CandleManager } = await import("../src/lib/market/candles");
    const { MarketStore } = await import("../src/lib/market/store");
    __setOperationalUniverse(["AAAUSDT", "BBBUSDT"]);

    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n === 1) await gate;
      const t = Math.floor(Date.now() / 1000 / 3600) * 3600;
      return json(bar(t));
    }));

    const mgr = new CandleManager(new MarketStore());
    mgr.enqueueBackfill(["1h"], PRIORITY.BACKFILL);
    await Promise.resolve();
    await Promise.resolve();
    mgr.enqueueCloseRefresh("AAAUSDT", "1h");
    release();

    await vi.waitFor(() => {
      expect(s.stats().total_grants).toBeGreaterThanOrEqual(3);
    });

    expect(s.stats().lanes.focus.granted).toBeGreaterThanOrEqual(1);
    expect(s.stats().lanes.sweep.granted).toBeGreaterThanOrEqual(1);
    expect(s.stats().lanes.backfill.granted).toBeGreaterThanOrEqual(1);
  });

  it("concurrent equivalent fetches coalesce onto one network call", async () => {
    await scheduler();
    const { CandleManager } = await import("../src/lib/market/candles");
    const { MarketStore } = await import("../src/lib/market/store");
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 15));
      const t = Math.floor(Date.now() / 1000 / 3600) * 3600;
      return json(bar(t));
    }));
    const mgr = new CandleManager(new MarketStore());
    const [a, b] = await Promise.all([mgr.fetch("BTCUSDT", "1h"), mgr.fetch("BTCUSDT", "1h")]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });
});

describe("catalog distinguishes an invalid body from a transport failure", () => {
  afterEach(async () => {
    const { setActiveScheduler } = await import("../src/lib/ttt/scheduler");
    const { __resetCatalogCache } = await import("../src/lib/market/catalog");
    setActiveScheduler(null);
    __resetCatalogCache();
  });

  it("wrong content-type is INVALID_RESPONSE; HTTP 503 stays NETWORK_FAILURE", async () => {
    await scheduler();
    const { discoverMarkets, __resetCatalogCache } = await import("../src/lib/market/catalog");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>no</html>", { status: 200, headers: { "Content-Type": "text/html" } })));
    const bad = await discoverMarkets(true);
    expect(bad.status).toBe("INVALID_RESPONSE");

    __resetCatalogCache();
    vi.stubGlobal("fetch", vi.fn(async () => json({ errors: [{ message: "down" }] }, 503)));
    const down = await discoverMarkets(true);
    expect(down.status).toBe("NETWORK_FAILURE");
  });
});
