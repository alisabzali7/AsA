"use client";
/**
 * AsA application shell — the persistent frame around every route.
 *
 * Architecture of the frame (mission §14-16): desktop = fixed intelligence
 * rail (grouped, collapsible, per-device) + slim status topbar; mobile = top
 * bar + bottom navigation with a More sheet. The shell mounts ONCE and never
 * remounts across navigation — only <main> re-keys, so the living-data layer
 * (health axis, RTT, SSE-driven boards) and scroll context keep continuity.
 *
 * The connection axis is truth, not decoration: OFFLINE/DEGRADED banners,
 * last contact time, "cached data is not live" — all preserved semantics.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore, useState, type ReactNode } from "react";
import { useLang } from "./lang";
import { stateColor } from "./hooks";
import { NAV_GROUPS, MOBILE_PRIMARY, recordRecent } from "./nav";
import { densityPref, motionPref, railPref } from "./selection";
import { FOOTER_EXACT } from "@/lib/i18n/strings";
import { IconClose, IconCommandCenter, IconDensity, IconLang, IconSearch, IconSettings } from "./icons";
import { SheetClose, useOverlay } from "./overlay";

interface HealthShape { ok: boolean; market: string; reason?: string; ts: number }

/* Browser connectivity via useSyncExternalStore — the idiomatic React
 * subscription to external browser state (no setState-in-effect). */
function subscribeOnline(onStoreChange: () => void): () => void {
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);
  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}
function getOnline(): boolean {
  return navigator.onLine;
}
/** SSR snapshot: assume online so the offline banner never flashes on first
 *  paint; the client snapshot takes over immediately. */
function getOnlineServer(): boolean {
  return true;
}

export function openPalette() {
  window.dispatchEvent(new Event("asa:palette"));
}

