/**
 * Shared strict HTTP layer for TTT (and only TTT; auxiliary sources like
 * news use their own bounded helpers). GET/HEAD only — the entire transport
 * refuses non-safe methods, which is one of the execution-safety proofs.
 * Behaviour: explicit timeout, bounded retries with jitter, 429 backoff,
 * response validation, structured error mapping, provenance capture.
 *
 * TASK 1 — CANONICAL ADMISSION BOUNDARY. The rate budget is consumed HERE and
 * nowhere else:
 *
 *   intent -> shared TTT transport -> scheduler admission -> fetch()
 *
 * Admission is charged inside the retry loop, after method/source/host
 * validation and immediately before the network attempt, so
 *   - a request that never reaches fetch() consumes ZERO tokens, and
 *   - every retry is a NEW attempt that pays a NEW admission.
 * Callers may only supply lane intent (`priority`).
 */
import { TTT_BASE_URL } from "../env";
import { randomInt } from "node:crypto";
import { marketSource } from "./guard";
import { activeScheduler, laneOf, DEFAULT_LANE, type PriorityLane } from "./scheduler";
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
  /**
   * LANE INTENT ONLY (Task 1). The caller states how important this traffic is
   * (see PRIORITY in ./scheduler); the transport performs the actual scheduler
   * admission, once per network attempt. Callers must never acquire budget
   * themselves, and passing a lane here never grants anything by itself.
   */
  priority?: number;
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
  // Lane intent is resolved once; the budget itself is charged per attempt below.
  const lane: PriorityLane = laneOf(opts.priority ?? DEFAULT_LANE);
  // The scheduler that charges this request is also the one exposed by status.
  const scheduler = activeScheduler();

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(opts.headers ?? {}),
      };
      if (opts.apiKey && opts.apiSecret) {
        const { buildSignedHeaders } = await import("./signer");
        Object.assign(headers, buildSignedHeaders(opts.apiKey, opts.apiSecret, Date.now(), method, uri));
      }
      // ── TASK 1: THE single admission point ───────────────────────────────
      // Reached only when the request is about to hit the network: unsafe
      // methods, a forbidden host/source and local failures consume zero
      // tokens, while every attempt (including every retry) pays exactly one.
      await scheduler.acquire(lane);
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(endpoint, { method, headers, signal: ctrl.signal, cache: "no-store" });
      } finally {
        clearTimeout(timer);
      }
      const latency_ms = Date.now() - started;
      const text = await res.text().catch(() => "");
      if (res.status === 429) {
        // 429 accounting is TRANSPORT-OWNED: exactly one note429() per observed
        // HTTP 429. Callers must never record rate-limit pressure themselves.
        scheduler.note429();
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
      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch (err) {
        // A well-labelled but corrupt body (`content-type: application/json`
        // with unparseable JSON) is a BAD RESPONSE, not a transport failure.
        // JSON.parse raises a native SyntaxError, which the outer catch would
        // otherwise classify as `network` and retry — turning a corrupt payload
        // into three requests and three admissions. `invalid_response` is
        // non-retryable in the outer catch, so a malformed body costs exactly
        // one attempt, one fetch and one admission.
        throw new TttHttpError(
          "invalid_response",
          `malformed JSON response: ${err instanceof Error ? err.message : String(err)}`,
          res.status,
          text.slice(0, 200),
        );
      }
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
