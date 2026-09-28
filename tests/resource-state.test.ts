/**
 * The normalized async state contract (Team 04 §5/§6): the provider layer
 * MUST keep UNAVAILABLE / ERROR / OFFLINE / OK distinct, must carry the
 * server's own verdict verbatim, and must never collapse a truthful
 * "not available" into a generic error or a fake success.
 *
 * Fixtures are REAL payloads captured from the live AsA server in this
 * repository (sandbox without TTT access), not invented shapes.
 */
import { describe, expect, it } from "vitest";
import { classifyResource, loadResource, parseFailureBody, contactAgeMs } from "../src/components/resource-state";

const mkResp = (status: number, body: string) =>
  ({ ok: status >= 200 && status < 300, status, text: async () => body }) as unknown as Response;

const IS_OFFLINE = () => true; // isOffline(): true only when the browser says offline
const NOT_OFFLINE = () => false;

// live-captured: GET /api/market/board while TTT discovery is down
const BOARD_503 = JSON.stringify({
  ok: false,
  source: "ttt",
  state: "NETWORK_FAILURE",
  error: "TTT discovery is NETWORK_FAILURE; market board is not ready",
  last_error: "TTT network error: fetch failed (/futures/markets)",
  rows: [],
  stats_age_ms: null,
  universe: { source: "not-ready", state: "NETWORK_FAILURE", count: 0, discovery_complete: false },
  ts: 1790368447308,
});
// live-captured: GET /api/market/candles?symbol=BTCUSDT (universe not ready)
const CANDLES_503 = JSON.stringify({
  ok: false,
  error: "market universe is NETWORK_FAILURE; cannot validate symbol 'BTCUSDT' without TTT discovery",
  state: "NETWORK_FAILURE",
  source: "not-ready",
  degraded: "DISCOVERY_UNAVAILABLE",
});
// live-captured: POST /api/ai-clone without token in production (fail-closed)
const MUTATION_503 = JSON.stringify({
  ok: false,
  error: "mutation denied: ASA_API_TOKEN is not configured in a production deployment (fail-closed)",
  remediation: "set ASA_API_TOKEN in the deployment environment and restart",
});
// live-captured: GET /api/opportunities with an empty store — a SUCCESSFUL empty answer
const OPPS_EMPTY = JSON.stringify({ ok: true, count: 0, items: [], ts: 1790368449382 });

describe("classifyResource — the state model the UI renders from", () => {
  it("503 with a machine-readable verdict is UNAVAILABLE, carrying the server's own state + reason verbatim", () => {
    const r = classifyResource(mkResp(503, BOARD_503), BOARD_503, null, NOT_OFFLINE, 1000);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.failure?.kind).toBe("UNAVAILABLE");
    expect(r.failure?.server_state).toBe("NETWORK_FAILURE");
    expect(r.failure?.message).toBe("TTT discovery is NETWORK_FAILURE; market board is not ready");
    expect(r.failure?.status).toBe(503);
  });

  it("a refused mutation (fail-closed 503) surfaces its remediation — never a silent success", () => {
    const r = classifyResource(mkResp(503, MUTATION_503), MUTATION_503, null, NOT_OFFLINE, 1);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.failure?.hint).toContain("ASA_API_TOKEN");
    expect(r.data).toBe(null);
  });

  it("200 + empty result is OK — EMPTY is the feature's derivation, not a failure", () => {
    const r = classifyResource(mkResp(200, OPPS_EMPTY), OPPS_EMPTY, null, NOT_OFFLINE, 5);
    expect(r.status).toBe("OK");
    expect(r.failure).toBe(null);
    const parsed = r.data as { ok: boolean; items: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.items).toEqual([]);
  });

  it("502 (venue outage per the analysis contract) is UNAVAILABLE with the server message", () => {
    const body = JSON.stringify({ ok: false, available: false, error: "TTT candle history unavailable: fetch failed" });
    const r = classifyResource(mkResp(502, body), body, null, NOT_OFFLINE, 5);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.failure?.message).toContain("TTT candle history unavailable");
  });

  it("transport failure while online is ERROR (never relabeled UNAVAILABLE, never silent)", () => {
    const r = classifyResource(null, null, new Error("ECONNREFUSED"), NOT_OFFLINE, 5);
    expect(r.status).toBe("ERROR");
    expect(r.failure?.message).toContain("ECONNREFUSED");
    expect(r.failure?.status).toBe(null);
  });

  it("browser offline is OFFLINE with no data claimed", () => {
    const r = classifyResource(null, null, new TypeError("Failed to fetch"), IS_OFFLINE, 5);
    expect(r.status).toBe("OFFLINE");
    expect(r.data).toBe(null);
    expect(r.failure?.kind).toBe("OFFLINE");
  });

  it("500 with non-JSON body is ERROR naming the status — the body is never parsed into success", () => {
    const r = classifyResource(mkResp(500, "<!doctype html>Internal Server Error"), "<!doctype html>Internal Server Error", null, NOT_OFFLINE, 5);
    expect(r.status).toBe("ERROR");
    expect(r.failure?.message).toBe("HTTP 500");
    expect(r.failure?.status).toBe(500);
  });

  it("404 is ERROR (a missing resource is not 'data unavailable' and certainly not EMPTY)", () => {
    const body = JSON.stringify({ ok: false, error: "not found" });
    const r = classifyResource(mkResp(404, body), body, null, NOT_OFFLINE, 5);
    expect(r.status).toBe("ERROR");
    expect(r.failure?.message).toBe("not found");
  });

  it("a 200 with a non-JSON body is ERROR, not a fake OK", () => {
    const r = classifyResource(mkResp(200, "upstream proxy said no"), "upstream proxy said no", null, NOT_OFFLINE, 5);
    expect(r.status).toBe("ERROR");
    expect(r.failure?.message).toContain("non-JSON");
  });

  it("parseFailureBody tolerates absent/garbage bodies", () => {
    expect(parseFailureBody("")).toBe(null);
    expect(parseFailureBody("<html>")).toBe(null);
    expect((parseFailureBody('{"state":"NOT_READY"}') as { state: string }).state).toBe("NOT_READY");
  });
});

describe("loadResource — one classified round trip", () => {
  it("wraps a real fetch failure with OFFLINE when the browser says offline", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    }) as unknown as typeof fetch;
    const r = await loadResource("http://127.0.0.1:1/api/market/board", { fetchImpl, isOffline: IS_OFFLINE });
    expect(r.status).toBe("OFFLINE");
  });

  it("classifies a captured candles 503 end-to-end", async () => {
    const fetchImpl = (async () => new Response(CANDLES_503, { status: 503 })) as unknown as typeof fetch;
    const r = await loadResource("/api/market/candles?symbol=BTCUSDT", { fetchImpl, isOffline: NOT_OFFLINE });
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.failure?.server_state).toBe("NETWORK_FAILURE");
    expect((r.failure?.message ?? "").length).toBeGreaterThan(10);
  });
});

describe("contactAgeMs — cached-while-down must age, never freeze as fresh", () => {
  it("counts up from the last contact", () => {
    expect(contactAgeMs(1000, 5000)).toBe(4000);
    expect(contactAgeMs(1000, 1000)).toBe(0);
    expect(contactAgeMs(null, 1000)).toBe(null);
    expect(contactAgeMs(9000, 1000)).toBe(0); // clock skew never negative-ages
  });
});
