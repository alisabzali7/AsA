/**
 * Deep knowledge-atom mining (§B1, §B2).
 *
 * The original extraction was marker-driven: it only saw blocks introduced by
 * `نام استراتژی:` and similar field labels. That found 87 strategy declarations
 * but ignored the far larger body of NARRATIVE teaching — 969 "اگر" (if),
 * 1193 "باید" (must), 1182 "ورود" (entry) occurrences that encode real rules.
 *
 * This layer is ADDITIVE. It never mutates the existing corpus ingestion; it
 * reads the already-persisted `source_fragments` and derives a second, richer
 * knowledge graph on top of them.
 *
 * GOVERNANCE: an atom records what the SOURCE SAYS and where. It never invents
 * a threshold, and a qualitative phrase stays qualitative.
 */
import type { SourceRef, SourceStatus } from "../types";

/** What kind of knowledge a sentence carries. */
export type AtomKind =
  | "CONDITION"        // اگر / وقتی / در صورتی — an if-clause
  | "OBLIGATION"       // باید — a must
  | "PROHIBITION"      // نباید — a must-not
  | "ENTRY"            // entry behaviour
  | "EXIT"             // exit behaviour
  | "INVALIDATION"     // analysis-void behaviour
  | "FILTER"           // a precondition that gates trading
  | "CONTEXT"          // higher-timeframe / regime framing
  | "LOCATION"         // where price must be
  | "TRIGGER"          // the event that fires
  | "CONFIRMATION"     // corroborating evidence
  | "STOP_MODEL"
  | "TARGET_MODEL"
  | "RISK"
  | "PSYCHOLOGY"
  | "SECURITY"
  | "PROCESS"
  | "EXAMPLE"          // an illustration, NOT a rule
  | "CLAIM"
  | "NARRATIVE";       // prose with no actionable content

/** Can the sentence become machine-executable? (§D) */
export type SemanticStatus =
  | "EXPLICIT_COMPUTABLE"      // names a feature AND a comparable quantity
  | "EXPLICIT_NON_COMPUTABLE"  // clear instruction, but qualitative wording
  | "INFERRED"
  | "UNKNOWN"
  | "CLAIM"
  | "CONFLICT";

export interface KnowledgeAtom {
  atom_id: string;
  file_id: string;
  line: number;
  text: string;
  kind: AtomKind;
  semantic_status: SemanticStatus;
  source_status: SourceStatus;
  /** canonical concepts the sentence references (rsi, prz, order-block, …) */
  concepts: string[];
  /** numeric quantities actually present in the source text */
  quantities: { raw: string; value: number; unit: string | null }[];
  /** timeframes named in the sentence */
  timeframes: string[];
  direction: "long" | "short" | "both" | "none";
  /** why it is not computable, when applicable */
  non_computable_reason: string | null;
  source_refs: SourceRef[];
}

/* ------------------------------------------------------------- lexicons */

