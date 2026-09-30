/**
 * TEST-ONLY synthetic compiled strategy.
 *
 * It is NOT a corpus strategy, is never registered in
 * `COMPILED_STRATEGIES`, and makes no source claim. Its only purpose is to
 * drive `runStrategyBacktest` deterministically so position-accounting and
 * exit-labelling invariants can be asserted without depending on a recorded
 * TTT replay fixture being present in the working tree.
 *
 * The setup deliberately declares no rules: `evaluateSetup` reports every
 * stage as SKIPPED and the setup outcome is PASS, which isolates the runner's
 * own fill/exit logic from rule semantics.
 */
import type { Candle } from "../../../src/lib/domain/types";
import { MapFeatureBag } from "../../../src/lib/rules/engine";
import type { CompiledStrategy, StrategyLevels } from "../../../src/lib/strategy/compiled";

export const SYNTHETIC_HOUR_SEC = 3_600;
export const SYNTHETIC_FIRST_TS = 1_700_000_000;

export function syntheticBar(index: number, o: number, h: number, l: number, c: number): Candle {
  return { t: SYNTHETIC_FIRST_TS + index * SYNTHETIC_HOUR_SEC, o, h, l, c, v: 1 };
}

/** A flat bar that neither reaches a target nor a stop in the scenarios below. */
export function syntheticFlatBar(index: number): Candle {
  return syntheticBar(index, 100, 101, 99, 100);
}

export function syntheticLadderStrategy(levels: StrategyLevels): CompiledStrategy {
  return {
    strategy_id: "TEST-ONLY-SYNTHETIC",
    setup_id: "SET-TEST-ONLY-SYNTHETIC",
    name: "test-only synthetic ladder strategy",
    family: "test-only",
    direction: "long",
    timeframe: "1h",
    min_bars: 3,
    build: () => MapFeatureBag.from([]),
    setup: () => ({
      setup_id: "SET-TEST-ONLY-SYNTHETIC",
      strategy_id: "TEST-ONLY-SYNTHETIC",
      name: "test-only synthetic ladder strategy",
      direction: "long",
      timeframe: "1h",
      rules: [],
      source_refs: [],
      version: "test-only-1",
    }),
    levels: () => ({ ...levels, targets: [...levels.targets], level_assumptions: [...levels.level_assumptions] }),
  };
}
