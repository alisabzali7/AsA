/**
 * Compiled strategies: the PRZ / invisible-level family (Phase 2 §5).
 *
 * Covers four corpus strategies that share one mechanism — price reacts at a
 * level with repeated historical touches — so they reuse the SAME primitives
 * instead of becoming four engines (governance J):
 *
 *   STR-RAW-2-581   PRZ Bounce Strategy            (2.txt:581-597, Daily, LONG)
 *   STR-RAW-2-803   پرایس اکشن سطوح نامرئی          (2.txt:803-818, 1H, SHORT)
 *   STR-RAW-2-926   استراتژی ۴-خطی                  (2.txt:926-941, 1H, SHORT)
 *   STR-RAW-2-1258  دو قله / دو دره بر اساس PRZ     (2.txt:1258-…, MTF, BOTH)
 *
 * BINDING HONESTY: each rule records the verbatim Persian source sentence it
 * encodes. Where the source is qualitative ("کمی پایین‌تر" — "a little below"),
 * the quantification is declared as an ENGINEERING PARAMETER in `unresolved`
 * or in the rule description, never presented as the instructor's number.
 */
import type { Candle } from "../../domain/types";
import type { SourceRef } from "../../brain/types";
import { MapFeatureBag, type RuleDefinition, val } from "../../rules/engine";
import type { SetupDefinition } from "../../rules/setup";
import {
  detectATR, detectDoublePattern, detectLevelTouch, detectLevels, detectPinbar,
  detectRejectionAt, detectStructureBias, detectSwings, SOURCE_PARAMS,
  type DoublePattern, type PriceLevel, type StructureState,
} from "../../features/detectors";

const ref = (line: number, endLine: number, quote: string): SourceRef => ({
  file: "2.txt", start_line: line, end_line: endLine, quote,
});

export const RULE_VERSION = "1.0.0";

/**
 * Build the shared feature bag for level-reaction strategies.
 * Runs every detector once so rules can consult them without recomputation.
 */
export function buildLevelFeatureBag(candles: Candle[], tf: string, minTouches: number): MapFeatureBag {
  const bag = MapFeatureBag.from([]);
  const levels = detectLevels(candles, tf);
  bag.set("FTR-LEVELS", levels);
  bag.set("FTR-ATR14", detectATR(candles, tf));
  bag.set("FTR-SWINGS", detectSwings(candles, tf));
  bag.set("FTR-STRUCT-BIAS", detectStructureBias(candles, tf));
  bag.set("FTR-PINBAR", detectPinbar(candles, tf));
  bag.set("FTR-DOUBLE", detectDoublePattern(candles, tf));

  const lv = levels.valid && levels.value ? (levels.value as PriceLevel[]) : [];
  bag.set("FTR-LEVEL-TOUCH", detectLevelTouch(candles, tf, lv, minTouches));

  // rejection is evaluated against the specific level being touched
  const touch = bag.get("FTR-LEVEL-TOUCH");
  const touched = touch?.valid ? (touch.value as { level: PriceLevel } | null) : null;
  if (touched) {
    bag.set("FTR-REJECTION", detectRejectionAt(candles, tf, touched.level.price, touched.level.kind));
  }
  return bag;
}

/* ------------------------------------------------------------ rule factory */

interface LevelRuleOpts {
  idPrefix: string;
  tf: string;
  direction: "long" | "short";
  minTouches: number;
  refs: SourceRef[];
  sourceTexts: Record<string, string>;
  /** require a reversal candle (pinbar or wick rejection) as confirmation */
  requireRejection: boolean;
  /** require a double top/bottom pattern at the level */
  requireDouble?: "double_top" | "double_bottom";
}

