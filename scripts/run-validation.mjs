#!/usr/bin/env node
/**
 * Run the full empirical validation pipeline over the compiled strategies
 * using REAL TTT replay data, and persist every experiment.
 *
 *   node scripts/run-validation.mjs [--json]
 *
 * Pipeline per (strategy, symbol): in-sample backtest -> OOS split ->
 * walk-forward -> promotion verdict -> persisted experiment row.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env", quiet: true });
loadDotenv({ path: ".env.local", override: true, quiet: true });

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";

const JSON_OUT = process.argv.includes("--json");

const entry = `
import fs from "node:fs";
import { execSync } from "node:child_process";
import { COMPILED_STRATEGIES } from "./src/lib/strategy/compiled";
import { runStrategyBacktest, DEFAULT_COSTS } from "./src/lib/backtest/strategy-runner";
import { runOOS, runWalkForward, decidePromotion, PROMOTION_CRITERIA } from "./src/lib/backtest/validation";
import { ExperimentStore, datasetFingerprint } from "./src/lib/backtest/experiments";
import { buildRiskPolicies, buildPsychologyPolicies } from "./src/lib/brain/policies";
import { parseUdfHistory } from "./src/lib/ttt/udf";
import { DETECTOR_VERSION, detectVolatilityRegime, detectStructureBias } from "./src/lib/features/detectors";
import { buildReleaseIdentity } from "./src/lib/release";

const manifest = JSON.parse(fs.readFileSync("tests/fixtures/replay/MANIFEST.json", "utf8"));
function load(file, tfMin) {
  const j = JSON.parse(fs.readFileSync("tests/fixtures/replay/" + file, "utf8"));
  return parseUdfHistory(j, tfMin).candles;
}
const release = buildReleaseIdentity();
const codeVersion = release.git_commit;

/** Classify the market regime of a replay series so coverage is auditable. */
function regimeOf(candles, tf) {
  const vol = detectVolatilityRegime(candles, tf);
  const bias = detectStructureBias(candles, tf);
  return {
    volatility: vol.valid && vol.value ? vol.value.state : "UNKNOWN",
    structure: bias.valid && bias.value ? bias.value.bias : "UNKNOWN",
  };
}

const policy = buildRiskPolicies().find((p) => p.policy_id === "RISK-ASA-CONSERVATIVE-DEFAULT");
const psychIds = buildPsychologyPolicies().map((p) => p.policy_id).join(",");
const store = new ExperimentStore();
const equity = 10000;
const out = [];

