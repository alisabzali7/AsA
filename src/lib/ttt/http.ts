/**
 * Shared strict HTTP layer for TTT (and only TTT; auxiliary sources like
 * news use their own bounded helpers). GET/HEAD only — the entire transport
 * refuses non-safe methods, which is one of the execution-safety proofs.
 * Behaviour: explicit timeout covering headers AND body, bounded retries with
 * jitter, 429 backoff, response validation, structured error mapping,
 * provenance capture. Redirects are not followed (the host allow-list would
 * otherwise be bypassed). Credentials are never attached: the venue edge
 * answers 403 to any X-API-Key, including on public routes.
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
 *
 * Retry policy (locked):
 *   - network / timeout: retried, each attempt pays
 *   - 429: retried, each observed 429 calls note429() exactly once, each attempt pays
 *   - 5xx: classified `server`, NOT retried (one admission; do not multiply
 *     load against a failing venue)
 *   - auth / ordinary 4xx / invalid_response / refused redirect: NOT retried
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

const CREDENTIAL_HEADERS = /^(x-api-key|x-signature|x-timestamp)$/i;

export function assertAllowedHost(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TttHttpError("client", `[ttt-http] invalid base URL '${baseUrl}'`);
  }
  if (url.username || url.password) {
    throw new TttHttpError("client", "[ttt-http] base URL must not embed credentials");
  }
  const host = url.hostname;
  const allowed = (TTT_ALLOWED_HOSTS as readonly string[]).includes(host);
  const localTestHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (allowed) {
    if (url.protocol !== "https:") {
      throw new TttHttpError(
        "client",
        `[ttt-http] host '${host}' must be requested over https — cleartext market data is refused`,
      );
    }
    return;
  }
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
  /**
   * Ignored and refused. Market-data transport never signs: attaching
   * X-API-Key makes the venue edge answer 403 on public routes.
   */
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
/**
 * 5xx classified as `server`. Membership does NOT mean "retry": see the retry
 * policy in the file header. 429 is handled before this set is consulted.
 */
const SERVER_STATUS = new Set([500, 502, 503, 504]);

function refuseCredentials(opts: TttHttpOptions): void {
  if (opts.apiKey || opts.apiSecret) {
    throw new TttHttpError(
      "client",
      "[ttt-http] refusing to attach TTT credentials to a market-data request (X-API-Key breaks public routes)",
    );
  }
  for (const key of Object.keys(opts.headers ?? {})) {
    if (CREDENTIAL_HEADERS.test(key)) {
      throw new TttHttpError(
        "client",
        `[ttt-http] refusing credential header '${key}' on the market-data transport`,
      );
    }
  }
}

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
  const baseUrl = opts.baseUrl ?? TTT_BASE_URL;
  try {
    assertAllowedHost(baseUrl); // no fallback venue, ever
  } catch (err) {
    if (err instanceof TttHttpError && /allow-list/.test(err.message)) {
      activeScheduler().noteRejectedNonTtt();
    }
    throw err;
  }
  // Credential refusal is pre-admission: a request that never reaches fetch()
  // consumes zero tokens. Signing is not a feature of this transport.
  refuseCredentials(opts);
  const endpoint = `${baseUrl}${uri}`;
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
      // ── TASK 1: THE single admission point ───────────────────────────────
      // Reached only when the request is about to hit the network: unsafe
      // methods, a forbidden host/source, credential refusal and local failures
      // consume zero tokens, while every attempt (including every retry) pays
      // exactly one.
      await scheduler.acquire(lane);
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      let text = "";
      try {
        // redirect:"manual" — a 3xx must not be followed. The default "follow"
        // would connect to whatever Location says, including another venue,
        // after the allow-list had already been passed.
        res = await fetch(endpoint, {
          method,
          headers,
          signal: ctrl.signal,
          cache: "no-store",
          redirect: "manual",
        });
        if (res.status === 429) {
          // 429 accounting is TRANSPORT-OWNED: exactly one note429() per observed
          // HTTP 429, even if the body cannot be read. Callers must never record
          // rate-limit pressure themselves.
          scheduler.note429();
          text = await res.text().catch(() => "");
          throw new TttHttpError("rate_limited", "TTT 429 rate limit", 429, text);
        }
        if (res.status >= 300 && res.status < 400) {
          throw new TttHttpError(
            "client",
            `[ttt-http] redirect ${res.status} refused — the host allow-list is not re-checked on follow`,
            res.status,
            res.headers.get("location"),
          );
        }
        // Body read is inside the timeout. A failure here must propagate
        // (timeout / network), never collapse into a successful empty payload.
        text = await res.text();
      } finally {
        clearTimeout(timer);
      }
      const latency_ms = Date.now() - started;
      if (res.status === 401 || res.status === 403) {
        const detail = (parseErrorBody(text) ?? text.slice(0, 160)) || res.statusText;
        // never retry auth failures
        throw new TttHttpError("auth", `TTT auth error ${res.status}: ${detail}`, res.status, text);
      }
      if (!res.ok) {
        if (SERVER_STATUS.has(res.status)) {
          throw new TttHttpError("server", `TTT HTTP ${res.status}`, res.status, text);
        }
        const detail = parseErrorBody(text) ?? text.slice(0, 160);
        throw new TttHttpError("client", `TTT HTTP ${res.status}: ${detail || res.statusText}`, res.status, text);
      }
      if (method === "HEAD") {
        return { ok: true, status: res.status, data: undefined as T, fetched_at_ms: started, latency_ms, endpoint: uri, source_name: source.id };
      }
      if (text.length === 0) {
        // A valid empty success is a parsed JSON value (e.g. [] or s:"ok" with
        // empty arrays), not a missing body. An empty GET body is invalid.
        throw new TttHttpError("invalid_response", "empty body on GET where a JSON payload is required", res.status, "");
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
      // AbortError -> timeout; TypeError -> network. A body-read abort is a
      // timeout too: the timer covers the body, and we do not swallow it.
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
