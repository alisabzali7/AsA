// @vitest-environment jsdom
/**
 * REAL-RUNTIME DOM VERIFICATION for the HOME command center.
 *
 * Renders the live home client component in a real DOM against the REAL running
 * AsA server (default http://127.0.0.1:3000, override with ASA_QA_ORIGIN). No
 * fetch mocking: the component performs its own usePoll → HTTP → classify →
 * state → DOM pipeline, so what is asserted is what a human would see for the
 * CURRENT backend truth.
 *
 * Pins the command-center contract: home must state WHAT NEEDS ATTENTION from
 * measured server facts (market truth, blocked opportunities, psychology
 * blocks, delivery problems), each item pointing at the surface that owns the
 * truth — and must claim nothing when nothing is wrong.
 *
 * If no server is running the whole file skips (never fakes a pass).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { vi } from "vitest";

const ORIGIN = process.env.ASA_QA_ORIGIN ?? "http://127.0.0.1:3000";

let root: Root | null = null;
let host: HTMLElement;
const realFetch = globalThis.fetch;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

// the shell subscribes to the SSE bus; jsdom has no EventSource, so provide the
// smallest stub (the home page only reads `connected` from it)
class StubEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
(globalThis as Record<string, unknown>).EventSource = StubEventSource;

const serverUp = await (async () => {
  try {
    const r = await realFetch(`${ORIGIN}/api/system/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
})();

async function waitFor(text: string, ms = 10000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (host?.textContent?.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

describe.skipIf(!serverUp)("home command center (live server)", () => {
  beforeAll(async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === "string" && input.startsWith("/")) return realFetch(`${ORIGIN}${input}`, init);
      return realFetch(input as never, init as never);
    }) as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
    const { LanguageProvider } = await import("../src/components/lang");
    const { ToastProvider: Toast } = await import("../src/components/toast");
    const mod = await import("../src/app/page");
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(LanguageProvider, null, createElement(Toast, null, createElement(mod.default))),
      );
    });
  });

  afterAll(async () => {
    if (root) await act(async () => { root?.unmount(); });
    host.remove();
    globalThis.fetch = realFetch;
  });

  it("renders the attention panel with measured problems only", async () => {
    expect(await waitFor("requires attention"), "home must expose the attention panel").toBe(true);

    // the market-truth item must use the SERVER's own state word
    const health = await (await realFetch(`${ORIGIN}/api/system/health`)).json() as { market?: string };
    const text = host.textContent ?? "";
    if (health.market && health.market !== "LIVE") {
      expect(text).toContain(String(health.market));
    }

    // a blocked opportunity must be counted as blocked, never as actionable —
    // wait for the opportunity poll that feeds the panel to land
    const opps = await (await realFetch(`${ORIGIN}/api/opportunities`)).json() as { items: { state: string; symbol: string }[] };
    const blocked = opps.items.filter((o) => o.state === "REJECTED" || o.state === "EXPIRED");
    if (blocked.length > 0) {
      const label = `${blocked.length} stored decision(s) not actionable`;
      expect(await waitFor(label), `home must count the ${blocked.length} blocked decision(s)`).toBe(true);
      expect(host.textContent ?? "").toContain("blocked opportunities");
    }
  }, 30000);

  it("every attention item links to the surface that owns the truth", () => {
    const links = Array.from(host.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
    const attentionLinks = links.filter((h) => ["/system", "/opportunities", "/psychology", "/signals"].includes(h));
    // when an item exists it must be navigable; no dead panel
    if (host.textContent?.includes("blocked opportunities")) {
      expect(attentionLinks.length).toBeGreaterThan(0);
    }
  });

  it("never claims a fabricated market or advisory state", () => {
    const text = host.textContent ?? "";
    // no invented price/percent, no execution affordance on the command center
    expect(text).not.toMatch(/\+\d+\.\d{2}%/);
    // "HUMAN EXECUTES" is the advisory boundary itself; an execution AFFORDANCE is not
    expect(text).not.toMatch(/buy now|place order|submit order|market order|limit order/i);
  });
});
