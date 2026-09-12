/**
 * Compiled strategy registry + runner (Phase 2 §5, §11, §13).
 *
 * ONE evaluation path is used by live advisory, paper mode and backtest. There
 * is deliberately no second "simulation" implementation to drift out of sync.
 *
 * Level derivation honesty: the corpus expresses stops qualitatively
 * ("کمی پایین‌تر از حمایت" — "a little below support"). We quantify that with a
 * NAMED ENGINEERING PARAMETER (an ATR buffer) and report it in
 * `level_assumptions` on every evaluation, so the arithmetic is never mistaken
 * for an instructor-specified number.
 */
import type { Candle } from "../../domain/types";
import { evaluateSetup, type SetupDefinition, type SetupEvaluation } from "../../rules/setup";
import { MapFeatureBag } from "../../rules/engine";
import { okFeature } from "../../features/types";
import {
  detectATR, detectLevels, DETECTOR_VERSION, type PriceLevel, type AbcdPattern, type DoublePattern,
} from "../../features/detectors";
import {
  buildLevelFeatureBag, przBounceSetup, invisibleLevelsSetup, fourLineSetup, doublePatternSetup,
} from "./prz-levels";
import { buildHarmonicFeatureBag, abcdBaseSetup, abcdInverseSetup } from "./harmonic-abcd";

/** Stop buffer beyond the level, in ATR. ENGINEERING PARAMETER, not source. */
export const STOP_BUFFER_ATR = 0.25;

export interface StrategyLevels {
  entry: number | null;
  stop: number | null;
  targets: number[];
  invalidation: number | null;
  /** every non-source quantification used to produce these numbers */
  level_assumptions: string[];
}

export interface CompiledEvaluation {
  strategy_id: string;
  setup_id: string;
  symbol: string;
  timeframe: string;
  direction: "long" | "short";
  setup: SetupEvaluation;
  levels: StrategyLevels;
  rr: number | null;
  bar_time: number | null;
  features_used: string[];
  version: string;
}

export interface CompiledStrategy {
  strategy_id: string;
  setup_id: string;
  name: string;
  family: string;
  direction: "long" | "short";
  timeframe: string;
  /** minimum closed bars required before this strategy may be evaluated */
  min_bars: number;
  build(candles: Candle[], tf: string): MapFeatureBag;
  setup(): SetupDefinition;
  levels(candles: Candle[], bag: MapFeatureBag, direction: "long" | "short"): StrategyLevels;
}

const lastOf = <T>(a: T[]): T | undefined => a[a.length - 1];

/** Attach the decision-bar close so invalidation predicates can use it. */
function withClose(bag: MapFeatureBag, candles: Candle[], tf: string): MapFeatureBag {
  const c = lastOf(candles);
  if (c) {
    bag.set("FTR-CLOSE", okFeature("FTR-CLOSE", tf, c.c, c.t, 1, DETECTOR_VERSION, ["candles"], "decision-bar close"));
  }
  return bag;
}

/**
 * Level model for level-reaction strategies.
 * entry  = the touched level (source: entry on touching the zone)
 * stop   = just beyond the level  (source qualitative + ATR buffer)
 * target = the next opposing level by close-density (source: "greatest
 *          concentration of candle closes")
 */
