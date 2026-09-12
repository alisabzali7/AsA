/**
 * Fragment classification + structured strategy-block parsing.
 *
 * The corpus is a Persian-language transcript extraction with a highly regular
 * field-block format, e.g.:
 *
 *   نام استراتژی: <name>
 *   تایم‌فریم: UNKNOWN
 *   شرایط ورود Long: UNKNOWN (مربوط به جلسات بعدی چارت)
 *   Stop Loss: UNKNOWN
 *
 * We parse those blocks literally. Where the source writes UNKNOWN we record
 * UNKNOWN — we never guess the missing value (governance E).
 *
 * All matching is driven by markers ACTUALLY PRESENT in the corpus (verified by
 * grep during Stage 0), not by assumptions about what a transcript might say.
 */
import type { FragmentClass, CriticalSpecField } from "./types";

/* Corpus markers, verified present in RAW_1..RAW_5 during Stage 0. */
export const MARK = {
  verified: "[VERIFIED]",
  inferred: "INFERRED",
  unknown: "UNKNOWN",
  conflict: "CONFLICT",
  claim: "CLAIM",
  strategyName: "نام استراتژی",
  rule: "قانون",
} as const;

/** Persian/English field labels -> canonical strategy spec field. */
const FIELD_MAP: { patterns: string[]; field: string }[] = [
  { patterns: ["نام استراتژی"], field: "name" },
  { patterns: ["ایده اصلی"], field: "idea" },
  { patterns: ["بازار مناسب"], field: "market" },
  { patterns: ["تایم‌فریم", "تایم فریم", "تایمفریم"], field: "timeframe" },
  { patterns: ["شرایط لازم"], field: "prerequisites" },
  { patterns: ["شرایط ورود Long", "شرایط ورود لانگ"], field: "entry_long" },
  { patterns: ["شرایط ورود Short", "شرایط ورود شورت"], field: "entry_short" },
  { patterns: ["شرایط ورود"], field: "entry" },
  { patterns: ["تأییدیه ورود", "تاییدیه ورود"], field: "confirmation" },
  { patterns: ["Stop Loss", "حد ضرر"], field: "stop" },
  { patterns: ["Take Profit", "حد سود"], field: "target" },
  { patterns: ["Risk/Reward", "ریسک به ریوارد", "R/R"], field: "rr" },
  { patterns: ["شرایط خروج"], field: "exit" },
  { patterns: ["فیلترها"], field: "filters" },
  { patterns: ["شرایطی که نباید معامله کرد"], field: "exclusions" },
  { patterns: ["مدیریت معامله"], field: "trade_management" },
  { patterns: ["مدیریت سرمایه"], field: "capital_management" },
  { patterns: ["اشتباهات رایج"], field: "common_mistakes" },
  { patterns: ["مثال‌های مدرس", "مثالهای مدرس"], field: "examples" },
  { patterns: ["سایر جزئیات"], field: "other" },
];

/** Meta-commentary that must NEVER become an executable rule (governance D). */
const META_PATTERNS = [
  "استخراج کامل و دقیق",
  "آیا مایل",
  "می‌خواهید",
  "در جلسات بعدی",
  "جلسه بعد",
  "خلاصه استخراج",
  "would you like",
  "let me know",
];

const TOPIC_TAGS: { tag: string; needles: string[] }[] = [
  { tag: "rsi", needles: ["RSI", "آر اس آی"] },
  { tag: "macd", needles: ["MACD", "مکدی"] },
  { tag: "ichimoku", needles: ["Ichimoku", "ایچیموکو"] },
  { tag: "fibonacci", needles: ["فیبوناچی", "Fibonacci", "فیبو"] },
  { tag: "elliott", needles: ["الیوت", "Elliott"] },
  { tag: "wyckoff", needles: ["وایکوف", "Wyckoff"] },
  { tag: "smc", needles: ["اسمارت مانی", "Smart Money", "SMC"] },
  { tag: "order-block", needles: ["اردر بلاک", "Order Block", "آردر بلاک", "OB"] },
  { tag: "choch", needles: ["CHOCH", "چیچ", "چنج آف کرکتر", "QM"] },
  { tag: "bos", needles: ["BOS", "شکست ساختار"] },
  { tag: "harmonic", needles: ["هارمونیک", "Harmonic", "AB=CD"] },
  { tag: "divergence", needles: ["دایورجنس", "Divergence", "واگرایی"] },
  { tag: "pinbar", needles: ["پین بار", "پین‌بار", "Pinbar", "Pin Bar"] },
  { tag: "candlestick", needles: ["کندل", "Candle"] },
  { tag: "support-resistance", needles: ["حمایت", "مقاومت", "Support", "Resistance"] },
  { tag: "prz", needles: ["PRZ", "پی آر زد"] },
  { tag: "momentum", needles: ["مومنتوم", "Momentum"] },
  { tag: "moving-average", needles: ["مووینگ", "میانگین متحرک", "EMA", "SMA"] },
  { tag: "risk", needles: ["ریسک", "مدیریت سرمایه", "Risk"] },
  { tag: "psychology", needles: ["روانشناسی", "روان‌شناسی", "احساسات", "استاندارد"] },
  { tag: "acd", needles: ["ACD"] },
  { tag: "brooks", needles: ["بروکس", "Brooks"] },
  { tag: "miner", needles: ["ماینر", "Miner"] },
  { tag: "wave-surfing", needles: ["موج سواری", "Wave Surfing", "موج‌سواری"] },
  { tag: "news", needles: ["اخبار", "فاندامنتال", "News"] },
  { tag: "security", needles: ["امنیت", "هک", "رمز عبور", "Security"] },
  { tag: "review", needles: ["ژورنال", "بازبینی", "Review"] },
  { tag: "position-management", needles: ["مدیریت پوزیشن", "ریسک فری", "ریسک‌فری"] },
];

