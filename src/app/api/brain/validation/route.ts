/**
 * GET/POST /api/brain/validation — empirical evidence, validation execution and promotion state.
 *
 * Backed by the deterministic promotion gate (`lib/backtest/promotion.ts`) and the
 * validation pipeline engine (`lib/backtest/validation-pipeline.ts`), so this endpoint
 * reports what the EVIDENCE and GOVERNANCE actually support:
 *
 *   executable ≠ validated ≠ promotable ≠ live eligible
 *
 * GET Queries:
 *   - ?experiment_id=<id> or ?run_id=<id> → deep single experiment audit + provenance chain
 *   - ?strategy=<id>                     → strategy validation record + all experiments + provenance chain
 *   - (no params)                        → universe overview, stage counts A→F, promotion statuses
 *
 * POST:
 *   - Protected by guardMutation(req)
 *   - Runs the validation pipeline on real TTT data and returns the execution report.
 */
import { NextResponse } from "next/server";
import { getExperiments, parseExperimentEvidence } from "@/lib/backtest/experiments";
import { PROMOTION_CRITERIA, VALIDATION_METHODOLOGY } from "@/lib/backtest/validation";
import {
  PROMOTION_CHECK_IDS, promotionReport, promotionReports,
  buildProvenanceChain, evaluateEvidenceRow, validateDatasetProvenance,
} from "@/lib/backtest/promotion";
import { runValidationPipeline, type ValidationPipelineOptions } from "@/lib/backtest/validation-pipeline";
import { guardMutation, readBody } from "@/lib/api-common";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try {
    const url = new URL(req.url);
    const experimentId = url.searchParams.get("experiment_id") ?? url.searchParams.get("run_id");
    const strategyId = url.searchParams.get("strategy");
    const store = getExperiments();

    /* -------------------------------------- single experiment deep audit */
    if (experimentId) {
      const raw = store.getById(experimentId);
      if (!raw) {
        return NextResponse.json(
          { ok: false, error: `experiment '${experimentId}' not found in validation store` },
          { status: 404 },
        );
      }

      const evidence = parseExperimentEvidence(raw);
      const evalRow = evaluateEvidenceRow(evidence);
      const provenance = validateDatasetProvenance(evidence);
      const chain = buildProvenanceChain(evidence.strategy_id);

      return NextResponse.json({
        ok: true,
        experiment_id: evidence.experiment_id,
        created_ms: evidence.created_ms,
        created_at: new Date(evidence.created_ms).toISOString(),
        strategy_id: evidence.strategy_id,
        setup_id: evidence.setup_id,
        symbol: evidence.symbol,
        timeframe: evidence.timeframe,
        bars: evidence.bars,
        dataset_fingerprint: evidence.dataset_fingerprint,
        range: { from_ts: evidence.from_ts, to_ts: evidence.to_ts },
        versions: evidence.versions,
        empirical_status: evidence.empirical_status,
        methodology: evidence.methodology ?? VALIDATION_METHODOLOGY,
        dataset_identity: evidence.dataset_identity,
        split: evidence.split,
        in_sample: evidence.in_sample,
        out_of_sample: evidence.oos,
        walk_forward: evidence.walk_forward,
        promotion_verdict: evidence.promotion,
        evaluation: {
          rederived_status: evalRow.effective_status,
          reproducible: evalRow.reproducible,
          rederive_error: evalRow.rederive_error,
          provenance_ok: provenance.ok,
          provenance_verdict: provenance.verdict,
          provenance_detail: provenance.detail,
        },
        parse_notes: evidence.parse_notes,
        provenance_chain: chain,
        ts: Date.now(),
      });
    }

    /* --------------------------------- single strategy validation dossier */
    if (strategyId) {
      const rows = store.allFor(strategyId, 50);
      const record = promotionReport(strategyId);
      const chain = buildProvenanceChain(strategyId, { record });

      return NextResponse.json({
        ok: true,
        strategy_id: strategyId,
        experiment_count: rows.length,
        experiments: rows.map((r) => ({
          experiment_id: r.experiment_id,
          created_ms: r.created_ms,
          created_at: new Date(Number(r.created_ms)).toISOString(),
          symbol: r.symbol,
          timeframe: r.timeframe,
          bars: r.bars,
          dataset_fingerprint: r.dataset_fingerprint,
          range: { from_ts: r.from_ts, to_ts: r.to_ts },
          versions: {
            strategy: r.strategy_version,
            detector: r.detector_version,
            rule: r.rule_version,
            code: r.code_version,
            app: r.app_version,
            build: r.build_id,
          },
          risk_policy_id: r.risk_policy_id,
          costs: JSON.parse(String(r.costs_json)),
          dataset_identity: r.dataset_identity_json ? JSON.parse(String(r.dataset_identity_json)) : null,
          split: r.split_json ? JSON.parse(String(r.split_json)) : null,
          in_sample: JSON.parse(String(r.in_sample_json)),
          out_of_sample: r.oos_json ? JSON.parse(String(r.oos_json)) : null,
          walk_forward: r.walk_forward_json ? JSON.parse(String(r.walk_forward_json)) : null,
          promotion: JSON.parse(String(r.promotion_json)),
          empirical_status: r.empirical_status,
        })),
        promotion: record.strategy_state.exists
          ? record
          : { ...record, note: "not a compiled runtime strategy — the promotion gate reports the absence" },
        provenance_chain: chain,
        ts: Date.now(),
      });
    }

    /* --------------------------------- universe summary & strategy list */
    const byStrategy = store.statusByStrategy();
    const records = promotionReports();

    const rows = records.map((rec) => {
      const counts = byStrategy[rec.strategy_id];
      return {
        strategy_id: rec.strategy_id,
        name: rec.name,
        family: rec.family,
        setups: rec.setup_ids,
        timeframe: rec.timeframe,
        empirical_status: rec.promotion.evidenced_status,
        stored_empirical_status: counts?.status ?? "UNTESTED",
        validation_status: rec.validation_status,
        promotion_status: rec.promotion.promotion_status,
        stage: rec.strategy_state.stage,
        strategy_state: rec.strategy_state,
        experiments: counts?.experiments ?? 0,
        symbols_tested: counts?.symbols ?? rec.validation.universe,
        runtime_status: rec.promotion.runtime_status,
        runtime_ceiling: rec.promotion.ceiling,
        promotion_decision: rec.promotion.decision,
        can_go_live: rec.promotion.live_eligible,
        why: rec.promotion.checks.map((c) => `${c.verdict}: ${c.label} — ${c.detail}`),
        blocking: rec.blocking,
        failure_reasons: rec.failure_reasons,
        unknown_reasons: rec.unknown_reasons,
        conflict_reasons: rec.conflict_reasons,
        primary_experiment_id: rec.promotion.primary_experiment_id,
        validation: rec.validation,
      };
    });

    return NextResponse.json({
      ok: true,
      total_experiments: store.count(),
      criteria: PROMOTION_CRITERIA,
      methodology: VALIDATION_METHODOLOGY,
      promotion_gate: {
        module: "src/lib/backtest/promotion.ts",
        checks: PROMOTION_CHECK_IDS,
        rule: "strategy exists AND executable AND governance pass AND validation evidence exists AND dataset provenance valid AND evidence describes the current build AND required metrics computed AND stored verdict reproducible AND OOS evidence exists AND quality ladder passed = promotion eligible; otherwise NOT_ELIGIBLE with the exact reasons",
      },
      counts: {
        strategies: rows.length,
        executable: rows.filter((r) => r.strategy_state.executable).length,
        with_validation_evidence: rows.filter((r) => r.strategy_state.has_validation_evidence).length,
        with_oos_evidence: rows.filter((r) => r.strategy_state.has_oos_evidence).length,
        promotion_eligible: rows.filter((r) => r.strategy_state.promotion_eligible).length,
        live_eligible: rows.filter((r) => r.strategy_state.live_eligible).length,
      },
      strategies: rows,
      note: "empirical status is the WEAKEST re-derived result across all symbols tested — a persisted status that cannot be reproduced under the current criteria is reported as such and never promoted. UNKNOWN blocks; it is never upgraded to PASS.",
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), hint: "run `npm run brain:validate`" },
      { status: 503 },
    );
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const denied = guardMutation(req);
  if (denied) return denied;

  const { body, error } = await readBody(req);
  if (error) return error;

  try {
    const opts: ValidationPipelineOptions = {
      strategyId: typeof body.strategyId === "string" ? body.strategyId : (typeof body.strategy_id === "string" ? body.strategy_id : undefined),
      sourceKind: body.sourceKind === "TTT_LIVE_SYNC" || body.source_kind === "TTT_LIVE_SYNC" ? "TTT_LIVE_SYNC" : "TTT_UDF_REPLAY",
      persist: body.persist !== false,
      symbols: Array.isArray(body.symbols) ? body.symbols.map(String) : undefined,
      equity: typeof body.equity === "number" ? body.equity : undefined,
    };

    const summary = runValidationPipeline(opts);
    return NextResponse.json({
      ok: true,
      summary,
      ts: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