function levelReactionLevels(candles: Candle[], bag: MapFeatureBag, direction: "long" | "short"): StrategyLevels {
  const assumptions: string[] = [];
  const touch = bag.get("FTR-LEVEL-TOUCH");
  const atrF = bag.get("FTR-ATR14");
  const levelsF = bag.get("FTR-LEVELS");
  const t = touch?.valid ? (touch.value as { level: PriceLevel } | null) : null;
  const a = atrF?.valid ? (atrF.value as number) : null;
  const all = levelsF?.valid ? (levelsF.value as PriceLevel[]) : [];

  if (!t || a === null) {
    return { entry: null, stop: null, targets: [], invalidation: null, level_assumptions: ["no touched level or ATR — levels not derivable"] };
  }
  const entry = t.level.price;
  const buffer = a * STOP_BUFFER_ATR;
  assumptions.push(`stop buffer = ${STOP_BUFFER_ATR} ATR (${buffer.toFixed(6)}) — ENGINEERING PARAMETER quantifying the source's qualitative "کمی پایین‌تر/بالاتر"`);

  const stop = direction === "long" ? entry - buffer : entry + buffer;

  // Targets: opposing levels ranked by close density, in the profit direction.
  //
  // SANITY BOUND (ENGINEERING PARAMETER): a level far outside the analysed
  // window produces an absurd R:R (a 138R "target" was observed before this
  // guard). The corpus never states a maximum target distance, so we cap
  // candidate targets at MAX_TARGET_ATR from entry and record the exclusion
  // instead of silently sizing a trade against an unreachable level.
  const MAX_TARGET_ATR = 20;
  const maxDist = a * MAX_TARGET_ATR;
  const inProfitDirection = all.filter((l) => (direction === "long" ? l.price > entry : l.price < entry));
  const reachable = inProfitDirection.filter((l) => Math.abs(l.price - entry) <= maxDist);
  const excluded = inProfitDirection.length - reachable.length;
  if (excluded > 0) {
    assumptions.push(`${excluded} opposing level(s) excluded as targets: further than ${MAX_TARGET_ATR} ATR (${maxDist.toFixed(6)}) from entry — ENGINEERING sanity bound, the corpus states no maximum target distance`);
  }

  const opposing = reachable.sort((x, y) => (direction === "long" ? x.price - y.price : y.price - x.price));
  const byDensity = opposing.slice().sort((x, y) => y.close_density - x.close_density);
  const targets: number[] = [];
  if (byDensity[0]) targets.push(byDensity[0].price);
  for (const l of opposing) {
    if (targets.length >= 2) break;
    if (!targets.includes(l.price)) targets.push(l.price);
  }
  // targets must be ordered by increasing benefit so TP1 is nearest
  targets.sort((x, y) => (direction === "long" ? x - y : y - x));
  if (targets.length) {
    assumptions.push("targets = opposing levels ranked by candle-close density (source: «بیشترین تراکم کلوز کندل‌ها»)");
  } else {
    assumptions.push("no opposing level found in the window — target UNKNOWN, trade not sizeable");
  }

  return { entry, stop, targets, invalidation: entry, level_assumptions: assumptions };
}

/**
 * Level model for AB=CD.
 * entry  = pattern completion (projected D)
 * stop   = beyond the prior minor swing (source: "از مینور قبل")
 * target = TP1 at the size of the previous same-direction leg (source)
 */
function harmonicLevels(candles: Candle[], bag: MapFeatureBag, direction: "long" | "short"): StrategyLevels {
  const assumptions: string[] = [];
  const pf = bag.get("FTR-ABCD");
  const af = bag.get("FTR-ATR14");
  const p = pf?.valid ? (pf.value as AbcdPattern | null) : null;
  const a = af?.valid ? (af.value as number) : null;
  if (!p || a === null) {
    return { entry: null, stop: null, targets: [], invalidation: null, level_assumptions: ["no ABCD pattern or ATR — levels not derivable"] };
  }
  const entry = p.d_projected;
  const buffer = a * STOP_BUFFER_ATR;
  assumptions.push(`stop placed beyond point C (source: «از مینور قبل») plus a ${STOP_BUFFER_ATR} ATR buffer — buffer is an ENGINEERING PARAMETER`);
  const stop = direction === "long" ? Math.min(p.c, entry) - buffer : Math.max(p.c, entry) + buffer;
  // TP1 = AB-sized move from entry (source: "حداقل به اندازه گام قبلی AB")
  const tp1 = direction === "long" ? entry + p.ab : entry - p.ab;
  assumptions.push("TP1 = one AB leg from entry (source: «TP1: حداقل به اندازه گام قبلی حرکت همجنس خودش (AB)»)");
  return { entry, stop, targets: [tp1], invalidation: p.c, level_assumptions: assumptions };
}

