/**
 * Centralized i18n (fa + en). Labels live here, not inline in components.
 * Persisted user language lives server-side in DB config (lang) and is
 * served by /api/system/config; the header toggle switches via that API.
 * The footer tagline is EXACT per product requirement in every language.
 */
export type Lang = "en" | "fa";

export const FOOTER_EXACT =
  "«سلام علی به شرکت چاپ پول تک نفره ات خوش اومدی»";

export const STRINGS = {
  en: {
    appName: "AsA",
    nav: {
      dashboard: "Command Center",
      market: "Market",
      chart: "Terminal",
      opportunities: "Opportunities",
      signals: "Signals",
      ai: "AI Clone",
      backtest: "Backtest",
      brain: "Brain",
      psychology: "Psychology",
      fundamental: "Fundamental",
      research: "Research",
      system: "System",
      settings: "Settings",
    },
    header: { status: "status", rtt: "ping", lang: "EN" },
    market: {
      symbol: "Symbol",
      price: "Price",
      change24h: "24h",
      funding: "Funding",
      oi: "Open Interest",
      volume: "Vol 24h",
      age: "age",
      live: "LIVE",
      stale: "STALE",
      connecting: "CONNECTING",
      unavailable: "UNAVAILABLE",
      lastUpdate: "last update",
    },
    board: { title: "TTT Market Universe", subtitle: "TTT /futures/markets/stats — one request per sweep" },
    status: {
      CONNECTING: "connecting",
      CONNECTED: "connected",
      LIVE: "live",
      DEGRADED: "degraded",
      STALE: "stale",
      UNAVAILABLE: "unavailable",
      NOT_CONFIGURED: "not configured",
      INSUFFICIENT_DATA: "insufficient data",
      ERROR: "error",
      READY: "ready",
      REJECTED: "rejected",
      COOLDOWN: "cooldown",
      IDLE: "idle",
    },
    footer: FOOTER_EXACT,
    common: {
      measured: "MEASURED",
      derived: "DERIVED",
      proxy: "PROXY",
      unverified: "UNVERIFIED",
      unavailable: "UNAVAILABLE",
      source: "source",
      endpoint: "endpoint",
      age: "age",
      ms: "ms",
      seconds: "s",
      minutes: "min",
      hours: "h",
      refresh: "refresh",
      focus: "focus",
      strategy: "strategy",
      provider: "provider",
      model: "model",
      noData: "no data",
    },
  },
  fa: {
    appName: "آسا",
    nav: {
      dashboard: "فرماندهی",
      market: "بازار",
      chart: "ترمینال",
      opportunities: "فرصت‌ها",
      signals: "سیگنال‌ها",
      ai: "کلون هوش مصنوعی",
      backtest: "بک‌تست",
      brain: "مغز دانش",
      psychology: "روانشناسی",
      fundamental: "بنیادی",
      research: "پژوهش",
      system: "سیستم",
      settings: "تنظیمات",
    },
    header: { status: "وضعیت", rtt: "پینگ", lang: "FA" },
    market: {
      symbol: "نماد",
      price: "قیمت",
      change24h: "۲۴ ساعت",
      funding: "فاندینگ",
      oi: "باز بودن قرارداد",
      volume: "حجم ۲۴ س",
      age: "قدمت",
      live: "زنده",
      stale: "منسوخ",
      connecting: "در حال اتصال",
      unavailable: "در دسترس نیست",
      lastUpdate: "آخرین به‌روزرسانی",
    },
    board: { title: "جهان بازار TTT", subtitle: "TTT — یک درخواست در هر چرخه" },
    status: {
      CONNECTING: "در حال اتصال",
      CONNECTED: "متصل",
      LIVE: "زنده",
      DEGRADED: "کاهش یافته",
      STALE: "منسوخ",
      UNAVAILABLE: "در دسترس نیست",
      NOT_CONFIGURED: "پیکربندی نشده",
      INSUFFICIENT_DATA: "داده ناکافی",
      ERROR: "خطا",
      READY: "آماده",
      REJECTED: "رد شد",
      COOLDOWN: "در انتظار",
      IDLE: "آزاد",
    },
    footer: FOOTER_EXACT,
    common: {
      measured: "اندازه‌گیری شده",
      derived: "مشتق",
      proxy: "نماینده",
      unverified: "تأییدنشده",
      unavailable: "در دسترس نیست",
      source: "منبع",
      endpoint: "نقطه پایانی",
      age: "قدمت",
      ms: "م.ث",
      seconds: "ثانیه",
      minutes: "دقیقه",
      hours: "ساعت",
      refresh: "تازه‌سازی",
      focus: "تمرکز",
      strategy: "استراتژی",
      provider: "ارائه‌دهنده",
      model: "مدل",
      noData: "بدون داده",
    },
  },
} as const;

export type StringKey = keyof typeof STRINGS["en"];

/** fa digit/format helpers. */
export function formatNum(n: number | null | undefined, digits = 2, faDigits = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const s = n.toLocaleString("en-US", { maximumFractionDigits: digits });
  if (!faDigits) return s;
  const map: Record<string, string> = { "0": "۰", "1": "۱", "2": "۲", "3": "۳", "4": "۴", "5": "۵", "6": "۶", "7": "۷", "8": "۸", "9": "۹" };
  return s.replace(/[0-9]/g, (d) => map[d]);
}

export function fmtAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function dirFor(lang: Lang): "rtl" | "ltr" {
  return lang === "fa" ? "rtl" : "ltr";
}
