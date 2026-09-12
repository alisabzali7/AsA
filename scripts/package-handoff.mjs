#!/usr/bin/env node
/**
 * Build the SOURCE HANDOFF archive (§I, §R).
 *
 * Includes source-of-truth only. Excludes runtime DBs, git metadata, caches,
 * secrets and build output — all of which are rebuildable or must never ship.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

// The archive is BUILD OUTPUT: written OUTSIDE the project tree so a handoff
// can never contain a nested ZIP of itself.
const OUT_DIR = process.env.ASA_HANDOFF_DIR || "..";
const OUT_NAME = "asa-source-handoff-final.zip";
const OUT = `${OUT_DIR}/${OUT_NAME}`;
const EXCLUDES = [
  // Directory excludes use BOTH `dir/*` and `dir/**` so nested paths such as
  // `.git/refs/heads/master` can never slip through.
  "node_modules/*", "node_modules/**",
  ".git/*", ".git/**", ".git", ".gitmodules",
  ".next/*", ".next/**", ".npm/*", ".npm/**",
  "out/*", "out/**", "coverage/*", "coverage/**",
  "logs/*", "logs/**", "cache/*", "cache/**", ".cache/*", ".cache/**",
  "asa-data/*", "asa-data/**",
  // local tool caches (machine-specific, never source)
  ".config/*", ".config/**",
  "*.db", "*.db-wal", "*.db-shm", "*.sqlite", "*.sqlite3",
  ".env", ".env.local", ".env.*", "*.tsbuildinfo",
  "uploads/*", "uploads/**", "*.log", ".DS_Store", `${OUT}`,
  ".asa-ingest-*", ".asa-val-*", ".asa-mine-*", "*.cjs.map",
  "*.zip", "_verify/*", "_verify/**",
];
// Stamp the packaged status artifacts with the ACTUAL current HEAD.
// A status file cannot name its own commit (writing the hash changes it), so we
// stamp at PACKAGE time: the archive then always reports the commit whose tree
// it contains. Working-tree files are restored immediately afterwards.
const HEAD = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const STAMPED = ["FINAL_STATUS.md", "FINAL_PROJECT_MANIFEST.md", "PROJECT_SIZE_REPORT.md", "MACHINE_READABLE_STATUS.json"];
const originals = new Map();
for (const f of STAMPED) {
  if (!fs.existsSync(f)) continue;
  const before = fs.readFileSync(f, "utf8");
  originals.set(f, before);
  let after;
  if (f.endsWith(".json")) {
    // JSON: stamp ONLY the `current` block; history[] hashes must stay intact.
    const j = JSON.parse(before);
    if (j.current) {
      j.current.git_commit = HEAD;
      j.current.git_commit_full = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    }
    after = JSON.stringify(j, null, 2);
  } else {
    // Markdown: only the "**Commit:** `xxxxxxx`" line names the current commit.
    after = before.replace(/(\*\*Commit:\*\* `)[0-9a-f]{7}(`)/g, `$1${HEAD}$2`);
  }
  fs.writeFileSync(f, after);
}

fs.rmSync(OUT, { force: true });
const ex = EXCLUDES.map((e) => `-x '${e}'`).join(" ");
execSync(`zip -r -q ${OUT} . ${ex}`, { stdio: "inherit" });

// restore the working tree exactly as it was
for (const [f, before] of originals) fs.writeFileSync(f, before);

const size = fs.statSync(OUT).size;
const mb = (size / 1024 / 1024).toFixed(2);
const listing = execSync(`unzip -l ${OUT}`, { encoding: "utf8" })
  // the zip header line names the archive itself; exclude it from the scan
  .split("\n").filter((l) => !l.includes(`Archive:  ${OUT}`)).join("\n");
const files = listing.trim().split("\n").length - 5;

// verify nothing forbidden slipped in
const gitEntries = listing.split("\n").filter((l) => /(^|\s)\.git\//.test(l));
if (gitEntries.length > 0) {
  console.error(`FATAL: ${gitEntries.length} .git entries found in the archive`);
  process.exitCode = 1;
}
console.log(`git entries: ${gitEntries.length} (must be 0)`);

const forbidden = [
  ".env.local", "asa-data/", ".git/", "history.db", "brain.db", "asa.db",
  "node_modules/", ".db-wal", ".db-shm", "tsbuildinfo",
  ".next/", ".npm/",
];
const leaked = forbidden.filter((f) => listing.includes(f));

console.log(`archive : ${OUT}`);
console.log(`size    : ${mb} MB (${size} bytes)`);
console.log(`files   : ${files}`);
console.log(`target  : < 10 MB -> ${size < 10 * 1024 * 1024 ? "PASS" : "FAIL"}`);
// SHA256 for reproducible handoff verification
const crypto = await import("node:crypto");
const sha = crypto.createHash("sha256").update(fs.readFileSync(OUT)).digest("hex");
console.log(`head    : ${HEAD} (stamped into packaged status artifacts)`);
console.log(`sha256  : ${sha}`);
console.log(`forbidden entries: ${leaked.length ? leaked.join(", ") : "NONE"}`);
fs.writeFileSync(`${OUT}.sha256`, `${sha}  ${OUT_NAME}\n`);
if (leaked.length) process.exitCode = 1;
