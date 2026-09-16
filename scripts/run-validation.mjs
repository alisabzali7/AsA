#!/usr/bin/env node
/**
 * Run the full empirical validation pipeline over the compiled strategies
 * using REAL TTT replay data, and persist every experiment.
 *
 *   node scripts/run-validation.mjs [--json]
 *
 * Pipeline per (strategy, symbol): in-sample backtest -> OOS split ->
 * walk-forward -> promotion verdict -> persisted experiment row.
 *
 * What every persisted row carries:
 *   - a DATASET IDENTITY: which series, from which venue base, captured when,
 *     sha256 of the exact source artifact, and the fingerprint RECOMPUTED from
 *     the candles that were actually used;
 *   - the in-sample / out-of-sample / walk-forward PERIODS the verdict covers;
 *   - the validation METHODOLOGY, so a result can never be re-read under a
 *     methodology it was not produced under;
 *   - the FULL walk-forward result (not a summary), so the promotion gate can
 *     REPRODUCE the verdict from the stored metrics instead of trusting a
 *     status string.
 *
 * Delegated to `src/lib/backtest/validation-pipeline.ts` for unified execution across
 * CLI, API and tests.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env", quiet: true });
loadDotenv({ path: ".env.local", override: true, quiet: true });

import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";

const JSON_OUT = process.argv.includes("--json");

const entry = `
import { runValidationPipeline } from "./src/lib/backtest/validation-pipeline";
import { getExperiments } from "./src/lib/backtest/experiments";

const summary = runValidationPipeline({ sourceKind: "TTT_UDF_REPLAY", persist: true });
const store = getExperiments();
const total = store.count();
store.close();

process.stdout.write("\\n__ASA_JSON__" + JSON.stringify({ ...summary, total_stored_experiments: total }));
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
    const isMetrics = r.in_sample;
    const oosMetrics = r.oos;
    const wf = r.walk_forward;
    console.log(
      pad(r.setup_id.replace("SET-STR-RAW-", ""), 28) + pad(r.symbol, 9) +
      pad(isMetrics.trade_count, 11) + pad(isMetrics.expectancy_r ?? "-", 9) + pad(isMetrics.profit_factor ?? "-", 8) +
      pad(oosMetrics?.trade_count ?? "-", 8) + pad(oosMetrics?.expectancy_r ?? "-", 9) +
      pad(wf ? `${wf.profitable_windows}/${wf.total_windows}` : "-", 7) + r.verdict.to,
    );
  }
  console.log("\n=== weakest status per strategy (across all symbols tested) ===");
  for (const [sid, v] of Object.entries(data.by_strategy)) {
    console.log(`  ${pad(sid, 20)} ${pad(v.empirical_status, 14)} experiments=${v.experiments} symbols=${v.symbols.join(",")}`);
  }
  console.log(`\ntotal experiments persisted: ${data.total_stored_experiments ?? data.total_experiments_persisted}`);
  console.log(`series skipped (below min_bars + warmup): ${data.skipped_series}`);
  console.log("\nNo strategy is promoted by this run: promotion eligibility is decided by");
  console.log("src/lib/backtest/promotion.ts, which additionally requires valid dataset");
  console.log("provenance, current versions, computed metrics, OOS + walk-forward evidence");
  console.log("and a reproducible verdict. Inspect it via GET /api/brain/validation.");
}
