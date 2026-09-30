"use client";
/** Language context: en/fa, RTL switching, persisted in localStorage. */
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { STRINGS, dirFor, type Lang, type StringKey } from "@/lib/i18n/strings";

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** namespace is type-checked against the string tables, so a page can never
   * reference a vocabulary that does not exist in BOTH languages. */
  t: (ns: StringKey, key: string) => string;
}
const Ctx = createContext<LangCtx>({ lang: "en", setLang: () => {}, t: () => "" });

const LANG_KEY = "asa-lang";
const langListeners = new Set<() => void>();

/** Read the browser preference only from the external-store snapshot. Keeping
 * the server snapshot at English makes hydration deterministic; the pre-paint
 * bootstrap in layout.tsx still prevents a visible language flash. */
function readLang(): Lang {
  if (typeof window === "undefined") return "en";
  try {
    const saved = window.localStorage.getItem(LANG_KEY);
    return saved === "fa" || saved === "en" ? saved : "en";
  } catch {
    return "en";
  }
}

function subscribeLang(listener: () => void): () => void {
  langListeners.add(listener);
  if (typeof window === "undefined") return () => { langListeners.delete(listener); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === LANG_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    langListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function setStoredLang(lang: Lang): void {
  try { window.localStorage.setItem(LANG_KEY, lang); } catch { /* private mode */ }
  langListeners.forEach((listener) => listener());
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const lang = useSyncExternalStore(subscribeLang, readLang, (): Lang => "en");
  const setLang = useCallback((next: Lang) => setStoredLang(next), []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dirFor(lang);
  }, [lang]);
  const t = useCallback(
    (ns: StringKey, key: string) => {
      const dict = STRINGS[lang] as unknown as Record<string, Record<string, string>>;
      const section = dict[ns] ?? {};
      return section[key] ?? (STRINGS.en as unknown as Record<string, Record<string, string>>)[ns]?.[key] ?? key;
    },
    [lang],
  );
  const value = useMemo(
    () => ({ lang, setLang, t }),
    [lang, setLang, t],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  return useContext(Ctx);
}
