"use client";
/**
 * Service-worker registration + PWA installation & update awareness.
 *
 * Requirements:
 * 1. The worker is an APP-SHELL cache (static assets + immutable bundles).
 *    /api/* is NEVER intercepted or cached; live market truth remains authoritative.
 * 2. Update awareness: Surfaces bilingual "نسخه جدید AsA آماده است" / "app shell updated"
 *    notice with reload action without interrupting active user workflows.
 * 3. Android Installation: Captures `beforeinstallprompt` event, detects standalone mode,
 *    and provides an install CTA with browser-specific instructions.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useLang } from "./lang";
import { IconSparkles, IconZap } from "./icons";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

function notifyInstallListeners() {
  installListeners.forEach((fn) => fn());
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notifyInstallListeners();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notifyInstallListeners();
  });
}

function subscribeInstall(cb: () => void) {
  installListeners.add(cb);
  return () => {
    installListeners.delete(cb);
  };
}

function getInstallSnapshot() {
  return deferredPrompt !== null;
}

function getInstallServer() {
  return false;
}

export function usePwaInstall() {
  const isInstallable = useSyncExternalStore(subscribeInstall, getInstallSnapshot, getInstallServer);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const isStandaloneMode =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as any).standalone === true;
    setIsStandalone(isStandaloneMode);
  }, []);

  const triggerInstall = async () => {
    if (!deferredPrompt) return false;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
      notifyInstallListeners();
      return choice.outcome === "accepted";
    } catch {
      return false;
    }
  };

  return { isInstallable, isStandalone, triggerInstall };
}

export function PwaRegistrator() {
  const { lang } = useLang();
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    let disposed = false;
    const register = () => {
      if (disposed) return;
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          if (disposed) return;
          const active = navigator.serviceWorker.controller;
          if (reg.waiting && active) setUpdated(true);
          reg.addEventListener("updatefound", () => {
            const nw = reg.installing;
            nw?.addEventListener("statechange", () => {
              if (
                nw.state === "activated" &&
                navigator.serviceWorker.controller &&
                active !== navigator.serviceWorker.controller
              ) {
                setUpdated(true);
              }
            });
          });
        })
        .catch(() => {
          /* non-fatal: offline shell optional */
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
      className="panel fixed bottom-3 z-50 flex items-center gap-2 px-3.5 py-2.5 text-[11.5px] font-medium shadow-2xl border-gold-3 start-3 end-3 sm:start-auto sm:end-3 sm:max-w-[420px]"
      style={{
        background: "var(--color-panel-2)",
        animation: "asa-dialog-in var(--t-med) var(--ease-spring) both",
      }}
    >
      <span className="h-2 w-2 rounded-full bg-[var(--color-up)] animate-ping" aria-hidden />
      <span className="flex-1" dir="auto">
        {lang === "fa" ? "نسخه جدید AsA آماده است" : "A newer AsA build is ready"}
      </span>
      <button
        className="focus-ring btn btn-gold !py-1 !px-2.5 text-[10.5px] font-bold"
        onClick={() => window.location.reload()}
      >
        {lang === "fa" ? "بارگذاری مجدد" : "Reload"}
      </button>
      <button
        className="focus-ring btn !py-1 !px-2 text-[10.5px]"
        onClick={() => setUpdated(false)}
        aria-label="dismiss update notice"
      >
        ✕
      </button>
    </div>
  ) : null;
}

export function PwaInstallBanner() {
  const { lang } = useLang();
  const { isInstallable, isStandalone, triggerInstall } = usePwaInstall();
  const [dismissed, setDismissed] = useState(false);

  if (isStandalone || !isInstallable || dismissed) return null;

  return (
    <div
      className="card mb-3 p-3 flex items-center justify-between gap-3 border-gold-3 bg-[rgba(216,188,120,0.06)]"
      dir="auto"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="grid h-8 w-8 place-items-center rounded-lg border border-gold-3 text-gold bg-gold-dim shrink-0">
          <IconSparkles size={16} />
        </span>
        <div className="min-w-0">
          <h4 className="text-xs font-bold text-text truncate">
            {lang === "fa" ? "نصب اپلیکیشن PWA ترمینال AsA" : "Install AsA Terminal PWA"}
          </h4>
          <p className="text-[10.5px] text-muted truncate">
            {lang === "fa"
              ? "دسترسی مستقیم و سریع از صفحه اصلی گوشی یا دسکتاپ"
              : "Fast, standalone terminal access on Android or desktop"}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={() => void triggerInstall()}
          className="focus-ring btn btn-gold !py-1 !px-2.5 text-xs font-bold"
        >
          <IconZap size={12} />
          <span>{lang === "fa" ? "نصب" : "Install"}</span>
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="focus-ring btn !py-1 !px-2 text-xs"
          aria-label="dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
