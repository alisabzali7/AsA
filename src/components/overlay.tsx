"use client";
/**
 * Shared overlay language — Dialog / Drawer / Sheet over ONE focus + scroll
 * discipline. Palette, More sheet, detail drawers and confirmation dialogs
 * all mount through here so there is exactly one focus behavior in AsA.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { IconClose } from "./icons";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

/** scroll-lock + focus trap + restore — mounted-only overlays (reset-by-unmount) */
export function useOverlay(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
      items[next]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prev?.focus?.();
    };
  }, [onClose]);
  return ref;
}

/** center dialog — scale+fade entrance, backdrop close */
export function Dialog({ onClose, children, label, wide = false }: { onClose: () => void; children: ReactNode; label: string; wide?: boolean }) {
  const ref = useOverlay(onClose);
  return (
    <div className="fixed inset-0 flex items-start justify-center px-3 pt-[10vh]" style={{ zIndex: "var(--z-dialog)" }} onMouseDown={onClose}>
      <div className="backdrop" aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`panel relative w-full ${wide ? "max-w-[760px]" : "max-w-[520px]"} overflow-hidden`}
        style={{ animation: "asa-dialog-in var(--t-med) var(--ease-spring) both", boxShadow: "var(--lift)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** bottom sheet (mobile) / side drawer (desktop) — directional motion */
export function Sheet({ onClose, children, label, side = "end" }: { onClose: () => void; children: ReactNode; label: string; side?: "end" | "bottom" }) {
  const ref = useOverlay(onClose);
  if (side === "bottom") {
    return (
      <div className="fixed inset-0 lg:hidden" style={{ zIndex: "var(--z-drawer)" }} onMouseDown={onClose}>
        <div className="backdrop" aria-hidden />
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t hairline px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2"
          style={{ background: "var(--color-panel)", animation: "asa-sheet-up var(--t-med) var(--ease-out) both" }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="mx-auto mb-2 h-1 w-9 rounded-full" style={{ background: "var(--color-line-3)" }} aria-hidden />
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 hidden lg:block" style={{ zIndex: "var(--z-drawer)" }} onMouseDown={onClose}>
      <div className="backdrop" aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-side={side}
        className={`drawer-panel absolute inset-y-0 ${side === "end" ? "end-0 border-s" : "start-0 border-e"} hairline w-[440px] max-w-[92vw] overflow-y-auto`}
        style={{ background: "var(--color-panel)", boxShadow: "var(--lift)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function SheetClose({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button className="focus-ring icon-btn absolute top-2 end-2" onClick={onClose} aria-label={label}>
      <IconClose size={15} />
    </button>
  );
}
