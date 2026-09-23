/* AsA app-shell service worker (asa-shell-v1) — Team 04 (PWA/app-shell).
 *
 * TRUTHFULNESS CONTRACT (absolute):
 *   - /api/* is NEVER intercepted, cached or replayed. Market truth always
 *     comes from the live AsA server; when it is unreachable, the UI's
 *     offline/stale presentation (header banner + per-board freshness)
 *     handles it. This worker can never produce or serve market data.
 *   - Only same-origin GETs are handled:
 *       * document navigations → network-first, fallback to the last-seen
 *         cached shell, then a built-in honest offline page (503).
 *       * /_next/static/** (content-hashed, immutable) and small app assets
 *         (icons, manifest) → cache-first with background refresh + a cap.
 *   - Mutations (POST/…) and cross-origin requests pass through untouched.
 *   - No authenticated or private responses are cached.
 *
 * Caches are versioned; activate() purges every old "asa-shell-*" version.
 */
"use strict";

const VERSION = "asa-shell-v1";
const PAGE_CACHE = VERSION + "-pages";
const STATIC_CACHE = VERSION + "-static";
const MAX_PAGES = 12;
const MAX_STATIC = 80;

/* Honest offline fallback: no values, no simulation, both languages. */
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AsA — offline</title>
<style>
 body{background:#07080a;color:#e8e6e1;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
 .box{text-align:center;padding:2rem;max-width:36rem}
 .word{font-size:2rem;font-weight:700;letter-spacing:.18em;color:#d4b874}
 .badge{display:inline-block;margin:1rem 0;padding:.35rem .9rem;border:1px solid rgba(217,96,94,.4);border-radius:999px;color:#d9605e;font-weight:700;letter-spacing:.14em;font-size:.85rem}
 p{color:#8b8f99;font-size:.9rem;line-height:1.6;margin:.75rem 0}
 .fa{color:#5d616b;font-size:.8rem}
</style>
<script>try{if(localStorage.getItem("asa-lang")==="fa"){document.documentElement.lang="fa";document.documentElement.dir="rtl";}}catch(e){}</script>
</head>
<body>
<div class="box">
 <div class="word">ASA</div>
 <div class="badge">OFFLINE</div>
 <p>The AsA terminal could not reach its server, so no market data is available on this page. Nothing is simulated and no cached value is presented as live. Check the connection and reload.</p>
 <p class="fa">ترمینال AsA به سرور دسترسی ندارد؛ هیچ داده‌ای در این صفحه در دسترس نیست. هیچ مقداری شبیه‌سازی نمی‌شود و هیچ مقدار ذخیره‌شده به‌عنوان زنده ارائه نمی‌شود. اتصال را بررسی کرده و دوباره بارگذاری کنید.</p>
</div>
</body>
</html>`;

function sameOrigin(req) {
  try {
    return new URL(req.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

/** FIFO-ish eviction: drop the oldest entries beyond the cap. */
async function trimCache(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i + max < keys.length; i++) {
    await c.delete(keys[i]);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // Precache the shell root so the first offline navigation has a page.
      // Non-fatal: if it fails (offline at install time) the runtime cache
      // fills in as pages are visited.
      try {
        const c = await caches.open(PAGE_CACHE);
        await c.add("/");
      } catch {
        /* shell cache fills at runtime */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("asa-shell-") && n !== PAGE_CACHE && n !== STATIC_CACHE)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept mutations
  if (!sameOrigin(req)) return; // never intercept cross-origin
  const u = new URL(req.url);
  // Market truth: network only, always. The app's offline/stale UI states
  // (not this worker) are what a disconnected browser sees.
  if (u.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(handlePage(req, u));
    return;
  }
  if (u.pathname.startsWith("/_next/static/") || u.pathname === "/manifest.webmanifest" || u.pathname.startsWith("/icons/")) {
    event.respondWith(handleStatic(req));
  }
  /* everything else (SSE is under /api/, already passed through) is untouched */
});

async function handlePage(req, u) {
  try {
    const fresh = await fetch(req);
    if (fresh.ok) {
      const c = await caches.open(PAGE_CACHE);
      c.put(u.pathname, fresh.clone()).catch(() => {});
      void trimCache(PAGE_CACHE, MAX_PAGES);
    }
    return fresh;
  } catch {
    // Offline (or server unreachable): last-seen shell for this path, then
    // the cached root, then the built-in honest offline page. Never fake data.
    const c = await caches.open(PAGE_CACHE);
    const hit = (await c.match(req, { ignoreSearch: true })) || (await c.match(u.origin + "/")) || (await c.match("/"));
    if (hit) return hit;
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function handleStatic(req) {
  const c = await caches.open(STATIC_CACHE);
  const hit = await c.match(req);
  if (hit) {
    // Content-hashed assets are immutable; refresh in background for the
    // rare non-hashed case (manifest/icons), capped.
    fetch(req)
      .then((fresh) => {
        if (fresh && fresh.ok) return c.put(req, fresh.clone());
      })
      .catch(() => {});
    return hit;
  }
  const fresh = await fetch(req);
  if (fresh && fresh.ok) {
    c.put(req, fresh.clone()).catch(() => {});
    void trimCache(STATIC_CACHE, MAX_STATIC);
  }
  return fresh;
}
