import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { COMPILED_STRATEGIES } from ".";
import sourceContractData from "./source-contracts.json";
import sourceContractLock from "./source-contracts.lock.json";

export type SourceContractStatus = "SOURCE_FAITHFUL" | "INCOMPLETE" | "CONFLICTING" | "UNKNOWN";
export type ContractEvidenceStatus =
  | "SOURCE_VERIFIED"
  | "DETERMINISTIC"
  | "INFERRED"
  | "UNKNOWN"
  | "CONFLICTING"
  | "NOT_PRESENT"
  | "PARTIAL"
  | "SOURCE_NAMED"
  | "CLAIM"
  | "ADJUDICATED_FROM_EXPLICIT_SOURCE_ACTION";
export type RuntimeContractStatus = "EXECUTABLE" | "RESEARCH_ONLY" | "DISABLED";

export interface SourceContractReference {
  file: string;
  start_line: number;
  end_line: number;
}

export interface CompiledVersionBinding {
  setup_id: string;
  direction: "long" | "short";
  timeframe: string;
  strategy_version: string;
  rule_versions: string[];
}

export interface CompiledSourceContract {
  strategy_id: string;
  canonical_name: string;
  compiled_bindings: CompiledVersionBinding[];
  contract_status: SourceContractStatus;
  record_source_status: string;
  source_completeness: string;
  semantic_validation: {
    status: "PASS" | "NOT_PROVEN" | "FAIL";
    method: string;
    test_ids: string[];
  };
  runtime_status: RuntimeContractStatus;
  empirical_status: string;
  promotion_eligible: boolean;
  live_eligible: boolean;
  source_refs: SourceContractReference[];
  implementation_refs: { file: string; symbol: string }[];
  blockers: {
    id: string;
    status: ContractEvidenceStatus;
    statement: string;
    source_refs: SourceContractReference[];
    implementation_refs: { file: string; symbol: string }[];
  }[];
  field_status: Record<string, { status: ContractEvidenceStatus; source_refs: SourceContractReference[]; [key: string]: unknown }>;
}

export interface SourceContractData {
  schema_version: string;
  contract_version: string;
  purpose: string;
  authority: string;
  semantic_proof_policy: string;
  validator_binding: { file: string; sha256: string };
  default_runtime_status: RuntimeContractStatus;
  default_live_eligible: false;
  source_bindings: {
    file_id: string;
    path: string;
    source_version: string;
    sha256: string;
    bytes: number;
    lines: number;
    chars: number;
    completeness: "COMPLETE" | "TRUNCATED" | "UNKNOWN";
  }[];
  canonical_index: { path: string; source_version: string; sha256: string; bytes: number; lines: number; role: "INDEX_ONLY" };
  implementation_bindings: { file: string; sha256: string }[];
  strategies: CompiledSourceContract[];
}

const STATUS = new Set<ContractEvidenceStatus>([
  "SOURCE_VERIFIED", "DETERMINISTIC", "INFERRED", "UNKNOWN", "CONFLICTING",
  "NOT_PRESENT", "PARTIAL", "SOURCE_NAMED", "CLAIM", "ADJUDICATED_FROM_EXPLICIT_SOURCE_ACTION",
]);
const CONTRACT_STATUS = new Set<SourceContractStatus>(["SOURCE_FAITHFUL", "INCOMPLETE", "CONFLICTING", "UNKNOWN"]);
const RUNTIME_STATUS = new Set<RuntimeContractStatus>(["EXECUTABLE", "RESEARCH_ONLY", "DISABLED"]);
const SHA256 = /^[0-9a-f]{64}$/;
export const SOURCE_CONTRACT_SCHEMA_VERSION = "1.2.0";
export const SOURCE_CONTRACT_VERSION = "1.2.0";
export const SOURCE_CONTRACT_LOCK_VERSION = "1.1.0";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function validRef(value: unknown): value is SourceContractReference {
  if (!isRecord(value)) return false;
  return nonempty(value.file) && positiveInt(value.start_line) && positiveInt(value.end_line) &&
    (value.end_line as number) >= (value.start_line as number);
}

function validImplementationRef(value: unknown): value is { file: string; symbol: string } {
  if (!isRecord(value) || !nonempty(value.file) || !nonempty(value.symbol)) return false;
  return !value.file.startsWith("/") && !value.file.split(/[\\/]/).includes("..") && value.file.startsWith("src/");
}

/** Runtime schema checks are deliberately strict; malformed data becomes UNKNOWN. */
export interface SourceContractArtifactInventory {
  sources: Record<string, { sha256: string; bytes: number; lines: number; chars: number; source_version?: string }>;
  canonical_index?: { path: string; sha256: string; bytes: number; lines: number; source_version?: string };
  implementations: Record<string, { sha256: string; text: string }>;
  validator?: { file: string; sha256: string };
}

