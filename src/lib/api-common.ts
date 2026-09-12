/**
 * Shared API helpers: JSON responses, query parsing, symbol/TF allow-lists,
 * centralized mutation authorization (x-asa-token). No route may mutate
 * without going through guardMutation().
 */
import { NextResponse } from "next/server";
import { ASA_API_TOKEN } from "./env";
import { isOperationalSymbol } from "./market/operational-universe";
import { isTimeframe, type TimeframeId } from "./domain/timeframes";

export function json(data: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(data, init ? { status: init.status } : undefined);
}

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

export function ok(data: unknown): NextResponse {
  return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) });
}

export interface QueryBag {
  get(k: string): string | null;
}

/** Parse + validate symbol from a query param (allow-list enforced). */
export function sym(q: QueryBag, key = "symbol", fallback?: string): { symbol?: string; error?: NextResponse } {
  const raw = q.get(key) ?? fallback;
  if (!raw) return { error: jsonError(`missing ${key}`) };
  const s = raw.trim().toUpperCase();
  // Validated against the DYNAMIC operational universe discovered from TTT,
  // not a hard-coded list — a newly listed contract is accepted immediately.
  if (!isOperationalSymbol(s)) return { error: jsonError(`symbol '${s}' is not in the operational TTT universe (permanently excluded symbols are always rejected)`) };
  return { symbol: s };
}

/** Validate timeframe from query param. */
export function tff(q: QueryBag, key = "tf", fallback?: string): { tf?: TimeframeId; error?: NextResponse } {
  const raw = q.get(key) ?? fallback;
  if (!raw || !isTimeframe(raw)) return { error: jsonError(`unsupported timeframe '${raw}'`) };
  return { tf: raw as TimeframeId };
}

export function intParam(q: QueryBag, key: string, fallback: number, lo: number, hi: number): number {
  const raw = q.get(key);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function boolParam(q: QueryBag, key: string): boolean {
  const raw = q.get(key);
  return raw === "1" || raw === "true";
}

/**
 * Centralized mutation guard. All mutating routes call this FIRST.
 * If ASA_API_TOKEN is set, the request must carry x-asa-token.
 */
/**
 * Mutation guard — FAILS CLOSED in production (closure §Y).
 *
 * Previously an unset ASA_API_TOKEN meant "allow everything", which in a
 * production deployment silently exposed every mutation endpoint. Now:
 *   - production without a token  -> 503, every mutation denied;
 *   - non-production without one  -> allowed, for local development only.
 */
export function guardMutation(req: Request): NextResponse | null {
  if (!ASA_API_TOKEN) {
    if (isProductionRuntime()) {
      return jsonError(
        "mutation denied: ASA_API_TOKEN is not configured in a production deployment (fail-closed)",
        503,
        { remediation: "set ASA_API_TOKEN in the deployment environment and restart" },
      );
    }
    return null; // development convenience only
  }
  const provided = req.headers.get("x-asa-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== ASA_API_TOKEN) {
    return jsonError("mutation denied: x-asa-token missing or wrong", 401);
  }
  return null;
}

/** True when this process is serving a production deployment. */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" && process.env.ASA_ALLOW_UNAUTHENTICATED !== "1";
}

/**
 * Startup configuration validation. Called at boot so a misconfigured
 * production deployment surfaces loudly instead of running wide open.
 */
export interface SecurityConfigInput {
  nodeEnv?: string;
  apiToken?: string;
  allowUnauthenticated?: boolean;
}

export function validateSecurityConfig(input: SecurityConfigInput = {}): { ok: boolean; errors: string[]; warnings: string[] } {
  const nodeEnv = input.nodeEnv ?? process.env.NODE_ENV;
  const apiToken = input.apiToken ?? ASA_API_TOKEN ?? "";
  const allowUnauth = input.allowUnauthenticated ?? process.env.ASA_ALLOW_UNAUTHENTICATED === "1";
  const errors: string[] = [];
  const warnings: string[] = [];

  if (nodeEnv === "production") {
    if (!apiToken) {
      if (allowUnauth) {
        warnings.push("ASA_ALLOW_UNAUTHENTICATED=1 disables the production mutation guard — only valid on a private, network-restricted deployment");
      } else {
        errors.push("ASA_API_TOKEN must be set in production: all mutation endpoints are denied until it is configured");
      }
    }
  } else if (!apiToken) {
    warnings.push("ASA_API_TOKEN not set (development): mutation endpoints are open locally");
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Parse JSON body defensively (max 256 KB, must be object). */
export async function readBody(req: Request): Promise<{ body: Record<string, unknown>; error?: NextResponse }> {
  try {
    const text = await req.text();
    if (text.length > 262_144) return { body: {}, error: jsonError("body too large") };
    if (!text.trim()) return { body: {} };
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { body: {}, error: jsonError("body must be a JSON object") };
    }
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { body: {}, error: jsonError("invalid JSON body") };
  }
}
