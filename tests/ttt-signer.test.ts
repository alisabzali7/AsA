/**
 * TTT signer tests — official semantics (§49): ms timestamp, uppercase
 * method, URI incl. query, body never signed, ±30s window.
 * Vector independently computed with raw node crypto here (no reuse of
 * the implementation under test).
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { tttSign, buildSignedHeaders } from "../src/lib/ttt/signer";
import { isWithinSkew } from "../src/lib/ttt/clock";

describe("tttSign (HMAC-SHA256 lowercase hex)", () => {
  const secret = "s3cret-test-key";

  it("matches an independently computed vector", () => {
    const ts = 1720000000123;
    const method = "GET";
    const uri = "/futures/markets/stats?symbol=BTCUSDT";
    const payload = `${ts}${method}${uri}`;
    const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
    expect(tttSign(secret, ts, method, uri)).toBe(expected);
    expect(tttSign(secret, ts, method, uri)).toMatch(/^[0-9a-f]{64}$/); // lowercase hex
  });

  it("uses the query string in the signed payload", () => {
    const ts = 1720000000123;
    const a = tttSign(secret, ts, "GET", "/futures/udf/history?symbol=BTCUSDT&resolution=1D");
    const b = tttSign(secret, ts, "GET", "/futures/udf/history");
    expect(a).not.toBe(b);
    // identical signature regardless of param ORDER is not required; different URI => different sig
    expect(tttSign(secret, ts, "GET", "/futures/udf/history?resolution=1D&symbol=BTCUSDT")).not.toBe(a);
  });

  it("upper-cases lowercase methods (payload uses uppercase METHOD)", () => {
    const ts = 1720000000123;
    expect(tttSign(secret, ts, "get", "/x")).toBe(tttSign(secret, ts, "GET", "/x"));
    expect(tttSign(secret, ts, "Post", "/x")).toBe(tttSign(secret, ts, "POST", "/x"));
    expect(tttSign(secret, ts, "get", "/x")).not.toBe(tttSign(secret, ts, "post", "/x"));
  });

  it("is deterministic for identical (ts, method, uri)", () => {
    expect(tttSign(secret, 1, "GET", "/a")).toBe(tttSign(secret, 1, "GET", "/a"));
    expect(tttSign(secret, 2, "GET", "/a")).not.toBe(tttSign(secret, 1, "GET", "/a"));
  });

  it("never includes a body in the signature (no body parameter exists)", () => {
    // The signature primitive signs only `${ts}${METHOD}${URI}`; even a
    // body-bearing POST must sign the same payload as its GET-less twin.
    const ts = 1720000000123;
    const sigPost = tttSign(secret, ts, "POST", "/futures/orders");
    const payload = `${ts}POST/futures/orders`;
    const check = createHmac("sha256", secret).update(payload).digest("hex");
    expect(sigPost).toBe(check);
  });
});

describe("buildSignedHeaders", () => {
  it("returns the three documented headers with ms timestamp", () => {
    const h = buildSignedHeaders("key-1", "sec-1", 1720000000000, "get", "/futures/markets");
    expect(h["X-API-Key"]).toBe("key-1");
    expect(h["X-Timestamp"]).toBe("1720000000000");
    expect(h["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("clock skew window", () => {
  it("accepts within ±30s and rejects outside", () => {
    const now = 1720000000000;
    expect(isWithinSkew(now, now)).toBe(true);
    expect(isWithinSkew(now, now + 29_999)).toBe(true);
    expect(isWithinSkew(now, now - 29_999)).toBe(true);
    expect(isWithinSkew(now, now + 30_001)).toBe(false);
    expect(isWithinSkew(now, now - 30_001)).toBe(false);
  });
});

/**
 * Execution/credential safety invariant (measured 2026-09-06):
 * the venue edge rejects ANY request carrying X-API-Key with HTTP 403, even
 * on routes that return 200 unsigned. The client must therefore never attach
 * credentials to market-data requests. See docs/evidence/capability-probe-*.json
 */
describe("market data is never signed", () => {
  it("client.ts does not build an AUTH object from env credentials", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/ttt/client.ts", "utf8");
    // AUTH must be a hard-coded undefined, not derived from the key/secret.
    expect(src).toMatch(/const AUTH:[^=]*=\s*undefined;/);
    expect(src).not.toMatch(/apiKey:\s*TTT_API_KEY/);
    expect(src).not.toMatch(/apiSecret:\s*TTT_API_SECRET/);
  });

  it("exposes credential presence without using it for transport", async () => {
    const mod = await import("../src/lib/ttt/client");
    expect(typeof mod.TTT_KEYS_PRESENT_BUT_UNUSED).toBe("boolean");
  });
});
