// @vitest-environment jsdom
/**
 * REAL-RUNTIME DOM VERIFICATION (Team 04 §43, best available without a
 * browser binary in this sandbox).
 *
 * Renders the live MarketBoard client component in a real DOM against the
 * REAL running AsA server (default http://127.0.0.1:3000, override with
 * ASA_QA_ORIGIN). No fetch mocking: the component performs its own
 * usePoll → HTTP → classify → state → DOM pipeline, so what is asserted is
 * what a human would see for the CURRENT backend truth:
 *
 *   server UNAVAILABLE (TTT discovery NETWORK_FAILURE)
 *     → normalized provider status UNAVAILABLE
 *     → visible banner with the server's own state token and reason
 *     → no fabricated rows, prices, or "0/0" universe claims
 *
 * If no server is running the whole file skips (never fakes a pass).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";

const ORIGIN = process.env.ASA_QA_ORIGIN ?? "http://127.0.0.1:3000";

let root: Root | null = null;
let host: HTMLElement;
const realFetch = globalThis.fetch;

/* module-scope reachability probe (top-level await) so skipIf sees the real
 * value BEFORE the tests are defined */
const serverUp = await (async () => {
  try {
    const r = await realFetch(`${ORIGIN}/api/system/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  if (!serverUp) return;
  // the component's relative fetches must resolve to the QA origin
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("/")) return realFetch(`${ORIGIN}${input}`, init);
    return realFetch(input as never, init as never);
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterAll(async () => {
  if (root) await act(async () => { root?.unmount(); });
  globalThis.fetch = realFetch;
});

async function renderApp() {
  const { LanguageProvider } = await import("../src/components/lang");
  const { MarketBoard } = await import("../src/components/market-board");
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(LanguageProvider, null, createElement(MarketBoard, { onFocus: () => {} })));
  });
}

async function waitFor(text: string, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (host.textContent?.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

describe("live server reachable", () => {
  it.skipIf(!serverUp)("GET /api/market/board answers with the machine-readable unavailable contract", async () => {
    const r = await realFetch(`${ORIGIN}/api/market/board`);
    expect(r.status).toBe(503); // while TTT discovery is down in this sandbox
    const j = (await r.json()) as { ok: boolean; state: string; error: string };
    expect(j.ok).toBe(false);
    expect(["NETWORK_FAILURE", "NOT_READY", "INVALID_RESPONSE"]).toContain(j.state);
    expect(j.error.length).toBeGreaterThan(10);
  });

  it.skipIf(!serverUp)("renders the UNAVAILABLE truth in the DOM — no fake rows, no fake zeros", async () => {
    await renderApp();
    const sawState = await waitFor("UNAVAILABLE");
    expect(sawState, "board must show UNAVAILABLE when the provider says so").toBe(true);
    expect(host.textContent).toContain("NETWORK_FAILURE"); // server's own token, verbatim
    expect(host.textContent).toMatch(/TTT discovery is/); // server's own reason, verbatim
    // anti-illusion checks over the same rendered DOM:
    expect(host.textContent).not.toMatch(/\+0\.00%/); // never a fabricated percentage
    expect(host.textContent).not.toMatch(/0\/0 universe/); // never an imputed universe count
    // keyboard-reachable recovery affordance exists
    const retry = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("retry"));
    expect(retry, "a retry affordance must exist next to the failure").toBeTruthy();
  }, 30000);
});