function levelRules(o: LevelRuleOpts): RuleDefinition[] {
  const wantKind = o.direction === "long" ? "support" : "resistance";
  const rules: RuleDefinition[] = [];

  // LOCATION — price is at a level with enough historical reactions
  rules.push({
    id: `${o.idPrefix}-LOC`,
    description: `price is touching a ${wantKind} level with at least ${o.minTouches} prior reactions`,
    source_text: o.sourceTexts.location ?? "",
    source_refs: o.refs,
    source_status: "SOURCE_VERIFIED",
    empirical_status: "UNTESTED",
    feature_dependencies: ["FTR-LEVELS", "FTR-LEVEL-TOUCH"],
    operator: "AND",
    timeframe: o.tf,
    direction: o.direction,
    kind: "location",
    unresolved: [],
    version: RULE_VERSION,
    predicates: [
      {
        expr: `FTR-LEVEL-TOUCH.level.kind == '${wantKind}'`,
        requires: ["FTR-LEVEL-TOUCH"],
        test: (bag) => {
          const t = val<{ level: PriceLevel; distance_atr: number } | null>(bag, "FTR-LEVEL-TOUCH");
          if (!t) return { ok: false, detail: "price is not at any qualified level" };
          if (t.level.kind !== wantKind) return { ok: false, detail: `at a ${t.level.kind}, need ${wantKind}` };
          return { ok: true, detail: `at ${wantKind} ${t.level.price.toFixed(6)} with ${t.level.touches} touches` };
        },
      },
      {
        expr: `FTR-LEVEL-TOUCH.level.touches >= ${o.minTouches}`,
        requires: ["FTR-LEVEL-TOUCH"],
        test: (bag) => {
          const t = val<{ level: PriceLevel } | null>(bag, "FTR-LEVEL-TOUCH");
          if (!t) return { ok: false, detail: "no level touched" };
          const ok = t.level.touches >= o.minTouches;
          return { ok, detail: `${t.level.touches} historical touches vs required ${o.minTouches}` };
        },
      },
    ],
  });

  // STRUCTURE — optional double top/bottom
  if (o.requireDouble) {
    rules.push({
      id: `${o.idPrefix}-STRUCT`,
      description: `a ${o.requireDouble} formed at the level`,
      source_text: o.sourceTexts.structure ?? "",
      source_refs: o.refs,
      source_status: "SOURCE_VERIFIED",
      empirical_status: "UNTESTED",
      feature_dependencies: ["FTR-DOUBLE"],
      operator: "AND",
      timeframe: o.tf,
      direction: o.direction,
      kind: "structure",
      unresolved: [],
      version: RULE_VERSION,
      predicates: [{
        expr: `FTR-DOUBLE.kind == '${o.requireDouble}'`,
        requires: ["FTR-DOUBLE"],
        test: (bag) => {
          const d = val<DoublePattern | null>(bag, "FTR-DOUBLE");
          if (!d) return { ok: false, detail: "no double pattern detected" };
          const ok = d.kind === o.requireDouble;
          return { ok, detail: ok ? `${d.kind} at ${d.p2.toFixed(6)}` : `found ${d.kind}, need ${o.requireDouble}` };
        },
      }],
    });
  }

  // TRIGGER — price entered the zone (the touch itself is the trigger)
  rules.push({
    id: `${o.idPrefix}-TRIG`,
    description: "price entered the level zone on the decision bar",
    source_text: o.sourceTexts.trigger ?? "",
    source_refs: o.refs,
    source_status: "SOURCE_VERIFIED",
    empirical_status: "UNTESTED",
    feature_dependencies: ["FTR-LEVEL-TOUCH"],
    operator: "AND",
    timeframe: o.tf,
    direction: o.direction,
    kind: "trigger",
    unresolved: [],
    version: RULE_VERSION,
    predicates: [{
      expr: "FTR-LEVEL-TOUCH != null",
      requires: ["FTR-LEVEL-TOUCH"],
      test: (bag) => {
        const t = val<{ level: PriceLevel; distance_atr: number } | null>(bag, "FTR-LEVEL-TOUCH");
        return t
          ? { ok: true, detail: `entered zone, ${t.distance_atr.toFixed(2)} ATR from level` }
          : { ok: false, detail: "price did not reach the zone" };
      },
    }],
  });

  // CONFIRMATION — reversal candle / wick rejection
  if (o.requireRejection) {
    rules.push({
      id: `${o.idPrefix}-CONF`,
      description: "a reversal candle (wick rejection or pin bar) printed at the level",
      source_text: o.sourceTexts.confirmation ?? "",
      source_refs: o.refs,
      source_status: "SOURCE_VERIFIED",
      empirical_status: "UNTESTED",
      feature_dependencies: ["FTR-REJECTION"],
      operator: "OR",
      timeframe: o.tf,
      direction: o.direction,
      kind: "confirmation",
      unresolved: [],
      version: RULE_VERSION,
      predicates: [
        {
          expr: "FTR-REJECTION.rejected == true",
          requires: ["FTR-REJECTION"],
          test: (bag) => {
            const r = val<{ rejected: boolean; wick_ratio: number }>(bag, "FTR-REJECTION");
            if (!r) return { ok: false, detail: "no rejection measurement" };
            return { ok: r.rejected, detail: r.rejected ? `wick rejection ${(r.wick_ratio * 100).toFixed(0)}% of range` : "no wick rejection" };
          },
        },
        {
          expr: "FTR-PINBAR.direction matches trade direction",
          requires: ["FTR-PINBAR"],
          test: (bag) => {
            const p = val<{ direction: "bullish" | "bearish" } | null>(bag, "FTR-PINBAR");
            if (!p) return { ok: false, detail: "no pin bar" };
            const want = o.direction === "long" ? "bullish" : "bearish";
            return { ok: p.direction === want, detail: `${p.direction} pin bar (need ${want})` };
          },
        },
      ],
    });
  }

  // INVALIDATION — a decisive close beyond the level voids the analysis.
  // Source (2.txt:818): "زمانی که قیمت با قدرت سطح را شکسته و بالای آن کندل می‌بندد (فیلد شدن تحلیل)"
  rules.push({
    id: `${o.idPrefix}-INVAL`,
    description: "price closed decisively beyond the level — analysis is void (فیلد شدن تحلیل)",
    source_text: o.sourceTexts.invalidation ?? "",
    source_refs: o.refs,
    source_status: "SOURCE_VERIFIED",
    empirical_status: "UNTESTED",
    feature_dependencies: ["FTR-LEVEL-TOUCH"],
    operator: "AND",
    timeframe: o.tf,
    direction: o.direction,
    kind: "invalidation",
    unresolved: [],
    version: RULE_VERSION,
    predicates: [{
      expr: "close beyond level",
      requires: ["FTR-LEVEL-TOUCH"],
      test: (bag) => {
        const t = val<{ level: PriceLevel } | null>(bag, "FTR-LEVEL-TOUCH");
        const close = val<number>(bag, "FTR-CLOSE");
        if (!t || close === null) return { ok: false, detail: "no level/close to compare" };
        const broken = o.direction === "long" ? close < t.level.price : close > t.level.price;
        return { ok: broken, detail: broken ? `close ${close} broke the level ${t.level.price.toFixed(6)}` : "level holding" };
      },
    }],
  });

  return rules;
}

