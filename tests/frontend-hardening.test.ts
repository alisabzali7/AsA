/**
 * Frontend recovery regressions that are deliberately exercised at the React
 * boundary rather than by asserting that a control merely exists.
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider, useLang } from "@/components/lang";
import { usePoll } from "@/components/hooks";
import { normalizeHistoryPage } from "@/lib/chart/adapter";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function LangProbe() {
  const { lang } = useLang();
  return createElement("output", null, lang);
}

function PollProbe({ url }: { url: string }) {
  const poll = usePoll<{ value: string }>(url, 60_000);
  return createElement("output", { "data-status": poll.status }, poll.data?.value ?? poll.status);
}

let root: Root | null = null;

async function unmountRoot() {
  if (!root) return;
  await act(async () => { root?.unmount(); });
  root = null;
}

afterEach(async () => {
  await unmountRoot();
  vi.restoreAllMocks();
});

describe("progressive chart history", () => {
  it("does not turn a failed history page into an exhausted empty boundary", () => {
    const result = normalizeHistoryPage(503, {
      ok: false,
      error: "TTT history unavailable",
      candles: [],
    });
    expect(result).toEqual({ ok: false, error: "TTT history unavailable" });
  });

  it("accepts only finite candle rows from a successful page", () => {
    const result = normalizeHistoryPage(200, {
      ok: true,
      candles: [
        { t: 10, o: 1, h: 2, l: 0.5, c: 1.5 },
        { t: "bad", o: 1, h: 2, l: 0.5, c: 1.5 },
      ],
      metadata: { earliest_available: 10, earliest_boundary_reached: true },
    });
    expect(result).toMatchObject({ ok: true, earliest: 10, venueBoundary: true });
    if (result.ok) expect(result.candles).toHaveLength(1);
  });
});

describe("hydration-safe presentation preferences", () => {
  it("server markup stays deterministic even when the browser preference is Persian", () => {
    window.localStorage.setItem("asa-lang", "fa");
    const html = renderToString(
      createElement(LanguageProvider, null, createElement(LangProbe)),
    );
    // The browser bootstrap changes the pre-paint document direction, but the
    // React server snapshot remains EN until hydration can safely switch.
    expect(html).toContain(">en</output>");
    expect(html).not.toContain(">fa</output>");
  });
});

describe("poll lifecycle", () => {
  it("aborts an in-flight request when the component is unmounted", async () => {
    let aborted = 0;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted += 1;
        reject(new DOMException("aborted", "AbortError"));
      });
    })));

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(PollProbe, { url: "/api/market/board" }));
      await Promise.resolve();
    });
    await act(async () => { root?.unmount(); });
    root = null;
    expect(aborted).toBe(1);
    host.remove();
  });

  it("switches resource identity without allowing the old response to paint", async () => {
    const requests: { url: string; resolve: (response: Response) => void }[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      requests.push({ url: String(input), resolve });
    })));

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(PollProbe, { url: "/api/market/stats?symbol=OLD" }));
      await Promise.resolve();
    });
    await act(async () => {
      root!.render(createElement(PollProbe, { url: "/api/market/stats?symbol=NEW" }));
      await Promise.resolve();
    });
    expect(requests.map((request) => request.url)).toContain("/api/market/stats?symbol=NEW");
    const old = requests.find((request) => request.url.includes("OLD"));
    old?.resolve(new Response(JSON.stringify({ value: "old" }), { status: 200 }));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).not.toContain("old");
    host.remove();
  });
});
