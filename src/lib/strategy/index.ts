/**
 * Strategy contract (master §58). ONE definition drives live evaluation,
 * explanation, signals and backtest. The user's future ~300-page strategy
 * will be formalized as a StrategyDefinition (via PDF -> DSL/JSON ->
 * validator -> this interface) WITHOUT touching AsA internals.
 */
import type { AnalysisBundle } from "../analysis/bundle";
import type { MtfResult } from "../analysis/mtf";
import type { PsychologySummary } from "../psychology/engine";

export type StrategyStatus =
  | "REFERENCE"
  | "RESEARCH_CANDIDATE"
  | "EXPERIMENTAL"
  | "VALIDATED"
  | "UNTESTED"
  | "DATA_LIMITED"
  | "REJECTED";

export type Direction = "long" | "short" | "flat";

export interface StrategyLevels {
  entry_zone: { top: number; bottom: number } | null;
  stop: number | null;
  targets: number[]; // absolute prices, ascending in benefit order
  invalidation: number | null;
}

export interface StrategyRules {
  prerequisites: string[];
  setup: string[];
  trigger: string[];
  confirmation: string[];
  invalidation: string[];
  stops: string[];
  targets: string[];
  regime: string[];
  mtf: string[];
  liquidity: string[];
  psychology: string[];
  derivativesFilters: string[];
  sessionRules: string[];
  exclusions: string[];
}

export interface StrategyResult {
  pass: boolean;
  direction: Direction;
  reasons: string[]; // why pass/fail
  rules_evaluated: number;
  failed: string[]; // human-readable failed rule descriptions
  strength: number; // 0..100 deterministic composite, NOT a probability
  levels: StrategyLevels;
  thesis: string;
  evidence: string[];
  provenance: { strategy_id: string; version: string; evaluated_at_ms: number };
}

export interface StrategyContext {
  symbol: string;
  mtf: MtfResult; // 4H/1H/15M bundles
  macro: AnalysisBundle | null;
  context: AnalysisBundle | null;
  trigger: AnalysisBundle | null;
  psychology: PsychologySummary;
  clock: { now_ms: number };
  session_rules?: string[];
}

export interface StrategyDefinition {
  id: string;
  family: string;
  name: string;
  status: StrategyStatus;
  version: string;
  liveEligible: boolean;
  timeframes: { macro: string; context: string; trigger: string };
  rules: StrategyRules;
  params: Record<string, number | string | boolean>;
  paramNote?: string;
  /** Deterministic given the same context. Same fn in live + backtest. */
  evaluate(ctx: StrategyContext): StrategyResult;
}

/**
 * Shared exit policy: staged 1R/2R/3R with stop at entry ± 1R. Used by
 * strategy levels, the chart annotations and the backtest resolver — one
 * definition so live and simulation cannot drift apart.
 */
export const EXIT_POLICY = {
  id: "staged-1r-2r-3r",
  description:
    "Initial stop at 1R from entry. Targets: T1 = +1R (close 1/3), T2 = +2R (close 1/3), T3 = +3R (trail remainder). Conservative same-bar rule: if SL and a target both touch the same candle, the STOP resolves first (documented, deterministic).",
  partials: [1, 2, 3], // multiples of risk taken at each stage
  t1: 1,
  t2: 2,
  t3: 3,
} as const;