/* ------------------------------------------------------- setup definitions */

export function przBounceSetup(): SetupDefinition {
  const refs = [ref(581, 597, "نام استراتژی: PRZ Bounce Strategy [VERIFIED]")];
  return {
    setup_id: "SET-STR-RAW-2-581",
    strategy_id: "STR-RAW-2-581",
    name: "PRZ Bounce Strategy",
    direction: "long",
    timeframe: "1d",
    source_refs: refs,
    version: "1.1.0",
    rules: levelRules({
      idPrefix: "R-581",
      tf: "1d",
      direction: "long",
      // source: "حداقل ۵ تا ۷ بار سابقه برخورد و بازگشت قیمتی"
      minTouches: SOURCE_PARAMS.prz_min_touches,
      refs,
      requireRejection: false, // source confirmation is historical, not a candle
      sourceTexts: {
        location: "شرایط ورود Long: لمس یا ورود قیمت به ناحیه PRZ حمایتی مشخص. [VERIFIED]",
        trigger: "شرایط لازم: شناسایی یک محدوده قیمتی با حداقل ۵ تا ۷ بار سابقه برخورد و بازگشت قیمتی. [VERIFIED]",
        invalidation: "شرایط خروج: رسیدن به مقصد اصلی قیمتی یا شکست اضطراری سطح PRZ. [VERIFIED]",
      },
    }),
  };
}

export function invisibleLevelsSetup(): SetupDefinition {
  const refs = [ref(803, 818, "نام استراتژی: پرایس اکشن سطوح نامرئی")];
  return {
    setup_id: "SET-STR-RAW-2-803",
    strategy_id: "STR-RAW-2-803",
    name: "پرایس اکشن سطوح نامرئی (Invisible Levels)",
    direction: "short",
    timeframe: "1h",
    source_refs: refs,
    version: "1.1.0",
    rules: levelRules({
      idPrefix: "R-803",
      tf: "1h",
      // source: "حداقل ۲ الی ۳ برخورد قبلی"
      minTouches: SOURCE_PARAMS.invisible_level_min_touches,
      direction: "short",
      refs,
      requireRejection: true,
      sourceTexts: {
        location: "شرایط ورود Short: برخورد قیمت به سقف نامرئی یا ناحیه Resistance که در گذشته بازار واکنش داشته + دیدن کندل بازگشتی. [VERIFIED]",
        trigger: "شرایط لازم: وجود حداقل ۲ الی ۳ برخورد قبلی در گذشته چارت و بسته شدن بدنه کندل‌ها در یک سطح مشترک. [VERIFIED]",
        confirmation: "تأییدیه ورود: دیدن برخورد شدو و شروع بازگشت کندل. [VERIFIED]",
        invalidation: "شرایطی که نباید معامله کرد: زمانی که قیمت با قدرت سطح را شکسته و بالای آن کندل می‌بندد (فیلد شدن تحلیل). [VERIFIED]",
      },
    }),
  };
}

