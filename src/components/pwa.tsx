"use client";
/**
 * Service-worker registration — production only.
 *
 * The worker is an APP-SHELL cache (static assets + last-seen HTML). It never
 * intercepts /api/*, so registering it cannot create fake live market data;
 * disconnection is presented by the UI's online/offline/stale states instead.
 *
 * Dev is intentionally excluded: an SW during HMR causes confusing stale
 * chunks. The app is fully functional without the SW (no offline shell).
 */
import { useEffect } from "react";

export function PwaRegistrator() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return; // older/mobile browsers: no-op
    let disposed = false;
    const register = () => {
      if (disposed) return;
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
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
  return null;
}
