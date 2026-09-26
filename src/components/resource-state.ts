/**
 * Normalized async resource state — the provider layer between HTTP and UI.
 *
 * PRODUCT LAW: truth flows downward. The backend already distinguishes
 *   READY vs EMPTY vs UNAVAILABLE vs outage; the frontend may NOT collapse
 * those into `error: true / loading: false / data: null` and repaint them as
 * "loading…" or a bare "HTTP 503". This module preserves that distinction:
 *
 *   LOADING      — a request is in flight and no authoritative answer yet
 *   OK           — server answered successfully (payload may still be EMPTY:
 *                  features derive emptiness from the payload itself)
 *   UNAVAILABLE  — the server explicitly says the data source/capability is
 *                  not available right now (503 / 502 / 429 / 504 with a
 *                  machine-readable payload, e.g. universe NETWORK_FAILURE).
 *                  The server's state + reason are carried verbatim.
 *   OFFLINE      — the browser has no network; nothing was received.
 *   ERROR        — unexpected transport/server failure (no usable contract).
 *
 * A previous OK payload is RETAINED on failure (with elapsed age) exactly the
 * way the board keeps showing a cached snapshot while its freshness decays —
 * never presented as fresh: `stale_age_ms` tells the UI how long ago truth was
 * last received, and consumers downgrade state by elapsed time only.
 *
 * Pure module: no React, no globals beyond fetch (injected for tests).
 */

export type ResourceStatus = "LOADING" | "OK" | "UNAVAILABLE" | "OFFLINE" | "ERROR";

export interface ResourceFailure {
  kind: "UNAVAILABLE" | "OFFLINE" | "ERROR";
  /** human-readable message — server-provided when available, never invented */
  message: string;
  /** HTTP status if a response was received (null on transport failure) */
  status: number | null;
  /** machine-readable server state, verbatim (e.g. NETWORK_FAILURE, NOT_READY) */
  server_state: string | null;
  /** server-provided remediation/hint when present */
  hint: string | null;
}

export interface ResourceResult<T> {
  status: ResourceStatus;
  data: T | null;
  failure: ResourceFailure | null;
  /** Date.now() at the moment the payload/failure arrived */
  at_ms: number;
}

/** Shape of every structured failure body the AsA API contract defines:
 *  { ok:false, error, reason?, state?, hint?, remediation? }. Unknown bodies
 *  are still surfaced as raw text — nothing here invents content. */
interface FailureBody {
  ok?: boolean;
  error?: unknown;
  reason?: unknown;
  state?: unknown;
  hint?: unknown;
  remediation?: unknown;
}

/** Statuses whose AsA payloads are authoritative "the source is unavailable"
 *  answers, not unexpected faults: venue outage, rate pause, fail-closed. */
const UNAVAILABLE_HTTP = new Set([502, 503, 504, 429]);

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Extract the server's own verdict from a failure JSON body, if it is one. */
export function parseFailureBody(raw: string): FailureBody | null {
  if (!raw.trim()) return null;
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) return j as FailureBody;
    return null;
  } catch {
    return null;
  }
}

/**
 * Classify ONE resource load. `resp` is null when the request never received
 * a response (transport error/abort); `transportError` is the thrown error.
 * `isOffline` is injected so this logic is testable without a browser.
 */
export function classifyResource(
  resp: Response | null,
  bodyText: string | null,
  transportError: unknown,
  isOffline: () => boolean,
  atMs: number,
): ResourceResult<unknown> {
  if (resp === null) {
    if (isOffline()) {
      return {
        status: "OFFLINE",
        data: null,
        at_ms: atMs,
        failure: { kind: "OFFLINE", message: "browser is offline", status: null, server_state: null, hint: null },
      };
    }
    const msg = transportError instanceof Error ? transportError.message : String(transportError ?? "network failure");
    return {
      status: "ERROR",
      data: null,
      at_ms: atMs,
      failure: { kind: "ERROR", message: `network error: ${msg}`, status: null, server_state: null, hint: null },
    };
  }

  if (resp.ok) {
    // success: parse or expose raw
    try {
      const data = bodyText && bodyText.trim() ? JSON.parse(bodyText) : null;
      return { status: "OK", data, failure: null, at_ms: atMs };
    } catch {
      return {
        status: "ERROR",
        data: null,
        at_ms: atMs,
        failure: { kind: "ERROR", message: "server answered 200 with a non-JSON body", status: resp.status, server_state: null, hint: null },
      };
    }
  }

  const body = parseFailureBody(bodyText ?? "");
  const serverMessage =
    asString(body?.error) ?? asString(body?.reason) ?? `HTTP ${resp.status}`;
  const serverState = asString(body?.state);
  const hint = asString(body?.hint) ?? asString(body?.remediation);

  if (UNAVAILABLE_HTTP.has(resp.status)) {
    return {
      status: "UNAVAILABLE",
      data: null,
      at_ms: atMs,
      failure: { kind: "UNAVAILABLE", message: serverMessage, status: resp.status, server_state: serverState, hint },
    };
  }
  // A structured ok:false on a client/server error is still a truth verdict,
  // but an unexpected status (400/401/404/500) remains ERROR — never silently
  // relabeled as "unavailable" or "empty".
  return {
    status: "ERROR",
    data: null,
    at_ms: atMs,
    failure: { kind: "ERROR", message: serverMessage, status: resp.status, server_state: serverState, hint },
  };
}

/** Perform one load with classification. `init` is passed to fetch verbatim. */
export async function loadResource(
  url: string,
  opts: { fetchImpl?: typeof fetch; isOffline?: () => boolean; signal?: AbortSignal } = {},
): Promise<ResourceResult<unknown>> {
  const f = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const offline = opts.isOffline ?? (() => (typeof navigator !== "undefined" ? navigator.onLine === false : false));
  try {
    const resp = await f(url, { cache: "no-store", signal: opts.signal });
    const text = await resp.text().catch(() => "");
    return classifyResource(resp, text, null, offline, Date.now());
  } catch (err) {
    return classifyResource(null, null, err, offline, Date.now());
  }
}

/** Age of the last authoritative contact (success OR failure) since `at_ms`. */
export function contactAgeMs(atMs: number | null, nowMs: number): number | null {
  return atMs === null ? null : Math.max(0, nowMs - atMs);
}
