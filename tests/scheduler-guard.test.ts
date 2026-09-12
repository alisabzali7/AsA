/**
 * Scheduler, transport-safety, retry/backoff and source-guard tests.
 * The HTTP tests spin up a local stub server (deterministic, no network).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { TttScheduler } from "../src/lib/ttt/scheduler";
import { tttRequest, TttHttpError } from "../src/lib/ttt/http";
import { ensureTttSource, marketSource, TTT_SOURCE } from "../src/lib/ttt/guard";

describe("TttScheduler token bucket", () => {
  it("allows immediate requests up to the bucket size", async () => {
    const s = new TttScheduler(10);
    const t0 = Date.now();
    await s.acquireMany(10, 2);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(s.stats().total_requests).toBe(10);
  });

  it("counts 429s, shrinks the budget and engages the pause", () => {
    const s = new TttScheduler(20);
    s.note429();
    const st = s.stats();
    expect(st.total_429).toBe(1);
    expect(st.budget_per_min).toBeLessThan(20);
    expect(st.paused).toBe(true);
    expect(st.paused_until_ms).toBeGreaterThan(Date.now());
  });

  it("never drops below the 4/min floor across repeated 429s", () => {
    const s = new TttScheduler(24);
    for (let i = 0; i < 10; i++) s.note429();
    expect(s.stats().budget_per_min).toBeGreaterThanOrEqual(4);
  });
});

describe("source guard", () => {
  it("returns the single permitted TTT source", () => {
    expect(marketSource().id).toBe("ttt");
    expect(TTT_SOURCE.id).toBe("ttt");
  });

  it("fails loudly for any third-party source", () => {
    for (const bad of ["binance", "tradingview", "coingecko", "bybit", "okx", "kraken", "kucoin", undefined, null, 42]) {
      expect(() => ensureTttSource(bad)).toThrow(/only permitted production market-data source/);
    }
    expect(() => ensureTttSource("ttt")).not.toThrow();
  });
});

/* ------------------------------------------------ local stub TTT server */
let server: Server;
let baseUrl = "";
const routes: { path: string; status: number; body: unknown; count?: { hit: number } }[] = [];
beforeAll(async () => {
  const { createServer } = await import("node:http");
  server = createServer((req, res) => {
    const route = routes.find((r) => req.url?.startsWith(r.path));
    if (route?.count) route.count.hit++;
    res.writeHead(route?.status ?? 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(route?.body ?? { errors: [{ message: "not found" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server?.close();
});

describe("TTT HTTP transport", () => {
  it("refuses every unsafe method before any network I/O", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      await expect(tttRequest("/futures/x", { method: method as never, baseUrl })).rejects.toSatisfy(
        (e: unknown) => e instanceof TttHttpError && (e as TttHttpError).kind === "client" && /unsafe method/.test((e as TttHttpError).message),
      );
    }
  });

  it("maps 401/403 to auth errors and does NOT retry them", async () => {
    const c = { hit: 0 };
    const route = { path: "/auth", status: 401, body: { errors: [{ message: "Missing or invalid bearer token" }] }, count: c };
    routes.push(route);
    try {
      await expect(tttRequest("/auth", { baseUrl, retries: 3 })).rejects.toSatisfy(
        (e: unknown) => e instanceof TttHttpError && (e as TttHttpError).kind === "auth" && /Missing or invalid bearer token/.test((e as TttHttpError).message),
      );
      expect(c.hit).toBe(1); // no retry on auth failures
    } finally {
      routes.splice(routes.indexOf(route), 1);
    }
  });

  it("backs off with bounded retries on 429 and eventually surfaces rate_limited", async () => {
    const c = { hit: 0 };
    const route = { path: "/rl", status: 429, body: { errors: [{ message: "rate limit" }] }, count: c };
    routes.push(route);
    try {
      await expect(tttRequest("/rl", { baseUrl, retries: 1, timeoutMs: 2000 })).rejects.toSatisfy(
        (e: unknown) => e instanceof TttHttpError && (e as TttHttpError).kind === "rate_limited",
      );
      expect(c.hit).toBe(2); // initial + 1 bounded retry
    } finally {
      routes.splice(routes.indexOf(route), 1);
    }
  });

  it("returns validated JSON with provenance on success", async () => {
    const okBody = [{ symbol: "BTCUSDT", lastPrice: "80000" }];
    const route = { path: "/ok", status: 200, body: okBody };
    routes.push(route);
    try {
      const res = await tttRequest<{ symbol: string }[]>("/ok", { baseUrl });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(res.data[0].symbol).toBe("BTCUSDT");
      expect(res.source_name).toBe("ttt");
      expect(res.fetched_at_ms).toBeGreaterThan(0);
      expect(res.latency_ms).toBeGreaterThanOrEqual(0);
      expect(res.endpoint).toBe("/ok");
    } finally {
      routes.splice(routes.indexOf(route), 1);
    }
  });

  it("rejects non-JSON content on a 200 (invalid_response, no retry)", async () => {
    // 200 with HTML body is caught by JSON.parse after content-type sniffing is bypassed;
    // use plain text content-type to trigger invalid_response
    const { createServer: cs } = await import("node:http");
    const s = cs((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not json</html>");
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const u = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    try {
      await expect(tttRequest("/x", { baseUrl: u, retries: 2 })).rejects.toSatisfy(
        (e: unknown) => e instanceof TttHttpError && (e as TttHttpError).kind === "invalid_response",
      );
    } finally {
      s.close();
    }
  });
});
