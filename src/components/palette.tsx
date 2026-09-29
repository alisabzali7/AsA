"use client";
/**
 * Command palette (⌘K / Ctrl+K) — a first-class product surface, not an addon.
 *
 * It is a NAVIGATOR, SELECTOR and DEVICE-ACTION runner only:
 *  · routes come from the shared NAV table (one source, no hardcoded lists)
 *  · symbols come from the REAL /api/market/symbols universe; when discovery
 *    has no answer, the palette says so — it never fabricates suggestions
 *  · actions touch real browser-owned state (language, density, motion,
 *    refresh bus). No placebo commands: every entry changes something true.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { NAV, readRecents, recordRecent } from "./nav";
import { useLang } from "./lang";
import { usePoll, stateColor } from "./hooks";
import { densityPref, motionPref, themePref, useSelection, SELECTION_KEY } from "./selection";
import { TIMEFRAMES } from "@/lib/domain/timeframes";
import { Dialog } from "./overlay";
import { IconAi, IconChart, IconChevron, IconDensity, IconLang, IconMoon, IconRefresh, IconSearch, IconSettings, IconSun, IconZap } from "./icons";

type Group = "recent" | "pages" | "symbols" | "timeframes" | "actions";
interface Entry {
  id: string;
  label: string;
  hint: string;
  group: Group;
  keywords?: string;
  run: () => void;
}

const GROUP_LABEL: Record<Group, string> = {
  recent: "Recent",
  pages: "Pages",
  symbols: "Symbols",
  timeframes: "Timeframes",
  actions: "Actions",
};
const ORDER: Group[] = ["recent", "pages", "symbols", "timeframes", "actions"];

/** small, honest scorer: prefix > word-start > contains > subsequence */
function score(q: string, text: string): number {
  if (!q) return 1;
  const s = text.toLowerCase();
  if (s.startsWith(q)) return 100;
  if (s.includes(` ${q}`)) return 80;
  if (s.includes(q)) return 60;
  let i = 0;
  for (const c of s) if (c === q[i]) i++;
  return i === q.length ? 30 : 0;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return <PaletteLauncher onOpen={() => setOpen(true)} />;
  }
  return <PaletteBody onClose={() => setOpen(false)} />;
}

