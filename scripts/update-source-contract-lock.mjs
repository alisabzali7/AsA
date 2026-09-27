#!/usr/bin/env node
/** Deliberately bind a source-contract document to exact source/implementation bytes. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const contractPath = "src/lib/strategy/compiled/source-contracts.json";
const lockPath = "src/lib/strategy/compiled/source-contracts.lock.json";
const contract = JSON.parse(fs.readFileSync(path.join(root, contractPath), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (relative) => {
  const full = path.resolve(root, relative);
  if (!full.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe repository path: ${relative}`);
  return full;
};
const assertIdentity = (relative, expected, fields) => {
  const bytes = fs.readFileSync(inside(relative));
  const text = bytes.toString("utf8");
  const actual = { sha256: digest(bytes), bytes: bytes.byteLength, lines: text.split("\n").length, chars: text.length };
  for (const field of fields) {
    if (expected[field] !== actual[field]) throw new Error(`${relative} ${field} mismatch: contract=${expected[field]}, actual=${actual[field]}`);
  }
  return { bytes, text, actual };
};

if (contract.schema_version !== "1.2.0" || contract.contract_version !== "1.2.0") {
  throw new Error(`unsupported source-contract version: ${contract.schema_version}/${contract.contract_version}`);
}
if (!contract.validator_binding || typeof contract.validator_binding.file !== "string") {
  throw new Error("source-contract validator binding is required");
}
for (const binding of contract.source_bindings ?? []) {
  assertIdentity(binding.path, binding, ["sha256", "bytes", "lines", "chars"]);
}
const index = contract.canonical_index;
if (!index || index.role !== "INDEX_ONLY") throw new Error("canonical index must be explicitly INDEX_ONLY");
assertIdentity(index.path, index, ["sha256", "bytes", "lines"]);

const references = new Map();
for (const strategy of contract.strategies ?? []) {
  const refs = [
    ...(strategy.implementation_refs ?? []),
    ...(strategy.blockers ?? []).flatMap((blocker) => blocker.implementation_refs ?? []),
  ];
  for (const ref of refs) {
    if (!references.has(ref.file)) references.set(ref.file, new Set());
    references.get(ref.file).add(ref.symbol);
  }
}
const implementationBindings = [...references.keys()].sort().map((file) => {
  const { bytes, text } = assertIdentity(file, {}, []);
  for (const symbol of references.get(file)) {
    if (!text.includes(symbol)) throw new Error(`implementation symbol not found: ${file}#${symbol}`);
  }
  return { file, sha256: digest(bytes) };
});
contract.implementation_bindings = implementationBindings;
const validator = assertIdentity(contract.validator_binding.file, {}, []);
contract.validator_binding.sha256 = digest(validator.bytes);
const contractBytes = `${JSON.stringify(contract, null, 2)}\n`;
fs.writeFileSync(inside(contractPath), contractBytes);
const lock = {
  lock_version: "1.1.0",
  contract_path: contractPath,
  contract_sha256: digest(Buffer.from(contractBytes, "utf8")),
  implementation_bindings: implementationBindings,
  source_bindings: contract.source_bindings,
  canonical_index: contract.canonical_index,
  validator_binding: contract.validator_binding,
};
fs.writeFileSync(inside(lockPath), `${JSON.stringify(lock, null, 2)}\n`);
console.log(JSON.stringify({ contract_sha256: lock.contract_sha256, implementation_files: implementationBindings.length, source_files: lock.source_bindings.length }, null, 2));
