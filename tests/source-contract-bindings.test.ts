import { describe, expect, it } from "vitest";
import sourceContractData from "../src/lib/strategy/compiled/source-contracts.json";
import { COMPILED_STRATEGIES } from "../src/lib/strategy/compiled";
import {
  compiledSourceContracts,
  sourceContractDocumentIdentity,
  sourceContractStatusFor,
  sourceContractValidationErrors,
  validateSourceContractData,
  validateSourceContractRuntimeBindings,
  type SourceContractData,
} from "../src/lib/strategy/compiled/source-contract";

describe("source-to-compiled contract binding", () => {
  it("validates the locked source, validator, implementation, and compiled registry identities", () => {
    expect(sourceContractValidationErrors()).toEqual([]);
    const identity = sourceContractDocumentIdentity();
    expect(identity.status).toBe("VALID");
    expect(identity.contract_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.validator_binding?.file).toBe("src/lib/strategy/compiled/source-contract.ts");
    expect(identity.implementation_bindings.length).toBeGreaterThan(0);
    expect(identity.compiled_bindings).toHaveLength(COMPILED_STRATEGIES.length);
    expect(new Set(identity.compiled_bindings.map((binding) => binding.setup_id)).size).toBe(COMPILED_STRATEGIES.length);
  });

  it("compares each setup ID, direction, timeframe, setup version, and rule version to runtime", () => {
    const actual = COMPILED_STRATEGIES.map((compiled) => {
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
    });
    expect(validateSourceContractRuntimeBindings(sourceContractData, actual)).toEqual([]);

    const stale = structuredClone(actual);
    stale[0]!.strategy_version = "0.0.0-stale";
    expect(validateSourceContractRuntimeBindings(sourceContractData, stale).join("\n"))
      .toContain(`${stale[0]!.strategy_id}|${stale[0]!.setup_id} compiled version binding mismatch`);
  });

  it("rejects missing or malformed setup bindings instead of accepting an unbound contract", () => {
    const missing = structuredClone(sourceContractData);
    delete (missing.strategies[0] as { compiled_bindings?: unknown }).compiled_bindings;
    expect(validateSourceContractData(missing).join("\n")).toContain("compiled_bindings must bind at least one compiled setup and version");

    const wrongVersion = structuredClone(sourceContractData);
    (wrongVersion.strategies[0]!.compiled_bindings[0] as { strategy_version: string }).strategy_version = "";
    expect(validateSourceContractData(wrongVersion).join("\n")).toContain("strategy_version is required");
  });

  it("rejects SOURCE_FAITHFUL when any field remains UNKNOWN, partial, inferred, or otherwise unresolved", () => {
    const candidate = structuredClone(sourceContractData) as unknown as SourceContractData;
    const strategy = candidate.strategies[0]!;
    strategy.contract_status = "SOURCE_FAITHFUL";
    strategy.source_completeness = "COMPLETE";
    strategy.semantic_validation = { status: "PASS", method: "named deterministic semantic parity test", test_ids: ["SEMANTIC-PARITY-TEST"] };
    strategy.runtime_status = "EXECUTABLE";
    strategy.blockers = [];
    for (const field of Object.values(strategy.field_status)) field.status = "SOURCE_VERIFIED";
    strategy.field_status.entry_long!.status = "UNKNOWN";
    expect(validateSourceContractData(candidate).join("\\n"))
      .toContain("SOURCE_FAITHFUL cannot retain unresolved field statuses: entry_long");
  });

  it("keeps every current compiled strategy incomplete and out of promotion/live eligibility", () => {
    const contracts = compiledSourceContracts();
    expect(contracts).toHaveLength(6);
    for (const contract of contracts) {
      expect(contract.contract_status).toBe("INCOMPLETE");
      expect(contract.semantic_validation.status).toBe("NOT_PROVEN");
      expect(contract.runtime_status).toBe("RESEARCH_ONLY");
      expect(contract.promotion_eligible).toBe(false);
      expect(contract.live_eligible).toBe(false);
      expect(sourceContractStatusFor(contract.strategy_id)).toBe("INCOMPLETE");
    }
  });
});
