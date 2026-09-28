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
      strategies: "Strategies",
      ai: "AI Clone",
      ai_analysis: "AI Analysis",
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
    conn: {
      offline: "OFFLINE",
      degraded: "CONNECTION DEGRADED",
      noNetwork: "no network connection",
      serverUnreachable: "AsA server unreachable",
      lastContact: "last contact",
      cachedNotLive: "values on screen are cached — not live",
      providerStatusUnavailable: "provider status unavailable — last received status is shown",
      questionNotSent: "question not sent — no answer is fabricated",
    },
    state: {
      loading: "request in flight — no authoritative answer yet",
      unavailable: "UNAVAILABLE — the backend says this data is not available right now",
      error: "request failed unexpectedly",
      offline: "browser offline — nothing was received, nothing is faked",
      empty: "the backend answered: nothing stored",
      retry: "retry now",
      cachedFor: "cached",
      notLive: "not live",
      serverDown: "AsA server did not answer — values shown are the last received snapshot",
    },
    palette: {
      open: "Command palette",
      placeholder: "Jump to a page, symbol or action…",
      pages: "Pages",
      symbols: "Open on the chart (real TTT universe)",
      actions: "Actions",
      noMatch: "nothing matches — the palette only knows real routes and the live universe",
      symbolsEmpty: "no symbols yet — the TTT universe has not been discovered",
      langEn: "Switch to English (LTR)",
      langFa: "تغییر به فارسی (RTL)",
    },
    ai: {
      context: "Deterministic context",
      contextNote: "authoritative — shown verbatim; the explanation layer cannot change it",
      explanation: "Explanation",
      footnote:
        "The deterministic context is measured state, shown verbatim. When an LLM provider is configured and online it adds an explanation that may only restate that context — it never changes it, overrides a risk gate or NO TRADE, or invents data. Without a provider — or when the LLM fails — you get the deterministic assembly only, labeled as such. AsA is advisory only; it never executes.",
    },
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
      strategies: "استراتژی‌ها",
      ai: "کلون هوش مصنوعی",
      ai_analysis: "تحلیل هوش مصنوعی",
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
    conn: {
      offline: "آفلاین",
      degraded: "اتصال ضعیف",
      noNetwork: "اتصال شبکه قطع است",
      serverUnreachable: "سرور AsA در دسترس نیست",
      lastContact: "آخرین تماس",
      cachedNotLive: "مقادیر روی صفحه از حافظهٔ پویا هستند — زنده نیستند",
      providerStatusUnavailable: "وضعیت ارائه‌دهنده‌ها در دسترس نیست — آخرین وضعیت دریافت‌شده نمایش داده می‌شود",
      questionNotSent: "پرسش ارسال نشد — پاسخی ساختگی داده نمی‌شود",
    },    state: {
      loading: "درخواست در حال انجام — هنوز پاسخ حاکمی دریافت نشده است",
      unavailable: "در دسترس نیست — سرور می‌گوید این داده فعلاً موجود نیست",
      error: "درخواست با خطای غیرمنتظره شکست خورد",
      offline: "مرورگر آفلاین است — چیزی دریافت نشده و چیزی جعل نمی‌شود",
      empty: "پاسخ موفق سرور: هیچ موردی ذخیره نشده است",
      retry: "تلاش دوباره",
      cachedFor: "در حافظهٔ پویا از",
      notLive: "زنده نیست",
      serverDown: "سرور AsA پاسخ نداده — مقادیر نشان‌داده‌شده آخرین اسنپ‌شات دریافتی‌اند",
    },
    palette: {
      open: "پالت دستور",
      placeholder: "برو به صفحه، نماد یا دستور…",
      pages: "صفحه‌ها",
      symbols: "باز کردن در ترمینال (جهان واقعی TTT)",
      actions: "دستورها",
      noMatch: "هیچ تطابقی نیست — پالت فقط مسیرهای واقعی و جهان زنده را می‌شناسد",
      symbolsEmpty: "هنوز نمادی نیست — جهان TTT کشف نشده است",
      langEn: "تغییر به English (LTR)",
      langFa: "تغییر به فارسی (RTL)",
    },

    ai: {
      context: "زمینهٔ قطعی",
      contextNote: "حاکم است — دقیقاً همان‌طور که اندازه‌گیری شده نمایش داده می‌شود؛ لایهٔ توضیح نمی‌تواند آن را تغییر دهد",
      explanation: "توضیح",
      footnote:
        "زمینهٔ قطعی، حالت اندازه‌گیری‌شده است و بدون تغییر نمایش داده می‌شود. اگر ارائه‌دهندهٔ LLM پیکربندی و آنلاین باشد، توضیحی افزوده می‌شود که فقط می‌تواند همان زمینه را بازنویسی کند — نه تغییر آن، نه نادیده گرفتن درگاه ریسک یا NO TRADE، و نه اختراع داده. بدون ارائه‌دهنده، یا در صورت شکست LLM، فقط مجموعهٔ قطعی با برچسب مشخص نمایش داده می‌شود. AsA فقط مشورتی است و هیچ‌گاه اجرا نمی‌کند.",
    },
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
