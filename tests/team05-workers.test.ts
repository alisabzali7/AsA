import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicationIdentity } from "./fixtures/publication-opportunity";
import { SqliteRepo } from "../src/db/sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asa-workers-"));
const bundle = path.join(tmp, "pipeline.cjs");
const require = createRequire(import.meta.url);

beforeAll(async () => {
  // Separate JS isolates + separate SQLite connections, not Promise.all over
  // one in-process repo. Only compilation is tooling; production code is real.
  await build({
    stdin: { contents: 'export { syntheticMarket } from "./tests/fixtures/publication-opportunity"; export { __setOperationalUniverse } from "./src/lib/market/operational-universe"; export { sharedStore } from "./src/lib/market/store"; export { getRepo, closeRepo } from "./src/db/sqlite"; export { publishSignal } from "./src/lib/pipeline/orchestrator"; export { evaluateLiveRisk } from "./src/lib/risk/live";', resolveDir: process.cwd(), loader: "ts" },
    outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    plugins: [{ name: "LOCAL-synthetic-admission", setup(b) {
      b.onLoad({ filter: /backtest\/promotion\.ts$/ }, async (args) => ({
        contents: (await fs.promises.readFile(args.path, "utf8"))
          .replace("export function promotedRuntimeStatus(", "function realRuntimeStatus(")
          + '\nexport function promotedRuntimeStatus(id:string){return id === "test" ? "LIVE_ADVISORY_ONLY" : realRuntimeStatus(id);}',
        loader: "ts",
      }));
      // The fixture is a test-only policy selection. The source's TRUNCATED
      // completeness remains visible; this override exercises transaction and
      // concurrency logic, not production-policy eligibility or source limits.
      b.onLoad({ filter: /risk\/policy\.ts$/ }, async (args) => ({
        contents: (await fs.promises.readFile(args.path, "utf8"))
          .replace("export function getProductionRiskPolicy(", "function realPolicy(")
          + '\nexport function getProductionRiskPolicy(){const policy=realPolicy();return {...policy,selection_status:"SELECTED",selected_by:"operator_pref",selection_reason:"TEST ONLY: explicit concurrency fixture; not production eligibility",policy_version:RISK_POLICY_VERSION,risk_per_trade_pct:null,daily_loss_limit_pct:null,max_account_risk_pct:null,period_loss_limit_pct:null,max_leverage:null,max_concurrent_positions:5};}',
        loader: "ts",
      }));
      // Publication persistence is under test here; isolate unrelated
      // psychology-source eligibility with a clearly named test-only PASS.
      b.onLoad({ filter: /psychology\/gate\.ts$/ }, async (args) => ({
        contents: (await fs.promises.readFile(args.path, "utf8"))
          .replace("export function evaluatePsychologyGate(", "function realEvaluatePsychologyGate(")
          + '\nexport function evaluatePsychologyGate(..._args:Parameters<typeof realEvaluatePsychologyGate>):ReturnType<typeof realEvaluatePsychologyGate>{return {verdict:"pass",score_penalty:0,blocks:[],penalties:[],flags:[],checklists_required:[],not_evaluated:[],evaluated:1,active_policy_ids:["TEST-ONLY-WORKER-GATE"]};}',
        loader: "ts",
      }));
      b.onLoad({ filter: /strategy\/runtime\.ts$/ }, async (args) => ({
        contents: (await fs.promises.readFile(args.path, "utf8"))
          .replace("export function getRuntimeStrategy(", "function realGetRuntimeStrategy(")
          + '\nexport function getRuntimeStrategy(id:string):ReturnType<typeof realGetRuntimeStrategy>{if(!id.startsWith("SET-WORKER-"))return realGetRuntimeStrategy(id);return {strategy_id:"test",setup_id:id,name:"TEST ONLY worker fixture",family:"test",direction:"long",timeframe:"1h",min_bars:0,availability:"EXECUTABLE",blocked_reason:null,source_contract_status:"SOURCE_FAITHFUL",source_contract_blockers:[],strategy_version:"TEST-ONLY-V1",version:"TEST-ONLY-V1",rule_ids:[],rule_versions:[],source_refs:[],impl:null};}',
        loader: "ts",
      }));
    } }, { name: "native-sqlite", setup(b) { b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve("better-sqlite3"), external: true })); } }],
  });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function configureTestPublicationAuthority(repo: SqliteRepo): void {
  repo.configSet("pref.risk.policyId", "RISK-DAILY-5PCT");
  repo.configSet("pref.risk.equity", "10000");
  repo.configSet("pref.risk.perTradePct", "1");
  repo.configSet("pref.risk.maxLeverage", "5");
}