/** Persian/English cue phrases, verified present in the corpus. */
const CUES: { kind: AtomKind; patterns: RegExp[] }[] = [
  { kind: "PROHIBITION", patterns: [/نباید/, /نکنید/, /خودداری/, /ممنوع/, /اجتناب/] },
  { kind: "INVALIDATION", patterns: [/باطل/, /فیلد شدن/, /نقض/, /تحلیل.{0,12}باطل/, /invalidat/i] },
  { kind: "ENTRY", patterns: [/شرایط ورود/, /ورود به معامله/, /نقطه ورود/, /Buy Limit/i, /Sell Limit/i, /Market Buy/i, /Market Sell/i] },
  { kind: "EXIT", patterns: [/شرایط خروج/, /خروج از معامله/, /بستن پوزیشن/, /Take Profit/i, /حد سود/] },
  { kind: "STOP_MODEL", patterns: [/استاپ لاس/, /حد ضرر/, /Stop Loss/i, /SL\b/] },
  { kind: "TARGET_MODEL", patterns: [/تارگت/, /هدف قیمتی/, /TP\d?\b/] },
  { kind: "CONFIRMATION", patterns: [/تأیید/, /تاییدیه/, /confirm/i, /کندل تایید/] },
  { kind: "FILTER", patterns: [/فیلتر/, /شرط لازم/, /پیش‌نیاز/, /شرایط لازم/] },
  { kind: "CONTEXT", patterns: [/تایم.?فریم بالاتر/, /روند کلی/, /Big Picture/i, /مولتی.?تایم/] },
  { kind: "LOCATION", patterns: [/ناحیه/, /سطح/, /محدوده/, /PRZ/, /حمایت/, /مقاومت/] },
  { kind: "TRIGGER", patterns: [/شکست/, /برخورد/, /لمس/, /نفوذ/, /break/i] },
  { kind: "RISK", patterns: [/ریسک/, /مدیریت سرمایه/, /حجم پوزیشن/, /لوریج/, /leverage/i, /درصد.{0,10}سرمایه/] },
  { kind: "PSYCHOLOGY", patterns: [/روان.?شناسی/, /احساس/, /ترس/, /طمع/, /استرس/, /پنیک/, /صبر/, /نظم/, /انضباط/] },
  { kind: "SECURITY", patterns: [/امنیت/, /رمز عبور/, /2FA/i, /هک/, /کیف پول/] },
  { kind: "PROCESS", patterns: [/ژورنال/, /بازبینی/, /چک.?لیست/, /تمرین/, /روتین/] },
  { kind: "EXAMPLE", patterns: [/برای مثال/, /به عنوان مثال/, /مثلا/, /مثال‌های مدرس/, /فرض کنید/] },
  { kind: "OBLIGATION", patterns: [/باید/, /لازم است/, /حتماً/] },
  // NOTE: JS \b is ASCII-only and NEVER matches at a Persian-script boundary,
  // so /\bاگر\b/ silently matched nothing. Use explicit delimiters instead.
  { kind: "CONDITION", patterns: [/(?:^|[\s،.:؛("'])اگر(?=[\s،.:؛)"']|$)/, /وقتی/, /زمانی که/, /در صورتی/, /هنگامی/] },
];

/** Canonical trading concepts, mapped from the vocabulary actually used. */
const CONCEPTS: { id: string; patterns: RegExp[] }[] = [
  { id: "rsi", patterns: [/RSI/i, /آر.?اس.?آی/, /اشباع/] },
  { id: "macd", patterns: [/MACD/i, /مکدی/] },
  { id: "moving-average", patterns: [/مووینگ/, /میانگین متحرک/, /\bEMA\b/i, /\bSMA\b/i] },
  { id: "ichimoku", patterns: [/ایچیموکو/i, /Ichimoku/i, /کومو/] },
  { id: "fibonacci", patterns: [/فیبوناچی/, /فیبو/, /Fibonacci/i, /618|382|786/] },
  { id: "prz", patterns: [/PRZ/i, /ناحیه بازگشت/, /پتانسیل بازگشت/] },
  // NOTE: bare «حمایت» also means "support" in the social/economic sense
  // ("بازوی حمایتی"). Require a TRADING context word so income/economics prose
  // is not mined as a price level.
  { id: "support-resistance", patterns: [/(?:سطح|خط|ناحیه|محدوده)\s*حمایت/, /(?:سطح|خط|ناحیه|محدوده)\s*مقاومت/, /حمایت(?:ی)?\s*(?:و\s*مقاومت|قیمت)/, /\bsupport\s*(?:level|zone|line)/i, /\bresistance\s*(?:level|zone|line)/i, /مقاومت(?:ی)?\s*(?:قیمت|چارت)/] },
  { id: "order-block", patterns: [/اردر بلاک/, /Order Block/i, /\bOB\b/] },
  { id: "rejection-block", patterns: [/رجکشن بلاک/, /Rejection Block/i] },
  { id: "fvg", patterns: [/\bFVG\b/i, /imbalance/i, /عدم تعادل/, /گپ قیمتی/] },
  { id: "bos", patterns: [/\bBOS\b/i, /شکست ساختار/] },
  { id: "choch", patterns: [/CHOCH/i, /چنج آف کرکتر/, /تغییر کرکتر/, /\bQM\b/] },
  { id: "market-structure", patterns: [/ساختار بازار/, /سقف و کف/, /پیوت/] },
  { id: "candlestick", patterns: [/کندل/, /candle/i, /شدو/, /بدنه/] },
  { id: "pinbar", patterns: [/پین.?بار/, /Pin.?bar/i] },
  { id: "engulfing", patterns: [/اینگالف/, /پوشا/, /engulf/i] },
  { id: "divergence", patterns: [/واگرایی/, /دایورجنس/, /divergence/i] },
  { id: "harmonic", patterns: [/هارمونیک/, /harmonic/i, /AB=CD/i, /گارتلی/] },
  { id: "elliott", patterns: [/الیوت/, /Elliott/i, /موج شماری/] },
  { id: "wyckoff", patterns: [/وایکوف/, /Wyckoff/i] },
  { id: "trend", patterns: [/روند/, /trend/i, /صعودی/, /نزولی/] },
  { id: "range", patterns: [/رنج/, /محدوده نوسان/, /سایدوی/] },
  { id: "breakout", patterns: [/بریک.?اوت/, /breakout/i, /شکست سطح/] },
  { id: "retest", patterns: [/ریتست/, /پولبک/, /retest/i, /اصلاح/] },
  { id: "volume", patterns: [/حجم/, /volume/i] },
  { id: "liquidity", patterns: [/نقدینگی/, /liquidity/i, /استاپ هانت/] },
  { id: "round-number", patterns: [/اعداد رند/, /عدد روانی/, /ناحیه روانی/] },
  { id: "leverage", patterns: [/لوریج/, /اهرم/, /leverage/i] },
  { id: "position-sizing", patterns: [/حجم پوزیشن/, /سایز پوزیشن/, /مدیریت سرمایه/] },
  { id: "risk-free", patterns: [/ریسک.?فری/, /risk.?free/i, /سر به سر/] },
  { id: "news", patterns: [/اخبار/, /فاندامنتال/, /news/i] },
];

const TF_PATTERNS: { tf: string; patterns: RegExp[] }[] = [
  { tf: "1m", patterns: [/۱ دقیقه|1 دقیقه|یک دقیقه|1m\b/i] },
  { tf: "5m", patterns: [/۵ دقیقه|5 دقیقه|پنج دقیقه|5m\b/i] },
  { tf: "15m", patterns: [/۱۵ دقیقه|15 دقیقه|پانزده دقیقه|15m\b/i] },
  { tf: "30m", patterns: [/۳۰ دقیقه|30 دقیقه|نیم ساعت|30m\b/i] },
  { tf: "45m", patterns: [/۴۵ دقیقه|45 دقیقه/] },
  { tf: "1h", patterns: [/۱ ساعت|1 ساعت|یک ساعت|یک‌ساعته|1h\b/i] },
  { tf: "2h", patterns: [/۲ ساعت|2 ساعت|دو ساعت/] },
  { tf: "4h", patterns: [/۴ ساعت|4 ساعت|چهار ساعت|4h\b/i] },
  { tf: "8h", patterns: [/۸ ساعت|8 ساعت|هشت ساعت/] },
  { tf: "1d", patterns: [/روزانه|دیلی|daily/i, /۱ روزه|1 روزه/] },
];

/** Persian-Indic digits -> ASCII, so quantities parse. */
export function normalizeDigits(s: string): string {
  const fa = "۰۱۲۳۴۵۶۷۸۹";
  const ar = "٠١٢٣٤٥٦٧٨٩";
  return s.replace(/[۰-۹٠-٩]/g, (d) => {
    const i = fa.indexOf(d);
    return String(i >= 0 ? i : ar.indexOf(d));
  });
}

/**
 * Sentences whose numbers are economic/biographical rather than market
 * parameters. Mining these as trading quantities produced false positives
 * (e.g. "monthly income of $2000" read as a price level), so they are excluded.
 */
const NON_MARKET_NUMERIC = [
  /دلار\s*(?:درآمد|ماهانه)/, /درآمد/, /تومان/, /میلیون/, /میلیارد/,
  /سال\s*\d|سن\s/, /جمعیت/, /حقوق\s*ماهانه/,
];

export function hasNonMarketNumerics(text: string): boolean {
  return NON_MARKET_NUMERIC.some((p) => p.test(text));
}

/** Extract quantities the SOURCE actually states. Never synthesised. */
export function extractQuantities(text: string): { raw: string; value: number; unit: string | null }[] {
  const t = normalizeDigits(text);
  const out: { raw: string; value: number; unit: string | null }[] = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(درصد|%|بار|کندل|دقیقه|ساعت|روز|برابر|R\b|تا)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const value = Number(m[1].replace(",", "."));
    if (!Number.isFinite(value)) continue;
    const unit = m[2] ?? null;
    // ignore bare years / very large bare numbers with no unit
    if (unit === null && (value > 1000 || value === 0)) continue;
    out.push({ raw: m[0].trim(), value, unit });
    if (out.length >= 8) break;
  }
  return out;
}

export function extractConcepts(text: string): string[] {
  const out: string[] = [];
  for (const c of CONCEPTS) if (c.patterns.some((p) => p.test(text))) out.push(c.id);
  return out;
}

export function extractTimeframes(text: string): string[] {
  const out: string[] = [];
  for (const t of TF_PATTERNS) if (t.patterns.some((p) => p.test(text))) out.push(t.tf);
  return out;
}

export function extractDirection(text: string): KnowledgeAtom["direction"] {
  // «اشباع خرید» = OVERBOUGHT and «اشباع فروش» = OVERSOLD are market STATES,
  // not trade directions — an overbought reading argues for a SHORT. Strip the
  // compound terms before looking for directional words.
  const t = text.replace(/اشباع\s*خرید/g, "«OVERBOUGHT»").replace(/اشباع\s*فروش/g, "«OVERSOLD»");
  const long = /\bLong\b|لانگ|خرید|صعودی|\bBuy\b/i.test(t);
  const short = /\bShort\b|شورت|فروش|نزولی|\bSell\b|(?:^|[\s،.:؛(])سل(?=[\s،.:؛)]|$)/i.test(t);
  if (long && short) return "both";
  if (long) return "long";
  if (short) return "short";
  return "none";
}

/** Classify the sentence. Most specific cue wins (CUES is ordered). */
export function classifyAtom(text: string): AtomKind {
  for (const c of CUES) if (c.patterns.some((p) => p.test(text))) return c.kind;
  return "NARRATIVE";
}

/**
 * Decide whether a sentence can become an executable predicate.
 *
 * EXPLICIT_COMPUTABLE requires BOTH a known concept (so a detector can supply
 * the value) AND a stated quantity (so there is something to compare against).
 * Qualitative instructions such as «کمی پایین‌تر» ("a little below") name a
 * concept but no quantity — they stay EXPLICIT_NON_COMPUTABLE and must never
 * be given an invented number.
 */
const QUALITATIVE = [
  /کمی\s*(پایین|بالا)/, /بالای ناحیه/, /پایین ناحیه/, /متناسب با/, /سقف قبلی/,
  /کف قبلی/, /مناسب/, /مقداری/, /حدوداً/, /تقریبا/, /نزدیک/, /در حوالی/,
];

export function classifySemantics(
  text: string,
  kind: AtomKind,
  concepts: string[],
  quantities: { value: number }[],
): { status: SemanticStatus; reason: string | null } {
  if (/\[CLAIM/i.test(text) || /CLAIMED BY INSTRUCTOR/i.test(text) || /ادعای/.test(text)) {
    return { status: "CLAIM", reason: "instructor claim — never executable without empirical proof" };
  }
  if (/\[CONFLICT/i.test(text) || /تناقض/.test(text)) {
    return { status: "CONFLICT", reason: "source marks a contradiction here" };
  }
  if (/\bUNKNOWN\b/.test(text)) {
    return { status: "UNKNOWN", reason: "source explicitly states UNKNOWN" };
  }
  if (/\[INFERRED\]/i.test(text) || /^•?\s*INFERRED/i.test(text) || /نکته استنباطی/.test(text)) {
    return { status: "INFERRED", reason: "derived by the extraction, not stated by the instructor" };
  }
  if (kind === "EXAMPLE") {
    return { status: "EXPLICIT_NON_COMPUTABLE", reason: "illustration, not a rule (governance: examples are not rules)" };
  }
  if (kind === "NARRATIVE" || kind === "PSYCHOLOGY" || kind === "SECURITY" || kind === "PROCESS") {
    return { status: "EXPLICIT_NON_COMPUTABLE", reason: `${kind.toLowerCase()} content is a guard/process, not a market predicate` };
  }
  const qualitative = QUALITATIVE.find((p) => p.test(text));
  if (qualitative) {
    return {
      status: "EXPLICIT_NON_COMPUTABLE",
      reason: "qualitative wording with no deterministic transformation in the source (no number is invented)",
    };
  }
  if (concepts.length === 0) {
    return { status: "EXPLICIT_NON_COMPUTABLE", reason: "no recognised trading concept — no detector can supply a value" };
  }
  if (quantities.length === 0) {
    return { status: "EXPLICIT_NON_COMPUTABLE", reason: "names a concept but states no comparable quantity" };
  }
  if (hasNonMarketNumerics(text)) {
    return {
      status: "EXPLICIT_NON_COMPUTABLE",
      reason: "the numbers in this sentence are economic/biographical, not market parameters",
    };
  }
  return { status: "EXPLICIT_COMPUTABLE", reason: null };
}

/** Build one atom from a source line. Returns null for empty/very short lines. */
export function mineAtom(fileId: string, line: number, raw: string): KnowledgeAtom | null {
  const text = raw.trim();
  if (text.length < 12) return null;

  const kind = classifyAtom(text);
  const concepts = extractConcepts(text);
  const quantities = extractQuantities(text);
  const timeframes = extractTimeframes(text);
  const direction = extractDirection(text);
  const { status, reason } = classifySemantics(text, kind, concepts, quantities);

  const sourceStatus: SourceStatus =
    status === "CLAIM" ? "CLAIM"
      : status === "CONFLICT" ? "CONFLICT"
        : status === "UNKNOWN" ? "UNKNOWN"
          : status === "INFERRED" ? "SOURCE_INFERRED"
            : /\[VERIFIED\]/i.test(text) ? "SOURCE_VERIFIED"
              // absence of a marker is NOT evidence of verification
              : "SOURCE_INFERRED";

  return {
    atom_id: `ATOM-${fileId.replace(".txt", "")}-${line}`,
    file_id: fileId,
    line,
    text: text.slice(0, 2000),
    kind,
    semantic_status: status,
    source_status: sourceStatus,
    concepts,
    quantities,
    timeframes,
    direction,
    non_computable_reason: status === "EXPLICIT_COMPUTABLE" ? null : reason,
    source_refs: [{ file: fileId, start_line: line, end_line: line, quote: text.slice(0, 300) }],
  };
}
