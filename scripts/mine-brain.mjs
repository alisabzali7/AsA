#!/usr/bin/env node
/**
 * Deep brain mining runner (§B, §C).
 *   node scripts/mine-brain.mjs [--json]
 * Additive: reads persisted source_fragments, writes atoms/components/candidates.
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
import { runDeepMining } from "./src/lib/brain/mining/run";
const r = runDeepMining();
process.stdout.write("\\n__ASA_JSON__" + JSON.stringify({ stats: r.stats,
  top_components: r.components.slice(0, 20).map(c => ({ id: c.component_id, role: c.role, concepts: c.concepts, occurrences: c.occurrences, computable: c.computable })),
  sample_candidates: r.candidates.slice(0, 10).map(c => ({ id: c.strategy_id, name: c.name, runtime: c.runtime_status, missing: c.missing_fields, source_status: c.source_status })) }));
`;
const tmpTs = path.join(process.cwd(), `.asa-mine-${Date.now()}.ts`);
const tmpJs = path.join(process.cwd(), `.asa-mine-${Date.now()}.cjs`);
fs.writeFileSync(tmpTs, entry);
let raw;
try {
  await build({ entryPoints: [tmpTs], bundle: true, platform: "node", target: "node20",
    format: "cjs", outfile: tmpJs, absWorkingDir: process.cwd(),
    external: ["better-sqlite3", "dotenv"], logLevel: "error" });
  raw = execFileSync(process.execPath, [tmpJs], { encoding: "utf8", cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 });
} finally {
  fs.rmSync(tmpTs, { force: true }); fs.rmSync(tmpJs, { force: true });
}
const m = raw.indexOf("__ASA_JSON__");
if (m < 0) { console.error(raw); throw new Error("mining produced no report"); }
const d = JSON.parse(raw.slice(m + "__ASA_JSON__".length));
if (JSON_OUT) { console.log(JSON.stringify(d, null, 2)); }
else {
  const s = d.stats;
  console.log("=== AsA deep brain mining ===");
  console.log(`fragments scanned : ${s.fragments_scanned}`);
  console.log(`knowledge atoms   : ${s.atoms_mined}  (computable: ${s.computable_atoms})`);
  console.log(`by kind           : ${JSON.stringify(s.atoms_by_kind)}`);
  console.log(`by semantics      : ${JSON.stringify(s.atoms_by_semantic)}`);
  console.log(`top concepts      : ${JSON.stringify(s.concepts_seen)}`);
  console.log(`components        : ${s.components_built} ${JSON.stringify(s.components_by_role)}`);
  console.log(`candidates        : ${s.candidates_generated} ${JSON.stringify(s.candidates_by_runtime)}`);
  console.log(`combos considered : ${s.combinations_considered}  rejected: ${s.combinations_rejected}`);
  console.log(`rejection reasons : ${JSON.stringify(s.rejection_reasons)}`);
  console.log(`duration          : ${s.duration_ms} ms`);
}
