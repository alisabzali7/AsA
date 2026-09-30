/**
 * EXECUTABLE-STATUS CONSISTENCY ACROSS THE STRATEGY SURFACES.
 *
 * The Brain registry API (`/api/brain/strategies`), the research registry API
 * (`/api/research/strategies`) and the runtime registry
 * (`src/lib/strategy/runtime.ts`) describe the SAME strategies. This suite
 * pins the invariants that keep their "executable" language from drifting
 * apart again:
 *
 *   1. `has_executable_spec` (Brain API) means "a compiled implementation
 *      binding exists" — it MUST coincide with the runtime registry having a
 *      definition for that strategy id, and NEVER with runtime
 *      EXECUTABLE/live eligibility.
 *   2. `runtime_availability` (Brain API) and `status` (Research API) report
 *      the same runtime-registry availability for the same strategy id.
 *   3. `research_computable` means exactly the same thing on both APIs.
 *   4. With a freshly ingested brain and no experiments, nothing is
 *      live-eligible and the validation endpoint's executable count equals
 *      the runtime registry's EXECUTABLE count.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-brain-api-"));
process.env.ASA_DB_PATH = path.join(TMP, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(TMP, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(TMP, "brain.db");
delete process.env.ASA_API_TOKEN;

const CORPUS_DIR = path.resolve("knowledge/raw");
const CORPUS_FILES = ["RAW_1.txt", "RAW_2.txt", "RAW_3.txt", "RAW_4.txt", "RAW_5.txt"];
const hasCorpus = CORPUS_FILES.every((f) => fs.existsSync(path.join(CORPUS_DIR, f)));

beforeAll(async () => {
  if (!hasCorpus) return;
  const { BrainStore, closeBrain } = await import("../src/lib/brain/store");
  closeBrain();
  const store = new BrainStore(path.join(TMP, "brain.db"));
  const { ingestAllSources } = await import("../src/lib/brain/ingest");
  const report = ingestAllSources(store);
  store.close();
  if (!report.ok) throw new Error(`ingest failed: ${JSON.stringify(report.errors)}`);
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

interface BrainRow {
  strategy_id: string;
  runtime_status: string;
  has_executable_spec: boolean;
  runtime_availability: string | null;
  research_computable: boolean;
}

interface ResearchRow {
  id: string;
  strategy_id: string;
  status: string;
  research_computable: boolean;
  executable: boolean;
  live_eligible: boolean;
  promotion_decision: string;
}

async function fetchBrainStrategies(): Promise<{ strategies: BrainRow[]; note: string }> {
  const { GET } = await import("../src/app/api/brain/strategies/route");
  const res = await GET(new Request("http://asa.local/api/brain/strategies?limit=500"));
  expect(res.status).toBe(200);
  return await res.json();
}

async function fetchResearchStrategies(): Promise<{ strategies: ResearchRow[] }> {
  const { GET } = await import("../src/app/api/research/strategies/route");
  const res = await GET();
  expect(res.status).toBe(200);
  return await res.json();
}

describe.runIf(hasCorpus)("brain strategies registry exposes the runtime view honestly", () => {
  it("every row with a compiled binding reports a runtime availability and research computability", async () => {
    const body = await fetchBrainStrategies();
    expect(body.strategies.length).toBeGreaterThan(0);
    for (const row of body.strategies) {
      if (row.has_executable_spec) {
        expect(row.runtime_availability, row.strategy_id).not.toBeNull();
        expect(row.research_computable, row.strategy_id).toBe(true);
      } else {
        // text-only brain record: no runtime definition exists — never fabricated
        expect(row.runtime_availability, row.strategy_id).toBeNull();
        expect(row.research_computable, row.strategy_id).toBe(false);
      }
    }
  });

  it("runtime_availability matches the runtime registry itself (not the corpus ceiling)", async () => {
    const { listRuntimeStrategies } = await import("../src/lib/strategy/runtime");
    const byStrategy = new Map<string, Set<string>>();
    for (const def of listRuntimeStrategies()) {
      const set = byStrategy.get(def.strategy_id) ?? new Set<string>();
      set.add(def.availability);
      byStrategy.set(def.strategy_id, set);
    }
    const body = await fetchBrainStrategies();
    for (const row of body.strategies) {
      const availabilities = byStrategy.get(row.strategy_id);
      if (!availabilities) {
        expect(row.runtime_availability, row.strategy_id).toBeNull();
        continue;
      }
      // single availability reports itself; mixed variants must be named MIXED
      const expected = availabilities.size === 1 ? [...availabilities][0] : "MIXED";
      expect(row.runtime_availability, row.strategy_id).toBe(expected);
    }
  });

  it("a compiled binding is never presented as runtime-executable or live-eligible", async () => {
    const body = await fetchBrainStrategies();
    expect(
      body.note,
      "the registry must define has_executable_spec so it cannot be read as 'executable'",
    ).toContain("does NOT mean executable or live-eligible");
    const compiled = body.strategies.filter((r) => r.has_executable_spec);
    expect(compiled.length).toBeGreaterThan(0);
    // The corpus ceiling (CANDIDATE) and the runtime availability
    // (RESEARCH_ONLY today) are different facts; neither is EXECUTABLE now.
    for (const row of compiled) {
      expect(row.runtime_status, row.strategy_id).not.toBe("LIVE_ADVISORY_ONLY");
    }
  });
});

describe.runIf(hasCorpus)("brain and research registries agree on executable status", () => {
  it("runtime availability and research computability are identical across both APIs", async () => {
    const brainBody = await fetchBrainStrategies();
    const researchBody = await fetchResearchStrategies();
    expect(researchBody.strategies.length).toBeGreaterThan(0);
    const brainById = new Map(brainBody.strategies.map((r) => [r.strategy_id, r]));
    for (const row of researchBody.strategies) {
      const brainRow = brainById.get(row.strategy_id);
      expect(brainRow, `research strategy ${row.strategy_id} missing from the brain registry`).toBeDefined();
      expect(brainRow!.runtime_availability, row.strategy_id).toBe(row.status);
      expect(brainRow!.research_computable, row.strategy_id).toBe(row.research_computable);
      // every research-registered strategy has a compiled binding in the brain view
      expect(brainRow!.has_executable_spec, row.strategy_id).toBe(true);
    }
  });

  it("executable and live_eligible on the research API come from the runtime/promotion gates", async () => {
    const { listRuntimeStrategies } = await import("../src/lib/strategy/runtime");
    const researchBody = await fetchResearchStrategies();
    const executableDefs = new Set(
      listRuntimeStrategies().filter((s) => s.availability === "EXECUTABLE").map((s) => s.setup_id),
    );
    for (const row of researchBody.strategies) {
      expect(row.executable, row.id).toBe(executableDefs.has(row.id));
      // fresh brain + no experiments: nothing is promotion-eligible
      expect(row.live_eligible, row.id).toBe(false);
      expect(row.promotion_decision, row.id).not.toBe("ELIGIBLE");
    }
  });

  it("the validation endpoint's executable count equals the runtime registry's EXECUTABLE count", async () => {
    const { listRuntimeStrategies } = await import("../src/lib/strategy/runtime");
    const { GET } = await import("../src/app/api/brain/validation/route");
    const res = await GET(new Request("http://asa.local/api/brain/validation"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const runtimeExecutable = new Set(
      listRuntimeStrategies().filter((s) => s.availability === "EXECUTABLE").map((s) => s.strategy_id),
    ).size;
    expect(body.counts.executable).toBe(runtimeExecutable);
    expect(body.counts.live_eligible).toBe(0);
  });
});
