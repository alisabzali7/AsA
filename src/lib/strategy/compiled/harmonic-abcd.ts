/**
 * Compiled strategies: the AB=CD harmonic family (Phase 2 §5).
 *
 *   STR-RAW-4-2425  هارمونیک پایه (AB=CD)     (4.txt:2425-2440)
 *   STR-RAW-4-2449  هارمونیک پایه معکوس        (4.txt:2449-…)
 *
 * The corpus states four explicit conditions for the base pattern, and the 50%
 * "deep correction" boundary is an actual source number — so it is bound as a
 * SOURCE_PARAM rather than an engineering guess. The two strategies are
 * mirror images that differ ONLY in whether the correction must be deep
 * (>50%, base) or shallow (<=50%, inverse), so they share one rule factory.
 */
import type { Candle } from "../../domain/types";
import type { SourceRef } from "../../brain/types";
import { MapFeatureBag, type RuleDefinition, val } from "../../rules/engine";
import type { SetupDefinition } from "../../rules/setup";
import {
  detectABCD, detectATR, detectStructureBias, detectSwings, detectVolatilityRegime,
  ENGINEERING_PARAMS, SOURCE_PARAMS, type AbcdPattern, type StructureState,
} from "../../features/detectors";

const ref = (line: number, endLine: number, quote: string): SourceRef => ({
  file: "4.txt", start_line: line, end_line: endLine, quote,
});

export const HARMONIC_RULE_VERSION = "1.0.0";

export function buildHarmonicFeatureBag(candles: Candle[], tf: string): MapFeatureBag {
  const bag = MapFeatureBag.from([]);
  bag.set("FTR-ABCD", detectABCD(candles, tf));
  bag.set("FTR-ATR14", detectATR(candles, tf));
  bag.set("FTR-SWINGS", detectSwings(candles, tf));
  bag.set("FTR-STRUCT-BIAS", detectStructureBias(candles, tf));
  bag.set("FTR-VOL-REGIME", detectVolatilityRegime(candles, tf));
  return bag;
}

interface HarmonicOpts {
  idPrefix: string;
  tf: string;
  /** base pattern requires a DEEP correction; the inverse requires a shallow one */
  wantDeepCorrection: boolean;
  refs: SourceRef[];
  sourceTexts: Record<string, string>;
}

