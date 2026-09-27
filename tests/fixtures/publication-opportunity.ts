/** Synthetic boundary fixture, NOT production market data or a live strategy. */
import { createHash } from "node:crypto";
import type { OpportunityPayload } from "../../src/lib/pipeline/orchestrator";
import { chartSource } from "../../src/lib/chart/source";
import { tfBarMs } from "../../src/lib/pipeline/freshness";

export function publicationIdentity(o: OpportunityPayload): OpportunityPayload {
  const setup = o.setup_id ?? `SET-TEST-${o.id}`;
  const anchor = (o.anchor_close_ms ?? Date.now()) - tfBarMs(o.timeframe);
  const id = createHash("sha1").update(`${o.symbol}|${o.timeframe}|${o.direction}|${setup}|${anchor / 1000}`).digest("hex").slice(0, 16);
  return { ...o,
    portfolio: o.portfolio ?? { verdict: "pass", reasons: ["TEST ONLY synthetic account"], unenforced: [] },
    psychology: o.psychology ?? { state: "READY", hard_blocks: [], soft_warnings: [], score_modifier: 0, not_evaluated: [] },
    provenance: o.provenance ?? { generated_at_ms: Date.now(), data: { series_fetched_ms: Date.now(), stats_fetched_ms: null, native_1d: true, candles: { macro: null, context: null, trigger: 1 } } },
    id, setup_id: setup, anchor_ts_ms: anchor,
    chart_source: o.chart_source ?? chartSource([{ t: anchor / 1000, o: 100, h: 101, l: 95, c: 100, v: 1 }]),
    chart_evidence: o.chart_evidence ?? {
      symbol: o.symbol, timeframe: o.timeframe, strategy_id: o.strategy_id, setup_id: setup, direction: o.direction,
      bar_time: anchor / 1000, annotations: [], rules: [], score: o.score, score_semantics: "synthetic test decision score", assumptions: ["TEST ONLY"], lineage_complete: true,
    },
  };
}

/** Simulates the trusted scanner's persisted decision in boundary-only tests. */
export function persistPublicationFixture(repo: import("../../src/db/repo").Repo, opp: OpportunityPayload): OpportunityPayload {
  const now = Date.now();
  repo.opportunityUpsert({ ...opp, payload_json: JSON.stringify(opp), created_ms: now, updated_ms: now });
  return opp;
}

/** Synthetic native metadata for local tests, never venue verification. */
export function syntheticMarket(symbol: string) {
  return {symbol,baseAsset:symbol.replace("USDT",""),quoteAsset:"USDT",category:"perpetual",name:"TEST ONLY",tickSize:0.01,stepSize:0.01,minQty:0.01,minNotional:1,maxLeverage:100,maintenanceMarginRate:0,takerFeeCoefficient:0,makerFeeCoefficient:0,isActive:true};
}
