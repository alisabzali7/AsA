/**
 * Brain-backed strategy runtime (closure §B).
 *
 * THE SINGLE SOURCE OF TRUTH for executable strategies.
 *
 * Before this module there were two registries: the Brain knew about 104
 * strategies and produced "brain-spec:*" bindings, while `strategy/registry.ts`
 * exposed only `referenceStrategy` to the live pipeline and the backtester.
 * That split meant the compiled corpus strategies could never actually run in
 * production. This adapter removes the split:
 *
 *   Brain StrategyRecord -> StrategyRuntimeDefinition -> RuleEvaluator
 *                        -> SetupEngine -> StrategyEngine
 *
 * `referenceStrategy` is retained ONLY as a test/reference harness and is
 * excluded from the production resolution path (see `PRODUCTION_STRATEGIES`).
 */
import type { Candle } from "../domain/types";
import { COMPILED_STRATEGIES, evaluateCompiled, type CompiledEvaluation, type CompiledStrategy } from "./compiled";
import type { SetupDefinition } from "../rules/setup";
import type { RuleDefinition } from "../rules/engine";
import type { SourceRef } from "../brain/types";
import { compiledSourceContractFor, sourceContractBlockersFor, sourceContractStatusFor } from "./compiled/source-contract";

export type RuntimeAvailability = "EXECUTABLE" | "RESEARCH_ONLY" | "NON_COMPUTABLE" | "DISABLED";

export interface StrategyRuntimeDefinition {
  /** stable id, identical to the Brain StrategyRecord id */
  strategy_id: string;
  setup_id: string;
  name: string;
  family: string;
  direction: "long" | "short";
  timeframe: string;
  min_bars: number;
  availability: RuntimeAvailability;
  /** exact reason when not source-faithful executable */
  blocked_reason: string | null;
  source_contract_status: "SOURCE_FAITHFUL" | "INCOMPLETE" | "CONFLICTING" | "UNKNOWN";
  source_contract_blockers: string[];
  /** exact compiled setup version; retained under `version` for compatibility */
  strategy_version: string;
  version: string;
  rule_ids: string[];
  rule_versions: string[];
  source_refs: SourceRef[];
  /** implementation; RESEARCH_ONLY is callable only through research/backtest entry points */
  impl: CompiledStrategy | null;
}

/**
 * Direction-corruption guard (closure §A5).
 *
 * The corpus contains at least one block where a SELL statement sits under an
 * `entry_long` label. A mismatch between the strategy's declared direction and
 * its rules must NEVER silently invert a trade — it disables the strategy.
 *
 * Returns a list of violations; empty means the direction mapping is coherent.
 */
export function auditDirection(
  declared: "long" | "short",
  setupDirection: "long" | "short",
  rules: RuleDefinition[],
): string[] {
  const bad: string[] = [];
  if (declared !== setupDirection) {
    bad.push(`declared direction '${declared}' does not match setup direction '${setupDirection}'`);
  }
  for (const r of rules) {
    if (r.direction !== "both" && r.direction !== "none" && r.direction !== declared) {
      bad.push(`rule ${r.id} is '${r.direction}' but the strategy is '${declared}'`);
    }
    // Semantic check on the SOURCE text. The real corpus defect looks like
    // "شرایط ورود Long: ورود به معامله سل ..." — a LONG *label* wrapping a SELL
    // *action*. So we compare the stated ACTION against the declared direction
    // and treat a label/action disagreement as corruption in its own right.
    const txt = r.source_text ?? "";
    const actionShort = /ورود به معامله\s*سل|معامله\s*سل|\bSELL\b|\bshort\s+entry\b/i.test(txt);
    const actionLong = /ورود به معامله\s*بای|معامله\s*خرید|\bBUY\b|\blong\s+entry\b/i.test(txt);
    const labelShort = /شرایط ورود\s*Short|شرایط ورود\s*شورت/i.test(txt);
    const labelLong = /شرایط ورود\s*Long|شرایط ورود\s*لانگ/i.test(txt);

    // 1. the stated ACTION contradicts the declared direction
    if (declared === "long" && actionShort) {
      bad.push(`rule ${r.id} source text states a SELL/short entry but the strategy direction is long`);
    }
    if (declared === "short" && actionLong) {
      bad.push(`rule ${r.id} source text states a BUY/long entry but the strategy direction is short`);
    }
    // 2. the LABEL contradicts the ACTION inside the same sentence
    if (labelLong && actionShort) {
      bad.push(`rule ${r.id} source text is labelled "ورود Long" but describes a SELL action — ambiguous direction, refusing to execute`);
    }
    if (labelShort && actionLong) {
      bad.push(`rule ${r.id} source text is labelled "ورود Short" but describes a BUY action — ambiguous direction, refusing to execute`);
    }
    // 3. the LABEL contradicts the declared direction
    if (declared === "long" && labelShort && !labelLong) {
      bad.push(`rule ${r.id} source text is labelled as a Short entry but the strategy direction is long`);
    }
    if (declared === "short" && labelLong && !labelShort) {
      bad.push(`rule ${r.id} source text is labelled as a Long entry but the strategy direction is short`);
    }
  }
  return bad;
}