export function AppShell({ children }: { children: ReactNode }) {
  const { lang, setLang, t } = useLang();
  const path = usePathname();
  const router = useRouter();
  const [health, setHealth] = useState<HealthShape | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [tttState, setTttState] = useState<string>("CONNECTING");
  const [connFails, setConnFails] = useState(0);
  const [lastReachableMs, setLastReachableMs] = useState<number | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const online = useSyncExternalStore(subscribeOnline, getOnline, getOnlineServer);
  const [density, setDensity] = densityPref.use();
  const [motion, setMotion] = motionPref.use();
  const [rail, setRail] = railPref.use();

  // remember destinations for the palette's RECENT group (device-owned)
  useEffect(() => { if (path) recordRecent(path); }, [path]);

  useEffect(() => {
    let dead = false;
    const ping = async () => {
      const s = performance.now();
      try {
        const r = await fetch("/api/system/health", { cache: "no-store" });
        const j = (await r.json()) as HealthShape;
        const ms = performance.now() - s;
        if (dead) return;
        setRttMs(ms);
        setHealth(j);
        setTttState(j.market);
        setConnFails(0);
        setLastReachableMs(Date.now());
      } catch {
        if (!dead) { setRttMs(null); setTttState("ERROR"); setConnFails((c) => c + 1); }
      }
    };
    void ping();
    const id = setInterval(() => void ping(), 10_000);
    return () => { dead = true; clearInterval(id); };
  }, []);

  const color = stateColor(tttState);

  /**
   * Connection state is a SEPARATE axis from market-data state (the TTT dot):
   * OFFLINE browser · DEGRADED network-up-but-server-silent · OK answered.
   * Text + shape, never color-only; timestamps stay LTR in RTL.
   */
  const connState: "OFFLINE" | "DEGRADED" | "OK" =
    !online ? "OFFLINE" : rttMs === null && connFails > 0 ? "DEGRADED" : "OK";

  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  return (
    <div id="asa-root" className="min-h-screen">
      <a href="#main" className="focus-ring sr-only z-50 rounded-md border px-3 py-1.5 text-[11px] focus:not-sr-only focus:absolute focus:start-3 focus:top-3" style={{ background: "var(--color-panel-2)" }}>
        Skip to content
      </a>

      {/* ---------------------------------------------------- desktop rail */}
      <aside className="asa-rail fixed inset-y-0 start-0 z-[var(--z-sticky)] hidden flex-col border-e hairline lg:flex" aria-label="primary navigation">
        <Link href="/" className="focus-ring flex h-12 items-center gap-2 border-b hairline px-3.5 rounded-none">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border text-[10px] font-black" style={{ borderColor: "var(--color-gold-3)", color: "var(--color-gold)", boxShadow: "inset 0 0 8px rgba(216,188,120,0.15)" }}>A</span>
          <span className="rail-label flex min-w-0 flex-col leading-none">
            <span className="gold-text text-[15px] font-bold tracking-[0.22em]">ASA</span>
            <span className="mt-1 text-[8px] uppercase tracking-[0.18em] text-dim">advisory terminal</span>
          </span>
        </Link>
        <nav className="flex-1 overflow-y-auto px-2 py-2" aria-label="sections">
          {NAV_GROUPS.map((g) => (
            <div key={g.id} className="mb-2.5">
              <p className="rail-label eyebrow px-2 pb-1">{lang === "fa" ? g.labelFa : g.label}</p>
              <ul className="space-y-0.5">
                {g.items.map((n) => {
                  const active = isActive(n.href);
                  const Icon = n.icon;
                  return (
                    <li key={n.href}>
                      <Link
                        href={n.href}
                        aria-current={active ? "page" : undefined}
                        className={`focus-ring rail-item w-full ${rail === "compact" ? "justify-center" : ""}`}
                        data-active={active}
                      >
                        <span className="tip shrink-0" tabIndex={-1}>
                          <Icon size={16} />
                          {rail === "compact" && <span role="tooltip" className="tip-body" dir="auto">{t("nav", n.key)}</span>}
                        </span>
                        <span className="rail-label min-w-0 truncate text-[11.5px] font-medium" dir="auto">{t("nav", n.key)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="rail-label space-y-1 border-t hairline p-2">
          <p className="text-[9px] leading-relaxed text-dim" lang="fa" dir="rtl">{FOOTER_EXACT}</p>
          <button
            className="focus-ring btn w-full justify-center !py-1 text-[9.5px]"
            onClick={() => setRail(rail === "expanded" ? "compact" : "expanded")}
            aria-pressed={rail === "compact"}
          >
            {rail === "expanded" ? <IconClose size={10} /> : <IconSettings size={10} />}
            <span>{rail === "expanded" ? "collapse rail" : "expand rail"}</span>
          </button>
        </div>
      </aside>

      {/* --------------------------------------------------- content column */}
      <div className="asa-main flex min-h-screen flex-col">
        <header className="sticky top-0 z-[var(--z-sticky)] border-b hairline" style={{ background: "color-mix(in srgb, var(--color-obsidian) 84%, transparent)", backdropFilter: "blur(10px) saturate(1.15)" }}>
          <div className="flex h-12 items-center gap-2 px-3">
            <Link href="/" className="focus-ring flex items-baseline gap-1.5 rounded lg:hidden">
              <span className="gold-text text-[15px] font-bold tracking-[0.18em]">ASA</span>
            </Link>
            <button
              className="focus-ring btn flex-1 justify-start gap-2 !py-1 lg:max-w-[340px] lg:flex-none"
              onClick={openPalette}
              aria-label="open command palette"
              aria-keyshortcuts="Meta+K Control+K"
            >
              <IconSearch size={13} />
              <span className="min-w-0 flex-1 truncate text-start text-[10.5px] font-normal text-dim">{t("palette", "placeholder")}</span>
              <kbd className="mono hidden rounded border px-1 text-[8.5px] text-dim lg:inline" style={{ borderColor: "var(--color-line-2)" }}>⌘K</kbd>
            </button>
            <div className="ms-auto flex items-center gap-1.5">
              {/* TTT truth + measured RTT — the only always-on pulse in the shell */}
              <button className="focus-ring panel-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] transition-colors hover:border-gold-3" onClick={() => router.push("/system")} title={health?.reason ? `health: ${health.reason}` : "open system status"}>
                <span className={`h-1.5 w-1.5 rounded-full ${tttState === "LIVE" ? "breathe" : ""}`} style={{ background: color, boxShadow: tttState === "LIVE" ? `0 0 6px ${color}` : "none" }} aria-hidden />
                <span className="font-bold uppercase tracking-wider" style={{ color }}>{tttState}</span>
                <span className="text-dim">·</span>
                <span className="mono iso font-bold" style={{ color: rttMs === null ? "var(--color-down)" : "var(--color-muted)" }}>
                  {rttMs === null ? "--" : `${Math.round(rttMs)}ms`}
                </span>
              </button>
              <button className="focus-ring icon-btn" onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")} aria-pressed={density === "compact"} title={`density: ${density}`}>
                <IconDensity size={14} />
              </button>
              <button className="focus-ring icon-btn text-[11px] font-bold" onClick={() => setLang(lang === "en" ? "fa" : "en")} aria-label="switch language">
                <span className="lg:hidden"><IconLang size={15} /></span>
                <span className="hidden lg:inline">{lang === "en" ? "فا" : "EN"}</span>
              </button>
              <button className="focus-ring icon-btn lg:hidden" onClick={() => setMoreOpen(true)} aria-label="more navigation" aria-haspopup="dialog" aria-expanded={moreOpen}>
                <IconCommandCenter size={15} />
              </button>
            </div>
          </div>
          {connState !== "OK" && (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-t hairline px-3 py-1.5 text-[10.5px] font-semibold tracking-wide"
              style={{
                color: connState === "OFFLINE" ? "var(--color-down)" : "var(--color-warn)",
                background: connState === "OFFLINE" ? "rgba(228,106,104,0.07)" : "rgba(223,168,79,0.07)",
              }}
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: "currentColor" }} />
              <span>{t("conn", connState === "OFFLINE" ? "offline" : "degraded")}</span>
              <span className="font-normal text-muted">
                {connState === "OFFLINE" ? t("conn", "noNetwork") : t("conn", "serverUnreachable")}
                {lastReachableMs !== null && (
                  <>{" · "}{t("conn", "lastContact")} <span dir="ltr" className="mono iso">{new Date(lastReachableMs).toLocaleTimeString("en-GB", { hour12: false })}</span></>
                )}
                {" · "}{t("conn", "cachedNotLive")}
              </span>
            </div>
          )}
        </header>

        {/* route transition: the shell persists, <main> re-keys per route —
            one entrance animation (opacity + 6px lift), no per-node storms */}
        <main id="main" key={path ?? "root"} className="page-enter mx-auto w-full max-w-[1560px] flex-1 px-3 pb-24 pt-3 lg:pb-6">
          {children}
        </main>

        <footer className="border-t hairline px-3 py-4 pb-[calc(64px+1rem)] text-center lg:pb-4">
          <p className="text-[13px]" style={{ color: "var(--color-gold-2)" }} lang="fa" dir="rtl">{FOOTER_EXACT}</p>
          <p className="mt-1 text-[9.5px] uppercase tracking-[0.16em] text-dim">
            advisory only · AsA never executes · human executes
            {motion === "reduced" ? " · reduced motion" : ""}
          </p>
        </footer>
      </div>

      {/* ------------------------------------------------------ mobile bottom nav */}
      <nav className="bnav fixed inset-x-0 bottom-0 z-[var(--z-sticky)] flex border-t hairline lg:hidden" style={{ background: "color-mix(in srgb, var(--color-ink) 92%, transparent)", backdropFilter: "blur(10px)" }} aria-label="primary mobile navigation">
        {NAV_GROUPS.flatMap((g) => g.items)
          .filter((n) => MOBILE_PRIMARY.includes(n.href))
          .map((n) => {
            const active = isActive(n.href);
            const Icon = n.icon;
            return (
              <Link key={n.href} href={n.href} className="focus-ring bnav-item" data-active={active} aria-current={active ? "page" : undefined}>
                <Icon size={18} />
                <span dir="auto">{t("nav", n.key)}</span>
              </Link>
            );
          })}
        <button className="focus-ring bnav-item" data-active={moreOpen} onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen} aria-label="more sections">
          <IconSettings size={18} />
          <span>More</span>
        </button>
      </nav>

      {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}
    </div>
  );
}

function MoreSheet({ onClose }: { onClose: () => void }) {
  const { lang, t } = useLang();
  const path = usePathname();
  const ref = useOverlay(onClose);
  const [motion, setMotion] = motionPref.use();
  const rest = NAV_GROUPS.flatMap((g) => g.items).filter((n) => !MOBILE_PRIMARY.includes(n.href));
  return (
    <div className="fixed inset-0 z-[var(--z-drawer)] lg:hidden" onMouseDown={onClose}>
      <div className="backdrop" aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="more sections"
        className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t hairline px-3 pb-[max(14px,env(safe-area-inset-bottom))] pt-2"
        style={{ background: "var(--color-panel)", animation: "asa-sheet-up var(--t-med) var(--ease-out) both" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-2 h-1 w-9 rounded-full" style={{ background: "var(--color-line-3)" }} aria-hidden />
        <div className="relative">
          <SheetClose onClose={onClose} label="close" />
          <p className="eyebrow pb-1">More sections</p>
          <ul className="grid grid-cols-2 gap-1.5">
            {rest.map((n) => {
              const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
              const Icon = n.icon;
              return (
                <li key={n.href}>
                  <Link href={n.href} onClick={onClose} className="focus-ring rail-item w-full" data-active={active} aria-current={active ? "page" : undefined}>
                    <Icon size={15} />
                    <span className="min-w-0 truncate text-[11px]" dir="auto">{t("nav", n.key)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="divider my-2.5" />
          <div className="flex items-center justify-between gap-2 pb-1">
            <p className="eyebrow">Device presentation</p>
            <div className="flex gap-1.5">
              <button className="focus-ring btn !py-0.5 text-[10px]" onClick={() => setMotion(motion === "reduced" ? "full" : "reduced")} aria-pressed={motion === "reduced"}>
                {motion === "reduced" ? "motion: reduced" : "motion: full"}
              </button>
            </div>
          </div>
          <p className="pb-1 text-[9px] leading-relaxed text-dim" lang="fa" dir="rtl">{FOOTER_EXACT}</p>
          <p className="pb-1 text-[8.5px] uppercase tracking-[0.14em] text-dim">{lang === "fa" ? "هشدار مشاوره" : "advisory only — never execution"}</p>
        </div>
      </div>
    </div>
  );
}

/** page header — the ONE title pattern every route shares */
export function PageHead({ title, sub, right, eyebrow }: { title: string; sub?: ReactNode; right?: ReactNode; eyebrow?: string }) {
  return (
    <div className="rise mb-2.5 flex flex-wrap items-end justify-between gap-x-3 gap-y-1.5">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow gold-text mb-0.5">{eyebrow}</p>}
        <h1 className="text-[16px] font-semibold tracking-wide" dir="auto">{title}</h1>
        {sub ? <p className="mt-0.5 max-w-[70ch] text-[11px] leading-snug text-muted" dir="auto">{sub}</p> : null}
      </div>
      {right && <div className="flex flex-wrap items-center gap-1.5">{right}</div>}
    </div>
  );
}