export function validateSourceContractArtifacts(data: unknown, inventory: SourceContractArtifactInventory): string[] {
  const errors = validateSourceContractData(data);
  if (!isRecord(data)) return errors;
  const sourceBindings = Array.isArray(data.source_bindings) ? data.source_bindings.filter(isRecord) : [];
  const sourceById = new Map(sourceBindings.filter((binding) => typeof binding.file_id === "string").map((binding) => [String(binding.file_id), binding]));
  for (const binding of sourceBindings) {
    if (typeof binding.file_id !== "string" || typeof binding.path !== "string") continue;
    const actual = inventory.sources[binding.path];
    if (!actual) { errors.push(`source artifact missing: ${binding.path}`); continue; }
    for (const field of ["sha256", "bytes", "lines", "chars"] as const) {
      if (actual[field] !== binding[field]) errors.push(`source identity mismatch ${binding.path}.${field}`);
    }
    if (actual.source_version !== undefined && actual.source_version !== binding.source_version) errors.push(`source identity mismatch ${binding.path}.source_version`);
  }
  const canonical = isRecord(data.canonical_index) ? data.canonical_index : null;
  if (!canonical || typeof canonical.path !== "string" || !inventory.canonical_index) {
    errors.push("canonical index artifact missing from supplied identity inventory");
  } else {
    const actual = inventory.canonical_index;
    if (actual.path !== canonical.path || actual.sha256 !== canonical.sha256 || actual.bytes !== canonical.bytes || actual.lines !== canonical.lines || (actual.source_version !== undefined && actual.source_version !== canonical.source_version)) {
      errors.push("canonical index identity mismatch");
    }
  }
  const validatorBinding = isRecord(data.validator_binding) ? data.validator_binding : null;
  if (!validatorBinding || !inventory.validator) errors.push("source-contract validator artifact missing from supplied identity inventory");
  else if (validatorBinding.file !== inventory.validator.file || validatorBinding.sha256 !== inventory.validator.sha256) errors.push("source-contract validator implementation identity mismatch");
  for (const strategy of (Array.isArray(data.strategies) ? data.strategies : []).filter(isRecord)) {
    const id = String(strategy.strategy_id ?? "UNKNOWN");
    const sourceRefs: Record<string, unknown>[] = [
      ...(Array.isArray(strategy.source_refs) ? strategy.source_refs.filter(isRecord) : []),
      ...Object.values(isRecord(strategy.field_status) ? strategy.field_status : {}).flatMap((field) => isRecord(field) && Array.isArray(field.source_refs) ? field.source_refs.filter(isRecord) : []),
      ...(Array.isArray(strategy.blockers) ? strategy.blockers.filter(isRecord).flatMap((blocker) => Array.isArray(blocker.source_refs) ? blocker.source_refs.filter(isRecord) : []) : []),
    ];
    const referencedBindings: Record<string, unknown>[] = [];
    for (const ref of sourceRefs) {
      const binding = sourceById.get(String(ref.file));
      if (!binding) { errors.push(`${id} source reference has no bound identity: ${String(ref.file)}`); continue; }
      referencedBindings.push(binding);
      const sourcePath = String(binding.path);
      const actual = inventory.sources[sourcePath];
      if (!actual || typeof ref.end_line !== "number" || ref.end_line > actual.lines) errors.push(`${id} source reference exceeds supplied lines: ${sourcePath}:${String(ref.start_line)}-${String(ref.end_line)}`);
    }
    if (strategy.source_completeness === "COMPLETE" && referencedBindings.some((binding) => binding.completeness !== "COMPLETE")) {
      errors.push(`${id} claims COMPLETE source while a referenced source binding is incomplete`);
    }
    const implementationRefs: Record<string, unknown>[] = [
      ...(Array.isArray(strategy.implementation_refs) ? strategy.implementation_refs.filter(isRecord) : []),
      ...(Array.isArray(strategy.blockers) ? strategy.blockers.filter(isRecord).flatMap((blocker) => Array.isArray(blocker.implementation_refs) ? blocker.implementation_refs.filter(isRecord) : []) : []),
    ];
    for (const ref of implementationRefs) {
      const file = String(ref.file);
      const expected = (Array.isArray(data.implementation_bindings) ? data.implementation_bindings : [])
        .filter(isRecord).find((binding) => binding.file === file);
      const actual = inventory.implementations[file];
      if (!expected || !actual) { errors.push(`${id} implementation artifact missing: ${file}`); continue; }
      if (actual.sha256 !== expected.sha256) errors.push(`implementation identity mismatch: ${file}`);
      if (typeof ref.symbol !== "string" || !actual.text.includes(ref.symbol)) errors.push(`${id} implementation symbol is not present: ${file}#${String(ref.symbol)}`);
    }
    const semantic = isRecord(strategy.semantic_validation) ? strategy.semantic_validation : null;
    if (strategy.contract_status === "SOURCE_FAITHFUL" && (!semantic || semantic.status !== "PASS" || !Array.isArray(semantic.test_ids) || semantic.test_ids.length === 0)) {
      errors.push(`${id} claims SOURCE_FAITHFUL without named semantic tests`);
    }
  }
  return [...new Set(errors)].sort();
}

