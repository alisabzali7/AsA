/**
 * GET /api/brain/validation — empirical evidence and promotion state.
 *
 * Shows, for every compiled strategy, the persisted experiments that justify
 * its empirical status. A strategy with no experiments is UNTESTED and says so.
 */
import { NextResponse } from "next/server";
import { ExperimentStore } from "@/lib/backtest/experiments";
import { PROMOTION_CRITERIA } from "@/lib/backtest/validation";
import { COMPILED_STRATEGIES, COMPILED_STRATEGY_IDS } from "@/lib/strategy/compiled";
import { getBrain } from "@/lib/brain/store";
import { gateStrategy } from "@/lib/brain/gate";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try {
    const url = new URL(req.url);
    const strategyId = url.searchParams.get("strategy");
    const store = new ExperimentStore();

    try {
      if (strategyId) {
        const rows = store.allFor(strategyId, 50);
        return NextResponse.json({
          ok: true,
          strategy_id: strategyId,
          experiment_count: rows.length,
          experiments: rows.map((r) => ({
            experiment_id: r.experiment_id,
            created_ms: r.created_ms,
            symbol: r.symbol,
            timeframe: r.timeframe,
            bars: r.bars,
            dataset_fingerprint: r.dataset_fingerprint,
            range: { from_ts: r.from_ts, to_ts: r.to_ts },
            versions: {
              strategy: r.strategy_version, detector: r.detector_version,
              rule: r.rule_version, code: r.code_version,
            },
            risk_policy_id: r.risk_policy_id,
            costs: JSON.parse(String(r.costs_json)),
            in_sample: JSON.parse(String(r.in_sample_json)),
            out_of_sample: r.oos_json ? JSON.parse(String(r.oos_json)) : null,
            walk_forward: r.walk_forward_json ? JSON.parse(String(r.walk_forward_json)) : null,
            promotion: JSON.parse(String(r.promotion_json)),
            empirical_status: r.empirical_status,
          })),
          ts: Date.now(),
        });
      }

      const byStrategy = store.statusByStrategy();
      const brain = getBrain();

      const rows = COMPILED_STRATEGY_IDS.map((id) => {
        const ev = byStrategy[id];
        const rec = brain.strategy(id);
        const setups = COMPILED_STRATEGIES.filter((s) => s.strategy_id === id);
        const gate = rec ? gateStrategy(rec) : null;
        return {
          strategy_id: id,
          name: setups[0]?.name ?? rec?.canonical_name ?? id,
          family: setups[0]?.family ?? rec?.family,
          setups: setups.map((s) => s.setup_id),
          empirical_status: ev?.status ?? "UNTESTED",
          experiments: ev?.experiments ?? 0,
          symbols_tested: ev?.symbols ?? [],
          runtime_status: rec?.runtime_status ?? "DISABLED",
          runtime_ceiling: gate?.ceiling ?? "DISABLED",
          why: gate?.reasons ?? ["strategy record not found in brain"],
          can_go_live: false,
          blocking:
            (ev?.status ?? "UNTESTED") === "ROBUST"
              ? []
              : [`empirical status ${ev?.status ?? "UNTESTED"} — LIVE_ADVISORY_ONLY requires OOS/walk-forward evidence`],
        };
      });

      return NextResponse.json({
        ok: true,
        total_experiments: store.count(),
        criteria: PROMOTION_CRITERIA,
        strategies: rows,
        note: "empirical status is the WEAKEST result across all symbols tested — a strategy that works on one pair and fails on another is not robust",
        ts: Date.now(),
      });
    } finally {
      store.close();
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), hint: "run `npm run brain:validate`" },
      { status: 503 },
    );
  }
}
