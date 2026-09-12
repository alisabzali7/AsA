/**
 * Shared strict HTTP layer for TTT (and only TTT; auxiliary sources like
 * news use their own bounded helpers). GET/HEAD only — the entire transport
 * refuses non-safe methods, which is one of the execution-safety proofs.
 * Behaviour: explicit timeout, bounded retries with jitter, 429 backoff,
 * response validation, structured error mapping, provenance capture.
 */
import { TTT_BASE_URL } from "../env";
import { randomInt } from "node:crypto";
import { marketSource } from "./guard";
import type { TttErrorBody } from "./types";

export type HttpMethod = "GET" | "HEAD";

/**
 * Production TTT host allow-list (closure §Q).
 * Any base URL outside this list is refused, so a misconfigured env var can
 * never silently redirect market-truth requests to another venue. Localhost is
 * permitted only outside production, for fixture/mock servers in tests.
 */
export const TTT_ALLOWED_HOSTS = ["apiv2.thetruetrade.io", "thetruetrade.io"] as const;

export function assertAllowedHost(baseUrl: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new TttHttpError("client", `[ttt-http] invalid base URL '${baseUrl}'`);
  }
  const allowed = (TTT_ALLOWED_HOSTS as readonly string[]).includes(host);
  const localTestHost = host === "127.0.0.1" || host === "localhost";
  if (allowed) return;
  if (localTestHost && process.env.NODE_ENV !== "production") return;
  throw new TttHttpError(
    "client",
    `[ttt-http] host '${host}' is not in the TTT allow-list (${TTT_ALLOWED_HOSTS.join(", ")}) — no fallback exchange is permitted`,
  );
}

export type HttpErrorKind =
  | "network"
  | "timeout"
  | "rate_limited"
  | "auth"
  | "server"
  | "client"
  | "http"
  | "invalid_response";

export class TttHttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly status: number | null;
  readonly body: unknown;
  constructor(kind: HttpErrorKind, message: string, status: number | null = null, body: unknown = null) {
    super(message);
    this.name = "TttHttpError";
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

export interface TttRequestResult<T> {
  ok: boolean;
  status: number;
  data: T;
  fetched_at_ms: number;
  latency_ms: number;
  endpoint: string;
  source_name: "ttt";
}

export interface TttHttpOptions {
  method?: HttpMethod;
  timeoutMs?: number;
  /** bounded retries for SAFE requests; never called with unsafe methods */
  retries?: number;
  apiKey?: string;
  apiSecret?: string;
  headers?: Record<string, string>;
  /** test seam: override the venue base URL (never used in app code) */
  baseUrl?: string;
}

function parseErrorBody(text: string): string | null {
  try {
    const j = JSON.parse(text) as TttErrorBody;
    if (Array.isArray(j.errors) && j.errors.length > 0) {
      return j.errors.map((e) => e.message + (e.field ? ` (${e.field})` : "")).join("; ");
    }
  } catch {
    /* fall through */
  }
  return null;
}

const DEFAULT_TIMEOUT = 10_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function tttRequest<T>(
  uri: string, // path + query, e.g. "/futures/markets/stats?symbol=BTCUSDT"
  opts: TttHttpOptions = {},
): Promise<TttRequestResult<T>> {
  const method: HttpMethod = opts.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    // AsA is advisory-only: the transport never issues POST/PATCH/DELETE/PUT.
    throw new TttHttpError("client", `[ttt-http] unsafe method ${method} is not allowed`);
  }
  const source = marketSource(); // central guard crossed on every request
  assertAllowedHost(opts.baseUrl ?? TTT_BASE_URL); // no fallback venue, ever
  const endpoint = `${opts.baseUrl ?? TTT_BASE_URL}${uri}`;
  const retries = Math.max(0, Math.min(3, opts.retries ?? 2));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(opts.headers ?? {}),
      };
      if (opts.apiKey && opts.apiSecret) {
        const { buildSignedHeaders } = await import("./signer");
        Object.assign(headers, buildSignedHeaders(opts.apiKey, opts.apiSecret, Date.now(), method, uri));
      }
      let res: Response;
      try {
        res = await fetch(endpoint, { method, headers, signal: ctrl.signal, cache: "no-store" });
      } finally {
        clearTimeout(timer);
      }
      const latency_ms = Date.now() - started;
      const text = await res.text().catch(() => "");
      if (res.status === 429) {
        throw new TttHttpError("rate_limited", "TTT 429 rate limit", 429, text);
      }
      if (res.status === 401 || res.status === 403) {
        const detail = (parseErrorBody(text) ?? text.slice(0, 160)) || res.statusText;
        // never retry auth failures
        throw new TttHttpError("auth", `TTT auth error ${res.status}: ${detail}`, res.status, text);
      }
      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status)) {
          throw new TttHttpError("server", `TTT HTTP ${res.status}`, res.status, text);
        }
        const detail = parseErrorBody(text) ?? text.slice(0, 160);
        throw new TttHttpError("client", `TTT HTTP ${res.status}: ${detail || res.statusText}`, res.status, text);
      }
      if (method === "HEAD" || text.length === 0) {
        return { ok: true, status: res.status, data: undefined as T, fetched_at_ms: started, latency_ms, endpoint: uri, source_name: source.id };
      }
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json") && !ct.includes("text/json")) {
        throw new TttHttpError("invalid_response", `unexpected content-type '${ct}'`, res.status, text.slice(0, 200));
      }
      const data = JSON.parse(text) as T;
      return { ok: true, status: res.status, data, fetched_at_ms: started, latency_ms, endpoint: uri, source_name: source.id };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e instanceof TttHttpError) {
        if (e.kind === "auth" || e.kind === "client" || e.kind === "invalid_response") throw e;
        if (e.kind === "rate_limited" && attempt < retries) {
          const backoffMs = 800 * 2 ** attempt + randomInt(0, 350);
          await sleep(backoffMs);
          lastErr = e;
          continue;
        }
        throw e;
      }
      // AbortError -> timeout; TypeError -> network
      if (e.name === "AbortError" || /abort/i.test(e.message)) {
        lastErr = new TttHttpError("timeout", `TTT timeout after ${timeoutMs}ms (${uri})`);
      } else if (e instanceof TypeError) {
        lastErr = new TttHttpError("network", `TTT network error: ${e.message} (${uri})`);
      } else {
        lastErr = new TttHttpError("network", `TTT request error: ${e.message} (${uri})`);
      }
      if (attempt < retries) {
        const backoffMs = 500 * 2 ** attempt + randomInt(0, 300);
        await sleep(backoffMs);
        continue;
      }
    }
  }
  throw lastErr ?? new TttHttpError("network", `TTT request failed after ${retries + 1} attempts (${uri})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when an upstream payload signals no data at HTTP-200 (e.g. UDF s=no_data). */
export function isHttp200NoData(): boolean {
  return false; // semantic marker; UDF no_data handled in udf.ts
}