export function validateSourceContractData(data: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(data)) return ["source-contract document must be an object"];
  for (const key of ["schema_version", "contract_version", "purpose", "authority", "semantic_proof_policy"] as const) {
    if (!nonempty(data[key])) errors.push(`${key} is required`);
  }
  if (data.schema_version !== SOURCE_CONTRACT_SCHEMA_VERSION) errors.push(`unsupported schema_version ${String(data.schema_version)}; expected ${SOURCE_CONTRACT_SCHEMA_VERSION}`);
  if (data.contract_version !== SOURCE_CONTRACT_VERSION) errors.push(`unsupported contract_version ${String(data.contract_version)}; expected ${SOURCE_CONTRACT_VERSION}`);
  const validatorBinding = isRecord(data.validator_binding) ? data.validator_binding : null;
  if (!validatorBinding || !validImplementationRef({ file: validatorBinding.file, symbol: "validateSourceContractData" })) {
    errors.push("validator_binding.file must identify a repository-local validator implementation");
  }
  if (!validatorBinding || typeof validatorBinding.sha256 !== "string" || !SHA256.test(validatorBinding.sha256)) {
    errors.push("validator_binding.sha256 is invalid");
  }
  if (data.default_runtime_status !== "RESEARCH_ONLY") errors.push("default_runtime_status must be RESEARCH_ONLY");
  if (data.default_live_eligible !== false) errors.push("default_live_eligible must be false");

  if (!Array.isArray(data.source_bindings) || data.source_bindings.length === 0) {
    errors.push("source_bindings must be a non-empty array");
  } else {
    const ids = new Set<string>();
    for (const [i, binding] of data.source_bindings.entries()) {
      if (!isRecord(binding)) { errors.push(`source_bindings[${i}] must be an object`); continue; }
      for (const key of ["file_id", "path", "source_version"] as const) {
        if (!nonempty(binding[key])) errors.push(`source_bindings[${i}].${key} is required`);
      }
      if (typeof binding.file_id === "string") {
        if (ids.has(binding.file_id)) errors.push(`duplicate source binding ${binding.file_id}`);
        ids.add(binding.file_id);
      }
      if (typeof binding.path === "string" && (binding.path.startsWith("/") || binding.path.split(/[\\/]/).includes(".."))) {
        errors.push(`source_bindings[${i}].path must remain inside the repository`);
      }
      if (typeof binding.sha256 !== "string" || !SHA256.test(binding.sha256)) errors.push(`source_bindings[${i}].sha256 is invalid`);
      for (const key of ["bytes", "lines", "chars"] as const) if (!positiveInt(binding[key])) errors.push(`source_bindings[${i}].${key} must be a positive integer`);
      if (!("COMPLETE" === binding.completeness || "TRUNCATED" === binding.completeness || "UNKNOWN" === binding.completeness)) {
        errors.push(`source_bindings[${i}].completeness is invalid`);
      }
    }
  }

  if (!isRecord(data.canonical_index)) errors.push("canonical_index is required");
  else {
    for (const key of ["path", "source_version"] as const) if (!nonempty(data.canonical_index[key])) errors.push(`canonical_index.${key} is required`);
    if (typeof data.canonical_index.sha256 !== "string" || !SHA256.test(data.canonical_index.sha256)) errors.push("canonical_index.sha256 is invalid");
    if (!positiveInt(data.canonical_index.bytes) || !positiveInt(data.canonical_index.lines)) errors.push("canonical_index size identity is invalid");
    if (data.canonical_index.role !== "INDEX_ONLY") errors.push("canonical_index.role must be INDEX_ONLY");
  }

  const sourceIds = new Set(Array.isArray(data.source_bindings)
    ? data.source_bindings.filter(isRecord).map((b) => b.file_id).filter((id): id is string => typeof id === "string")
    : []);
  if (!Array.isArray(data.strategies) || data.strategies.length === 0) {
    errors.push("strategies must be a non-empty array");
  } else {
    const strategyIds = new Set<string>();
    for (const [i, strategy] of data.strategies.entries()) {
      const prefix = `strategies[${i}]`;
      if (!isRecord(strategy)) { errors.push(`${prefix} must be an object`); continue; }
      for (const key of ["strategy_id", "canonical_name", "record_source_status", "source_completeness", "empirical_status"] as const) {
        if (!nonempty(strategy[key])) errors.push(`${prefix}.${key} is required`);
      }
      if (typeof strategy.strategy_id === "string") {
        if (strategyIds.has(strategy.strategy_id)) errors.push(`duplicate strategy contract ${strategy.strategy_id}`);
        strategyIds.add(strategy.strategy_id);
      }
      if (!Array.isArray(strategy.compiled_bindings) || strategy.compiled_bindings.length === 0) {
        errors.push(`${prefix}.compiled_bindings must bind at least one compiled setup and version`);
      } else {
        const setupIds = new Set<string>();
        for (const [j, binding] of strategy.compiled_bindings.entries()) {
          const bindingPrefix = `${prefix}.compiled_bindings[${j}]`;
          if (!isRecord(binding)) { errors.push(`${bindingPrefix} must be an object`); continue; }
          for (const key of ["setup_id", "timeframe", "strategy_version"] as const) {
            if (!nonempty(binding[key])) errors.push(`${bindingPrefix}.${key} is required`);
          }
          if (binding.direction !== "long" && binding.direction !== "short") errors.push(`${bindingPrefix}.direction is invalid`);
          if (typeof binding.setup_id === "string") {
            if (setupIds.has(binding.setup_id)) errors.push(`${prefix} duplicate compiled setup binding ${binding.setup_id}`);
            setupIds.add(binding.setup_id);
          }
          if (!Array.isArray(binding.rule_versions) || binding.rule_versions.length === 0 || !binding.rule_versions.every(nonempty)) {
            errors.push(`${bindingPrefix}.rule_versions must contain current rule version identities`);
          }
        }
      }
      if (typeof strategy.contract_status !== "string" || !CONTRACT_STATUS.has(strategy.contract_status as SourceContractStatus)) errors.push(`${prefix}.contract_status is invalid`);
      if (typeof strategy.runtime_status !== "string" || !RUNTIME_STATUS.has(strategy.runtime_status as RuntimeContractStatus)) errors.push(`${prefix}.runtime_status is invalid`);
      if (!["COMPLETE", "PARTIAL", "UNKNOWN"].includes(String(strategy.source_completeness))) errors.push(`${prefix}.source_completeness is invalid`);
      if (typeof strategy.promotion_eligible !== "boolean" || typeof strategy.live_eligible !== "boolean") errors.push(`${prefix} eligibility fields must be booleans`);

      if (!Array.isArray(strategy.source_refs) || strategy.source_refs.length === 0 || !strategy.source_refs.every(validRef)) errors.push(`${prefix}.source_refs must contain valid source ranges`);
      else for (const ref of strategy.source_refs as SourceContractReference[]) if (!sourceIds.has(ref.file)) errors.push(`${prefix} source ref ${ref.file} has no source identity binding`);

      if (!Array.isArray(strategy.implementation_refs) || strategy.implementation_refs.length === 0 || !strategy.implementation_refs.every(validImplementationRef)) errors.push(`${prefix}.implementation_refs must contain repository-local implementation symbols`);
      if (!Array.isArray(strategy.blockers)) errors.push(`${prefix}.blockers must be an array`);
      else {
        const blockerIds = new Set<string>();
        for (const [j, blocker] of strategy.blockers.entries()) {
          if (!isRecord(blocker)) { errors.push(`${prefix}.blockers[${j}] must be an object`); continue; }
          if (!nonempty(blocker.id) || !nonempty(blocker.statement)) errors.push(`${prefix}.blockers[${j}] needs id and statement`);
          if (typeof blocker.id === "string") {
            if (blockerIds.has(blocker.id)) errors.push(`${prefix} duplicate blocker id ${blocker.id}`);
            blockerIds.add(blocker.id);
          }
          if (typeof blocker.status !== "string" || !STATUS.has(blocker.status as ContractEvidenceStatus)) errors.push(`${prefix}.blockers[${j}].status is invalid`);
          if (!Array.isArray(blocker.source_refs) || !blocker.source_refs.every(validRef)) errors.push(`${prefix}.blockers[${j}].source_refs is invalid`);
          if (!Array.isArray(blocker.implementation_refs) || !blocker.implementation_refs.every(validImplementationRef)) errors.push(`${prefix}.blockers[${j}].implementation_refs is invalid`);
        }
      }

      if (!isRecord(strategy.field_status) || Object.keys(strategy.field_status).length === 0) errors.push(`${prefix}.field_status must be a non-empty map`);
      else for (const [field, value] of Object.entries(strategy.field_status)) {
        if (!isRecord(value) || typeof value.status !== "string" || !STATUS.has(value.status as ContractEvidenceStatus)) errors.push(`${prefix}.field_status.${field}.status is invalid`);
        if (!isRecord(value) || !Array.isArray(value.source_refs) || !value.source_refs.every(validRef)) errors.push(`${prefix}.field_status.${field}.source_refs is invalid`);
        else for (const ref of value.source_refs as SourceContractReference[]) if (!sourceIds.has(ref.file)) errors.push(`${prefix}.field_status.${field} source ref ${ref.file} has no source identity binding`);
      }

      if (!isRecord(strategy.semantic_validation) || !["PASS", "NOT_PROVEN", "FAIL"].includes(String(strategy.semantic_validation.status)) || !nonempty(strategy.semantic_validation.method) || !Array.isArray(strategy.semantic_validation.test_ids) || !strategy.semantic_validation.test_ids.every(nonempty)) {
        errors.push(`${prefix}.semantic_validation must state status, method and non-empty test_ids`);
      }
      const semantic = isRecord(strategy.semantic_validation) ? strategy.semantic_validation.status : undefined;
      if (semantic === "PASS" && isRecord(strategy.semantic_validation) && Array.isArray(strategy.semantic_validation.test_ids) && strategy.semantic_validation.test_ids.length === 0) errors.push(`${prefix}.semantic_validation PASS requires named test ids`);
      const blockers = Array.isArray(strategy.blockers) ? strategy.blockers : [];
      if (strategy.contract_status === "SOURCE_FAITHFUL") {
        if (strategy.source_completeness !== "COMPLETE") errors.push(`${prefix} SOURCE_FAITHFUL requires COMPLETE source fields`);
        if (blockers.length !== 0) errors.push(`${prefix} SOURCE_FAITHFUL cannot retain blockers`);
        if (semantic !== "PASS") errors.push(`${prefix} SOURCE_FAITHFUL requires passing semantic tests`);
        if (strategy.runtime_status === "RESEARCH_ONLY" || strategy.runtime_status === "DISABLED") errors.push(`${prefix} SOURCE_FAITHFUL conflicts with runtime_status`);
        const unresolvedStatuses = Object.entries(isRecord(strategy.field_status) ? strategy.field_status : {})
          .filter(([, field]) => !isRecord(field) || !["SOURCE_VERIFIED", "DETERMINISTIC", "ADJUDICATED_FROM_EXPLICIT_SOURCE_ACTION"].includes(String(field.status)))
          .map(([field]) => field);
        if (unresolvedStatuses.length > 0) errors.push(`${prefix} SOURCE_FAITHFUL cannot retain unresolved field statuses: ${unresolvedStatuses.join(", ")}`);
      } else {
        if (strategy.runtime_status === "EXECUTABLE") errors.push(`${prefix} non-faithful source contract cannot be EXECUTABLE`);
        if (strategy.promotion_eligible === true || strategy.live_eligible === true) errors.push(`${prefix} non-faithful source contract cannot be promotion/live eligible`);
      }
      if (strategy.live_eligible === true && strategy.promotion_eligible !== true) errors.push(`${prefix} live eligibility requires promotion eligibility`);
      if (strategy.live_eligible === true && !["ROBUST", "WALK_FORWARD"].includes(String(strategy.empirical_status))) errors.push(`${prefix} live eligibility requires robust/walk-forward evidence`);
    }
  }

  const refs = new Set<string>();
  if (Array.isArray(data.strategies)) for (const strategy of data.strategies.filter(isRecord)) {
    for (const ref of (Array.isArray(strategy.implementation_refs) ? strategy.implementation_refs : []).filter(isRecord)) {
      if (typeof ref.file === "string") refs.add(ref.file);
    }
    for (const blocker of (Array.isArray(strategy.blockers) ? strategy.blockers : []).filter(isRecord)) {
      for (const ref of (Array.isArray(blocker.implementation_refs) ? blocker.implementation_refs : []).filter(isRecord)) {
        if (typeof ref.file === "string") refs.add(ref.file);
      }
    }
  }
  if (!Array.isArray(data.implementation_bindings)) errors.push("implementation_bindings must be an array");
  else {
    const actual = new Set<string>();
    for (const [i, binding] of data.implementation_bindings.entries()) {
      if (!isRecord(binding) || !nonempty(binding.file) || typeof binding.sha256 !== "string" || !SHA256.test(binding.sha256)) {
        errors.push(`implementation_bindings[${i}] is invalid`); continue;
      }
      if (actual.has(binding.file)) errors.push(`duplicate implementation binding ${binding.file}`);
      actual.add(binding.file);
    }
    for (const ref of refs) if (!actual.has(ref)) errors.push(`implementation file ${ref} has no hash binding`);
    for (const file of actual) if (!refs.has(file)) errors.push(`implementation binding ${file} is not referenced by any contract`);
  }

  return [...new Set(errors)].sort();
}