for (const strat of COMPILED_STRATEGIES) {
  const tfMin = strat.timeframe === "1d" ? 1440 : 60;
  const wanted = manifest.series.filter((s) =>
    strat.timeframe === "1d" ? s.resolution === "1D" : s.resolution === "60");
  for (const ser of wanted) {
    const candles = load(ser.file, tfMin);
    if (candles.length < strat.min_bars + 60) continue;
    const opts = { equity, policy, costs: DEFAULT_COSTS };

    const regime = regimeOf(candles, strat.timeframe);
    const full = runStrategyBacktest(strat, ser.symbol, candles, opts);
    const split = runOOS(strat, ser.symbol, candles, opts, 0.7);
    const wf = runWalkForward(strat, ser.symbol, candles, opts, 4);
    const verdict = decidePromotion(split.in_sample.metrics, split.out_of_sample.metrics, wf);

    const id = strat.setup_id + "|" + ser.symbol + "|" + Date.now() + "|" + Math.random().toString(36).slice(2, 8);
    store.insert({
      experiment_id: id,
      created_ms: Date.now(),
      strategy_id: strat.strategy_id,
      setup_id: strat.setup_id,
      symbol: ser.symbol,
      timeframe: strat.timeframe,
      dataset_fingerprint: datasetFingerprint(candles),
      bars: candles.length,
      from_ts: candles[0].t,
      to_ts: candles[candles.length - 1].t,
      strategy_version: strat.setup().version,
      detector_version: DETECTOR_VERSION,
      app_version: release.app_version,
      build_id: release.build_id,
      rule_version: "1.0.0",
      risk_policy_id: policy.policy_id,
      psychology_policy_set: psychIds,
      costs: DEFAULT_COSTS,
      params: { split_ratio: 0.7, windows: 4, criteria: PROMOTION_CRITERIA, regime },
      in_sample: split.in_sample.metrics,
      oos: split.out_of_sample.metrics,
      walk_forward: { windows: wf.windows.map((w) => ({ w: w.window, trades: w.trades, total_r: w.metrics.total_r, expectancy: w.metrics.expectancy_r })), profitable: wf.profitable_windows, total: wf.total_windows, stability: wf.stability, note: wf.note },
      promotion: verdict,
      empirical_status: verdict.to,
      code_version: codeVersion,
    });

    out.push({
      strategy_id: strat.strategy_id, setup_id: strat.setup_id, symbol: ser.symbol,
      full_trades: full.metrics.trade_count, full_total_r: full.metrics.total_r,
      is_trades: split.in_sample.metrics.trade_count, is_expectancy: split.in_sample.metrics.expectancy_r,
      is_pf: split.in_sample.metrics.profit_factor,
      oos_trades: split.out_of_sample.metrics.trade_count, oos_expectancy: split.out_of_sample.metrics.expectancy_r,
      wf_profitable: wf.profitable_windows, wf_total: wf.total_windows, wf_stability: wf.stability,
      status: verdict.to, reasons: verdict.reasons, regime,
      max_oos_dd: split.out_of_sample.metrics.max_drawdown_r,
      wf_negative: wf.total_windows - wf.profitable_windows,
    });
  }
}
const byStrategy = store.statusByStrategy();
const total = store.count();
store.close();
process.stdout.write("\\n__ASA_JSON__" + JSON.stringify({ results: out, byStrategy, total_experiments: total }));
`;

const tmpEntry = path.join(process.cwd(), `.asa-val-${Date.now()}.ts`);
const tmpOut = path.join(process.cwd(), `.asa-val-${Date.now()}.cjs`);
fs.writeFileSync(tmpEntry, entry);

let raw;
try {
  await build({
    entryPoints: [tmpEntry], bundle: true, platform: "node", target: "node20",
    format: "cjs", outfile: tmpOut, absWorkingDir: process.cwd(),
    external: ["better-sqlite3", "dotenv"], logLevel: "error",
  });
  raw = execFileSync(process.execPath, [tmpOut], { encoding: "utf8", cwd: process.cwd(), maxBuffer: 128 * 1024 * 1024 });
} finally {
  fs.rmSync(tmpEntry, { force: true });
  fs.rmSync(tmpOut, { force: true });
}

const marker = raw.indexOf("__ASA_JSON__");
if (marker < 0) { console.error(raw); throw new Error("validation produced no report"); }
const data = JSON.parse(raw.slice(marker + "__ASA_JSON__".length));

if (JSON_OUT) {
  console.log(JSON.stringify(data, null, 2));
} else {
  console.log("=== AsA empirical validation (real TTT replay data) ===\n");
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("setup", 28) + pad("sym", 9) + pad("IS trades", 11) + pad("IS exp", 9) + pad("IS PF", 8) + pad("OOS tr", 8) + pad("OOS exp", 9) + pad("WF", 7) + "status");
  for (const r of data.results) {
    console.log(
      pad(r.setup_id.replace("SET-STR-RAW-", ""), 28) + pad(r.symbol, 9) +
      pad(r.is_trades, 11) + pad(r.is_expectancy ?? "-", 9) + pad(r.is_pf ?? "-", 8) +
      pad(r.oos_trades, 8) + pad(r.oos_expectancy ?? "-", 9) +
      pad(`${r.wf_profitable}/${r.wf_total}`, 7) + r.status,
    );
  }
  console.log("\n=== weakest status per strategy (across all symbols tested) ===");
  for (const [sid, v] of Object.entries(data.byStrategy)) {
    console.log(`  ${pad(sid, 20)} ${pad(v.status, 14)} experiments=${v.experiments} symbols=${v.symbols.join(",")}`);
  }
  console.log(`\ntotal experiments persisted: ${data.total_experiments}`);
}
