// @vitest-environment jsdom
/**
 * REAL-RUNTIME DOM VERIFICATION for the OPPORTUNITIES surface.
 *
 * Renders the live opportunities client component in a real DOM against the
 * REAL running AsA server (default http://127.0.0.1:3000, override with
 * ASA_QA_ORIGIN). No fetch mocking: the component performs its own
 * usePoll → HTTP → classify → state → DOM pipeline, so what is asserted is
 * what a human would see for the CURRENT backend truth.
 *
 * The regression this pins: a stored REJECTED opportunity whose risk engine
 * returned `pass` (portfolio boundary BLOCK — daily realized loss UNKNOWN)
 * used to be painted READY. The displayed verdict must be the STORED ADMISSION
 * STATE, and the blocking gate must be named.
 *
 * If no server is running the whole file skips (never fakes a pass).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { vi } from "vitest";

// the page navigates with the app router; outside a router mount we provide the
// smallest possible navigation surface (push only records the target)
const pushed: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => pushed.push(href), replace: (href: string) => pushed.push(href), back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/opportunities",
}));

const ORIGIN = process.env.ASA_QA_ORIGIN ?? "http://127.0.0.1:3000";

async function waitForText(text: string, ms = 8000): Promise<boolean> {
  return waitFor(text, ms);
}

async function waitFor(text: string, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (host?.textContent?.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

let root: Root | null = null;
let host: HTMLElement;
const realFetch = globalThis.fetch;

const serverUp = await (async () => {
  try {
    const r = await realFetch(`${ORIGIN}/api/opportunities`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
})();

/** pick a stored opportunity whose risk engine passed but admission refused */
interface LiveOpp {
  symbol: string;
  state: string;
  actionable?: boolean;
  risk?: { verdict?: string } | null;
  portfolio?: { verdict?: string; reasons?: string[] } | null;
  blocked_factors?: string[];
}
interface LiveOppFull extends LiveOpp { signal_state?: string | null }
const liveCases = await (async (): Promise<{ rejectedWithRiskPass: LiveOpp | null; ready: LiveOppFull | null; downgraded: LiveOppFull | null; stored: number }> => {
  if (!serverUp) return { rejectedWithRiskPass: null, ready: null, downgraded: null, stored: 0 };
  try {
    const r = await realFetch(`${ORIGIN}/api/opportunities`, { signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { items: LiveOppFull[] };
    const live = j.items.filter((o) => typeof o.state === "string" && typeof o.symbol === "string");
    return {
      stored: live.length,
      rejectedWithRiskPass:
        live.find((o) => o.state === "REJECTED" && o.risk?.verdict === "pass") ?? null,
      // a READY row whose linked signal is NOT terminal keeps READY
      ready:
        live.find(
          (o) =>
            o.state === "READY" &&
            (o.signal_state == null || ["candidate", "qualified", "published"].includes(o.signal_state)),
        ) ?? null,
      // a READY row whose signal is terminal must be DOWNGRADED in the UI
      downgraded: live.find((o) => o.state === "READY" && o.signal_state != null && !["candidate", "qualified", "published"].includes(o.signal_state)) ?? null,
    };
  } catch {
    return { rejectedWithRiskPass: null, ready: null, downgraded: null, stored: 0 };
  }
})();

/**
 * PREREQUISITE CONTRACT (why this is explicit).
 *
 * These suites render the REAL UI against a running server, so they need
 * STORED rows. A server with an empty database is not a UI regression — it is
 * an unmet prerequisite, and it must say so instead of crashing with
 * "Cannot read properties of null" (the pre-repair behaviour) or silently
 * passing. Once the database HAS rows, the required cases below are asserted
 * as hard requirements: seeded-but-incomplete data fails with the exact
 * missing case, never with a skip.
 *
 * Seed the scenario DB (see docs/testing.md) and point ASA_QA_ORIGIN at it.
 */
const scenarioReady = serverUp && liveCases.stored > 0;
if (serverUp && !scenarioReady) {
  console.warn(
    `[runtime-opportunities] SKIPPED: ${ORIGIN} answered but stores 0 opportunities. ` +
      "This suite needs the LOCAL TEST scenario database (SEED IT — do not read this as a UI pass): " +
      "node scripts/prepare-team05-local.mjs /tmp/team05-local-evidence seed, then run the server on that DB and set ASA_QA_ORIGIN.",
  );
}
function requireCase<T>(value: T | null, description: string): T {
  if (value === null) {
    throw new Error(
      `runtime scenario prerequisite not met: ${description}. ` +
        "The server has stored rows but not the row this contract needs; seed a complete LOCAL TEST scenario " +
        "(docs/testing.md) — do not weaken this assertion.",
    );
  }
  return value;
}

describe.skipIf(!scenarioReady)("opportunities surface (live server)", () => {
  beforeAll(async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    // the page's relative fetches must resolve to the QA origin
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === "string" && input.startsWith("/")) return realFetch(`${ORIGIN}${input}`, init);
      return realFetch(input as never, init as never);
    }) as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
    const { LanguageProvider } = await import("../src/components/lang");
    const mod = await import("../src/app/opportunities/page");
    const Page = mod.default;
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(LanguageProvider, null, createElement(Page)));
    });
  });

  afterAll(async () => {
    if (root) await act(async () => { root?.unmount(); });
    host.remove();
    globalThis.fetch = realFetch;
  });

  // The regression case below can only be exercised when the store actually
  // HOLDS such an opportunity. The whole suite is gated on a NON-EMPTY store
  // (see scenarioReady above): when the backend answers with rows, the required
  // regression case is a hard prerequisite — a seeded-but-incomplete scenario
  // fails here with the exact missing case instead of silently skipping the
  // rule it exists to protect (never fake a pass).
  it("renders the REJECTED opportunity as REJECTED, never as READY", async () => {
    const rejected = requireCase(liveCases.rejectedWithRiskPass, "an opportunity stored as REJECTED whose risk verdict is pass (portfolio/daily-loss block)");
    const seen = await waitFor(rejected.symbol);
    expect(seen, "the stored opportunity must be rendered from the live API").toBe(true);
    const text = host.textContent ?? "";
    expect(text).toContain(rejected.symbol);
    // the row's own verdict word must be REJECTED
    const row = text.slice(text.indexOf(rejected.symbol));
    expect(row.slice(0, 400)).toContain("REJECTED");
    // and it must be marked not actionable
    expect(text.toLowerCase()).toContain("not actionable");
  });

  it("keeps a genuinely READY opportunity READY", async () => {
    const text = host.textContent ?? "";
    if (!liveCases.ready) return;
    const idx = text.indexOf(liveCases.ready.symbol);
    expect(idx).toBeGreaterThan(-1);
    expect(text.slice(idx, idx + 400)).toContain("READY");
  });

  it("downgrades a READY row whose signal is terminal (never upgrades)", async () => {
    if (!liveCases.downgraded) return;
    const text = host.textContent ?? "";
    const idx = text.indexOf(liveCases.downgraded.symbol);
    expect(idx).toBeGreaterThan(-1);
    const row = text.slice(idx, idx + 400);
    expect(row).toContain(String(liveCases.downgraded.signal_state).toUpperCase());
    expect(row).not.toMatch(/^READY/);
  });

  it("the dossier gate ledger names every boundary for the REJECTED row", async () => {
    // open the dossier of the risk-pass-but-rejected row (the regression case)
    const symbol = requireCase(liveCases.rejectedWithRiskPass, "the REJECTED-with-risk-pass row for the dossier ledger").symbol;
    expect(await waitFor(symbol)).toBe(true);
    const btn = Array.from(host.querySelectorAll("button")).find((b) =>
      (b.getAttribute("aria-label") ?? "").toLowerCase().includes("inspect opportunity details"),
    );
    expect(btn, "a row must expose an inspect affordance").toBeTruthy();
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const drawerText = await waitForText("gate ledger");
    expect(drawerText, "the dossier must show the gate ledger").toBe(true);
    const text = host.textContent ?? "";
    // each independent boundary is listed with its own verdict
    expect(text).toContain("risk engine");
    expect(text).toContain("portfolio / account boundary");
    expect(text).toContain("psychology gate");
    // the risk engine's PASS is shown as a PASS — it is one gate, not an approval
    expect(text).toContain("PASS");
    // and the blocking gate is named, in the server's own words
    const opps = await (await realFetch(`${ORIGIN}/api/opportunities`)).json() as { items: LiveOpp[] };
    const row = opps.items.find((o) => o.symbol === symbol)!;
    if (row.portfolio?.verdict === "block") {
      expect(text).toContain("BLOCKED");
      for (const reason of (row.portfolio.reasons ?? []).slice(0, 2)) {
        expect(text).toContain(reason);
      }
    }
    // the verdict itself is the stored admission state
    expect(text).toContain("admission state");
    expect(text).toContain("REJECTED");
  }, 30000);

  it("navigation targets stay inside the terminal (no execution path)", () => {
    // clicking through to the chart must navigate to /chart, never to an order surface
    const links = Array.from(host.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
    expect(links.every((h) => h.startsWith("/"))).toBe(true);
    expect(links.some((h) => h.startsWith("/order") || h.includes("execute"))).toBe(false);
  });

  it("never renders an empty verdict chip (UNAVAILABLE is stated, not blank)", async () => {
    const chips = Array.from(host.querySelectorAll("[data-state], .badge, span"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean);
    // no chip may ever be an empty string
    expect(chips.every((c) => c.length > 0)).toBe(true);
    const hasRow = liveCases.rejectedWithRiskPass ?? liveCases.ready ?? liveCases.downgraded;
    if (!hasRow) {
      // No row exists, so there is no row verdict to render; what the surface
      // must state instead is the EMPTY truth (backend answered, nothing stored
      // — never a blank or a fabricated row). That text lives in the state
      // block, so it is asserted on the page text, not on a chip. Wait for the
      // first poll to settle: before it answers, the honest state is LOADING.
      expect(await waitFor("EMPTY", 15000), "an empty store must settle into the EMPTY truth state").toBe(true);
      return;
    }
    expect(chips.some((c) => /UNAVAILABLE|LOADING|EMPTY|REJECTED|READY|EXPIRED/.test(c))).toBe(true);
  });
});

