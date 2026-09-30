"use client";
/**
 * Shared overlay language — Dialog / Drawer / Sheet / AdaptiveDrawer / Popover
 * over ONE focus + scroll discipline.
 * Palette, More sheet, detail drawers, market inspector and confirmation dialogs
 * all mount through here so there is exactly one focus behavior in AsA.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconClose } from "./icons";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

/** monotonic id so nested overlays (palette opened from within a sheet, etc.)
 * each own exactly one history entry and never fight over who consumes the
 * next back-button press. */
let overlayStackSeq = 0;

/** scroll-lock + focus trap + restore + Android/browser BACK BUTTON — mounted-only
 * overlays (reset-by-unmount). The close callback is kept in a ref so parent
 * re-renders do not tear down and recreate the trap. That used to move focus
 * back to the opener while typing or while a sheet updated its data.
 *
 * Back-button hierarchy (mission §54): opening ANY overlay pushes one history
 * entry tagged with its own id. Hardware/gesture back (popstate) closes the
 * topmost overlay instead of leaving the route — it never falls through to
 * normal browser history while something is open. Closing via Escape/backdrop
 * consumes that same entry (history.back()) so back-button and in-app close
 * stay perfectly symmetric and never leave an orphaned history slot behind. */
export function useOverlay(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const visibleFocusable = (): HTMLElement[] => {
      if (!ref.current) return [];
      return Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && !el.closest("[aria-hidden=\"true\"]");
      });
    };
    visibleFocusable()[0]?.focus();

    // --- back-button hierarchy -------------------------------------------
    // One history entry per overlay instance. A hardware/gesture back press
    // (or the browser back button) fires popstate, which closes THIS overlay
    // instead of leaving the route underneath it. Closing any other way
    // (Escape, backdrop tap, an explicit close button, a completed action)
    // just calls onClose() as before; the cleanup below then pops our own
    // now-unused history entry so it never lingers for a *later* back press.
    const overlayId = ++overlayStackSeq;
    let poppedByBack = false;
    try { window.history.pushState({ asaOverlay: overlayId }, ""); } catch { /* unavailable */ }
    const onPopState = (e: PopStateEvent) => {
      const state = e.state as { asaOverlay?: number } | null;
      if (state?.asaOverlay === overlayId) return; // navigated back onto our own entry
      poppedByBack = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCloseRef.current(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const items = visibleFocusable();
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
      items[next]?.focus();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPopState);
      document.body.style.overflow = prevOverflow;
      if (prev?.isConnected) prev.focus();
      // closed via UI (not the back button): consume our own history entry
      // so it doesn't sit there waiting to eat a future, unrelated back press.
      // Deferred one tick so a same-click navigation (e.g. a Link inside a
      // sheet) has already pushed its own entry before we decide whether the
      // top of the stack is still ours to pop.
      if (!poppedByBack) {
        setTimeout(() => {
          try {
            if ((window.history.state as { asaOverlay?: number } | null)?.asaOverlay === overlayId) {
              window.history.back();
            }
          } catch { /* noop */ }
        }, 0);
      }
    };
  }, []);
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

/** Modal alias for Dialog */
export const Modal = Dialog;

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

/** Drawer — desktop side drawer */
export function Drawer({ onClose, children, label, side = "end", width = "480px" }: { onClose: () => void; children: ReactNode; label: string; side?: "end" | "start"; width?: string }) {
  const ref = useOverlay(onClose);
  return (
    <div className="fixed inset-0" style={{ zIndex: "var(--z-drawer)" }} onMouseDown={onClose}>
      <div className="backdrop" aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-side={side}
        className={`drawer-panel absolute inset-y-0 ${side === "end" ? "end-0 border-s" : "start-0 border-e"} hairline max-w-[95vw] overflow-y-auto`}
        style={{ width, background: "var(--color-panel)", boxShadow: "var(--lift)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * AdaptiveDrawer — the definitive AsA drawer primitive:
 * Renders as a side drawer on desktop (respecting RTL/LTR start/end),
 * and as a bottom sheet with touch handle on mobile.
 */
export function AdaptiveDrawer({
  onClose,
  children,
  title,
  sub,
  badge,
  width = "500px",
}: {
  onClose: () => void;
  children: ReactNode;
  title: string;
  sub?: string;
  badge?: ReactNode;
  width?: string;
}) {
  // ONE trap container around BOTH breakpoint branches: on mobile the desktop
  // drawer is display:none, so a ref on the desktop branch alone left the sheet
  // with no focus trap, no focus restore and no initial focus. The outer wrapper
  // covers both; hidden-branch controls are filtered out by visibility.
  const ref = useOverlay(onClose);
  return (
    <div ref={ref} className="fixed inset-0" style={{ zIndex: "var(--z-drawer)" }} onMouseDown={onClose}>
      <div className="backdrop" aria-hidden />
      {/* Desktop side drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="drawer-panel absolute inset-y-0 end-0 hidden lg:flex flex-col border-s hairline max-w-[95vw] overflow-hidden"
        style={{ width, background: "var(--color-panel)", boxShadow: "var(--lift)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b hairline px-4 py-3 shrink-0">
          <div className="min-w-0 flex-1 pe-3">
            <div className="flex items-center gap-2">
              <h2 className="eyebrow gold-text truncate text-[12px] font-bold">{title}</h2>
              {badge}
            </div>
            {sub && <p className="mt-0.5 text-[10.5px] text-muted truncate" dir="auto">{sub}</p>}
          </div>
          <button className="focus-ring icon-btn" onClick={onClose} aria-label="close drawer">
            <IconClose size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>

      {/* Mobile bottom sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="absolute inset-x-0 bottom-0 max-h-[88vh] rounded-t-2xl border-t hairline flex flex-col lg:hidden overflow-hidden"
        style={{ background: "var(--color-panel)", animation: "asa-sheet-up var(--t-med) var(--ease-out) both", boxShadow: "var(--lift)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pt-2 pb-1 shrink-0 flex flex-col items-center">
          <div className="h-1 w-10 rounded-full" style={{ background: "var(--color-line-3)" }} aria-hidden />
        </div>
        <div className="flex items-center justify-between border-b hairline px-4 py-2.5 shrink-0">
          <div className="min-w-0 flex-1 pe-2">
            <div className="flex items-center gap-2">
              <h2 className="eyebrow gold-text truncate text-[11.5px] font-bold">{title}</h2>
              {badge}
            </div>
            {sub && <p className="mt-0.5 text-[10px] text-muted truncate" dir="auto">{sub}</p>}
          </div>
          <button className="focus-ring icon-btn" onClick={onClose} aria-label="close sheet">
            <IconClose size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 pb-[max(18px,env(safe-area-inset-bottom))]">{children}</div>
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

/** Popover primitive for menus / dropdowns */
export function Popover({
  trigger,
  children,
  align = "start",
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-block">
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div
          className={`panel absolute top-full mt-1.5 z-[var(--z-raised)] min-w-[180px] p-1.5 ${
            align === "end" ? "end-0" : "start-0"
          }`}
          style={{ animation: "asa-page-in var(--t-micro) var(--ease-out) both", boxShadow: "var(--lift)" }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
