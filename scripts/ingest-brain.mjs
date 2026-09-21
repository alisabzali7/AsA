#!/usr/bin/env node
/**
 * Stage 1+2 runner — ingest the immutable corpus into the AsA brain.
 *
 * Usage:
 *   node scripts/ingest-brain.mjs            # ingest + human report
 *   node scripts/ingest-brain.mjs --json     # machine-readable report
 *
 * Reads ONLY from the corpus dir (never writes there). Writes the brain DB at
 * ASA_BRAIN_DB_PATH. Safe to re-run: knowledge tables are rebuilt from source.
 *
 * TypeScript is compiled on the fly with esbuild (already a Next.js dependency)
 * so no extra runtime loader is required.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env", quiet: true });
loadDotenv({ path: ".env.local", override: true, quiet: true });

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const JSON_OUT = process.argv.includes("--json");

const entry = `
import { BrainStore } from "./src/lib/brain/store";
import { ingestCorpus } from "./src/lib/brain/ingest";
import { ingestUserPsychologySources } from "./src/lib/psychology/user-source";
const store = new BrainStore();
const report = ingestCorpus(store);
const userPsychology = ingestUserPsychologySources(store);
const stats = store.stats();
store.close();
process.stdout.write("\\n__ASA_JSON__" + JSON.stringify({ report, stats, user_psychology: userPsychology }));
`;

// entry must live inside the project so relative imports resolve
const tmpEntry = path.join(process.cwd(), `.asa-ingest-${Date.now()}.ts`);
const tmpOut = path.join(process.cwd(), `.asa-ingest-${Date.now()}.cjs`);
fs.writeFileSync(tmpEntry, entry);

await build({
  entryPoints: [tmpEntry],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: tmpOut,
  absWorkingDir: process.cwd(),
  external: ["better-sqlite3", "dotenv"],
  logLevel: "error",
});

const { execFileSync } = await import("node:child_process");
let raw;
try {
  raw = execFileSync(process.execPath, [tmpOut], {
    encoding: "utf8",
    cwd: process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });
} finally {
  // always clean up, even if the ingest throws, so no build artifact is left behind
  fs.rmSync(tmpEntry, { force: true });
  fs.rmSync(tmpOut, { force: true });
}

const marker = raw.indexOf("__ASA_JSON__");
if (marker < 0) {
  console.error(raw);
  throw new Error("ingest produced no report");
}
const { report, stats, user_psychology: userPsychology } = JSON.parse(raw.slice(marker + "__ASA_JSON__".length));

if (JSON_OUT) {
  console.log(JSON.stringify({ report, stats, user_psychology: userPsychology }, null, 2));
} else {
  console.log("=== AsA Brain ingestion ===");
  for (const d of report.documents) {
    console.log(`  ${d.file_id}: ${String(d.lines).padStart(5)} lines, ${String(d.chars).padStart(7)} chars, sha256=${d.sha256.slice(0, 12)}…${d.truncated ? "  [TRUNCATED UPSTREAM]" : ""}`);
  }
  console.log(`\nlines seen        : ${report.lines_seen}`);
  console.log(`fragments written : ${report.fragments_written}`);
  console.log(`coverage_ok       : ${report.coverage_ok}`);
  console.log(`strategies        : ${report.strategies}`);
  console.log(`rules             : ${report.rules} (source text)`);
  console.log(`machine rules     : ${report.machine_rules} (registered executable)`);
  console.log(`claims            : ${report.claims}`);
  console.log(`conflicts         : ${report.conflicts}`);
  console.log(`unknown fragments : ${report.unknown_fragments}`);
  console.log(`quarantined       : ${report.quarantined}`);
  console.log(`primitives        : ${report.primitives}`);
  console.log(`features          : ${report.features}`);
  console.log(`risk policies     : ${report.risk_policies}`);
  console.log(`psych policies    : ${report.psychology_policies}`);
  console.log(`user psych source : ${userPsychology.documents.length} files / ${userPsychology.fragments_written} fragments`);
  console.log(`duration          : ${report.duration_ms} ms`);
  if (report.errors.length) {
    console.log("\nERRORS:");
    for (const e of report.errors) console.log("  -", e);
  }
  console.log("\nuser psychology:", JSON.stringify(userPsychology));
  console.log("stats:", JSON.stringify(stats));
}