/** global key handling lives OUTSIDE the dialog so ⌘K works on every route */
function PaletteLauncher({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpen();
      }
    };
    const onBus = () => onOpen();
    window.addEventListener("keydown", onKey);
    window.addEventListener("asa:palette", onBus);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("asa:palette", onBus);
    };
  }, [onOpen]);
  return null;
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const { t, lang, setLang } = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const [sel, setSel] = useSelection();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [density, setDensity] = densityPref.use();
  const [motion, setMotion] = motionPref.use();
  const [theme, setTheme] = themePref.use();
  const inputRef = useRef<HTMLInputElement>(null);

  // fetched when mounted (mounted == open): no background hammering
  const syms = usePoll<{ ok: boolean; symbols: string[]; discovery_complete?: boolean }>("/api/market/symbols", 120_000);
  const universe = useMemo(() => syms.data?.symbols ?? [], [syms.data]);
  const activeTf = sel.tf ?? "15m";

  const entries = useMemo<Entry[]>(() => {
    const go = (href: string, sym?: string) => () => {
      recordRecent(href);
      onClose();
      router.push(sym ? `${href}?symbol=${sym}` : href);
    };
    const recents = readRecents()
      .map((h) => NAV.find((n) => n.href === h))
      .filter((n): n is (typeof NAV)[number] => Boolean(n))
      .map((n): Entry => ({ id: `r:${n.href}`, label: t("nav", n.key), hint: n.en, group: "recent", run: go(n.href) }));
    const pages: Entry[] = NAV.map((n) => ({
      id: `p:${n.href}`,
      label: t("nav", n.key),
      hint: n.en,
      group: "pages",
      keywords: n.href,
      run: go(n.href),
    }));
    const symbols: Entry[] = universe.map((s) => ({
      id: `s:${s}`,
      label: s,
      hint: `open terminal on ${s}`,
      group: "symbols",
      run: go("/chart", s),
    }));
    // Timeframe switching — a terminal command, driven by the same selection
    // store the chart reads (one source of truth, no mirror state).
    const timeframes: Entry[] = TIMEFRAMES.map((f) => ({
      id: `tf:${f.id}`,
      label: `${f.id}${activeTf === f.id ? " · current" : ""}`,
      hint: `${f.minutes}m bars · TTT resolution ${f.tttResolution}`,
      group: "timeframes",
      keywords: `timeframe tf ${f.id} resolution ${f.tttResolution}`,
      run: () => {
        setSel({ tf: f.id });
        onClose();
        if (pathname !== "/chart") router.push("/chart");
      },
    }));
    const actions: Entry[] = [
      {
        id: "a:lang",
        label: lang === "en" ? t("palette", "langFa") : t("palette", "langEn"),
        hint: "switch the entire interface language",
        group: "actions",
        keywords: "language rtl ltr persian",
        run: () => { setLang(lang === "en" ? "fa" : "en"); onClose(); },
      },
      {
        id: "a:theme",
        label: theme === "dark" ? "Light theme" : "Dark theme",
        hint: "switch between obsidian dark and clean light mode",
        group: "actions",
        keywords: "theme dark light mode color",
        run: () => { setTheme(theme === "dark" ? "light" : "dark"); onClose(); },
      },
      {
        id: "a:intro",
        label: "Replay Cinematic Intro",
        hint: "watch 3D money tearing intro & Persian welcome",
        group: "actions",
        keywords: "intro animation welcome money 3d replay",
        run: () => {
          sessionStorage.removeItem("asa-intro-seen");
          window.dispatchEvent(new Event("asa:replay-intro"));
          onClose();
          router.push("/");
        },
      },
      {
        id: "a:density",
        label: density === "compact" ? "Comfortable density" : "Compact density",
        hint: "row rhythm across every table and panel",
        group: "actions",
        keywords: "ui rows",
        run: () => { setDensity(density === "compact" ? "comfortable" : "compact"); onClose(); },
      },
      {
        id: "a:motion",
        label: motion === "reduced" ? "Full motion" : "Reduce motion",
        hint: "device-level animation preference",
        group: "actions",
        keywords: "animation a11y",
        run: () => { setMotion(motion === "reduced" ? "full" : "reduced"); onClose(); },
      },
      {
        id: "a:refresh",
        label: "Refresh all data",
        hint: "re-ask every live endpoint now",
        group: "actions",
        keywords: "reload poll",
        run: () => { window.dispatchEvent(new Event("asa:refresh")); onClose(); },
      },
      {
        id: "a:chart",
        label: "Open terminal on current symbol",
        hint: "uses the cross-page selection",
        group: "actions",
        keywords: "chart symbol",
        run: () => {
          let sym: string | null = null;
          try {
            sym = (JSON.parse(localStorage.getItem(SELECTION_KEY) || "{}").symbol) ?? null;
          } catch { sym = null; }
          go("/chart", sym ?? undefined)();
        },
      },
    ];
    return [...recents, ...pages, ...symbols, ...timeframes, ...actions];
  }, [universe, activeTf, pathname, lang, density, motion, theme, t, setSel, setLang, setDensity, setMotion, setTheme, router, onClose]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase().replace(/^!/, "");
    const groupFilter = q.trim().startsWith("!") ? (q.trim().slice(1) ? ORDER.find((g) => g.startsWith(q.trim().slice(1).toLowerCase())) : undefined) : undefined;
    const scored = entries
      .map((e) => ({ e, s: Math.max(score(query, e.label), score(query, e.hint), score(query, e.keywords ?? "")) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.e);
    return groupFilter ? scored.filter((e) => e.group === groupFilter) : scored;
  }, [entries, q]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  // reset the cursor WITH the query event (no cascade effect needed)
  const onQuery = (v: string) => { setQ(v); setIdx(0); };

  const run = (e: Entry) => e.run();

  // grouped render when the query is empty, flat ranked list once typing
  const grouped = useMemo(() => {
    if (q.trim()) return [[null, filtered] as const];
    return ORDER.map((g) => [g, filtered.filter((e) => e.group === g)] as const).filter(([, xs]) => xs.length > 0);
  }, [filtered, q]);

  const flat = grouped.flatMap(([, xs]) => xs as Entry[]);

  return (
    <Dialog onClose={onClose} label="command palette" wide>
      <div
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => (flat.length ? (i + 1) % flat.length : 0)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0)); }
          else if (e.key === "Enter" && flat[idx]) { e.preventDefault(); run(flat[idx]); }
        }}
      >
        <div className="flex items-center gap-2 border-b hairline px-3">
          <span className="text-dim" aria-hidden><IconSearch size={15} /></span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={t("palette", "placeholder")}
            aria-label="command palette search"
            aria-controls="palette-results"
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            className="w-full border-0 bg-transparent py-3 text-sm outline-none placeholder:text-dim"
            style={{ background: "transparent" }}
          />
          <kbd className="mono rounded border px-1.5 py-0.5 text-[9px] text-dim" style={{ borderColor: "var(--color-line-2)" }}>ESC</kbd>
        </div>

        {universe.length === 0 && (
          <p className="border-b hairline bg-panel-2/60 px-3 py-1.5 text-[9.5px] text-dim" dir="auto" data-qa="palette-symbols-empty">
            {t("palette", "symbolsEmpty")}
          </p>
        )}
        <ul id="palette-results" role="listbox" aria-label="results" className="max-h-[46vh] overflow-y-auto p-1.5">
          {flat.length === 0 && (
            <li className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
              <span className="text-dim" aria-hidden><IconZap size={18} /></span>
              <p className="text-[11.5px] text-muted" dir="auto">
                {q.trim() ? <>no match for <span className="mono text-gold">“{q.trim()}”</span></> : "type to search routes, symbols and actions"}
              </p>
              {syms.status !== "OK" && (
                <p className="max-w-[40ch] text-[10px] leading-snug text-dim" dir="auto">
                  symbol universe is {syms.status.toLowerCase()}
                  {syms.failure ? ` — ${syms.failure.message}` : syms.data?.discovery_complete === false ? " — discovery has returned no symbols yet" : ""}
                </p>
              )}
            </li>
          )}
          {grouped.map(([group, xs]) => (
            <li key={group ?? "flat"} role="group">
              {group && <p className="eyebrow px-2 pb-1 pt-2">{GROUP_LABEL[group]}</p>}
              <ul>
                {(xs as Entry[]).map((e) => {
                  const i = flat.indexOf(e);
                  const active = i === idx;
                  return (
                    <li key={e.id}>
                      <button
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => setIdx(i)}
                        onClick={() => run(e)}
                        className={`focus-ring flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start transition-colors duration-[var(--t-micro)] ${active ? "btn-active" : "hover:bg-panel-2"}`}
                      >
                        <span className="shrink-0 text-dim" aria-hidden>
                          {e.group === "symbols" ? <IconChart size={13} /> : e.group === "actions" ? <IconSettings size={13} /> : <IconAi size={13} />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px]" dir="auto">{e.label}</span>
                        <span className="hidden max-w-[36%] truncate text-[9.5px] text-dim sm:block" dir="auto">{e.hint}</span>
                        {active && <span className="text-dim" aria-hidden><IconChevron size={11} /></span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t hairline px-3 py-1.5 text-[9px] text-dim">
          <span className="flex items-center gap-2">
            <span><kbd className="mono">↑↓</kbd> select</span>
            <span><kbd className="mono">↵</kbd> run</span>
            <span><kbd className="mono">!pages / !symbols</kbd> filter</span>
          </span>
          <span className="flex items-center gap-2.5">
            <span className="flex items-center gap-1"><IconDensity size={10} /> {density}</span>
            <span className="flex items-center gap-1"><IconLang size={10} /> {lang}</span>
            <span className="flex items-center gap-1"><IconRefresh size={10} /> universe: <span style={{ color: stateColor(syms.status === "OK" ? "READY" : syms.status) }} className="font-bold">{syms.status}</span></span>
          </span>
        </div>
      </div>
    </Dialog>
  );
}