export function topicTags(text: string): string[] {
  const out: string[] = [];
  for (const t of TOPIC_TAGS) {
    if (t.needles.some((n) => text.includes(n))) out.push(t.tag);
  }
  return out;
}

export function isMetaCommentary(text: string): boolean {
  return META_PATTERNS.some((p) => text.includes(p));
}

/**
 * Classify one line of source. Order matters: explicit uncertainty markers win
 * over generic narrative so UNKNOWN/CONFLICT/CLAIM are never downgraded.
 */
export function classifyLine(text: string): { cls: FragmentClass; quarantine: string | null } {
  const t = text.trim();
  if (!t) return { cls: "NARRATIVE", quarantine: null };

  if (isMetaCommentary(t)) {
    return { cls: "META_COMMENTARY", quarantine: "extractor/assistant meta commentary — never executable (governance D)" };
  }
  if (t.includes(MARK.conflict) || t.includes("تناقض")) return { cls: "CONFLICT_MARKER", quarantine: null };
  if (t.includes(MARK.claim) || t.includes("ادعای")) return { cls: "CLAIM", quarantine: null };
  if (t.includes(MARK.unknown)) return { cls: "UNKNOWN_MARKER", quarantine: null };
  if (t.startsWith(MARK.strategyName) || t.includes(`${MARK.strategyName}:`)) return { cls: "STRATEGY_DECL", quarantine: null };
  if (/^#+\s/.test(t) || /^\d+\.\s*\S/.test(t)) return { cls: "SECTION_HEADER", quarantine: null };
  if (t.startsWith(MARK.rule) || /^قانون\s*\d*/.test(t)) return { cls: "RULE_CANDIDATE", quarantine: null };

  const tags = topicTags(t);
  if (tags.includes("psychology")) return { cls: "PSYCHOLOGY", quarantine: null };
  if (tags.includes("risk")) return { cls: "RISK", quarantine: null };
  return { cls: "NARRATIVE", quarantine: null };
}

export interface ParsedField {
  field: string;
  value: string;
  line: number;
  is_unknown: boolean;
}

export interface ParsedStrategyBlock {
  name: string;
  name_line: number;
  fields: ParsedField[];
  file: string;
  start_line: number;
  end_line: number;
}

function matchField(line: string): { field: string; value: string } | null {
  const idx = line.indexOf(":");
  const idxFa = line.indexOf("：");
  const at = idx >= 0 ? idx : idxFa;
  if (at < 0) return null;
  const label = line.slice(0, at).trim();
  const value = line.slice(at + 1).trim();
  for (const f of FIELD_MAP) {
    if (f.patterns.some((p) => label.startsWith(p) || label === p)) return { field: f.field, value };
  }
  return null;
}

/**
 * Extract structured strategy blocks. A block starts at a `نام استراتژی:` line
 * and continues until the next such line or a gap of non-field lines.
 */
export function parseStrategyBlocks(file: string, lines: string[]): ParsedStrategyBlock[] {
  const blocks: ParsedStrategyBlock[] = [];
  let cur: ParsedStrategyBlock | null = null;
  let sinceField = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const m = matchField(raw);

    if (m && m.field === "name") {
      if (cur) {
        cur.end_line = lineNo - 1;
        blocks.push(cur);
      }
      cur = { name: m.value, name_line: lineNo, fields: [], file, start_line: lineNo, end_line: lineNo };
      sinceField = 0;
      continue;
    }
    if (!cur) continue;

    if (m) {
      // Some blocks write a header line ("Take Profit:") and put the actual
      // content on the FOLLOWING indented lines ("تارگت ۱: ...", "تارگت ۲: ...").
      // Treating the empty header as "no target" would discard values that are
      // genuinely present in the source, so collect the continuation lines.
      let value = m.value;
      if (value === "") {
        const cont: string[] = [];
        for (let k = i + 1; k < lines.length; k++) {
          const nxt = lines[k];
          if (!nxt.trim()) break;
          if (matchField(nxt)) break; // next known field label ends the run
          cont.push(nxt.trim());
          if (cont.length >= 6) break;
        }
        if (cont.length) value = cont.join(" | ");
      }
      cur.fields.push({
        field: m.field,
        value,
        line: lineNo,
        is_unknown: value.toUpperCase().startsWith("UNKNOWN") || value.toUpperCase() === "N/A" || value === "",
      });
      cur.end_line = lineNo;
      sinceField = 0;
    } else {
      sinceField++;
      // 6 consecutive non-field lines closes the block (blocks are dense)
      if (sinceField > 6) {
        blocks.push(cur);
        cur = null;
      }
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** Map a parsed block to the critical spec fields the corpus left UNKNOWN. */
export function unknownCriticalFields(b: ParsedStrategyBlock): CriticalSpecField[] {
  const get = (names: string[]): ParsedField[] => b.fields.filter((f) => names.includes(f.field));
  const out: CriticalSpecField[] = [];

  const entry = get(["entry", "entry_long", "entry_short"]);
  if (entry.length === 0 || entry.every((f) => f.is_unknown)) out.push("entry");

  const stop = get(["stop"]);
  if (stop.length === 0 || stop.every((f) => f.is_unknown)) out.push("stop");

  const target = get(["target"]);
  if (target.length === 0 || target.every((f) => f.is_unknown)) out.push("target");

  const tf = get(["timeframe"]);
  if (tf.length === 0 || tf.every((f) => f.is_unknown)) out.push("timeframe");

  // invalidation is expressed via exit conditions or exclusions in this corpus
  const inval = get(["exit", "exclusions"]);
  if (inval.length === 0 || inval.every((f) => f.is_unknown)) out.push("invalidation");

  return out;
}
