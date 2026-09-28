#!/usr/bin/env node
/**
 * Atomic ingestion of the supplied trading corpus AND user psychology sources.
 *
 * Usage:
 *   node scripts/ingest-brain.mjs            # human report
 *   node scripts/ingest-brain.mjs --json     # machine-readable report
 *
 * Writes only the configured Brain database. Source files are read-only. Any
 * corpus, psychology, conflict-history, or manifest failure rolls back the
 * complete refresh and returns a non-zero process status.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env", quiet: true });
loadDotenv({ path: ".env.local", override: true, quiet: true });

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const JSON_OUT = process.argv.includes("--json");
const entry = `
import { BrainStore } from "./src/lib/brain/store";
import { ingestAllSources } from "./src/lib/brain/ingest";
const store = new BrainStore();
let result;
try {
  result = ingestAllSources(store);
} catch (error) {
  result = { ok: false, rolled_back: true, source_manifest_sha256: null, completeness: "UNKNOWN", corpus: null, psychology: null, errors: [error instanceof Error ? error.message : String(error)] };
} finally {
  const stats = store.stats();
  store.close();
  process.stdout.write("\\n__ASA_JSON__" + JSON.stringify({ result, stats }));
}
if (!result?.ok) process.exitCode = 1;
`;

const suffix = `${process.pid}-${Date.now()}`;
const tmpEntry = path.join(process.cwd(), `.asa-ingest-${suffix}.ts`);
const tmpOut = path.join(process.cwd(), `.asa-ingest-${suffix}.cjs`);
let stdout = "";
let stderr = "";
let status = 1;
try {
  fs.writeFileSync(tmpEntry, entry);
  await build({
    entryPoints: [tmpEntry], bundle: true, platform: "node", target: "node20", format: "cjs",
    outfile: tmpOut, absWorkingDir: process.cwd(), external: ["better-sqlite3", "dotenv"], logLevel: "error",
  });
  const execution = spawnSync(process.execPath, [tmpOut], {
    encoding: "utf8", cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024,
  });
  stdout = execution.stdout ?? "";
  stderr = execution.stderr ?? "";
  status = execution.status ?? 1;
  if (execution.error) stderr += `${stderr ? "\n" : ""}${execution.error.message}`;
} finally {
  fs.rmSync(tmpEntry, { force: true });
  fs.rmSync(tmpOut, { force: true });
}

const marker = stdout.indexOf("__ASA_JSON__");
let payload;
if (marker >= 0) {
  try { payload = JSON.parse(stdout.slice(marker + "__ASA_JSON__".length)); }
  catch (error) { stderr += `\ninvalid ingestion report JSON: ${error instanceof Error ? error.message : String(error)}`; }
}
if (!payload) {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(`${stderr}\n`);
  console.error("ingest produced no valid report");
  process.exitCode = status || 1;
} else {
  const { result, stats } = payload;
  if (JSON_OUT) {
    console.log(JSON.stringify({ ...result, stats }, null, 2));
  } else {
    console.log("=== AsA atomic source ingestion ===");
    console.log(`ok                : ${result.ok}`);
    console.log(`rolled back       : ${result.rolled_back}`);
    console.log(`manifest status   : ${result.completeness}`);
    console.log(`manifest sha256   : ${result.source_manifest_sha256 ?? "UNKNOWN"}`);
    if (result.corpus) {
      for (const d of result.corpus.documents) {
        console.log(`  ${d.file_id}: ${String(d.lines).padStart(5)} lines, ${String(d.chars).padStart(7)} chars, ${d.bytes} bytes, sha256=${d.sha256}${d.truncated ? " [TRUNCATED]" : ""}`);
      }
      console.log(`corpus coverage   : ${result.corpus.coverage_ok} (${result.corpus.fragments_written} fragments / ${result.corpus.lines_seen} lines)`);
      console.log(`machine rules     : ${result.corpus.machine_rules}`);
    }
    if (result.psychology) console.log(`psychology        : ${result.psychology.documents.length} files / ${result.psychology.fragments_written} fragments / ${result.psychology.principles_written} source-only principles`);
    for (const error of result.errors ?? []) console.error(`ERROR: ${error}`);
    console.log("stats:", JSON.stringify(stats));
  }
  if (stderr) process.stderr.write(stderr);
  process.exitCode = result.ok && status === 0 ? 0 : 1;
}
