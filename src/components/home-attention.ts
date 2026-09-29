/**
 * Command-center "requires attention" derivation — PURE, testable, read-only.
 *
 * The home surface is a command center, so its first duty is to say WHAT NEEDS
 * A HUMAN, using only measured server facts. This module turns three payloads
 * (health, stored opportunities, stored signals) into an ordered list of
 * attention items. Rules:
 *
 *   - only DEGRADED/BLOCKED/FAILED facts become items; nothing is inferred
 *     from a missing field, and nothing is smoothed into "all good";
 *   - every item names the surface that owns the truth (href), because the
 *     home panel is a pointer, never a second source of truth;
 *   - market health is reported with the SERVER's own state word;
 *   - a REJECTED opportunity counts as "blocked", never as "actionable";
 *   - delivery problems are transport facts (FAILED/DEAD/UNLINKED/partial),
 *     which are NOT decision facts — decision and delivery stay separate.
 */

export interface AttentionHealth {
  market?: string | null;
  reason?: string | null;
}

export interface AttentionOpportunity {
  id: string;
  symbol: string;
  state: string;
  actionable?: boolean;
  /** carried for readability of the fixtures; the derivation never reads it */
  risk?: { verdict?: string } | null;
  psychology?: { state?: string } | null;
}

export interface AttentionSignal {
  id: string;
  symbol: string;
  state: string;
  delivery?: { delivery_state?: string; progress?: { photo_required?: boolean; photo_sent?: boolean; text_sent?: boolean } | null } | null;
}

export type AttentionTone = "block" | "warn" | "info";

export interface AttentionItem {
  key: string;
  /** short label — the category of problem */
  label: string;
  /** the measured detail, in the server's own words where possible */
  detail: string;
  tone: AttentionTone;
  href: string;
}

/** Delivery states that are transport problems (never decision problems). */
const DELIVERY_PROBLEM_STATES = ["FAILED", "DEAD"] as const;

/** Health states that mean "the truth source is not healthy right now". */
const UNHEALTHY_MARKET_STATES = ["UNAVAILABLE", "DEGRADED", "STALE", "ERROR", "NOT_READY", "NETWORK_FAILURE", "INVALID_RESPONSE", "CONNECTING"] as const;

export function attentionItems(
  health: AttentionHealth | null | undefined,
  healthReachable: boolean,
  opportunities: readonly AttentionOpportunity[],
  signals: readonly AttentionSignal[],
): AttentionItem[] {
  const items: AttentionItem[] = [];

  // 1. market truth — the server's own word, never upgraded by a live socket
  const market = health?.market ?? null;
  if (!healthReachable) {
    items.push({
      key: "health",
      label: "system health",
      detail: "the health endpoint has not answered yet — no verdict is claimed",
      tone: "warn",
      href: "/system",
    });
  } else if (market && UNHEALTHY_MARKET_STATES.includes(market as (typeof UNHEALTHY_MARKET_STATES)[number])) {
    items.push({
      key: "market",
      label: "market truth",
      detail: `${market}${health?.reason ? ` — ${health.reason}` : ""}`,
      tone: market === "CONNECTING" ? "info" : "block",
      href: "/system",
    });
  }

  // 2. blocked opportunities (admission refused or window closed)
  const blocked = opportunities.filter((o) => o.state === "REJECTED" || o.state === "EXPIRED");
  if (blocked.length > 0) {
    const symbols = blocked.slice(0, 4).map((o) => o.symbol).join(", ");
    items.push({
      key: "blocked",
      label: "blocked opportunities",
      detail: `${blocked.length} stored decision(s) not actionable${symbols ? ` — ${symbols}${blocked.length > 4 ? "…" : ""}` : ""}`,
      tone: "block",
      href: "/opportunities",
    });
  }

  // 3. psychology hard blocks recorded on stored opportunities
  const psychBlocked = opportunities.filter((o) => o.psychology?.state === "BLOCKED");
  if (psychBlocked.length > 0) {
    items.push({
      key: "psychology",
      label: "psychology gate",
      detail: `${psychBlocked.length} stored decision(s) carry a psychology BLOCK — ${psychBlocked
        .slice(0, 4)
        .map((o) => o.symbol)
        .join(", ")}`,
      tone: "block",
      href: "/psychology",
    });
  }

  // 4. delivery problems — transport truth only
  const deliveryProblems = signals.filter((s) => {
    const state = s.delivery?.delivery_state;
    if (state && DELIVERY_PROBLEM_STATES.includes(state as (typeof DELIVERY_PROBLEM_STATES)[number])) return true;
    const p = s.delivery?.progress;
    return Boolean(p?.photo_required && p.photo_sent && !p.text_sent);
  });
  if (deliveryProblems.length > 0) {
    items.push({
      key: "delivery",
      label: "delivery problems",
      detail: `${deliveryProblems.length} signal(s) not fully delivered (FAILED / DEAD / partial) — ${deliveryProblems
        .slice(0, 4)
        .map((s) => s.symbol)
        .join(", ")}`,
      tone: "warn",
      href: "/signals",
    });
  }

  return items;
}

/** Tone → CSS colour. Colour is never the only signal; every item has a word. */
export function attentionToneColor(tone: AttentionTone): string {
  if (tone === "block") return "var(--color-down)";
  if (tone === "warn") return "var(--color-warn)";
  return "var(--color-info)";
}