function workerOpportunity(id: string, symbol: string, now: number) {
  return publicationIdentity({
    id, symbol, timeframe: "1h", direction: "long", strategy_id: "test",
    setup_id: `SET-WORKER-${id}`, strategy_version: "TEST-ONLY-V1",
    rule_ids: [], rule_versions: [], source_contract_status: "SOURCE_FAITHFUL",
    source_contract_blockers: [], state: "READY", mode: "live", score: 90,
    anchor_close_ms: now, entry_zone: { top: 100, bottom: 100 }, stop: 95,
    targets: [110], data_quality: { stale: false }, blocked_factors: [],
    contradictions: [], psychology: { state: "READY", hard_blocks: [], soft_warnings: [], score_modifier: 0, not_evaluated: [] },
    portfolio: { verdict: "pass", reasons: ["TEST ONLY fixture"], unenforced: [] },
  } as never);
}

async function race(file: string, action: "publish" | "claim" | "read", id: number | string | string[]) {
  const workers = ["A", "B"].map((token, index) => new Worker(`
    const {parentPort, workerData:d} = require('node:worker_threads');
    process.env.ASA_DB_PATH=d.file;
    process.env.ASA_HISTORY_DB_PATH=d.file+'.history';
    process.env.ASA_BRAIN_DB_PATH=d.file+'.brain';
    const lib=require(d.bundle); const repo=lib.getRepo();
    parentPort.once('message', () => {
      try {
        let result;
        if(d.action==='claim') result=repo.outboxClaim(d.id,{token:d.token,claimed_at_ms:Date.now(),expires_at_ms:Date.now()+120000});
        else if(d.action==='read') result=repo.outboxGet(d.id);
        else {
          const opp=JSON.parse(repo.opportunityGet(d.id).payload_json);
          lib.__setOperationalUniverse([opp.symbol]);
          lib.sharedStore.catalog.set(opp.symbol,lib.syntheticMarket(opp.symbol));
          opp.risk=lib.evaluateLiveRisk(opp.symbol,opp.direction,100,95,110);
          repo.opportunityUpsert({...repo.opportunityGet(d.id),payload_json:JSON.stringify(opp)});
          result=lib.publishSignal(opp);
        }
        lib.closeRepo(); parentPort.postMessage({result});
      } catch(e) { parentPort.postMessage({error:String(e)}); }
    });
    parentPort.postMessage('ready');
  `, { eval: true, workerData: { file, action, id: Array.isArray(id) ? id[index] : id, token, bundle } }));
  try {
    const ready = workers.map((w) => new Promise<void>((resolve, reject) => {
      w.once("error", reject); w.once("message", (m) => m === "ready" ? resolve() : reject(new Error(JSON.stringify(m))));
    }));
    await Promise.all(ready);
    const results = workers.map((w) => new Promise<unknown>((resolve, reject) => {
      w.once("error", reject); w.once("message", (m) => m.error ? reject(new Error(m.error)) : resolve(m.result));
    }));
    workers.forEach((w) => w.postMessage("go"));
    return await Promise.all(results);
  } finally { await Promise.all(workers.map((w) => w.terminate())); }
}

