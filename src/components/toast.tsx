"use client";
/**
 * AsA toast center — real operational events only (settings saves, journal
 * results, backtest completion, provider state). Enter from the inline-end
 * edge, stack with a cap, never auto-claim success: tones mirror what the
 * server actually said.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconAlert, IconCheck, IconClose, IconInfo } from "./icons";

export type ToastTone = "info" | "success" | "warn" | "error";
export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
  action?: { label: string; run: () => void };
}

const TONE: Record<ToastTone, { color: string; icon: typeof IconInfo }> = {
  info: { color: "var(--color-info)", icon: IconInfo },
  success: { color: "var(--color-up)", icon: IconCheck },
  warn: { color: "var(--color-warn)", icon: IconAlert },
  error: { color: "var(--color-down)", icon: IconAlert },
};

const Ctx = createContext<{ push: (t: Omit<Toast, "id">) => void }>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<(Toast & { life: number })[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
  }, []);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq.current;
    // errors linger longer than confirmations — recovery deserves reading time
    const life = t.tone === "error" ? 9000 : t.tone === "success" ? 4200 : 6000;
    setItems((xs) => [...xs.slice(-3), { ...t, id, life }]);
    timers.current.set(id, setTimeout(() => dismiss(id), life));
  }, [dismiss]);

  useEffect(() => () => { timers.current.forEach((t) => clearTimeout(t)); }, []);
  const value = useMemo(() => ({ push }), [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-label="notifications"
        className="pointer-events-none fixed bottom-[max(70px,calc(env(safe-area-inset-bottom)+12px))] end-3 z-[var(--z-toast)] flex w-[min(360px,calc(100vw-24px))] flex-col gap-1.5 lg:bottom-3"
      >
        {items.map((t) => {
          const tone = TONE[t.tone];
          const Icon = tone.icon;
          return (
            <div key={t.id} className="toast pointer-events-auto panel flex items-start gap-2 px-3 py-2" style={{ boxShadow: "var(--lift)" }}>
              <span className="mt-0.5 shrink-0" style={{ color: tone.color }}><Icon size={14} /></span>
              <div className="min-w-0 flex-1">
                <p className="text-[11.5px] font-semibold leading-snug" dir="auto">{t.title}</p>
                {t.body && <p className="mt-0.5 text-[10.5px] leading-snug text-muted" dir="auto">{t.body}</p>}
                {t.action && (
                  <button className="focus-ring btn mt-1.5 px-2 py-0.5 text-[10px]" onClick={() => { t.action?.run(); dismiss(t.id); }}>
                    {t.action.label}
                  </button>
                )}
              </div>
              <button className="focus-ring icon-btn !h-6 !min-w-6 !w-6" onClick={() => dismiss(t.id)} aria-label="dismiss notification">
                <IconClose size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() { return useContext(Ctx); }