/** Build the runtime definition list from the compiled strategies. */
function buildRuntime(): StrategyRuntimeDefinition[] {
  return COMPILED_STRATEGIES.map((c) => {
    const def: SetupDefinition = c.setup();
    const rules: RuleDefinition[] = def.rules;
    const unresolved = rules.filter((r) => r.unresolved.length > 0);
    const dirViolations = auditDirection(c.direction, def.direction, rules);
    const sourceStatus = sourceContractStatusFor(c.strategy_id);
    const sourceBlockers = sourceContractBlockersFor(c.strategy_id);
    const sourceContract = compiledSourceContractFor(c.strategy_id);

    const availability: RuntimeAvailability = dirViolations.length > 0
      ? "DISABLED"
      : unresolved.length > 0
        ? "NON_COMPUTABLE"
        : sourceStatus === "SOURCE_FAITHFUL"
          ? "EXECUTABLE"
          : "RESEARCH_ONLY";
    const blocked = dirViolations.length
      ? `DIRECTION MISMATCH (refusing to execute): ${dirViolations.join("; ")}`
      : unresolved.length
        ? `non-computable rules: ${unresolved.map((r) => `${r.id} (${r.unresolved.join(", ")})`).join("; ")}`
        : availability === "RESEARCH_ONLY"
          ? `source contract ${sourceStatus}: ${sourceBlockers.join("; ") || "source-to-code parity not established"}`
          : null;

    return {
      strategy_id: c.strategy_id,
      setup_id: c.setup_id,
      name: c.name,
      family: c.family,
      direction: c.direction,
      timeframe: c.timeframe,
      min_bars: c.min_bars,
      availability,
      blocked_reason: blocked,
      source_contract_status: sourceStatus,
      source_contract_blockers: sourceBlockers,
      strategy_version: def.version,
      version: def.version,
      rule_ids: rules.map((r) => r.id),
      rule_versions: [...new Set(rules.map((r) => r.version))].sort(),
      source_refs: sourceContract?.source_refs.map((r) => ({ ...r })) ?? def.source_refs,
      impl: availability === "EXECUTABLE" || availability === "RESEARCH_ONLY" ? c : null,
    };
  });
}

let cache: StrategyRuntimeDefinition[] | null = null;

/** All Brain-backed runtime definitions (production path). */
export function PRODUCTION_STRATEGIES(): StrategyRuntimeDefinition[] {
  if (!cache) cache = buildRuntime();
  return cache;
}

/** Resolve by setup_id (unique) or strategy_id (may map to several setups). */
export function getRuntimeStrategy(id: string): StrategyRuntimeDefinition | undefined {
  const all = PRODUCTION_STRATEGIES();
  return all.find((s) => s.setup_id === id) ?? all.find((s) => s.strategy_id === id);
}

/** Every runtime definition sharing a Brain strategy id (long+short variants). */
export function getRuntimeVariants(strategyId: string): StrategyRuntimeDefinition[] {
  return PRODUCTION_STRATEGIES().filter((s) => s.strategy_id === strategyId);
}

export function listRuntimeStrategies(): StrategyRuntimeDefinition[] {
  return PRODUCTION_STRATEGIES();
}

/** Only strategies that can actually be evaluated deterministically. */
export function executableStrategies(): StrategyRuntimeDefinition[] {
  return PRODUCTION_STRATEGIES().filter((s) => s.availability === "EXECUTABLE" && s.impl !== null);
}

/** Deterministically computable definitions that are not source-faithful/live eligible. */
export function researchableStrategies(): StrategyRuntimeDefinition[] {
  return PRODUCTION_STRATEGIES().filter(
    (s) => (s.availability === "EXECUTABLE" || s.availability === "RESEARCH_ONLY") && s.impl !== null,
  );
}

/** Live/advisory evaluator: only a source-contract-complete definition can run. */
export function evaluateRuntime(
  def: StrategyRuntimeDefinition,
  symbol: string,
  candles: Candle[],
  now = Date.now(),
): CompiledEvaluation | { blocked: true; reason: string } {
  if (def.availability !== "EXECUTABLE" || !def.impl) {
    return { blocked: true, reason: def.blocked_reason ?? `strategy is ${def.availability}` };
  }
  return evaluateCompiled(def.impl, symbol, candles, now);
}

/** Research/backtest evaluator. It never makes a source-incomplete rule live. */
export function evaluateResearchRuntime(
  def: StrategyRuntimeDefinition,
  symbol: string,
  candles: Candle[],
  now = Date.now(),
): CompiledEvaluation | { blocked: true; reason: string } {
  if ((def.availability !== "EXECUTABLE" && def.availability !== "RESEARCH_ONLY") || !def.impl) {
    return { blocked: true, reason: def.blocked_reason ?? `strategy is ${def.availability}` };
  }
  return evaluateCompiled(def.impl, symbol, candles, now);
}

/** Distinct Brain strategy ids reachable from the production registry. */
export function runtimeStrategyIds(): string[] {
  return [...new Set(PRODUCTION_STRATEGIES().map((s) => s.strategy_id))];
}
