/**
 * AUDIT ARTIFACT STALENESS GUARD.
 *
 * `MACHINE_READABLE_STATUS.json` and `docs/brain/AUDIT.md` are COMMITTED
 * generator outputs (`scripts/brain-audit.mjs`) that the repo ships as the
 * machine-readable truth about the build. They went stale once already: the
 * committed JSON still carried the sha256 of a PREVIOUS
 * `source-contracts.json` after the contract changed, and its psychology
 * policy matrix omitted the `runtime status is DISABLED` eligibility reason
 * that the current policy registry produces.
 *
 * These tests do NOT pin timestamps or DB-derived values that legitimately
 * change between runs. They pin exactly the relationships that only change
 * when CODE or CONTRACTS change, so a stale artifact fails loudly here
 * instead of misdescribing the shipped build:
 *
 *   1. the committed source-contract digest equals the sha256 of the
 *      checked-in `source-contracts.json` bytes (the same identity the lock
 *      and `docs/roadmap/ASA_100_PERCENT_CONTRACT.md` pin);
 *   2. the committed contract inventory (version, strategy count, status
 *      counts) matches the actual contract file;
 *   3. the committed psychology/risk policy matrices agree with what the
 *      CURRENT policy registry code produces (ids, and the DISABLED
 *      eligibility reason the generator must state);
 *   4. the JSON artifact and `docs/brain/AUDIT.md` were regenerated together
 *      (same generated_at instant).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPsychologyPolicies, buildRiskPolicies } from "../src/lib/brain/policies";

const ROOT = process.cwd();
const STATUS_PATH = path.join(ROOT, "MACHINE_READABLE_STATUS.json");
const AUDIT_MD_PATH = path.join(ROOT, "docs/brain/AUDIT.md");
const CONTRACT_PATH = path.join(ROOT, "src/lib/strategy/compiled/source-contracts.json");
const LOCK_PATH = path.join(ROOT, "src/lib/strategy/compiled/source-contracts.lock.json");

interface PolicyMatrixRow {
  id: string;
  runtime: string;
  eligibility_reasons: string[];
}

interface StatusArtifact {
  generated_at: string;
  source_contract: {
    contract_path: string;
    contract_version: string;
    contract_sha256: string;
    strategy_count: number;
    status_counts: Record<string, number>;
  };
  psychology_policy_matrix: PolicyMatrixRow[];
  risk_policy_matrix: (PolicyMatrixRow & { production_selectable: boolean })[];
}

function readStatus(): StatusArtifact {
  return JSON.parse(fs.readFileSync(STATUS_PATH, "utf8")) as StatusArtifact;
}

describe("committed audit artifact describes the CURRENT source contract", () => {
  it("source_contract.contract_sha256 equals the sha256 of the checked-in contract bytes", () => {
    const status = readStatus();
    const sha = createHash("sha256").update(fs.readFileSync(CONTRACT_PATH)).digest("hex");
    expect(status.source_contract.contract_sha256).toBe(sha);
  });

  it("the committed digest also equals the checked-in lock digest", () => {
    const status = readStatus();
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { contract_sha256: string };
    expect(status.source_contract.contract_sha256).toBe(lock.contract_sha256);
  });

  it("the committed contract inventory matches the actual contract file", () => {
    const status = readStatus();
    const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8")) as {
      schema_version: string;
      contract_version: string;
      strategies: { contract_status: string }[];
    };
    expect(status.source_contract.contract_version).toBe(contract.contract_version);
    expect(status.source_contract.strategy_count).toBe(contract.strategies.length);
    const expectedCounts: Record<string, number> = {};
    for (const strategy of contract.strategies) {
      expectedCounts[strategy.contract_status] = (expectedCounts[strategy.contract_status] ?? 0) + 1;
    }
    expect(status.source_contract.status_counts).toEqual(expectedCounts);
  });
});

describe("committed policy matrices agree with the current policy registry code", () => {
  it("psychology policy matrix lists exactly the current psychology policies", () => {
    const status = readStatus();
    const committed = status.psychology_policy_matrix.map((row) => row.id).sort();
    const live = buildPsychologyPolicies().map((p) => p.policy_id).sort();
    expect(committed).toEqual(live);
  });

  it("a policy the code marks DISABLED states the DISABLED eligibility reason", () => {
    const status = readStatus();
    for (const row of status.psychology_policy_matrix) {
      const live = buildPsychologyPolicies().find((p) => p.policy_id === row.id);
      expect(live, row.id).toBeDefined();
      if (live!.runtime_status === "DISABLED") {
        expect(
          row.eligibility_reasons,
          `${row.id}: the generator must state the code-level DISABLED status`,
        ).toContain("runtime status is DISABLED");
      } else {
        expect(
          row.eligibility_reasons,
          `${row.id}: must not claim a DISABLED reason for a live policy`,
        ).not.toContain("runtime status is DISABLED");
      }
    }
  });

  it("risk policy matrix lists exactly the current risk policies and states DISABLED honestly", () => {
    const status = readStatus();
    const committed = status.risk_policy_matrix.map((row) => row.id).sort();
    const live = buildRiskPolicies().map((p) => p.policy_id).sort();
    expect(committed).toEqual(live);
    for (const row of status.risk_policy_matrix) {
      const policy = buildRiskPolicies().find((p) => p.policy_id === row.id);
      expect(policy, row.id).toBeDefined();
      if (policy!.runtime_status === "DISABLED") {
        expect(row.eligibility_reasons, row.id).toContain("runtime status is DISABLED");
        expect(row.production_selectable, row.id).toBe(false);
      }
    }
  });
});

describe("committed audit artifacts were regenerated together", () => {
  it("MACHINE_READABLE_STATUS.json and docs/brain/AUDIT.md share the same generation instant", () => {
    const status = readStatus();
    const audit = fs.readFileSync(AUDIT_MD_PATH, "utf8");
    const m = /^Generated (\S+) from/m.exec(audit);
    expect(m, "docs/brain/AUDIT.md must state its generation instant").not.toBeNull();
    expect(m![1]).toBe(status.generated_at);
  });
});
