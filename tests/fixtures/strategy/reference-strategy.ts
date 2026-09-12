/**
 * ReferenceStrategy — a structural, deterministic trend-continuation
 * strategy used to exercise the engine in backtests and tests. It is NOT
 * the user's strategy and is NOT live-eligible: no signal is published
 * from it in production. All rules are documented strings; the ~300-page
 * document will replace it via the same interface.
 */
import { EXIT_POLICY, type StrategyContext, type StrategyDefinition, type StrategyResult } from "../../../src/lib/strategy/index";

export const REFERENCE_STRATEGY_ID = "reference-trend-continuation";

function r2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

export const referenceStrategy: StrategyDefinition = {
  id: REFERENCE_STRATEGY_ID,
  family: "trend-continuation",
  name: "Reference — trend continuation (structural only)",
  status: "REFERENCE",
  version: "1.0.0",
  executable: false, // structural test only; never publishes production signals
  timeframes: { macro: "4h", context: "1h", trigger: "15m" },
  rules: {
    prerequisites: ["macro trend is up (long) or down (short) by structure engine", "macro series has >= 200 closed candles", "context has >= 150 closed candles"],
    setup: ["pullback toward context EMA20 without breaking context structure", "context EMA20 slope agrees with macro direction"],
    trigger: ["15m candle CLOSES back in the macro direction after the pullback (trigger on close, never intrabar)", "15m RSI leaves the pullback zone (cross above 40 long / below 60 short)"],
    confirmation: ["volume ratio >= 1.0 on the trigger bar vs 20-bar average"],
    invalidation: ["close beyond the pullback extreme invalidates the setup", "context structure break (CHoCH against direction) invalidates"],
    stops: ["1R below the pullback low (long) / above the pullback high (short)"],
    targets: [EXIT_POLICY.description],
    regime: ["no trade in range regime on macro"],
    mtf: ["macro and context agree; trigger provides the entry; PARTIAL/ALIGNED only"],
    liquidity: ["avoid entries into a visible FVG in the adverse direction immediately overhead"],
    psychology: ["psychology engine must report neutral bias; never trades INTO liquidation-pressure conjecture (always UNAVAILABLE today)"],
    derivativesFilters: ["funding magnitude beyond +-0.0001 blocks (crowding filter, documented rule)"],
    sessionRules: [],
    exclusions: ["symbol must be in the operational TTT universe", "TONUSDT excluded"],
  },
  params: {
    // macro warmup 64 x 4h ~= 10.7 days: reachable both by the live 4h series
    // (deep backfill) and by a single-request 15m backtest window (~1500 bars)
    minMacroBars: 64,
    minContextBars: 150,
    pullbackRsiLong: 40,
    pullbackRsiShort: 60,
    volumeRatioMin: 1.0,
    fundingAbsBlock: 0.0001,
  },
  paramNote: "research parameters; not derived from any personal strategy document",
  evaluate(ctx: StrategyContext): StrategyResult {
    const evidence: string[] = [];
    const failed: string[] = [];
    const reasons: string[] = [];
    const p = this.params as { minMacroBars: number; minContextBars: number; pullbackRsiLong: number; pullbackRsiShort: number; volumeRatioMin: number; fundingAbsBlock: number };

    const macro = ctx.macro;
    const trigger = ctx.trigger;
    const context = ctx.context;

    // prerequisites + regime
    if (!macro || macro.bars < p.minMacroBars) failed.push(`macro bars ${macro?.bars ?? 0} < ${p.minMacroBars}`);
    else evidence.push(`macro bars=${macro.bars}`);
    if (!context || context.bars < p.minContextBars) failed.push(`context bars ${context?.bars ?? 0} < ${p.minContextBars}`);
    if (!trigger || trigger.bars < 100) failed.push("trigger bars < 100");

    if (failed.length > 0) return fail(ctx, reasons, failed, evidence, "insufficient data on a core timeframe");

    const macroTrend = macro!.structure.trend;
    if (macroTrend === "range") {
      failed.push("macro regime is range — no trade per regime rule");
    }
    if (macroTrend === "up" && context!.structure.trend === "down") failed.push("context disagrees with macro (CHoCH)");
    if (macroTrend === "down" && context!.structure.trend === "up") failed.push("context disagrees with macro (CHoCH)");

    // psychology + derivatives gates
    const psych = ctx.psychology;
    if (psych.bias !== "neutral") failed.push("psychology bias is not neutral");
    const funding = trigger!.stats.fundingRate;
    if (funding !== null && Math.abs(funding) > (p.fundingAbsBlock as number)) failed.push(`funding ${funding} beyond ±${p.fundingAbsBlock} crowding block`);
    else evidence.push(`funding=${funding}`);

    // trigger: last 15m close against macro direction after pullback
    const trigClose = trigger!.last_close;
    const trigRsi = trigger!.indicators.rsi14;
    const trigVolRatio = trigger!.indicators.last_volume_ratio;
    let direction: "long" | "short" | "flat" = "flat";
    const levels: StrategyResult["levels"] = { entry_zone: null, stop: null, targets: [], invalidation: null };

    if (macroTrend === "up") {
      if (trigRsi !== null && trigRsi >= (p.pullbackRsiLong as number) && (trigVolRatio ?? 0) >= (p.volumeRatioMin as number)) {
        direction = "long";
      } else {
        failed.push(`15m trigger not satisfied rsi=${r2(trigRsi)} vol=${r2(trigVolRatio)}`);
      }
    } else if (macroTrend === "down") {
      if (trigRsi !== null && trigRsi <= (p.pullbackRsiShort as number) && (trigVolRatio ?? 0) >= (p.volumeRatioMin as number)) {
        direction = "short";
      } else {
        failed.push(`15m trigger not satisfied rsi=${r2(trigRsi)} vol=${r2(trigVolRatio)}`);
      }
    }

    if (direction !== "flat") {
      const trigger = ctx.trigger!;
      const st = trigger.structure;
      const stopRef = direction === "long" ? st.last_swing_low : st.last_swing_high;
      const atrPct = trigger.indicators.atr14_pct ?? 1;
      const riskDist = trigger.last_close * (Math.max(atrPct / 100, 0.001) * 1.5);
      if (stopRef === null) {
        failed.push("no recent swing to place the stop against");
        direction = "flat";
      } else {
        const stop = direction === "long" ? Math.min(stopRef * 0.999, trigger.last_close - riskDist) : Math.max(stopRef * 1.001, trigger.last_close + riskDist);
        levels.stop = r2(stop) as number;
        levels.entry_zone = direction === "long" ? { bottom: trigger.last_close * 0.999, top: trigger.last_close * 1.001 } : { bottom: trigger.last_close * 0.999, top: trigger.last_close * 1.001 };
        const risk = Math.abs(trigger.last_close - stop);
        levels.targets = EXIT_POLICY.partials.map((m) => {
          const t = direction === "long" ? trigger.last_close + m * risk : trigger.last_close - m * risk;
          return r2(t) as number;
        });
        levels.invalidation = direction === "long" ? st.last_swing_low : st.last_swing_high;
        evidence.push(`direction=${direction}`, `stop=${levels.stop} targets=${levels.targets.join("/")}`, `rsi14=${r2(trigRsi)} volRatio=${r2(trigVolRatio)}`, "trigger evaluated on CLOSED bar only — no intrabar lookahead");
        const rr = risk > 0 ? (Math.abs(levels.targets[2] - trigger.last_close) / risk) : 0;
        if (rr < 1.5) failed.push(`R:R ${r2(rr)} < 1.5`);
      }
    }

    if (failed.length > 0) return fail(ctx, reasons, failed, evidence, "rules not satisfied");
    reasons.push("all evaluated rules satisfied");

    const strength = 55; // structural test only; deterministic constant documented as NOT calibrated
    const thesis =
      direction === "long"
        ? "Macro uptrend (4H), context aligned, 15M closed back up out of the pullback with volume."
        : "Macro downtrend (4H), context aligned, 15M closed back down out of the pullback with volume.";
    return {
      pass: true,
      direction,
      reasons,
      rules_evaluated: Object.keys(this.rules).length,
      failed,
      strength,
      levels,
      thesis,
      evidence,
      provenance: { strategy_id: this.id, version: this.version, evaluated_at_ms: ctx.clock.now_ms },
    };
  },
};

function fail(
  ctx: StrategyContext,
  reasons: string[],
  failed: string[],
  evidence: string[],
  why: string,
): StrategyResult {
  return {
    pass: false,
    direction: "flat",
    reasons: [...reasons, why],
    rules_evaluated: Object.keys(referenceStrategy.rules).length,
    failed,
    strength: 0,
    levels: { entry_zone: null, stop: null, targets: [], invalidation: null },
    thesis: "No setup.",
    evidence,
    provenance: { strategy_id: referenceStrategy.id, version: referenceStrategy.version, evaluated_at_ms: ctx.clock.now_ms },
  };
}