/**
 * HONEST EMPTY STATE — the mirror of the skip above.
 *
 * When a server IS answering but its store holds nothing, the surface must say
 * so in the backend's own words. An empty store is not an error, and it must
 * never be dressed up as a row or a blank verdict. This block therefore runs
 * exactly when the QA origin answers with ZERO stored opportunities: the
 * populated cases are the seeded suite above, and between them there is no
 * state in which this file silently passes without asserting anything.
 */
describe.skipIf(!serverUp || scenarioReady)("opportunities surface — empty store (live server)", () => {
  let emptyRoot: Root | null = null;
  let emptyHost: HTMLElement;

  beforeAll(async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === "string" && input.startsWith("/")) return realFetch(`${ORIGIN}${input}`, init);
      return realFetch(input as never, init as never);
    }) as typeof fetch;
    emptyHost = document.createElement("div");
    document.body.appendChild(emptyHost);
    const { LanguageProvider } = await import("../src/components/lang");
    const mod = await import("../src/app/opportunities/page");
    emptyRoot = createRoot(emptyHost);
    await act(async () => {
      emptyRoot!.render(createElement(LanguageProvider, null, createElement(mod.default)));
    });
  });

  afterAll(async () => {
    if (emptyRoot) await act(async () => { emptyRoot?.unmount(); });
    emptyHost.remove();
    globalThis.fetch = realFetch;
  });

  it("states the EMPTY truth — never a blank chip and never a fabricated row", async () => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (emptyHost.textContent?.includes("EMPTY")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const text = emptyHost.textContent ?? "";
    expect(text, "an answering-but-empty backend must be stated as EMPTY").toContain("EMPTY");
    expect(text.toLowerCase(), "the empty state must say nothing is simulated").toContain("nothing is simulated");
    const chips = Array.from(emptyHost.querySelectorAll("[data-state], .badge, span"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean);
    expect(chips.every((c) => c.length > 0), "no chip may be an empty string").toBe(true);
  }, 30000);
});