export function fourLineSetup(): SetupDefinition {
  const refs = [ref(926, 941, "نام استراتژی: استراتژی ۴-خطی (برگشت از نواحی PRZ)")];
  return {
    setup_id: "SET-STR-RAW-2-926",
    strategy_id: "STR-RAW-2-926",
    name: "استراتژی ۴-خطی (4-Line PRZ Reversal)",
    direction: "short",
    timeframe: "1h",
    source_refs: refs,
    version: "1.1.0",
    rules: levelRules({
      idPrefix: "R-926",
      tf: "1h",
      // source: "حداقل دو یا سه بار به عنوان سقف نامرئی عمل کرده"
      minTouches: SOURCE_PARAMS.invisible_level_min_touches,
      direction: "short",
      refs,
      requireRejection: true,
      sourceTexts: {
        location: "شرایط ورود Short: منتظر ماندن تا قیمت وارد ناحیه مقاومت (خط قرمز) شود. [VERIFIED]",
        trigger: "شرایط لازم: قیمت باید به سطحی برسد که پیش‌تر حداقل دو یا سه بار به عنوان سقف نامرئی عمل کرده. [VERIFIED]",
        confirmation: "تأییدیه ورود: قیمت به داخل ناحیه نفوذ کند (شدو بزند)، نشانه‌های برگشت ظاهر شود و سپس ورود انجام گردد. [VERIFIED]",
        invalidation: "شرایطی که نباید معامله کرد: اگر قیمت به جای واکنش و برگشت، در بالای ناحیه قرمز تثبیت شود (روند تغییر کرده است). [VERIFIED]",
      },
    }),
  };
}

/** Double top/bottom at a PRZ — direction is chosen by the caller. */
export function doublePatternSetup(direction: "long" | "short"): SetupDefinition {
  // The block spans 1258–1280: the entry-method lines (1279/1280) state the
  // TRIGGER event ("the second touch fails to break the level") and are part
  // of the same strategy block's provenance.
  const refs = [ref(1258, 1280, "نام استراتژی: استراتژی معاملاتی دو قله و دو دره بر اساس نواحی PRZ")];
  return {
    setup_id: `SET-STR-RAW-2-1258-${direction}`,
    strategy_id: "STR-RAW-2-1258",
    name: `دو قله/دو دره بر اساس PRZ (${direction})`,
    direction,
    timeframe: "1h",
    source_refs: refs,
    version: "1.1.1",
    rules: levelRules({
      idPrefix: `R-1258-${direction}`,
      tf: "1h",
      minTouches: SOURCE_PARAMS.invisible_level_min_touches,
      direction,
      refs,
      requireRejection: true,
      requireDouble: direction === "long" ? "double_bottom" : "double_top",
      sourceTexts: {
        location: direction === "long"
          ? "شرایط ورود Long: شکل‌گیری الگوی دو دره در نواحی حمایتی و PRZ معتبر پس از یک روند نزولی. [VERIFIED]"
          : "شرایط ورود Short: شکل‌گیری الگوی دو قله در نواحی مقاومتی و PRZ معتبر پس از یک روند صعودی. [VERIFIED]",
        structure: "شرایط لازم: تشکیل روند اولیه، برخورد قیمت به ناحیه PRZ و شکل‌گیری الگوهای دو قله یا دو دره. [VERIFIED]",
        // TRIGGER provenance (rule-graph closure): this rule previously had NO
        // source text — an executable rule without lineage. The verbatim
        // trigger is the block's own entry-method sentence (2.txt:1279/1280):
        // price returns to the PRZ a second time and fails to break it.
        trigger: direction === "long"
          ? "روش ورود دوم (Long): برعکس حالت قبل، پس از تشکیل دو دره در نواحی حمایتی و برگشت قدرت روند نزولی. [VERIFIED]"
          : "روش ورود اول (Short): پس از اینکه روند صعودی به ناحیه PRZ اول خورد، ریزش کرد، دوباره پولبک زد به PRZ بالا و بار دوم نتوانست مقاومت را بشکند و شروع به ریزش کرد. [VERIFIED]",
        confirmation: "تأییدیه ورود: بازگشت قیمت از ناحیه PRZ و عدم توانایی بازار در شکستن مقاومت/حمایت در بار دوم. [VERIFIED]",
        invalidation: "شرایطی که نباید معامله کرد: زمانی که نواحی PRZ معتبر شکسته شده و روند پرقدرت ادامه دارد. [VERIFIED]",
      },
    }),
  };
}

export type { StructureState };
