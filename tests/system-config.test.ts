import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-system-config-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
delete process.env.ASA_API_TOKEN;

type Repo = import("../src/db/repo").Repo;
let repo: Repo;
let closeRepo: () => void;
let POST: (request: Request) => Promise<Response>;

beforeAll(async () => {
  const sqlite = await import("../src/db/sqlite");
  repo = sqlite.getRepo();
  closeRepo = sqlite.closeRepo;
  POST = (await import("../src/app/api/system/config/route")).POST;
});

afterAll(() => {
  closeRepo();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
  return POST(new Request("http://asa.local/api/system/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("system config risk input validation", () => {
  it("fails closed when a selected policy cites truncated source, without persisting it", async () => {
    const priorPolicy = repo.configGet("pref.risk.policyId");
    const response = await post({ section: "risk", policyId: "RISK-DAILY-5PCT" });
    expect(response.status).toBe(409);
    const body = await response.json() as { ok: false; reasons: string[] };
    expect(body.reasons.join(" ")).toMatch(/4.txt completeness is TRUNCATED/);
    expect(repo.configGet("pref.risk.policyId")).toBe(priorPolicy);

    repo.configSet("pref.risk.policyId", "RISK-DAILY-5PCT"); // legacy/stale persisted choice
    const { getProductionRiskPolicy } = await import("../src/lib/risk/policy");
    const selected = getProductionRiskPolicy();
    expect(selected.selection_status).toBe("BLOCKED");
    expect(selected.source_completeness["4.txt"]).toBe("TRUNCATED");
  });

  it("permits sizing-only saves without silently selecting or clearing a risk policy", async () => {
    const priorPolicy = repo.configGet("pref.risk.policyId");
    const response = await post({ section: "risk", equity: 10_000, perTradePct: 1, maxLeverage: 5 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, applied: { equity: 10_000, perTradePct: 1, maxLeverage: 5 } });
    expect(repo.configGet("pref.risk.policyId")).toBe(priorPolicy);
  });

  it("rejects booleans and non-decimal coercions instead of treating them as numeric risk inputs", async () => {
    repo.configSet("pref.risk.equity", "1234");
    for (const equity of [true, false, "0x10", [], {}]) {
      const response = await post({ section: "risk", equity });
      expect(response.status, JSON.stringify(equity)).toBe(400);
      expect(repo.configGet("pref.risk.equity")).toBe("1234");
    }
  });

  it("accepts ordinary decimal strings while preserving explicit bounds", async () => {
    const accepted = await post({ section: "risk", equity: "25000.50", perTradePct: "0.5", maxLeverage: "3" });
    expect(accepted.status).toBe(200);
    expect(repo.configGet("pref.risk.equity")).toBe("25000.5");
    const rejected = await post({ section: "risk", equity: "0" });
    expect(rejected.status).toBe(400);
    expect(repo.configGet("pref.risk.equity")).toBe("25000.5");
  });
});
