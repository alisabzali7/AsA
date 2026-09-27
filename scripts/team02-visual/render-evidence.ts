/**
 * TEAM 02 release-gate: server-rendered evidence image (SVG + PNG) of a REAL
 * compiled-strategy evaluation on FIXTURE candles, with its decision snapshot
 * and snapshot verification — the same code path as /api/charts/{id} and the
 * Telegram photo (chart/evidence.ts + chart/render.ts). Nothing is drawn by
 * hand; the files are written exactly as the renderers return them.
 *
 * Input: FINAL_ARTIFACTS/visual/fixtures/FIXTUREB_1h_candles.json (synthetic
 * shape, source=fixture — NOT market data), fixture clock 2026-09-26 04:37Z.
 *
 * Run: /tmp/pw/node_modules/.bin/tsx scripts/team02-visual/render-evidence.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Candle, CandleSeries } from "../../src/lib/domain/types";
import { prepareAnalysisInput } from "../../src/lib/analysis/input";
import { COMPILED_STRATEGIES, evaluateCompiled } from "../../src/lib/strategy/compiled";
import { DETECTOR_VERSION } from "../../src/lib/features/detectors";
import { buildChartEvidence, decisionSnapshot, verifyDecisionSnapshot } from "../../src/lib/chart/evidence";
import { renderEvidencePng, renderEvidenceSvg } from "../../src/lib/chart/render";

const ROOT = path.resolve(__dirname, "../..");
const OUT = path.join(ROOT, "FINAL_ARTIFACTS");
const NOW_MS = Date.UTC(2026, 8, 26, 4, 37, 0);
const SYMBOL = "FIXTUREB", TF = "1h";

const fx = JSON.parse(readFileSync(path.join(OUT, "visual/fixtures/FIXTUREB_1h_candles.json"), "utf8")) as { candles: Candle[] };
const series: CandleSeries = { symbol: SYMBOL, timeframe: TF, candles: fx.candles, native: true, source: "ttt" as CandleSeries["source"], fetched_at_ms: NOW_MS };
const input = prepareAnalysisInput(SYMBOL, TF, series, NOW_MS);
if (input.reason_code !== "OK" || input.source_ts_ms === null) throw new Error(`input refused: ${input.reason_code} ${input.reason ?? ""}`);
const closed = input.candles;

// evaluate every 1h compiled strategy at the last closed bar; keep the richest evidence
const runs = COMPILED_STRATEGIES.filter((s) => s.timeframe === TF).map((strat) => {
  const ev = evaluateCompiled(strat, SYMBOL, closed, NOW_MS);
  const snapshot = decisionSnapshot(SYMBOL, TF, closed, input.source_ts_ms as number, `strategy:${strat.strategy_id}@${ev.version}|detectors:${DETECTOR_VERSION}`);
  // score: null — the scoring context (risk/psychology gates) is not part of this render; no score is invented
  const evidence = buildChartEvidence(ev, null, snapshot);
  return { strat, ev, evidence };
});
runs.sort((a, b) => b.evidence.annotations.length - a.evidence.annotations.length || a.strat.strategy_id.localeCompare(b.strat.strategy_id));
const pick = runs[0];

// verification against the FULL fetched series (incl. the forming bar): must reproduce the window
const check = verifyDecisionSnapshot(pick.evidence, fx.candles);
// negative controls, same functions: a revised decision-window bar and a legacy record
const revised = fx.candles.map((c, i) => (i === closed.length - 5 ? { ...c, c: c.c * 1.001 } : c));
const mismatch = verifyDecisionSnapshot(pick.evidence, revised);
const legacy = verifyDecisionSnapshot({ ...pick.evidence, snapshot: undefined }, fx.candles);

const svg = renderEvidenceSvg(pick.evidence, fx.candles, { title: `${SYMBOL} ${TF} · ${pick.strat.strategy_id} · FIXTURE (not market data)`, snapshotState: check.state });
const png = renderEvidencePng(pick.evidence, fx.candles, { snapshotState: check.state });
writeFileSync(path.join(OUT, "team02-evidence-render.svg"), svg);
writeFileSync(path.join(OUT, "team02-evidence-render.png"), Buffer.from(png));

const drawnBars = fx.candles.filter((c) => c.t <= (pick.evidence.snapshot?.as_of_t ?? Infinity));
const summary = {
  generated_by: "scripts/team02-visual/render-evidence.ts",
  source_type: "FIXTURE",
  symbol: SYMBOL, timeframe: TF, fixture_clock_utc: new Date(NOW_MS).toISOString(),
  strategy_id: pick.strat.strategy_id, setup_outcome: pick.ev.setup.outcome, direction_of_strategy_definition: pick.ev.direction,
  score: null, score_note: "not computed in this render (scoring context absent); never invented",
  snapshot: pick.evidence.snapshot,
  snapshot_check: check,
  negative_controls: { revised_bar_in_window: mismatch, legacy_record_without_snapshot: legacy },
  forming_bar_excluded: input.forming_bar_excluded,
  last_drawn_bar_t: drawnBars.length ? drawnBars[drawnBars.length - 1].t : null,
  annotations: pick.evidence.annotations.map((a) => ({ kind: a.kind, label: a.label, price: a.price, produced_by: a.produced_by, evidence_kind: a.evidence_kind })),
  candidates: runs.map((r) => ({ strategy_id: r.strat.strategy_id, outcome: r.ev.setup.outcome, annotations: r.evidence.annotations.length })),
  files: { svg: "FINAL_ARTIFACTS/team02-evidence-render.svg", png: "FINAL_ARTIFACTS/team02-evidence-render.png" },
  png_note: "the PNG rasteriser draws no text; its verification state travels in the X-Snapshot-Check header (/api/charts) or the Telegram caption",
};
writeFileSync(path.join(OUT, "team02-evidence-render.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ strategy: summary.strategy_id, outcome: summary.setup_outcome, check: check.state, mismatch: mismatch.state, legacy: legacy.state, annotations: summary.annotations.length, fp: summary.snapshot?.input_fingerprint }));