describe("T05 separate-worker persistence proofs", () => {
  it("simultaneous activation yields one signal, one outbox, one publication transition", async () => {
    const file = path.join(tmp, "publication.db");
    const repo = new SqliteRepo(file);
    try {
      const now = Date.now();
      configureTestPublicationAuthority(repo);
      const opp = workerOpportunity("race", "BTCUSDT", now);
      repo.opportunityUpsert({ ...opp, payload_json: JSON.stringify(opp), created_ms: now, updated_ms: now });
      repo.signalInsert({ id: "existing-candidate", state: "qualified", symbol: opp.symbol, timeframe: opp.timeframe, direction: opp.direction, strategy_id: opp.strategy_id, score: opp.score, opp_id: opp.id, payload_json: "{}", created_ms: 123, updated_ms: now });
      const results = await race(file, "publish", opp.id) as Array<{ published: boolean; id: string; reason: string }>;
      expect(results.every((r) => r.published), JSON.stringify(results)).toBe(true);
      expect(results.every((r) => r.id === "existing-candidate")).toBe(true);
      expect(results.filter((r) => r.reason.startsWith("already published"))).toHaveLength(1);
      expect(repo.signalList(10)).toHaveLength(1);
      expect(repo.outboxList("ALL", 10)).toHaveLength(1);
      expect(repo.signalHistory("existing-candidate").map((r) => r.to_state)).toEqual(["qualified", "published"]);
      expect(repo.signalGet("existing-candidate")?.created_ms).toBe(123);
    } finally { repo.close(); }
  });
  it("two worker connections cannot claim one row and a fresh process retains partial progress", async () => {
    const file = path.join(tmp, "delivery.db");
    const repo = new SqliteRepo(file);
    try {
      const id = repo.outboxEnqueue("system", { kind: "system", delivery_progress: { photo_required: true, photo_sent: true, text_sent: false } });
      expect((await race(file, "claim", id)).sort()).toEqual([false, true]);
      const rows = await race(file, "read", id) as Array<{ claimed_by: string; payload_json: string }>;
      expect(rows[0]).toEqual(rows[1]);
      expect(JSON.parse(rows[0].payload_json).delivery_progress.photo_sent).toBe(true);
      expect(["A", "B"]).toContain(rows[0].claimed_by);
    } finally { repo.close(); }
  });
});

describe("T05 SQLite failure injection", () => {
  it("SQLITE_BUSY does not leave a partial enqueue and recovery succeeds after lock release", async () => {
    const Database = (await import("better-sqlite3")).default;
    const file = path.join(tmp, "busy.db");
    const repo = new SqliteRepo(file);
    const lock = new Database(file);
    try {
      lock.exec("BEGIN IMMEDIATE");
      expect(() => repo.withTransaction(() => repo.outboxEnqueue("system", { kind: "system" }))).toThrow(/locked/);
      lock.exec("ROLLBACK");
      expect(repo.outboxList("ALL", 10)).toEqual([]);
      repo.withTransaction(() => repo.outboxEnqueue("system", { kind: "system" }));
      expect(repo.outboxList("ALL", 10)).toHaveLength(1);
    } finally { if (lock.inTransaction) lock.exec("ROLLBACK"); lock.close(); repo.close(); }
  });
  it("unique opportunity conflict rolls back the companion outbox and transition insert", () => {
    const repo = new SqliteRepo(":memory:");
    try {
      const signal = { id: "first", state: "published", symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 90, strategy_id: "x", opp_id: "one", payload_json: "{}", created_ms: 1, updated_ms: 1 };
      repo.signalInsert(signal);
      expect(() => repo.withTransaction(() => {
        repo.outboxEnqueue("signal", { opportunity_id: "one" });
        repo.signalInsert({ ...signal, id: "second" });
      })).toThrow(/UNIQUE/);
      expect(repo.outboxList("ALL", 10)).toHaveLength(0);
      expect(repo.signalList(10)).toHaveLength(1);
      expect(repo.signalHistory("second")).toEqual([]);
    } finally { repo.close(); }
  });
});


it("LOCAL different-worker candidates cannot oversubscribe the last portfolio slot", async () => {
  const file = path.join(tmp, "portfolio-race.db");
  const repo = new SqliteRepo(file);
  try {
    const now = Date.now();
    configureTestPublicationAuthority(repo);
    for(let i=0;i<4;i++) repo.signalInsert({id:`open-${i}`,state:"published",symbol:`TEST-${i}`,timeframe:"1h",direction:"long",strategy_id:"test",score:90,opp_id:`open-${i}`,created_ms:now,updated_ms:now,
      payload_json:JSON.stringify({anchor_close_ms:now,timeframe:"1h",risk:{numbers:{risk_notional:100}}})});
    const ids = ["ETHUSDT", "ADAUSDT"].map(symbol => {
      const opp = workerOpportunity(symbol, symbol, now);
      repo.opportunityUpsert({...opp,payload_json:JSON.stringify(opp),created_ms:now,updated_ms:now});
      return opp.id;
    });
    const results = await race(file,"publish",ids) as Array<{published:boolean;reason:string}>;
    expect(results.filter(r=>r.published),JSON.stringify(results)).toHaveLength(1);
    expect(results.filter(r=>!r.published)[0].reason).toMatch(/current admission gate BLOCK/);
    expect(repo.signalActive()).toHaveLength(5);
    expect(repo.outboxList("ALL",10)).toHaveLength(1);
  } finally {repo.close();}
});
