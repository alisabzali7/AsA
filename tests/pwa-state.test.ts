/**
 * Task 2 regression tests — PWA/app-shell + explicit online/offline/stale state.
 *
 * Covers what is testable in a node environment (no browser):
 *   - client freshness logic: a cached snapshot can NEVER keep presenting as
 *     LIVE; reconnection alone never makes stale data live
 *   - en/fa localization parity for the new conn namespace (and all namespaces)
 *   - manifest correctness: valid JSON, required installable fields, and every
 *     referenced icon actually exists on disk (no dangling manifest refs)
 *   - service worker guard rails: /api/* is never intercepted, only same-origin
 *     GETs are handled, navigations fall back honestly (503, no fake data),
 *     caches are versioned and purged
 *   - SW registration is production-gated
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  effectiveAgeMs,
  displayStateFor,
  BOARD_LIVE_MS,
  BOARD_STALE_MS,
} from "../src/components/board-selectors";
import { STRINGS } from "../src/lib/i18n/strings";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("client freshness: a cached snapshot can never keep presenting as LIVE", () => {
  it("effective age = server-reported age + time elapsed since the response", () => {
    expect(effectiveAgeMs(10_000, 25_000)).toBe(35_000);
    expect(effectiveAgeMs(10_000, null)).toBe(10_000);
    expect(effectiveAgeMs(10_000, 0)).toBe(10_000);
    expect(effectiveAgeMs(null, 25_000)).toBe(null);
    expect(effectiveAgeMs(undefined, 5)).toBe(null);
    expect(effectiveAgeMs(Number.NaN, 5)).toBe(null);
  });

  it("server state LIVE + no response for 2 min → STALE, not LIVE", () => {
    expect(displayStateFor("LIVE", effectiveAgeMs(1_000, 120_000))).toBe("STALE");
  });

  it("transitions LIVE → STALE → DEGRADED at the server's own board thresholds", () => {
    expect(displayStateFor("LIVE", 10_000)).toBe("LIVE");
    expect(displayStateFor("LIVE", BOARD_LIVE_MS - 1)).toBe("LIVE");
    expect(displayStateFor("LIVE", BOARD_LIVE_MS)).toBe("STALE");
    expect(displayStateFor("LIVE", BOARD_STALE_MS - 1)).toBe("STALE");
    expect(displayStateFor("LIVE", BOARD_STALE_MS)).toBe("DEGRADED");
    expect(displayStateFor("LIVE", 1_800_000)).toBe("DEGRADED");
  });

  it("reconnection does NOT make stale data live: only a fresh successful response (client age 0) does", () => {
    // no response for 3 minutes while the last snapshot claimed LIVE
    expect(displayStateFor("LIVE", effectiveAgeMs(5_000, 180_000))).toBe("STALE");
    // "online" again, but no new response has arrived yet → still not live
    expect(displayStateFor("LIVE", effectiveAgeMs(5_000, 180_500))).toBe("STALE");
    // 5+ minutes without a response → clearly DEGRADED
    expect(displayStateFor("LIVE", effectiveAgeMs(5_000, 300_000))).toBe("DEGRADED");
    // a fresh successful response resets the client age to 0 with a fresh server age
    expect(displayStateFor("LIVE", effectiveAgeMs(2_000, 0))).toBe("LIVE");
  });

  it("rows without a measured age keep their server state (CONNECTING passthrough)", () => {
    expect(displayStateFor("CONNECTING", null)).toBe("CONNECTING");
    expect(displayStateFor("ERROR", null)).toBe("ERROR");
  });
});

describe("conn i18n (en/fa parity)", () => {
  it("en and fa carry the same conn keys", () => {
    expect(Object.keys(STRINGS.en.conn).sort()).toEqual(Object.keys(STRINGS.fa.conn).sort());
  });

  it("every STRINGS namespace has full en/fa key parity", () => {
    const en = STRINGS.en as unknown as Record<string, unknown>;
    const fa = STRINGS.fa as unknown as Record<string, unknown>;
    for (const k of Object.keys(en)) {
      const a = en[k];
      const b = fa[k];
      const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
      if (isObj(a) && isObj(b)) {
        expect(Object.keys(b as object).sort(), `fa key parity for "${k}"`).toEqual(Object.keys(a as object).sort());
      }
    }
  });

  it("fa conn labels are real translations (non-empty, not English)", () => {
    for (const k of Object.keys(STRINGS.en.conn) as (keyof typeof STRINGS.en.conn)[]) {
      const fa = String((STRINGS.fa.conn as Record<string, string>)[k]);
      expect(fa.length, `fa conn.${k} must not be empty`).toBeGreaterThan(2);
      expect(fa).not.toBe(String(STRINGS.en.conn[k]));
    }
  });
});

describe("PWA manifest", () => {
  const manifest = () => JSON.parse(read("public/manifest.webmanifest")) as {
    name: string;
    short_name: string;
    description: string;
    id: string;
    start_url: string;
    scope: string;
    display: string;
    background_color: string;
    theme_color: string;
    lang: string;
    icons: { src: string; sizes: string; type: string }[];
  };

  it("is valid JSON with the required installable fields", () => {
    const m = manifest();
    expect(m.name.length).toBeGreaterThan(0);
    expect(m.short_name.length).toBeGreaterThan(0);
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(["standalone", "fullscreen", "minimal-ui"]).toContain(m.display);
    expect(/#[0-9a-f]{6}/i.test(m.background_color)).toBe(true);
    expect(/#[0-9a-f]{6}/i.test(m.theme_color)).toBe(true);
    expect(m.lang).toBe("en"); // matches the default document language
    expect(m.icons.length).toBeGreaterThanOrEqual(2);
  });

  it("every referenced icon exists on disk with a sane declared size", () => {
    for (const icon of manifest().icons) {
      const p = path.join(ROOT, "public", icon.src.replace(/^\//, ""));
      expect(fs.existsSync(p), `manifest icon ${icon.src} must exist`).toBe(true);
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(Number.isInteger(w) && Number.isInteger(h) && w >= 192 && h >= 192, `icon ${icon.src} size`).toBe(true);
      expect(icon.type).toBe("image/png");
    }
  });

  it("the layout wires the manifest and icons into the document head", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("manifest: \"/manifest.webmanifest\"");
    expect(layout).toContain("/icons/icon-192.png");
    expect(layout).toContain("/icons/icon-512.png");
    expect(layout).toContain("appleWebApp");
  });
});

describe("service worker: app shell only, never market data", () => {
  const sw = () => read("public/sw.js");

  it("is a classic script (no module imports) — maximum browser compatibility", () => {
    expect(sw()).not.toMatch(/^[ \t]*import\s/m);
  });

  it("explicitly passes /api/* through to the network (no cached market truth, ever)", () => {
    expect(sw()).toContain('u.pathname.startsWith("/api/")');
    // and no literal /api/* URL is ever passed to a cache add/put/match
    expect(sw()).not.toMatch(/(add|put|match)\(\s*["'`][^"'`]*api/i);
  });

  it("only intercepts same-origin GETs — mutations and cross-origin untouched", () => {
    expect(sw()).toContain('req.method !== "GET"');
    expect(sw()).toContain("sameOrigin(req)");
  });

  it("navigations are network-first with an honest offline fallback (503, no fabricated values)", () => {
    const s = sw();
    expect(s).toContain("event.respondWith(handlePage(req, u))");
    expect(s).toContain("status: 503");
    expect(s).toContain("no market data is available");
    expect(s).toContain("no cached value is presented as live");
  });

  it("caches are versioned and every old asa-shell-* version is purged on activate", () => {
    const s = sw();
    expect(s).toMatch(/const VERSION = "asa-shell-v\d+"/);
    expect(s).toContain('n.startsWith("asa-shell-")');
    expect(s).toContain("caches.delete(n)");
  });

  it("static asset caching is bounded (eviction caps exist)", () => {
    expect(sw()).toMatch(/const MAX_PAGES = \d+/);
    expect(sw()).toMatch(/const MAX_STATIC = \d+/);
    expect(sw()).toContain("trimCache");
  });
});

describe("service-worker registration (client)", () => {
  const reg = () => read("src/components/pwa.tsx");

  it("is a client component, production-gated, and registers /sw.js with scope /", () => {
    const s = reg();
    expect(s).toContain('"use client"');
    expect(s).toContain('process.env.NODE_ENV !== "production"');
    expect(s).toContain('"/sw.js"');
    expect(s).toContain('{ scope: "/" }');
    expect(s).toContain('"serviceWorker" in navigator');
  });

  it("registration failure is non-fatal (the app works without the SW)", () => {
    expect(reg()).toContain(".catch(");
  });

  it("the layout mounts the registrator", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("<PwaRegistrator />");
    expect(layout).toContain('from "@/components/pwa"');
  });
});

describe("global online/offline presentation (AppShell)", () => {
  const chrome = () => read("src/components/chrome.tsx");

  it("tracks navigator.onLine and both online/offline events", () => {
    const s = chrome();
    expect(s).toContain("navigator.onLine");
    expect(s).toContain('window.addEventListener("online"');
    expect(s).toContain('window.addEventListener("offline"');
    expect(s).toContain('window.removeEventListener("online"');
    expect(s).toContain('window.removeEventListener("offline"');
  });

  it("OFFLINE requires !navigator.onLine; DEGRADED requires online + failing health (no RTT)", () => {
    const s = chrome();
    expect(s).toContain('!online ? "OFFLINE"');
    expect(s).toContain('rttMs === null && connFails > 0 ? "DEGRADED"');
    // DEGRADED must not fire before the first health attempt
    expect(s).toContain("connFails");
  });

  it("the banner is an accessible status region and never color-only", () => {
    const s = chrome();
    expect(s).toContain('role="status"');
    expect(s).toContain('aria-live="polite"');
    // text labels, localized, plus an explicit cached-not-live statement
    expect(s).toContain('"offline"');
    expect(s).toContain('"degraded"');
    expect(s).toContain('t("conn", "cachedNotLive")');
    expect(s).toContain('t("conn", "lastContact")');
    expect(s).toContain('t("conn", "noNetwork")');
    expect(s).toContain('t("conn", "serverUnreachable")');
  });

  it("timestamps render LTR (RTL-safe) and are only shown when a contact was measured", () => {
    const s = chrome();
    expect(s).toContain('dir="ltr"');
    expect(s).toContain("lastReachableMs !== null");
  });

  it("SSR never shows a banner (server snapshot assumes online; client snapshot reads navigator.onLine)", () => {
    const s = chrome();
    expect(s).toContain("useSyncExternalStore(subscribeOnline, getOnline, getOnlineServer)");
    expect(s).toMatch(/function getOnlineServer\(\)[\s\S]{0,160}return true;/);
    expect(s).toMatch(/function getOnline\(\)[\s\S]{0,80}return navigator\.onLine;/);
  });
});
