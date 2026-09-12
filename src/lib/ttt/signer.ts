/**
 * TTT request signing — official guide semantics, implemented ONCE:
 *   X-Timestamp  = unix milliseconds
 *   X-Signature  = lowercase hex HMAC-SHA256( secret, `${ts}${METHOD}${URI}` )
 *   METHOD uppercase; URI includes the query string when present;
 *   BODY IS NEVER INCLUDED IN THE SIGNATURE.
 * Secrets never appear in output objects or logs (only header building).
 */
import { createHmac } from "node:crypto";

export interface SignedHeaders {
  "X-API-Key": string;
  "X-Timestamp": string;
  "X-Signature": string;
}

/**
 * Deterministic signing primitive. `uri` MUST be the exact final path+query
 * (e.g. "/futures/markets/stats?symbol=BTCUSDT") — no base URL, no scheme.
 */
export function tttSign(secret: string, timestampMs: number, method: string, uri: string): string {
  const upperMethod = method.toUpperCase();
  const payload = `${timestampMs}${upperMethod}${uri}`;
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Build the three auth headers for a request. */
export function buildSignedHeaders(
  apiKey: string,
  apiSecret: string,
  timestampMs: number,
  method: string,
  uri: string,
): SignedHeaders {
  return {
    "X-API-Key": apiKey,
    "X-Timestamp": String(timestampMs),
    "X-Signature": tttSign(apiSecret, timestampMs, method, uri),
  };
}
