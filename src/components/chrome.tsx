"use client";
/** Design-system chrome: header (TTT state + red RTT/ping), nav, footer. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useLang } from "./lang";
import { stateColor } from "./hooks";
import { FOOTER_EXACT } from "@/lib/i18n/strings";

const NAV = [
  { href: "/", key: "dashboard" },
  { href: "/market", key: "market" },
  { href: "/chart", key: "chart" },
  { href: "/opportunities", key: "opportunities" },
  { href: "/signals", key: "signals" },
  { href: "/ai-clone", key: "ai" },
  { href: "/backtest", key: "backtest" },
  { href: "/brain", key: "brain" },
  { href: "/psychology", key: "psychology" },
  { href: "/fundamental", key: "fundamental" },
  { href: "/research", key: "research" },
  { href: "/system", key: "system" },
  { href: "/settings", key: "settings" },
] as const;

interface HealthShape { ok: boolean; market: string; reason?: string; ts: number }

export function AppShell({ children }: { children: ReactNode }) {
  const { lang, setLang, t } = useLang();
  const path = usePathname();
  const [health, setHealth] = useState<HealthShape | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [tttState, setTttState] = useState<string>("CONNECTING");

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
      } catch {
        if (!dead) { setRttMs(null); setTttState("ERROR"); }
      }
    };
    void ping();
    const id = setInterval(() => void ping(), 10_000);
    return () => { dead = true; clearInterval(id); };
  }, []);

  const color = stateColor(tttState);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b hairline" style={{ background: "rgba(7,8,10,0.88)", backdropFilter: "blur(8px)" }}>
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
          <Link href="/" className="focus-ring flex items-baseline gap-2 rounded">
            <span className="gold-text text-lg font-bold tracking-[0.18em]">ASA</span>
            <span className="hidden text-[9px] uppercase tracking-[0.2em] text-dim sm:inline">advisory terminal · ttt only</span>
          </Link>
          <nav className="flex flex-1 flex-wrap items-center gap-0.5 overflow-x-auto" aria-label="sections">
            {NAV.map((n) => {
              const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
              return (
                <Link key={n.href} href={n.href} className={`focus-ring rounded px-2 py-1 text-[11.5px] font-medium tracking-wide whitespace-nowrap ${active ? "text-gold" : "text-muted hover:text-text"}`}>
                  {t("nav", n.key)}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-2 text-[10.5px]">
            {/* TTT state + measured client->server RTT (red) */}
            <span className="panel-2 flex items-center gap-1.5 px-2 py-1" title={`health: ${health?.reason ?? ""}`}>
              <span className="h-2 w-2 rounded-full" style={{ background: color, boxShadow: tttState === "LIVE" ? "0 0 6px rgba(63,182,139,0.9)" : "none" }} />
              <span style={{ color }} className="font-semibold uppercase tracking-wider">{tttState}</span>
              <span className="text-dim">·</span>
              <span className="font-mono" style={{ color: "#d9605e", fontWeight: 700 }}>
                {rttMs === null ? "--" : `${Math.round(rttMs)}ms`}
              </span>
            </span>
            <button
              className="focus-ring btn px-2 py-1"
              onClick={() => setLang(lang === "en" ? "fa" : "en")}
              aria-label="switch language"
            >
              {lang === "en" ? "فارسی" : "EN"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-3 py-3">{children}</main>

      <footer className="border-t hairline py-4 text-center">
        <p className="text-[13px]" style={{ color: "#d4b874" }}>{FOOTER_EXACT}</p>
        <p className="mt-1 text-[9.5px] uppercase tracking-[0.16em] text-dim">
          advisory only · AsA never executes · human executes
        </p>
      </footer>
    </div>
  );
}

export function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="text-[15px] font-semibold tracking-wide text-text">{title}</h1>
      {sub ? <p className="text-[11px] text-muted">{sub}</p> : null}
    </div>
  );
}
