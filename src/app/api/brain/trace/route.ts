/**
 * GET /api/brain/trace — machine-readable dependency trace (closure §A1, §A2).
 *
 * Resolves the strategy-vs-setup ambiguity explicitly and, for every runtime
 * strategy, emits the full chain:
 *
 *   Strategy -> Setup -> Rules -> Predicates -> Features -> Detectors -> Source refs
 *
 * `?strategy=<id>` narrows the trace to one strategy.
 */
import { NextResponse } from "next/server";
import { listRuntimeStrategies, runtimeStrategyIds } from "@/lib/strategy/runtime";
import { DETECTOR_VERSION } from "@/lib/features/detectors";
import { buildFeatures, buildPrimitives } from "@/lib/brain/primitives";
import { getBrain } from "@/lib/brain/store";

export const dynamic = "force-dynamic";

/** Feature ids for which a real detector function exists in detectors.ts. */
const IMPLEMENTED_DETECTORS = new Set([
  "FTR-SWINGS", "FTR-STRUCT-BIAS", "FTR-BOS", "FTR-CHOCH", "FTR-VOL-REGIME",
  "FTR-ANATOMY", "FTR-PINBAR", "FTR-REJECTION", "FTR-MOMENTUM-CANDLE",
  "FTR-LEVELS", "FTR-LEVEL-TOUCH", "FTR-DOUBLE", "FTR-ABCD",
  "FTR-RSI14", "FTR-ATR14", "FTR-FIB", "FTR-CLOSE",
]);

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const only = url.searchParams.get("strategy");

  const all = listRuntimeStrategies();
  const setups = only ? all.filter((s) => s.strategy_id === only || s.setup_id === only) : all;

  const traces = setups.map((s) => {
    const def = s.impl ? s.impl.setup() : null;
    const rules = def?.rules ?? [];
    const featureIds = [...new Set(rules.flatMap((r) => r.feature_dependencies))];
    return {
      strategy_id: s.strategy_id,
      setup_id: s.setup_id,
      name: s.name,
      family: s.family,
      direction: s.direction,
      timeframe: s.timeframe,
      min_bars: s.min_bars,
      availability: s.availability,
      blocked_reason: s.blocked_reason,
      version: s.version,
      rules: rules.map((r) => ({
        rule_id: r.id,
        stage: r.kind,
        direction: r.direction,
        timeframe: r.timeframe,
        operator: r.operator,
        source_status: r.source_status,
        empirical_status: r.empirical_status,
        executable: r.unresolved.length === 0,
        unresolved: r.unresolved,
        source_text: r.source_text,
        source_refs: r.source_refs,
        predicates: r.predicates.map((p) => ({ expr: p.expr, requires: p.requires })),
        features: r.feature_dependencies,
      })),
      features: featureIds.map((fid) => ({
        feature_id: fid,
        detector_implemented: IMPLEMENTED_DETECTORS.has(fid),
        detector_version: IMPLEMENTED_DETECTORS.has(fid) ? DETECTOR_VERSION : null,
        status: IMPLEMENTED_DETECTORS.has(fid) ? "IMPLEMENTED" : "UNAVAILABLE",
      })),
      source_refs: s.source_refs,
    };
  });

  // Capability truthfulness: catalogue entries whose detector is null.
  const catalogue = buildFeatures();
  const primitives = buildPrimitives();
  const capability = {
    implemented: catalogue.filter((f) => IMPLEMENTED_DETECTORS.has(f.feature_id)).map((f) => f.feature_id),
    catalogued_without_detector: catalogue
      .filter((f) => !IMPLEMENTED_DETECTORS.has(f.feature_id))
      .map((f) => ({ feature_id: f.feature_id, availability: f.availability, reason: f.unavailable_reason ?? "no detector implemented in this build" })),
    primitives_without_detector: primitives.filter((p) => p.detector === null).map((p) => p.primitive_id),
  };

  let brainStrategyCount = 0;
  try {
    brainStrategyCount = getBrain().stats().strategies;
  } catch {
    brainStrategyCount = 0;
  }

  const executable = all.filter((s) => s.availability === "EXECUTABLE");
  return NextResponse.json({
    ok: true,
    counts: {
      // explicit disambiguation of the strategy-vs-setup question
      brain_strategy_count: brainStrategyCount,
      runtime_strategy_count: runtimeStrategyIds().length,
      setup_count: all.length,
      executable_setup_count: executable.length,
      disabled_setup_count: all.length - executable.length,
    },
    counts_note:
      "STR-RAW-2-1258 compiles into TWO setups (a long and a short branch) because the corpus states separate entry conditions for each direction. That is why 6 runtime strategies yield 7 setups.",
    strategy_to_setups: Object.fromEntries(
      runtimeStrategyIds().map((id) => [id, all.filter((s) => s.strategy_id === id).map((s) => s.setup_id)]),
    ),
    traces,
    feature_capability: capability,
    ts: Date.now(),
  });
}
