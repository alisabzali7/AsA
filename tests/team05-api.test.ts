import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asa-t05-api-"));
process.env.ASA_DB_PATH = path.join(tmp, "asa.db");
process.env.ASA_HISTORY_DB_PATH = path.join(tmp, "history.db");
process.env.ASA_BRAIN_DB_PATH = path.join(tmp, "brain.db");
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.ASA_API_TOKEN;
process.env.TELEGRAM_DRY_RUN = "1";
let repo: import("../src/db/repo").Repo;
let close: () => void;
beforeAll(async () => { const db = await import("../src/db/sqlite"); repo = db.getRepo(); close = db.closeRepo; });
afterAll(() => { close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("T05 route/service/SQLite failure truth", () => {
  it("corrupt/null opportunity payload stays un-actionable and is explicitly unavailable", async () => {
    repo.opportunityUpsert({ id: "null", symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 100, state: "READY", strategy_id: "x", mode: "live", payload_json: "null", created_ms: 1, updated_ms: 1 });
    const { GET } = await import("../src/app/api/opportunities/route");
    const res = await GET(new Request("http://asa.local/api/opportunities?limit=invalid"));
    expect(res.status).toBe(200);
    expect((await res.json()).items[0]).toMatchObject({ payload_status: "UNAVAILABLE", actionable: false, fresh: "EXPIRED" });
  });
  it("cold API reads expire stale published rows without depending on engine boot", async () => {
    const now = Date.now();
    repo.signalInsert({ id: "stale", state: "published", symbol: "BTCUSDT", timeframe: "1h", direction: "long", score: 90, strategy_id: "x", opp_id: "stale", payload_json: JSON.stringify({ anchor_close_ms: now - 5 * 3600_000, timeframe: "1h" }), created_ms: now, updated_ms: now });
    const { GET } = await import("../src/app/api/signals/route");
    const body = await (await GET(new Request("http://asa.local/api/signals"))).json();
    expect(body.items.find((s: { id: string }) => s.id === "stale").state).toBe("expired");
    expect(repo.signalGet("stale")?.state).toBe("expired");
    expect(repo.signalHistory("stale").at(-1)?.to_state).toBe("expired");
  });
  it("invalid percent route params do not cause double-decoding 500s", async () => {
    const { GET } = await import("../src/app/api/signals/[id]/route");
    const res = await GET(new Request("http://asa.local/api/signals/%25"), { params: Promise.resolve({ id: "%" }) });
    expect(res.status).toBe(404);
  });
  it("notify test reports its own FAILED row when unconfigured even with dry-run enabled", async () => {
    const { POST } = await import("../src/app/api/system/notify/route");
    const res = await POST(new Request("http://asa.local/api/system/notify", { method: "POST", body: JSON.stringify({ action: "test" }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enqueued_delivery).toBe("FAILED");
    expect(body.drained.attempted).toBe(0);
    expect(body.drained.inspected).toBe(1);
    expect(body.drained.sent).toBe(0);
    expect(body.delivery).not.toContain("left QUEUED");
    expect(repo.outboxGet(body.enqueued_row_id)?.attempts).toBe(0);
  });
  it("notify rejects malformed requests and counts beyond the old 500-row sample", async () => {
    const { POST, GET } = await import("../src/app/api/system/notify/route");
    expect((await POST(new Request("http://asa.local/api/system/notify", { method: "POST", body: "null" }))).status).toBe(400);
    expect((await POST(new Request("http://asa.local/api/system/notify", { method: "POST", body: '{"action":"execute"}' }))).status).toBe(400);
    repo.withTransaction(() => { for (let i = 0; i < 501; i++) repo.outboxEnqueue("system", { kind: "system" }); });
    const body = await (await GET()).json();
    expect(body.outbox.QUEUED).toBe(501);
    expect(body.outbox.FAILED).toBe(1);
  });
});

it("malformed risk settings fail atomically instead of reporting a fake save", async () => {
  const {POST} = await import("../src/app/api/system/config/route");
  repo.configSet("pref.risk.equity","10000");
  for(const value of [null,true,"",{},"bad"]) {
    const r=await POST(new Request("http://asa.local/api/system/config",{method:"POST",body:JSON.stringify({section:"risk",equity:12000,maxLeverage:value})}));
    expect(r.status).toBe(400);
    expect(repo.configGet("pref.risk.equity")).toBe("10000");
  }
});

it("a terminal linked signal cannot leave its historical READY opportunity actionable",async()=>{
  const now=Date.now(),id="closed-opportunity";
  repo.opportunityUpsert({id,symbol:"BTCUSDT",timeframe:"1h",direction:"long",score:90,state:"READY",strategy_id:"TEST",mode:"live",payload_json:JSON.stringify({anchor_close_ms:now,risk:{verdict:"pass"}}),created_ms:now,updated_ms:now});
  repo.signalInsert({id:"sig-"+id,opp_id:id,symbol:"BTCUSDT",timeframe:"1h",direction:"long",score:90,state:"expired",strategy_id:"TEST",payload_json:JSON.stringify({anchor_close_ms:now}),created_ms:now,updated_ms:now});
  const {GET}=await import("../src/app/api/opportunities/route");
  const body=await (await GET(new Request("http://asa.local/api/opportunities"))).json();
  expect(body.items.find((o:{id:string})=>o.id===id)).toMatchObject({state:"READY",fresh:"READY",signal_state:"expired",actionable:false});
});