export function currentCompiledVersionBindings(): CompiledVersionBinding[] {
  return COMPILED_STRATEGIES.map((compiled) => {
    const setup = compiled.setup();
    return {
      setup_id: compiled.setup_id,
      direction: compiled.direction,
      timeframe: compiled.timeframe,
      strategy_version: setup.version,
      rule_versions: [...new Set(setup.rules.map((rule) => rule.version))].sort(),
    };
  }).sort((a, b) => a.setup_id.localeCompare(b.setup_id));
}

/** Ensure contract IDs and version bindings match the actual compiled registry. */
export function validateSourceContractRuntimeBindings(
  data: unknown,
  actualBindings: { strategy_id: string; setup_id: string; direction: string; timeframe: string; strategy_version: string; rule_versions: string[]; setup_strategy_id?: string; setup_direction?: string; setup_timeframe?: string }[] = COMPILED_STRATEGIES.map((compiled) => {
    const setup = compiled.setup();
    return {
      strategy_id: compiled.strategy_id,
      setup_id: compiled.setup_id,
      direction: compiled.direction,
      timeframe: compiled.timeframe,
      strategy_version: setup.version,
      rule_versions: [...new Set(setup.rules.map((rule) => rule.version))].sort(),
      setup_strategy_id: setup.strategy_id,
      setup_direction: setup.direction,
      setup_timeframe: setup.timeframe,
    };
  }),
): string[] {
  if (!isRecord(data) || !Array.isArray(data.strategies)) return ["compiled runtime bindings cannot be checked without source-contract strategies"];
  const errors: string[] = [];
  const expectedByStrategy = new Map<string, Map<string, Record<string, unknown>>>();
  for (const strategy of data.strategies.filter(isRecord)) {
    const strategyId = String(strategy.strategy_id ?? "UNKNOWN");
    const setupBindings = new Map<string, Record<string, unknown>>();
    for (const binding of (Array.isArray(strategy.compiled_bindings) ? strategy.compiled_bindings : []).filter(isRecord)) {
      if (typeof binding.setup_id === "string") setupBindings.set(binding.setup_id, binding);
    }
    expectedByStrategy.set(strategyId, setupBindings);
  }

  const actualStrategyIds = new Set(actualBindings.map((binding) => binding.strategy_id));
  const contractStrategyIds = new Set(expectedByStrategy.keys());
  for (const id of [...actualStrategyIds].sort()) if (!contractStrategyIds.has(id)) errors.push(`compiled strategy has no source contract: ${id}`);
  for (const id of [...contractStrategyIds].sort()) if (!actualStrategyIds.has(id)) errors.push(`source contract has no compiled strategy binding: ${id}`);

  const seenSetups = new Set<string>();
  for (const actual of actualBindings) {
    const key = `${actual.strategy_id}|${actual.setup_id}`;
    if (seenSetups.has(key)) errors.push(`duplicate compiled runtime setup ${key}`);
    seenSetups.add(key);
    if (actual.setup_strategy_id !== undefined && actual.setup_strategy_id !== actual.strategy_id) errors.push(`${key} setup strategy_id differs from compiled registry`);
    if (actual.setup_direction !== undefined && actual.setup_direction !== actual.direction) errors.push(`${key} setup direction differs from compiled registry`);
    if (actual.setup_timeframe !== undefined && actual.setup_timeframe !== actual.timeframe) errors.push(`${key} setup timeframe differs from compiled registry`);
    const declared = expectedByStrategy.get(actual.strategy_id)?.get(actual.setup_id);
    if (!declared) { errors.push(`${key} is missing from compiled_bindings`); continue; }
    const actualNormalized = {
      setup_id: actual.setup_id,
      direction: actual.direction,
      timeframe: actual.timeframe,
      strategy_version: actual.strategy_version,
      rule_versions: [...actual.rule_versions].sort(),
    };
    const declaredNormalized = {
      setup_id: declared.setup_id,
      direction: declared.direction,
      timeframe: declared.timeframe,
      strategy_version: declared.strategy_version,
      rule_versions: Array.isArray(declared.rule_versions) ? [...declared.rule_versions].sort() : [],
    };
    if (JSON.stringify(actualNormalized) !== JSON.stringify(declaredNormalized)) {
      errors.push(`${key} compiled version binding mismatch: contract=${JSON.stringify(declaredNormalized)} runtime=${JSON.stringify(actualNormalized)}`);
    }
  }
  for (const [strategyId, bindings] of expectedByStrategy) {
    const actualIds = new Set(actualBindings.filter((binding) => binding.strategy_id === strategyId).map((binding) => binding.setup_id));
    for (const setupId of bindings.keys()) if (!actualIds.has(setupId)) errors.push(`${strategyId}|${setupId} contract setup is missing from compiled runtime`);
  }
  return [...new Set(errors)].sort();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function repositoryFile(relative: string): string | null {
  const root = path.resolve(process.cwd());
  const target = path.resolve(root, relative);
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

function currentArtifactInventory(): { inventory: SourceContractArtifactInventory; errors: string[] } {
  const errors: string[] = [];
  const sources: SourceContractArtifactInventory["sources"] = {};
  const implementations: SourceContractArtifactInventory["implementations"] = {};
  let canonicalIndex: SourceContractArtifactInventory["canonical_index"];
  let validator: SourceContractArtifactInventory["validator"];
  const data = sourceContractData as unknown as SourceContractData;
  for (const binding of data.source_bindings ?? []) {
    const full = repositoryFile(binding.path);
    if (!full || !fs.existsSync(full)) { errors.push(`source artifact unavailable: ${binding.path}`); continue; }
    try {
      const bytes = fs.readFileSync(full);
      const text = bytes.toString("utf8");
      sources[binding.path] = {
        sha256: sha256(bytes), bytes: bytes.byteLength, lines: text.split("\n").length,
        chars: text.length, source_version: binding.source_version,
      };
    } catch (err) {
      errors.push(`source artifact unreadable ${binding.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const index = data.canonical_index;
  if (index) {
    const full = repositoryFile(index.path);
    if (!full || !fs.existsSync(full)) errors.push(`canonical index unavailable: ${index.path}`);
    else {
      try {
        const bytes = fs.readFileSync(full);
        const text = bytes.toString("utf8");
        canonicalIndex = { path: index.path, sha256: sha256(bytes), bytes: bytes.byteLength, lines: text.split("\n").length, source_version: index.source_version };
      } catch (err) {
        errors.push(`canonical index unreadable ${index.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const binding of data.implementation_bindings ?? []) {
    const full = repositoryFile(binding.file);
    if (!full || !fs.existsSync(full)) { errors.push(`implementation artifact unavailable: ${binding.file}`); continue; }
    try {
      const bytes = fs.readFileSync(full);
      implementations[binding.file] = { sha256: sha256(bytes), text: bytes.toString("utf8") };
    } catch (err) {
      errors.push(`implementation artifact unreadable ${binding.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const validatorBinding = data.validator_binding;
  const validatorPath = repositoryFile(validatorBinding.file);
  if (!validatorPath || !fs.existsSync(validatorPath)) errors.push(`source-contract validator artifact unavailable: ${validatorBinding.file}`);
  else {
    try {
      validator = { file: validatorBinding.file, sha256: sha256(fs.readFileSync(validatorPath)) };
    } catch (err) {
      errors.push(`source-contract validator artifact unreadable ${validatorBinding.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { inventory: { sources, implementations, canonical_index: canonicalIndex, validator }, errors };
}

function validateLockIdentity(): string[] {
  const errors: string[] = [];
  const contractPath = "src/lib/strategy/compiled/source-contracts.json";
  const lock = sourceContractLock as unknown as Record<string, unknown>;
  if (lock.lock_version !== SOURCE_CONTRACT_LOCK_VERSION || lock.contract_path !== contractPath) errors.push("source-contract lock version/path mismatch");
  const full = repositoryFile(contractPath);
  if (!full || !fs.existsSync(full)) errors.push("source-contract JSON artifact unavailable");
  else {
    try {
      const actual = sha256(fs.readFileSync(full));
      if (actual !== lock.contract_sha256) errors.push("source-contract JSON hash differs from the checked-in lock");
    } catch (err) {
      errors.push(`source-contract JSON unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const data = sourceContractData as unknown as SourceContractData;
  const stable = (value: unknown) => JSON.stringify(value);
  if (stable(lock.source_bindings) !== stable(data.source_bindings)) errors.push("source-contract lock source bindings differ from the contract");
  if (stable(lock.canonical_index) !== stable(data.canonical_index)) errors.push("source-contract lock canonical index differs from the contract");
  if (stable(lock.implementation_bindings) !== stable(data.implementation_bindings)) errors.push("source-contract lock implementation bindings differ from the contract");
  if (stable(lock.validator_binding) !== stable(data.validator_binding)) errors.push("source-contract lock validator binding differs from the contract");
  return errors;
}

const schemaErrors = validateSourceContractData(sourceContractData);
const artifactResult = schemaErrors.length === 0 ? currentArtifactInventory() : { inventory: { sources: {}, implementations: {}, canonical_index: undefined, validator: undefined } as SourceContractArtifactInventory, errors: [] };
const artifactErrors = schemaErrors.length === 0
  ? validateSourceContractArtifacts(sourceContractData, artifactResult.inventory)
  : [];
const runtimeBindingErrors = schemaErrors.length === 0 ? validateSourceContractRuntimeBindings(sourceContractData) : [];
const validationErrors = [...new Set([...schemaErrors, ...artifactResult.errors, ...artifactErrors, ...runtimeBindingErrors, ...validateLockIdentity()])].sort();
const contracts = validationErrors.length === 0
  ? (sourceContractData as unknown as SourceContractData).strategies
  : [];

export function sourceContractValidationErrors(): string[] {
  return [...validationErrors];
}

/** Public, non-secret identity/provenance view for APIs and closure reports. */
export function sourceContractDocumentIdentity(): {
  status: "VALID" | "INVALID";
  contract_path: string;
  schema_version: string | null;
  contract_version: string | null;
  contract_sha256: string | null;
  canonical_index: SourceContractData["canonical_index"] | null;
  source_bindings: SourceContractData["source_bindings"];
  implementation_bindings: SourceContractData["implementation_bindings"];
  validator_binding: SourceContractData["validator_binding"] | null;
  compiled_bindings: { strategy_id: string; setup_id: string; direction: "long" | "short"; timeframe: string; strategy_version: string; rule_versions: string[] }[];
  strategy_count: number;
  validation_errors: string[];
} {
  const data = sourceContractData as unknown as Partial<SourceContractData>;
  const lock = sourceContractLock as unknown as Record<string, unknown>;
  return {
    status: validationErrors.length === 0 ? "VALID" : "INVALID",
    contract_path: typeof lock.contract_path === "string" ? lock.contract_path : "src/lib/strategy/compiled/source-contracts.json",
    schema_version: typeof data.schema_version === "string" ? data.schema_version : null,
    contract_version: typeof data.contract_version === "string" ? data.contract_version : null,
    contract_sha256: typeof lock.contract_sha256 === "string" && SHA256.test(lock.contract_sha256) ? lock.contract_sha256 : null,
    canonical_index: data.canonical_index ?? null,
    source_bindings: data.source_bindings ?? [],
    implementation_bindings: data.implementation_bindings ?? [],
    validator_binding: data.validator_binding ?? null,
    compiled_bindings: Array.isArray(data.strategies)
      ? data.strategies.flatMap((strategy) => Array.isArray(strategy.compiled_bindings)
        ? strategy.compiled_bindings.map((binding) => ({ strategy_id: strategy.strategy_id, ...binding }))
        : [])
      : [],
    strategy_count: Array.isArray(data.strategies) ? data.strategies.length : 0,
    validation_errors: [...validationErrors],
  };
}

export function compiledSourceContracts(): CompiledSourceContract[] {
  return structuredClone(contracts);
}

/** Missing or malformed audit evidence is UNKNOWN and therefore fails closed. */
export function compiledSourceContractFor(strategyId: string): CompiledSourceContract | null {
  return contracts.find((contract) => contract.strategy_id === strategyId) ?? null;
}

export function sourceContractStatusFor(strategyId: string): SourceContractStatus {
  if (validationErrors.length > 0) return "UNKNOWN";
  return compiledSourceContractFor(strategyId)?.contract_status ?? "UNKNOWN";
}

/** Deterministic runtime blockers; missing/malformed contracts can never pass. */
export function sourceContractBlockersFor(strategyId: string): string[] {
  if (validationErrors.length > 0) return validationErrors.map((error) => `SOURCE_CONTRACT_VALIDATION: ${error}`);
  const contract = compiledSourceContractFor(strategyId);
  if (!contract) return [`no source-contract audit exists for ${strategyId}`];
  const blockers = contract.blockers.map((blocker) => `${blocker.id}: ${blocker.statement}`);
  if (contract.semantic_validation.status !== "PASS") blockers.push("SEMANTIC_PARITY_NOT_PROVEN: source-reference existence is not implementation equivalence");
  if (contract.contract_status !== "SOURCE_FAITHFUL") blockers.push(`SOURCE_CONTRACT_${contract.contract_status}: source-to-code parity is incomplete`);
  return [...new Set(blockers)].sort();
}
