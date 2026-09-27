/** Fresh closure reproductions; no promotion/account mocks in this file. */
import { describe, it, expect } from "vitest";
import { SqliteRepo } from "../src/db/sqlite";
import { loadLiveGateContext, advisoryOpenRisks } from "../src/lib/pipeline/live-gates";
import type { SignalRow } from "../src/db/repo";
const now = Date.now();
function signal(id: string, over: Partial<SignalRow> = {}): SignalRow {
  return { id, state: "published", symbol: id, timeframe: "1h", direction: "long", score: 90, strategy_id: "TEST", opp_id: id,
    payload_json: JSON.stringify({ timeframe: "1h", anchor_close_ms: now, risk: { numbers: { risk_notional: 100 } } }), created_ms: now, updated_ms: now, ...over };
}
describe("closure: complete, honest advisory exposure", () => {
  it("does not lose active exposure behind 500 newer terminal rows", () => {
    const repo = new SqliteRepo(":memory:");
    try {
      repo.signalInsert(signal("old-active", { updated_ms: now - 1000 }));
      for(let i=0; i<501; i++) repo.signalInsert(signal(`closed-${i}`, { state: "expired" }));
      const ctx = loadLiveGateContext(repo, now, { daily_loss_limit_pct: 5 });
      expect(ctx.open_risks).toEqual([{symbol:"old-active", direction:"long",risk_amount:100}]);
      expect(ctx.daily_realized_loss).toBeNull();
    } finally { repo.close(); }
  });
  it("unknown risk notional is unavailable, never a zero-risk holding", () => {
    expect(advisoryOpenRisks([signal("unknown", { payload_json: JSON.stringify({timeframe:"1h",anchor_close_ms:now}) })], now)).toBeNull();
  });
});

import { liveMeasurementBlocks } from "../src/lib/pipeline/live-gates";
import { getProductionRiskPolicy } from "../src/lib/risk/policy";
it("default live policy cannot skip unknown currency loss; research accounting remains explicit", () => {
  const repo = new SqliteRepo(":memory:");
  try {
    const ctx = loadLiveGateContext(repo, now, { daily_loss_limit_pct: 5 });
    expect(liveMeasurementBlocks(ctx, getProductionRiskPolicy())).toEqual([
      "daily realized loss UNAVAILABLE for configured hard limit", "period realized loss UNAVAILABLE for configured hard limit",
    ]);
  } finally { repo.close(); }
});

import { evaluateLiveRisk } from "../src/lib/risk/live";
import { sharedStore } from "../src/lib/market/store";
import { syntheticMarket } from "./fixtures/publication-opportunity";
it("unknown/inactive/incomplete venue constraints cannot yield live risk PASS", () => {
  const symbol = "TEST-CLOSURE-UNKNOWN";
  expect(evaluateLiveRisk(symbol,"long",100,95,110).verdict).toBe("block");
  sharedStore.catalog.set(symbol,{...syntheticMarket(symbol),isActive:false});
  expect(evaluateLiveRisk(symbol,"long",100,95,110).verdict).toBe("block");
  sharedStore.catalog.set(symbol,{...syntheticMarket(symbol),tickSize:null});
  expect(evaluateLiveRisk(symbol,"long",100,95,110).verdict).toBe("block");
  sharedStore.catalog.delete(symbol);
});

import { signalDelivery } from "../src/lib/pipeline/provenance";
it("cross-linked outbox provenance never reports another signal's delivery", () => {
  const repo = new SqliteRepo(":memory:");
  try {
    const id = repo.outboxEnqueue("signal", {kind:"signal",signal_id:"other",opportunity_id:"other"});
    const s = signal("wrong-link",{outbox_id:id});
    repo.signalInsert(s);
    expect(signalDelivery(repo,s).delivery_state).toBe("UNLINKED");
    expect(signalDelivery(repo,s).outbox_id).toBeNull();
  } finally { repo.close(); }
});

import { vi } from "vitest";
import * as sqlite from "../src/db/sqlite";
import * as universe from "../src/lib/market/operational-universe";
it("live risk rejects corrupt server prefs and stale discovery even when metadata exists", () => {
  const repo = new SqliteRepo(":memory:");
  const spy=vi.spyOn(sqlite,"getRepo").mockReturnValue(repo);
  const state=vi.spyOn(universe,"universeState").mockReturnValue("READY");
  const member=vi.spyOn(universe,"isOperationalSymbol").mockReturnValue(true);
  sharedStore.catalog.set("BTCUSDT",syntheticMarket("BTCUSDT"));
  try {
    expect(evaluateLiveRisk("BTCUSDT","long",100,95,110).verdict).toBe("pass");
    sharedStore.catalog.set("BTCUSDT",{...syntheticMarket("BTCUSDT"),minNotional:null});
    expect(evaluateLiveRisk("BTCUSDT","long",100,95,110).verdict).toBe("block");
    sharedStore.catalog.set("BTCUSDT",syntheticMarket("BTCUSDT"));
    repo.configSet("pref.risk.equity","bad");
    expect(evaluateLiveRisk("BTCUSDT","long",100,95,110).verdict).toBe("block");
    repo.configSet("pref.risk.equity","10000");state.mockReturnValue("STALE");
    expect(evaluateLiveRisk("BTCUSDT","long",100,95,110).verdict).toBe("block");
  } finally {spy.mockRestore();state.mockRestore();member.mockRestore();sharedStore.catalog.delete("BTCUSDT");repo.close();}
});
