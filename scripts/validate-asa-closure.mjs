#!/usr/bin/env node
/**
 * Deterministic AsA source-to-runtime closure audit.
 *
 * Verifies source and compiled-contract identities, inventories every file under
 * knowledge/, checks source/manifest relationships and fail-closed eligibility,
 * then runs focused semantic regression suites and the required typecheck,
 * lint, full test, and build checks. A valid implementation may still report
 * CLOSURE_BLOCKED_BY_SOURCE; source incompleteness is never converted into an
 * eligible state.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const CONTRACT_PATH = "src/lib/strategy/compiled/source-contracts.json";
const CLOSURE_CONTRACT_DOC_PATH = "docs/roadmap/ASA_100_PERCENT_CONTRACT.md";
const LOCK_PATH = "src/lib/strategy/compiled/source-contracts.lock.json";
const PSY_MANIFEST_PATH = "knowledge/psychology/USER_PSYCHOLOGY_MANIFEST.json";
const PATCH_PATH = "knowledge/psychology/inbox/AsA_user_psychology_integration.patch.txt";
const PSY_SOURCE_PACK_PATH = "docs/psychology/USER_PSYCHOLOGY_SOURCE_PACK.md";
const REQUIRED_NPM_CHECKS = [
  { id: "typecheck", args: ["run", "typecheck"] },
  { id: "lint", args: ["run", "lint"] },
  { id: "full_tests", args: ["test"] },
  { id: "build", args: ["run", "build"] },
];
const FOCUSED_TESTS = [
  "tests/source-contract-bindings.test.ts",
  "tests/mining-project.test.ts",
  "tests/source-recovery.test.ts",
  "tests/brain-governance.test.ts",
  "tests/brain-safety.test.ts",
  "tests/user-psychology-source.test.ts",
  "tests/conflict-resolution.test.ts",
  "tests/rule-closure.test.ts",
  "tests/strategy-promotion.test.ts",
  "tests/closure.test.ts",
  "tests/validation-pipeline.test.ts",
  "tests/decision-truth-recovery.test.ts",
  "tests/open-book-coverage.test.ts",
  "tests/risk-settings.test.ts",
  "tests/system-config.test.ts",
  "tests/release-identity.test.ts",
  "tests/signal-publish.test.ts",
  "tests/live-timeframe-coverage.test.ts",
  "tests/live-signal-runtime.test.ts",
  "tests/ai-clone.test.ts",
];
const SUPPORT_IDENTITIES = [
  {
    path: PSY_MANIFEST_PATH,
    role: "SOURCE_IDENTITY_AND_EXTRACTION_METADATA; NOT_RAW_SOURCE",
    sha256: "e6baa5790bb54a68f599ec61886d31fda05c0b161d0818bc1a6705a10eb5bbf0",
    bytes: 7924,
    lines: 234,
  },
  {
    path: PATCH_PATH,
    role: "RETAINED_IMPLEMENTATION_PATCH; EXACT_CURRENT_SOURCE_COPIES_VERIFIED_BELOW; NOT_MISSING_CONTINUATION",
    sha256: "4142670196d49c7311a049b4fbdd9d37674f4b6e48aff5f3fafe83ebff737d59",
    bytes: 818916,
    lines: 3768,
  },
  {
    path: PSY_SOURCE_PACK_PATH,
    role: "HUMAN_READABLE_SOURCE_AUDIT; NOT_RAW_SOURCE_AUTHORITY",
    sha256: "ea46940f39d0c8ac7ed4b9304cc9d254c4c2ec7cedb209b562dd92750aa80abd",
    bytes: 5535,
    lines: 90,
  },
];
const SUPPLEMENTARY_PDF_IDENTITIES = [
  {
    path: "docs/archive/AsA_Master_Build_Bible_v1.0.pdf",
    role: "SUPPLEMENTARY_PRODUCT_ARCHITECTURE_REFERENCE",
    sha256: "1b85dfdf47c17c972e4e1325a560f1b8245d4ff086ec8121e609450541533edc",
    bytes: 145226,
    pages: 50,
  },
  {
    path: "docs/ttt/ttt-api-reference.pdf",
    role: "VENDOR_API_REFERENCE_NOT_STRATEGY_SOURCE",
    sha256: "ca64384650d1be2971122e1ca0f0a52a56a89db5c28087f45ea3452b6963b34b",
    bytes: 361619,
    pages: 20,
  },
];
const EXPECTED_COMPLETENESS = new Map([
  ["1.txt", "TRUNCATED"],
  ["2.txt", "TRUNCATED"],
  ["3.txt", "UNKNOWN"],
  ["4.txt", "TRUNCATED"],
  ["5.txt", "UNKNOWN"],
  ["USER-PSY-1", "TRUNCATED"],
  ["USER-PSY-2", "TRUNCATED"],
]);
const errors = [];
const sourceBlockers = [];
const artifactRelationships = [];
const supplementaryPdfResults = [];
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

function insideRepo(relative) {
  const full = path.resolve(ROOT, relative);
  if (full !== ROOT && !full.startsWith(`${ROOT}${path.sep}`)) {
    errors.push(`repository path escapes root: ${relative}`);
    return null;
  }
  return full;
}

function readBytes(relative) {
  const full = insideRepo(relative);
  if (!full) return null;
  try {
    return fs.readFileSync(full);
  } catch (error) {
    errors.push(`required artifact unavailable: ${relative} (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

function readJson(relative) {
  const bytes = readBytes(relative);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    errors.push(`invalid JSON artifact ${relative}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function identity(relative) {
  const bytes = readBytes(relative);
  if (!bytes) return null;
  const text = bytes.toString("utf8");
  const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
  return { path: relative, sha256: sha256(bytes), bytes: bytes.byteLength, lines: lineCount, chars: text.length, text };
}

function extractAddedFileFromPatch(patchText, relative) {
  const header = `+++ b/${relative}`;
  const lines = patchText.split(/\r?\n/);
  const positions = [];
  for (let i = 0; i < lines.length; i += 1) if (lines[i] === header) positions.push(i);
  if (positions.length !== 1) {
    errors.push(`retained patch must contain exactly one added-file section for ${relative}; found ${positions.length}`);
    return null;
  }
  const added = [];
  let inHunk = false;
  let noFinalNewline = false;
  for (let i = positions[0] + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("--- ") || line.startsWith("diff --git ")) break;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line === "\\ No newline at end of file") {
      noFinalNewline = true;
      continue;
    }
    if (line.startsWith("+")) {
      added.push(line.slice(1));
    } else {
      errors.push(`retained patch section for ${relative} is not an added-file-only hunk at line ${i + 1}`);
      return null;
    }
  }
  if (!inHunk) {
    errors.push(`retained patch has no added-file hunk for ${relative}`);
    return null;
  }
  const body = added.join("\n") + (noFinalNewline ? "" : "\n");
  return Buffer.from(body, "utf8");
}

function verifyPatchSourceCopy(patchText, relative) {
  const extracted = extractAddedFileFromPatch(patchText, relative);
  const current = readBytes(relative);
  if (!extracted || !current) return;
  if (!extracted.equals(current)) {
    errors.push(`retained patch added-file body does not byte-match current source ${relative}`);
    return;
  }
  artifactRelationships.push({
    patch_path: PATCH_PATH,
    file: relative,
    relation: "BYTE_IDENTICAL_ADDED_FILE_BODY",
    sha256: sha256(current),
    bytes: current.byteLength,
  });
}

function compareIdentity(relative, expected, fields = ["sha256", "bytes", "lines", "chars"]) {
  if (!isRecord(expected)) {
    errors.push(`identity metadata missing for ${relative}`);
    return null;
  }
  const actual = identity(relative);
  if (!actual) return null;
  for (const field of fields) {
    if (expected[field] !== actual[field]) {
      errors.push(`${relative} ${field} mismatch: expected ${String(expected[field])}, actual ${String(actual[field])}`);
    }
  }
  return actual;
}

function countPdfPages(relative) {
  const bytes = readBytes(relative);
  if (!bytes) return null;
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    errors.push(`supplementary document is not a PDF: ${relative}`);
    return null;
  }

  // Count page dictionaries both as ordinary indirect objects and inside Flate
  // object streams. This is intentionally a narrow inventory check, not a PDF
  // text extractor or a source-semantics parser.
  const pdf = bytes.toString("latin1");
  let pages = 0;
  const objectPattern = /^(\d+) \d+ obj\b([\s\S]*?)\bendobj\b/gm;
  for (const match of pdf.matchAll(objectPattern)) {
    const body = match[2];
    const streamMatch = /\bstream\r?\n/.exec(body);
    const dictionary = streamMatch ? body.slice(0, streamMatch.index) : body;
    if (/\/Type\s*\/Page(?!s)\b/.test(dictionary)) pages += 1;
    if (!streamMatch || !/\/Type\s*\/ObjStm\b/.test(dictionary) || !/\/FlateDecode\b/.test(dictionary)) continue;

    const endStream = body.lastIndexOf("endstream");
    if (endStream < streamMatch.index + streamMatch[0].length) {
      errors.push(`malformed PDF object stream in ${relative}`);
      continue;
    }
    let compressed = Buffer.from(body.slice(streamMatch.index + streamMatch[0].length, endStream), "latin1");
    while (compressed.length > 0 && (compressed[compressed.length - 1] === 0x0a || compressed[compressed.length - 1] === 0x0d)) {
      compressed = compressed.subarray(0, compressed.length - 1);
    }
    try {
      const decoded = inflateSync(compressed).toString("latin1");
      pages += [...decoded.matchAll(/\/Type\s*\/Page(?!s)\b/g)].length;
    } catch (error) {
      errors.push(`cannot count pages in PDF object stream ${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return pages;
}

function walkFiles(relative) {
  const full = insideRepo(relative);
  if (!full) return [];
  try {
    const result = [];
    for (const entry of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(`symbolic link is not permitted in source inventory: ${child}`);
      } else if (entry.isDirectory()) {
        result.push(...walkFiles(child));
      } else if (entry.isFile()) {
        result.push(child);
      }
    }
    return result;
  } catch (error) {
    errors.push(`cannot enumerate ${relative}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function collectRefs(strategy) {
  const refs = [
    ...(Array.isArray(strategy.source_refs) ? strategy.source_refs : []),
    ...Object.values(isRecord(strategy.field_status) ? strategy.field_status : {}).flatMap((field) => isRecord(field) && Array.isArray(field.source_refs) ? field.source_refs : []),
    ...(Array.isArray(strategy.blockers) ? strategy.blockers.flatMap((blocker) => isRecord(blocker) && Array.isArray(blocker.source_refs) ? blocker.source_refs : []) : []),
  ];
  return refs.filter(isRecord);
}

function collectImplementationRefs(strategy) {
  return [
    ...(Array.isArray(strategy.implementation_refs) ? strategy.implementation_refs : []),
    ...(Array.isArray(strategy.blockers) ? strategy.blockers.flatMap((blocker) => isRecord(blocker) && Array.isArray(blocker.implementation_refs) ? blocker.implementation_refs : []) : []),
  ].filter(isRecord);
}

const contractBytes = readBytes(CONTRACT_PATH);
const contract = readJson(CONTRACT_PATH);
const lock = readJson(LOCK_PATH);
const psychologyManifest = readJson(PSY_MANIFEST_PATH);
const sourcePack = readJson("knowledge/canonical/ASA_CANONICAL_KNOWLEDGE_PACK_v1_1.json");
const psychologySourcePack = identity(PSY_SOURCE_PACK_PATH);
const retainedPatch = identity(PATCH_PATH);
const closureContractDoc = identity(CLOSURE_CONTRACT_DOC_PATH);

if (closureContractDoc) {
  for (const heading of [
    "## Scope and decision rules",
    "## Supplied-source inventory",
    "## Source/history recovery audit",
    "## Source-to-runtime strategy status",
    "## Risk, psychology, and AI Clone boundary",
    "## Closure decision and remaining blockers",
  ]) {
    if (!closureContractDoc.text.includes(heading)) errors.push(`closure contract document is missing required section ${heading}`);
  }
}

if (!contract || !lock) {
  errors.push("source-contract JSON and lock are required");
}
const sourceBindings = contract && Array.isArray(contract.source_bindings) ? contract.source_bindings : [];
const bindingById = new Map(sourceBindings.filter(isRecord).map((binding) => [binding.file_id, binding]));
const sourceIdentities = new Map();
if (closureContractDoc && contract) {
  for (const binding of sourceBindings.filter(isRecord)) {
    if (!closureContractDoc.text.includes(binding.path) || !closureContractDoc.text.includes(binding.sha256)) {
      errors.push(`closure contract document omits the identity-bound source row for ${String(binding.file_id)}`);
    }
  }
}

if (contract) {
  if (contract.schema_version !== "1.2.0" || contract.contract_version !== "1.2.0") {
    errors.push(`unsupported source-contract version ${String(contract.schema_version)}/${String(contract.contract_version)}`);
  }
  if (contract.default_runtime_status !== "RESEARCH_ONLY" || contract.default_live_eligible !== false) {
    errors.push("source-contract defaults must remain RESEARCH_ONLY and not live eligible");
  }
  if (contract.canonical_index?.role !== "INDEX_ONLY") errors.push("canonical knowledge pack must remain INDEX_ONLY");
  if (typeof contract.authority !== "string" || !/raw.*authoritative/i.test(contract.authority)) {
    errors.push("source-contract must explicitly keep raw source bytes authoritative");
  }
  if (!Array.isArray(contract.strategies) || contract.strategies.length === 0) errors.push("source-contract strategy inventory is empty");
  if (sourceBindings.length !== 7) errors.push(`expected seven authoritative supplied text sources, found ${sourceBindings.length}`);
  const raw = sourceBindings.filter((binding) => String(binding.path).startsWith("knowledge/raw/"));
  const psychology = sourceBindings.filter((binding) => String(binding.path).startsWith("knowledge/psychology/USER_PSYCHOLOGY_"));
  if (raw.length !== 5 || psychology.length !== 2) errors.push(`source inventory must include 5 raw transcripts and 2 psychology transcripts (found ${raw.length}/${psychology.length})`);
  if (stable(raw.map((binding) => binding.file_id).sort()) !== stable(["1.txt", "2.txt", "3.txt", "4.txt", "5.txt"])) {
    errors.push("raw source identity mapping must contain 1.txt through 5.txt exactly once");
  }
  if (stable(psychology.map((binding) => binding.file_id).sort()) !== stable(["USER-PSY-1", "USER-PSY-2"])) {
    errors.push("psychology source identity mapping must contain USER-PSY-1 and USER-PSY-2 exactly once");
  }

  for (const binding of sourceBindings) {
    if (!isRecord(binding) || typeof binding.path !== "string") {
      errors.push("malformed source binding");
      continue;
    }
    const actual = compareIdentity(binding.path, binding);
    if (actual) sourceIdentities.set(binding.path, actual);
    if (!["COMPLETE", "TRUNCATED", "UNKNOWN"].includes(binding.completeness)) {
      errors.push(`invalid completeness state for ${binding.path}: ${String(binding.completeness)}`);
    }
    const expectedCompleteness = EXPECTED_COMPLETENESS.get(binding.file_id);
    if (binding.completeness !== expectedCompleteness) {
      errors.push(`${binding.file_id} completeness mismatch: expected ${String(expectedCompleteness)}, actual ${String(binding.completeness)}`);
    }
    if (binding.completeness === "UNKNOWN") {
      sourceBlockers.push(`${binding.file_id}: completeness is UNKNOWN; it is not treated as COMPLETE`);
    } else if (binding.completeness === "TRUNCATED") {
      sourceBlockers.push(`${binding.file_id}: source is explicitly marked TRUNCATED`);
    }
  }

  const canonical = contract.canonical_index;
  if (!isRecord(canonical) || typeof canonical.path !== "string") errors.push("canonical index identity is missing");
  else {
    const actual = compareIdentity(canonical.path, canonical, ["sha256", "bytes", "lines"]);
    if (actual && actual.path !== canonical.path) errors.push("canonical index path identity mismatch");
  }

  const implementationBindings = Array.isArray(contract.implementation_bindings) ? contract.implementation_bindings : [];
  const implementationByPath = new Map(implementationBindings.filter(isRecord).map((binding) => [binding.file, binding]));
  for (const binding of implementationBindings) {
    if (!isRecord(binding) || typeof binding.file !== "string") {
      errors.push("malformed implementation binding");
      continue;
    }
    compareIdentity(binding.file, binding, ["sha256"]);
  }
  if (!isRecord(contract.validator_binding) || typeof contract.validator_binding.file !== "string") {
    errors.push("source-contract validator binding is missing");
  } else {
    compareIdentity(contract.validator_binding.file, contract.validator_binding, ["sha256"]);
  }

  for (const strategy of Array.isArray(contract.strategies) ? contract.strategies.filter(isRecord) : []) {
    const id = String(strategy.strategy_id ?? "UNKNOWN");
    if (strategy.contract_status !== "SOURCE_FAITHFUL") {
      sourceBlockers.push(`${id}: source contract is ${String(strategy.contract_status)}; semantic parity is not established`);
      if (strategy.runtime_status === "EXECUTABLE" || strategy.promotion_eligible === true || strategy.live_eligible === true) {
        errors.push(`${id} has runtime/promotion eligibility despite a non-faithful source contract`);
      }
    } else {
      const unresolved = Object.entries(isRecord(strategy.field_status) ? strategy.field_status : {})
        .filter(([, field]) => !isRecord(field) || !["SOURCE_VERIFIED", "DETERMINISTIC", "ADJUDICATED_FROM_EXPLICIT_SOURCE_ACTION"].includes(String(field.status)))
        .map(([field]) => field);
      if (strategy.source_completeness !== "COMPLETE" || strategy.semantic_validation?.status !== "PASS" || strategy.semantic_validation?.test_ids?.length === 0 || (strategy.blockers?.length ?? 0) > 0 || unresolved.length > 0) {
        errors.push(`${id} claims SOURCE_FAITHFUL without complete source fields, named semantic proof, resolved fields, and no blockers`);
      }
    }

    for (const ref of collectRefs(strategy)) {
      const binding = bindingById.get(ref.file);
      if (!binding) {
        errors.push(`${id} source reference has no exact source identity binding: ${String(ref.file)}`);
        continue;
      }
      const source = sourceIdentities.get(binding.path);
      if (!source || !Number.isSafeInteger(ref.start_line) || !Number.isSafeInteger(ref.end_line) || ref.start_line < 1 || ref.end_line < ref.start_line || ref.end_line > source.lines) {
        errors.push(`${id} source range is outside the supplied bytes: ${String(binding.path)}:${String(ref.start_line)}-${String(ref.end_line)}`);
      }
    }

    for (const ref of collectImplementationRefs(strategy)) {
      const binding = implementationByPath.get(ref.file);
      if (!binding) {
        errors.push(`${id} implementation reference has no identity binding: ${String(ref.file)}`);
        continue;
      }
      const implementation = identity(String(ref.file));
      if (!implementation || typeof ref.symbol !== "string" || !implementation.text.includes(ref.symbol)) {
        errors.push(`${id} implementation symbol is absent: ${String(ref.file)}#${String(ref.symbol)}`);
      }
    }
  }

  if (contractBytes && lock) {
    if (lock.lock_version !== "1.1.0" || lock.contract_path !== CONTRACT_PATH) errors.push("source-contract lock version/path mismatch");
    if (lock.contract_sha256 !== sha256(contractBytes)) errors.push("source-contract bytes differ from the checked-in lock hash");
    for (const key of ["source_bindings", "canonical_index", "implementation_bindings", "validator_binding"]) {
      if (stable(lock[key]) !== stable(contract[key])) errors.push(`source-contract lock ${key} differs from the contract`);
    }
  }
}

if (psychologyManifest && contract) {
  const psychSources = Array.isArray(psychologyManifest.sources) ? psychologyManifest.sources : [];
  const psychBindings = sourceBindings.filter((binding) => String(binding.path).startsWith("knowledge/psychology/USER_PSYCHOLOGY_"));
  if (psychSources.length !== 2) errors.push(`psychology source manifest must describe 2 files, found ${psychSources.length}`);
  for (const binding of psychBindings) {
    const row = psychSources.find((source) => source.repository_filename === path.basename(binding.path));
    if (!row) {
      errors.push(`psychology manifest omits ${binding.path}`);
      continue;
    }
    for (const [manifestField, bindingField] of [["sha256", "sha256"], ["total_bytes", "bytes"], ["total_lines", "lines"], ["total_chars", "chars"]]) {
      if (row[manifestField] !== binding[bindingField]) errors.push(`psychology manifest ${path.basename(binding.path)} ${manifestField} differs from source binding`);
    }
    if (row.truncated !== (binding.completeness === "TRUNCATED")) errors.push(`psychology manifest truncation flag differs from source binding for ${binding.file_id}`);
  }
  for (const section of Array.isArray(psychologyManifest.sections) ? psychologyManifest.sections : []) {
    const binding = psychBindings.find((source) => source.file_id === section.file_id);
    if (!binding || section.start_line < 1 || section.end_line < section.start_line || section.end_line > binding.lines) {
      errors.push(`psychology manifest section has invalid range: ${String(section.file_id)}:${String(section.start_line)}-${String(section.end_line)}`);
    }
  }
  for (const principle of Array.isArray(psychologyManifest.source_only_rules) ? psychologyManifest.source_only_rules : []) {
    for (const ref of Array.isArray(principle.source_refs) ? principle.source_refs : []) {
      const binding = psychBindings.find((source) => path.basename(source.path) === ref.file);
      if (!binding || ref.start_line < 1 || ref.end_line < ref.start_line || ref.end_line > binding.lines) {
        errors.push(`psychology principle has invalid source range: ${String(principle.id)} ${String(ref.file)}:${String(ref.start_line)}-${String(ref.end_line)}`);
      }
    }
  }
}

if (sourcePack && contract) {
  if (!Array.isArray(sourcePack.source_files) || sourcePack.source_files.length !== 5) errors.push("canonical index must list exactly the five raw source identities");
  for (const binding of sourceBindings.filter((row) => String(row.path).startsWith("knowledge/raw/"))) {
    const sourceName = sourcePack.source_files?.find((row) => row.file === binding.file_id);
    if (!sourceName || sourceName.sha256 !== binding.sha256 || sourceName.lines !== binding.lines || sourceName.chars !== binding.chars) {
      errors.push(`canonical index identity is not aligned to raw source ${binding.file_id}`);
    }
  }
}

for (const support of SUPPORT_IDENTITIES) compareIdentity(support.path, support, ["sha256", "bytes", "lines"]);
for (const document of SUPPLEMENTARY_PDF_IDENTITIES) {
  compareIdentity(document.path, document, ["sha256", "bytes"]);
  const pages = countPdfPages(document.path);
  if (pages !== document.pages) errors.push(`${document.path} page count mismatch: expected ${document.pages}, actual ${String(pages)}`);
  if (closureContractDoc) {
    const formattedBytes = String(document.bytes).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    for (const value of [document.path, document.sha256, formattedBytes, String(document.pages)]) {
      if (!closureContractDoc.text.includes(value)) errors.push(`closure contract document omits supplementary PDF identity value ${value}`);
    }
  }
  supplementaryPdfResults.push({ path: document.path, role: document.role, sha256: document.sha256, bytes: document.bytes, pages });
}
if (!psychologySourcePack) errors.push(`human-readable psychology source pack is unavailable: ${PSY_SOURCE_PACK_PATH}`);
if (!retainedPatch) errors.push(`retained psychology source patch is unavailable: ${PATCH_PATH}`);
else {
  verifyPatchSourceCopy(retainedPatch.text, "knowledge/psychology/USER_PSYCHOLOGY_1.txt");
  verifyPatchSourceCopy(retainedPatch.text, "knowledge/psychology/USER_PSYCHOLOGY_2.txt");
}

const expectedKnowledge = new Set([
  ...sourceBindings.map((binding) => binding.path),
  contract?.canonical_index?.path,
  PSY_MANIFEST_PATH,
  PATCH_PATH,
].filter((value) => typeof value === "string"));
const actualKnowledge = new Set(walkFiles("knowledge"));
for (const file of expectedKnowledge) if (!actualKnowledge.has(file)) errors.push(`knowledge inventory is missing ${file}`);
for (const file of actualKnowledge) if (!expectedKnowledge.has(file)) errors.push(`unclassified knowledge artifact requires inventory review: ${file}`);

const testBin = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
let focusedTests = { status: "NOT_RUN", exit_code: null };
if (!fs.existsSync(testBin)) {
  errors.push("Vitest is unavailable; install the repository's declared dev dependencies before closure validation");
} else {
  const run = spawnSync(process.execPath, [testBin, "run", "--reporter=dot", ...FOCUSED_TESTS], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  const exitCode = run.status ?? 1;
  focusedTests = { status: exitCode === 0 ? "PASS" : "FAIL", exit_code: exitCode };
  if (run.error) errors.push(`focused closure tests could not complete: ${run.error.message}`);
  if (exitCode !== 0) errors.push(`focused closure tests failed with exit code ${exitCode}`);
}

const requiredChecks = [];
for (const check of REQUIRED_NPM_CHECKS) {
  const run = spawnSync("npm", check.args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  const exitCode = run.status ?? 1;
  const result = { id: check.id, status: exitCode === 0 ? "PASS" : "FAIL", exit_code: exitCode };
  requiredChecks.push(result);
  if (run.error) errors.push(`required ${check.id} check could not complete: ${run.error.message}`);
  if (exitCode !== 0) errors.push(`required ${check.id} check failed with exit code ${exitCode}`);
}

let status = errors.length > 0
  ? "CLOSURE_BLOCKED_BY_IMPLEMENTATION"
  : sourceBlockers.length > 0
    ? "CLOSURE_BLOCKED_BY_SOURCE"
    : "CLOSURE_READY";
const statedDocumentStatus = closureContractDoc?.text.match(/^\*\*Computed closure status:\*\* `([^`]+)`/m)?.[1];
if (statedDocumentStatus !== status) {
  errors.push(`closure contract document status differs from deterministic result: document=${String(statedDocumentStatus)}, validator=${status}`);
  status = "CLOSURE_BLOCKED_BY_IMPLEMENTATION";
}
const result = {
  validator: "AsA deterministic source-to-runtime closure validator",
  validator_version: "1.2.0",
  status,
  contract_document: closureContractDoc ? { path: closureContractDoc.path, sha256: closureContractDoc.sha256, bytes: closureContractDoc.bytes, lines: closureContractDoc.lines } : null,
  artifact_relationships: artifactRelationships,
  supplementary_documents: supplementaryPdfResults,
  source_inventory: {
    authoritative_text_sources: sourceBindings.length,
    raw_transcripts: sourceBindings.filter((binding) => String(binding.path).startsWith("knowledge/raw/")).length,
    psychology_transcripts: sourceBindings.filter((binding) => String(binding.path).startsWith("knowledge/psychology/USER_PSYCHOLOGY_")).length,
    completeness: Object.fromEntries(["COMPLETE", "TRUNCATED", "UNKNOWN"].map((state) => [state, sourceBindings.filter((binding) => binding.completeness === state).length])),
    canonical_index_role: contract?.canonical_index?.role ?? "UNKNOWN",
    supporting_artifacts: SUPPORT_IDENTITIES.map(({ path: file, role, sha256: digest, bytes, lines }) => ({ path: file, role, sha256: digest, bytes, lines })),
  },
  compiled_source_contracts: {
    strategies: Array.isArray(contract?.strategies) ? contract.strategies.length : 0,
    setups: Array.isArray(contract?.strategies) ? contract.strategies.reduce((count, strategy) => count + (Array.isArray(strategy.compiled_bindings) ? strategy.compiled_bindings.length : 0), 0) : 0,
    statuses: Object.fromEntries([...new Set((contract?.strategies ?? []).map((strategy) => strategy.contract_status))].sort().map((value) => [value, contract.strategies.filter((strategy) => strategy.contract_status === value).length])),
  },
  focused_tests: { files: FOCUSED_TESTS, ...focusedTests },
  required_checks: requiredChecks,
  source_blockers: [...new Set(sourceBlockers)].sort(),
  implementation_errors: [...new Set(errors)].sort(),
};
console.log("\n=== AsA closure validation ===");
console.log(JSON.stringify(result, null, 2));
process.exitCode = errors.length > 0 ? 1 : 0;
