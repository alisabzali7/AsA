"use client";
/**
 * Service-worker registration + honest update awareness — production only.
 *
 * The worker is an APP-SHELL cache (static assets + last-seen HTML). It never
 * intercepts /api/*, so registering it cannot create fake live market data;
 * disconnection is presented by the UI's online/offline/stale states instead.
 *
 * Update awareness: the worker self-skips, so when a NEW build takes
 * control we surface a visible "shell updated" notice with a reload action —
 * the user decides; the page never silently reloads mid-interaction and the
 * notice never claims the app is "live" (market truth is the server's).
 *
 * Dev is intentionally excluded: an SW during HMR causes confusing stale
 * chunks. The app is fully functional without the SW (no offline shell).
 */
import { useEffect, useState } from "react";

export function PwaRegistrator() {
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return; // older/mobile browsers: no-op
    let disposed = false;
    const register = () => {
      if (disposed) return;
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((reg) => {
        if (disposed) return;
        // a `waiting` worker means a new shell exists; this build declares
        // skipWaiting, so claim() happens automatically — listening for a
        // controller CHANGE (not just first control) is the update signal.
        const active = navigator.serviceWorker.controller;
        if (reg.waiting && active) setUpdated(true);
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          nw?.addEventListener("statechange", () => {
            if (nw.state === "activated" && navigator.serviceWorker.controller && active !== navigator.serviceWorker.controller) {
              setUpdated(true);
            }
          });
        });
      }).catch(() => {
        /* non-fatal: the terminal works without the app-shell cache */
      });
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => {
      disposed = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return updated ? (
    <div
      role="status"
      aria-live="polite"
      className="panel fixed bottom-3 z-50 flex items-center gap-2 px-3 py-2 text-[11px] ltr:right-3 rtl:left-3"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-up)]" aria-hidden />
      <span>app shell updated by a newer build</span>
      <button className="focus-ring btn px-2 py-0.5 text-[10px]" onClick={() => window.location.reload()}>
        reload now
      </button>
      <button className="focus-ring btn px-2 py-0.5 text-[10px]" onClick={() => setUpdated(false)} aria-label="dismiss update notice">
        later
      </button>
    </div>
  ) : null;
}
