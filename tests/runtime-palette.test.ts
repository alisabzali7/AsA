// @vitest-environment jsdom
/**
 * PALETTE + LIVE-STATE DOM VERIFICATION against the REAL running server
 * (same discipline as runtime-dom.test.ts: no fetch mocks for data paths —
 * the palette must speak the universe's actual truth, whatever that is).
 *
 * The only mocked module is next/navigation's useRouter (a routing side
 * effect, not data): palette entries are asserted to CALL it with real URLs.
 *
 * Skips itself when no AsA server is running — never fakes a pass.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";

const ORIGIN = process.env.ASA_QA_ORIGIN ?? "http://127.0.0.1:3000";
const pushSpy = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, replace: vi.fn() }),
  usePathname: () => "/",
}));

let root: Root | null = null;
let host: HTMLElement;
const realFetch = globalThis.fetch;

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

async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

describe("command palette against the live server", () => {
  it.skipIf(!serverUp)("opens on the event bus, fetches the REAL universe, and states its truth honestly", async () => {
    const { LanguageProvider } = await import("../src/components/lang");
    const { CommandPalette } = await import("../src/components/palette");
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(LanguageProvider, null, createElement(CommandPalette)));
    });
    // launcher renders nothing until invoked
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { window.dispatchEvent(new Event("asa:palette")); });

    const opened = await waitFor(() => !!host.querySelector('[role="dialog"]'));
    expect(opened, "the asa:palette bus event must open the dialog").toBe(true);

    // combobox semantics exist and the input takes focus (a11y contract)
    expect(host.querySelector('[role="combobox"]')).toBeTruthy();
    expect(host.contains(document.activeElement)).toBe(true);

    // universe truth: THIS deployment answers 200 with an empty discovery —
    // the palette must say so, not offer fake symbols
    const emptyNote = await waitFor(() => (host.textContent ?? "").includes("no symbols yet"));
    expect(emptyNote, "palette must disclose an empty universe verbatim").toBe(true);

    // footer carries the real provider status word
    expect(host.textContent).toMatch(/universe:\s*(OK|LOADING|UNAVAILABLE|ERROR|OFFLINE)/);

    // typing filters to real routes; running one performs a real router push
    const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
    // drive the controlled input the way React's synthetic layer observes it
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "settings");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const hit = await waitFor(() => Array.from(host.querySelectorAll("button")).some((b) => /settings/i.test(b.textContent ?? "")));
    expect(hit, "typed query must surface the settings route").toBe(true);
    const btn = Array.from(host.querySelectorAll("button")).find((b) => /settings/i.test(b.textContent ?? ""))!;
    await act(async () => { btn.click(); });
    expect(pushSpy).toHaveBeenCalledWith("/settings");
    expect(localStorage.getItem("asa-recents")).toContain("/settings");

    // unmounting the dialog removes it entirely (reset-by-unmount, no hidden state)
    expect(await waitFor(() => !host.querySelector('[role="dialog"]'))).toBe(true);
  }, 30000);
});