export const COMPILED_STRATEGIES: CompiledStrategy[] = [
  {
    strategy_id: "STR-RAW-2-581", setup_id: "SET-STR-RAW-2-581", name: "PRZ Bounce Strategy",
    family: "level-reaction", direction: "long", timeframe: "1d", min_bars: 120,
    build: (c, tf) => withClose(buildLevelFeatureBag(c, tf, 5), c, tf),
    setup: przBounceSetup,
    levels: levelReactionLevels,
  },
  {
    strategy_id: "STR-RAW-2-803", setup_id: "SET-STR-RAW-2-803", name: "پرایس اکشن سطوح نامرئی",
    family: "level-reaction", direction: "short", timeframe: "1h", min_bars: 120,
    build: (c, tf) => withClose(buildLevelFeatureBag(c, tf, 2), c, tf),
    setup: invisibleLevelsSetup,
    levels: levelReactionLevels,
  },
  {
    strategy_id: "STR-RAW-2-926", setup_id: "SET-STR-RAW-2-926", name: "استراتژی ۴-خطی",
    family: "level-reaction", direction: "short", timeframe: "1h", min_bars: 120,
    build: (c, tf) => withClose(buildLevelFeatureBag(c, tf, 2), c, tf),
    setup: fourLineSetup,
    levels: levelReactionLevels,
  },
  {
    strategy_id: "STR-RAW-2-1258", setup_id: "SET-STR-RAW-2-1258-short", name: "دو قله بر اساس PRZ",
    family: "level-reaction", direction: "short", timeframe: "1h", min_bars: 120,
    build: (c, tf) => withClose(buildLevelFeatureBag(c, tf, 2), c, tf),
    setup: () => doublePatternSetup("short"),
    levels: levelReactionLevels,
  },
  {
    strategy_id: "STR-RAW-2-1258", setup_id: "SET-STR-RAW-2-1258-long", name: "دو دره بر اساس PRZ",
    family: "level-reaction", direction: "long", timeframe: "1h", min_bars: 120,
    build: (c, tf) => withClose(buildLevelFeatureBag(c, tf, 2), c, tf),
    setup: () => doublePatternSetup("long"),
    levels: levelReactionLevels,
  },
  {
    strategy_id: "STR-RAW-4-2425", setup_id: "SET-STR-RAW-4-2425", name: "هارمونیک پایه (AB=CD)",
    family: "harmonic", direction: "short", timeframe: "1h", min_bars: 120,
    build: (c, tf) => withClose(buildHarmonicFeatureBag(c, tf), c, tf),
    setup: abcdBaseSetup,
    levels: harmonicLevels,
  },
  {
    strategy_id: "STR-RAW-4-2449", setup_id: "SET-STR-RAW-4-2449", name: "هارمونیک پایه معکوس",
    family: "harmonic", direction: "long", timeframe: "1h", min_bars: 120,
    build: (c, tf) => withClose(buildHarmonicFeatureBag(c, tf), c, tf),
    setup: abcdInverseSetup,
    levels: harmonicLevels,
  },
];

/** The 6 distinct corpus strategies (STR-RAW-2-1258 has two directions). */
export const COMPILED_STRATEGY_IDS = [...new Set(COMPILED_STRATEGIES.map((s) => s.strategy_id))];

/**
 * Evaluate one compiled strategy on a candle window.
 * `candles` MUST end at the decision bar — the runner never looks past it.
 */
export function evaluateCompiled(
  strat: CompiledStrategy,
  symbol: string,
  candles: Candle[],
  now = Date.now(),
): CompiledEvaluation {
  const tf = strat.timeframe;
  const bag = strat.build(candles, tf);
  const def = strat.setup();
  const setup = evaluateSetup(def, bag, now);
  const levels = strat.levels(candles, bag, strat.direction);

  let rr: number | null = null;
  if (levels.entry !== null && levels.stop !== null && levels.targets.length > 0) {
    const risk = Math.abs(levels.entry - levels.stop);
    const reward = Math.abs(levels.targets[0] - levels.entry);
    rr = risk > 0 ? Math.round((reward / risk) * 1000) / 1000 : null;
  }

  return {
    strategy_id: strat.strategy_id,
    setup_id: strat.setup_id,
    symbol,
    timeframe: tf,
    direction: strat.direction,
    setup,
    levels,
    rr,
    bar_time: lastOf(candles)?.t ?? null,
    features_used: bag.ids(),
    version: def.version,
  };
}

export type { DoublePattern, PriceLevel, AbcdPattern };
