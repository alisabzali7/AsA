"use client";
/** Language context: en/fa, RTL switching, persisted in localStorage. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { STRINGS, dirFor, type Lang } from "@/lib/i18n/strings";

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (ns: "nav" | "header" | "market" | "status" | "common" | "board" | "conn", key: string) => string;
}
const Ctx = createContext<LangCtx>({ lang: "en", setLang: () => {}, t: () => "" });

function initialLang(): Lang {
  if (typeof window === "undefined") return "en"; // SSR first paint
  try {
    const saved = localStorage.getItem("asa-lang");
    return saved === "fa" || saved === "en" ? saved : "en";
  } catch { /* private mode */ return "en"; }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dirFor(lang);
    try { localStorage.setItem("asa-lang", lang); } catch { /* ignore */ }
  }, [lang]);
  const t = useCallback(
    (ns: keyof typeof STRINGS.en, key: string) => {
      const dict = STRINGS[lang] as unknown as Record<string, Record<string, string>>;
      const section = dict[ns] ?? {};
      return section[key] ?? (STRINGS.en as unknown as Record<string, Record<string, string>>)[ns]?.[key] ?? key;
    },
    [lang],
  );
  const value = useMemo(
    () => ({ lang, setLang: setLangState, t }),
    [lang, t],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  return useContext(Ctx);
}