function harmonicRules(o: HarmonicOpts): RuleDefinition[] {
  const rules: RuleDefinition[] = [];

  // CONTEXT — a prior trend must exist; the corpus forbids ranging markets.
  // Source: "معامله در بازارهای رنج یا زمانی که روند مشخصی وجود ندارد" (exclusion)
  rules.push({
    id: `${o.idPrefix}-CTX`,
    description: "a prior directional trend exists (the source forbids trading this pattern in a range)",
    source_text: o.sourceTexts.context ?? "",
    source_refs: o.refs,
    source_status: "SOURCE_VERIFIED",
    empirical_status: "UNTESTED",
    feature_dependencies: ["FTR-STRUCT-BIAS"],
    operator: "AND",
    timeframe: o.tf,
    direction: "both",
    kind: "context",
    unresolved: [],
    version: HARMONIC_RULE_VERSION,
    predicates: [{
      expr: "FTR-STRUCT-BIAS.bias != 'MIXED'",
      requires: ["FTR-STRUCT-BIAS"],
      test: (bag) => {
        const s = val<StructureState>(bag, "FTR-STRUCT-BIAS");
        if (!s) return { ok: false, detail: "structure bias unavailable" };
        const ok = s.bias !== "MIXED";
        return { ok, detail: ok ? `trend structure ${s.bias}` : "structure is MIXED (range) — source excludes range markets" };
      },
    }],
  });

  // STRUCTURE — the ABCD legs exist and AB is well formed
  rules.push({
    id: `${o.idPrefix}-LEGS`,
    description: "three alternating swings form clean A-B-C legs",
    source_text: o.sourceTexts.legs ?? "",
    source_refs: o.refs,
    source_status: "SOURCE_VERIFIED",
    empirical_status: "UNTESTED",
    feature_dependencies: ["FTR-ABCD"],
    operator: "AND",
    timeframe: o.tf,
    direction: "both",
    kind: "structure",
    unresolved: [],
    version: HARMONIC_RULE_VERSION,
    predicates: [{
      expr: "FTR-ABCD != null",
      requires: ["FTR-ABCD"],
      test: (bag) => {
        const p = val<AbcdPattern | null>(bag, "FTR-ABCD");
        return p
          ? { ok: true, detail: `AB=${p.ab.toFixed(6)}, correction ${(p.correction_frac * 100).toFixed(1)}%` }
          : { ok: false, detail: "no ABCD leg structure" };
      },
    }],
  });

  // LOCATION — correction depth relative to the source's 50% boundary
  rules.push({
    id: `${o.idPrefix}-CORR`,
    description: o.wantDeepCorrection
      ? "the BC correction is DEEPER than 50% of AB (source: دیپ کورکشن)"
      : "the correction is at most 50% of AB (source: نباید دیپ کورکشن باشد)",
    source_text: o.sourceTexts.correction ?? "",
    source_refs: o.refs,
    source_status: "SOURCE_VERIFIED",
    empirical_status: "UNTESTED",
    feature_dependencies: ["FTR-ABCD"],
    operator: "AND",
    timeframe: o.tf,
    direction: "both",
    kind: "location",
    unresolved: [],
    version: HARMONIC_RULE_VERSION,
    predicates: [{
      expr: `FTR-ABCD.correction_frac ${o.wantDeepCorrection ? ">" : "<="} ${SOURCE_PARAMS.deep_correction_frac}`,
      requires: ["FTR-ABCD"],
      test: (bag) => {
        const p = val<AbcdPattern | null>(bag, "FTR-ABCD");
        if (!p) return { ok: false, detail: "no ABCD pattern" };
        const ok = o.wantDeepCorrection ? p.deep_correction : !p.deep_correction;
        return {
          ok,
          detail: `correction ${(p.correction_frac * 100).toFixed(1)}% vs 50% boundary — ${p.deep_correction ? "deep" : "shallow"}${ok ? "" : " (wrong type for this strategy)"}`,
        };
      },
    }],
  });

  // TRIGGER — CD slope must not exceed AB slope (stated only for the base form)
  if (o.wantDeepCorrection) {
    rules.push({
      id: `${o.idPrefix}-SLOPE`,
      description: "the CD leg's slope is equal to or shallower than AB's (source condition 4)",
      source_text: o.sourceTexts.slope ?? "",
      source_refs: o.refs,
      source_status: "SOURCE_VERIFIED",
      empirical_status: "UNTESTED",
      feature_dependencies: ["FTR-ABCD"],
      operator: "AND",
      timeframe: o.tf,
      direction: "both",
      kind: "trigger",
      unresolved: [],
      version: HARMONIC_RULE_VERSION,
      predicates: [{
        expr: `FTR-ABCD.slope_cd <= FTR-ABCD.slope_ab * (1 + ${ENGINEERING_PARAMS.abcd_slope_tol})`,
        requires: ["FTR-ABCD"],
        test: (bag) => {
          const p = val<AbcdPattern | null>(bag, "FTR-ABCD");
          if (!p) return { ok: false, detail: "no ABCD pattern" };
          const ok = p.slope_cd <= p.slope_ab * (1 + ENGINEERING_PARAMS.abcd_slope_tol);
          return { ok, detail: `slope CD ${p.slope_cd.toFixed(6)} vs AB ${p.slope_ab.toFixed(6)} (tol ${ENGINEERING_PARAMS.abcd_slope_tol})` };
        },
      }],
    });
  } else {
    // The inverse form's trigger is a counter-trend entry on a shallow pullback.
    rules.push({
      id: `${o.idPrefix}-TRIG`,
      description: "counter-trend entry while the pullback remains shallow",
      source_text: o.sourceTexts.trigger ?? "",
      source_refs: o.refs,
      source_status: "SOURCE_VERIFIED",
      empirical_status: "UNTESTED",
      feature_dependencies: ["FTR-ABCD"],
      operator: "AND",
      timeframe: o.tf,
      direction: "both",
      kind: "trigger",
      unresolved: [],
      version: HARMONIC_RULE_VERSION,
      predicates: [{
        expr: "FTR-ABCD.correction_frac <= 0.5",
        requires: ["FTR-ABCD"],
        test: (bag) => {
          const p = val<AbcdPattern | null>(bag, "FTR-ABCD");
          if (!p) return { ok: false, detail: "no ABCD pattern" };
          const ok = p.correction_frac <= SOURCE_PARAMS.deep_correction_frac;
          return { ok, detail: `pullback ${(p.correction_frac * 100).toFixed(1)}% (must stay <= 50%)` };
        },
      }],
    });
  }

  // FILTER — the source forbids trading violent counter-trend spikes / ranges
  rules.push({
    id: `${o.idPrefix}-FILTER`,
    description: "exclusion: violent counter-trend spike / range conditions",
    source_text: o.sourceTexts.filter ?? "",
    source_refs: o.refs,
    source_status: "SOURCE_VERIFIED",
    empirical_status: "UNTESTED",
    feature_dependencies: ["FTR-VOL-REGIME"],
    operator: "AND",
    timeframe: o.tf,
    direction: "both",
    kind: "filter",
    unresolved: [],
    version: HARMONIC_RULE_VERSION,
    predicates: [{
      // FILTER SEMANTICS (see rules/setup.ts): the setup engine BLOCKS when a
      // filter rule evaluates to FAIL. Therefore this predicate must return
      // ok=TRUE when the condition is ACCEPTABLE and ok=FALSE when the source
      // forbids trading.
      //
      // REGRESSION FIXED: the predicate previously returned `ok: spike`, which
      // meant a violent EXPANSION *passed* the filter and a calm market was
      // blocked — the exact inverse of the source rule
      // («در اسپایک‌های پرقدرت خلاف روند معامله ثبت نکنید»).
      expr: "FTR-VOL-REGIME.state != 'EXPANSION'",
      requires: ["FTR-VOL-REGIME"],
      test: (bag) => {
        const v = val<{ state: string; atr: number; atr_avg: number }>(bag, "FTR-VOL-REGIME");
        // unavailable regime data must not silently permit the trade
        if (!v) return { ok: false, detail: "volatility regime unavailable — cannot confirm the source's spike exclusion" };
        const spike = v.state === "EXPANSION";
        return {
          ok: !spike,
          detail: spike
            ? `BLOCKED: volatility EXPANSION (ATR ${v.atr.toFixed(6)} vs avg ${v.atr_avg.toFixed(6)}) — the source excludes spike entries`
            : `volatility ${v.state} — acceptable`,
        };
      },
    }],
  });

  return rules;
}

export function abcdBaseSetup(): SetupDefinition {
  const refs = [ref(2425, 2440, "نام استراتژی: هارمونیک پایه (AB=CD)")];
  return {
    setup_id: "SET-STR-RAW-4-2425",
    strategy_id: "STR-RAW-4-2425",
    name: "هارمونیک پایه (AB=CD)",
    /**
     * DIRECTION RESOLUTION (closure §A5). The corpus stores this entry under a
     * generic "شرایط ورود" field whose text reads "ورود به معامله سل" — a SELL
     * action with no directional label. The Brain compiler flags this as a
     * direction anomaly rather than trusting a field name. We resolve it here
     * EXPLICITLY from the stated ACTION (سل = sell = short), and the runtime
     * direction audit re-checks the decision on every build.
     */
    direction: "short",
    timeframe: "1h",
    source_refs: refs,
    version: "1.1.0",
    rules: harmonicRules({
      idPrefix: "R-2425",
      tf: "1h",
      wantDeepCorrection: true,
      refs,
      sourceTexts: {
        context: "شرایط لازم: وجود روند قبلی. [VERIFIED]",
        legs: "شرایط لازم: برابری اندازه گام AB با گام CD (AB = CD). [VERIFIED]",
        correction: "شرایط لازم: وجود دیپ کورکشن (اصلاح بیش از ۵۰ درصد گام AB). [VERIFIED]",
        slope: "شرایط لازم: شیب (قدرت) گام CD برابر یا کمتر از شیب گام AB باشد. [VERIFIED]",
        filter: "شرایطی که نباید معامله کرد: معامله در بازارهای رنج یا زمانی که روند مشخصی وجود ندارد. [VERIFIED]",
      },
    }),
  };
}

export function abcdInverseSetup(): SetupDefinition {
  const refs = [ref(2449, 2462, "نام استراتژی: هارمونیک پایه معکوس")];
  return {
    setup_id: "SET-STR-RAW-4-2449",
    strategy_id: "STR-RAW-4-2449",
    name: "هارمونیک پایه معکوس (Inverse AB=CD)",
    direction: "long",
    timeframe: "1h",
    source_refs: refs,
    version: "1.1.0",
    rules: harmonicRules({
      idPrefix: "R-2449",
      tf: "1h",
      wantDeepCorrection: false,
      refs,
      sourceTexts: {
        context: "شرایط لازم: وجود روند. [VERIFIED]",
        legs: "الگوی موجی ABCD بر اساس گام‌های قبلی. [VERIFIED]",
        correction: "شرایط لازم: اندازه اصلاح (CD) کوچکتر یا مساوی ۵۰ درصد باشد (نباید دیپ کورکشن باشد). [VERIFIED]",
        trigger: "شرایط ورود Long: ورود خلاف روند در زمانی که اصلاح قیمت سطحی و زیر ۵۰ درصد باشد. [VERIFIED]",
        filter: "شرایطی که نباید معامله کرد: در اسپایک‌های پرقدرت خلاف روند معامله ثبت نکنید. [VERIFIED]",
      },
    }),
  };
}
