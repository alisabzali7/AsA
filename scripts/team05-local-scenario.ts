/** LOCAL TEST ONLY. Compiled by prepare-team05-local.mjs with isolated test-only
 * risk-policy, psychology, promotion, runtime, source-admission, and account seams.
 * Exercises persistence/delivery lifecycle; it is not source, policy, or live-eligibility proof.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { getRepo, closeRepo } from "../src/db/sqlite";
import { scanSymbol } from "../src/lib/pipeline/orchestrator";
import { MapFeatureBag } from "../src/lib/rules/engine";
import { okFeature } from "../src/lib/features/types";
import type { StrategyRuntimeDefinition } from "../src/lib/strategy/runtime";
import { candleManager } from "../src/lib/market/candles";
import { __setOperationalUniverse } from "../src/lib/market/operational-universe";
import { sharedStore } from "../src/lib/market/store";
import { getHistoryStore } from "../src/lib/market/history-store";
import { deliverOutboxRow } from "../src/lib/notify/telegram";
import { signalDelivery } from "../src/lib/pipeline/provenance";
import { syntheticMarket } from "../tests/fixtures/publication-opportunity";
import type { CandleSeries } from "../src/lib/domain/types";

async function main() {
  const [action,root]=process.argv.slice(2);
  assert.equal(path.basename(root),"team05-local-evidence");
  const calls:{method:string;accepted:boolean;message_id:number|null}[]=[];
  let rejectText=action==="seed";
  const server=http.createServer((req,res)=>{
    req.resume();
    const method=req.url?.split("/").pop()??"unknown";
    const accepted=!(method==="sendMessage"&&rejectText);
    if(method==="sendMessage") rejectText=false;
    const message_id=accepted?Math.floor(Date.now()/1000)+calls.length:null;
    calls.push({method,accepted,message_id});
    res.writeHead(accepted?200:502,{"content-type":"application/json"});
    res.end(JSON.stringify({ok:accepted,result:accepted?{message_id}:undefined,description:accepted?undefined:"LOCAL TEST injected text failure"}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as {port:number}).port;
  const realFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>{
    const url=String(input);
    if(!url.startsWith("https://api.telegram.org/")) throw new Error("LOCAL harness denies external HTTP");
    return realFetch(`http://127.0.0.1:${port}/${url.split("/").pop()}`,init);
  };
  const repo=getRepo();
  // Explicit LOCAL TEST preferences; the production policy remains blocked by source completeness.
  repo.configSet("pref.risk.policyId","RISK-DAILY-5PCT");
  repo.configSet("pref.risk.equity","10000");
  repo.configSet("pref.risk.perTradePct","1");
  repo.configSet("pref.risk.maxLeverage","5");
  const history=getHistoryStore();
  candleManager.ensureSeries=async(symbol)=>{
    sharedStore.catalog.set(symbol,syntheticMarket(symbol));
    __setOperationalUniverse([...sharedStore.catalog.keys()]);
    const end=Math.floor(Date.now()/3600000)*3600-3600;
    const candles=Array.from({length:200},(_,i)=>({t:end-(199-i)*3600,o:100,h:101,l:99,c:100,v:10+i}));
    history.put(symbol,"1h",candles);
    return {symbol,timeframe:"1h",candles,native:true,source:"ttt",fetched_at_ms:Date.now(),closed_count:200} as CandleSeries;
  };
  const strategy=(name:string,block=false):StrategyRuntimeDefinition=>{
    const id=`SET-LOCAL-TEST-${name}`;
    const refs=[{file:"LOCAL_TEST_ONLY.txt",start_line:1,end_line:1,quote:"SYNTHETIC market/strategy/account. Local HTTP Telegram stub, never real delivery."}];
    const sourceBlocker="LOCAL TEST ONLY: no authoritative corpus source or semantic-parity validation";
    const definition={setup_id:id,strategy_id:"STR-LOCAL-TEST",name:`LOCAL TEST ${name}`,family:"test",timeframe:"1h",direction:"long" as const,min_bars:120};
    return {...definition,availability:"EXECUTABLE",blocked_reason:"LOCAL TEST ONLY",version:"LOCAL-TEST",strategy_version:"LOCAL-TEST",
      rule_ids:[],rule_versions:[],source_contract_status:"UNKNOWN",source_contract_blockers:[sourceBlocker],source_refs:refs,
      impl:{...definition,
        build:(c,tf)=>MapFeatureBag.from([["FTR-LOCAL-TEST",okFeature("FTR-LOCAL-TEST",tf,1,c.at(-1)?.t??0,c.length,"LOCAL-TEST",["SYNTHETIC"] )]]),
        setup:()=>({...definition,version:"LOCAL-TEST",source_refs:refs,rules:(["context","location","structure","trigger","confirmation"] as const).map(kind=>({
          id:`${id}-${kind}`,description:"LOCAL TEST",source_text:"SYNTHETIC",source_refs:refs,source_status:"SOURCE_INFERRED" as const,empirical_status:"UNTESTED" as const,
          feature_dependencies:["FTR-LOCAL-TEST"],operator:"AND" as const,timeframe:"1h",direction:"long" as const,kind,unresolved:[],version:"LOCAL-TEST",
          predicates:[{expr:"synthetic > 0",requires:["FTR-LOCAL-TEST"],test:()=>({ok:true,detail:"LOCAL TEST condition"})}]
        }))}),
        levels:()=>({entry:100,stop:block?102:98,targets:[106],invalidation:97,level_assumptions:["LOCAL TEST ONLY"]})
      }};
  };
  try {
    const file=path.join(root,"scenario.json");
    if(action==="seed") {
      const a=await scanSymbol("BTCUSDT",strategy("PARTIAL"),"live");
      assert.equal(a.publish?.published,true,JSON.stringify(a));
      const sig=repo.signalByOpp(a.opportunity!.id)!;
      const partial=await deliverOutboxRow(repo.outboxGet(sig.outbox_id!)!,repo);
      assert.equal(partial.ok,false);
      const delivery=signalDelivery(repo,sig);
      assert.equal(delivery.progress?.photo_sent,true); assert.equal(delivery.progress?.text_sent,false);
      const blocked=await scanSymbol("ETHUSDT",strategy("RISK-BLOCK",true),"live");
      assert.equal(blocked.opportunity?.risk?.verdict,"block");
      assert.equal(repo.signalByOpp(blocked.opportunity!.id),null);
      const accepted=await scanSymbol("ADAUSDT",strategy("ACCEPTED"),"live");
      assert.equal(accepted.publish?.published,true);
      const sent=repo.signalByOpp(accepted.opportunity!.id)!;
      assert.equal((await deliverOutboxRow(repo.outboxGet(sent.outbox_id!)!,repo)).ok,true);
      const terminal=await scanSymbol("SOLUSDT",strategy("LIFECYCLE"),"live");
      assert.equal(terminal.publish?.published,true);
      repo.signalUpdate({id:terminal.publish!.id,state:"expired"});
      assert.equal((await deliverOutboxRow(repo.outboxGet(repo.signalGet(terminal.publish!.id)!.outbox_id!)!,repo)).ok,false);
      process.env.TEST_ACCOUNT_UNAVAILABLE="1";
      const unknown=await scanSymbol("XRPUSDT",strategy("UNKNOWN-LOSS"),"live");
      assert.equal(unknown.opportunity?.state,"REJECTED");
      assert.equal(repo.signalByOpp(unknown.opportunity!.id),null);
      fs.writeFileSync(file,JSON.stringify({label:"LOCAL TEST ONLY / synthetic; source status UNKNOWN; not source, policy, promotion, or production-live proof",synthetic_source_status:"UNKNOWN",synthetic_source_blocker:"LOCAL TEST ONLY: no authoritative corpus source or semantic-parity validation",partial_signal:sig.id,sent_signal:sent.id,terminal_signal:terminal.publish!.id,
        blocked_opportunity:blocked.opportunity!.id,unknown_opportunity:unknown.opportunity!.id,calls,delivery,signal_count:repo.signalList(100).length,outbox_count:repo.outboxList("ALL",100).length},null,2));
    } else {
      const old=JSON.parse(fs.readFileSync(file,"utf8"));
      const sig=repo.signalGet(old.partial_signal)!;
      assert.equal((await deliverOutboxRow(repo.outboxGet(sig.outbox_id!)!,repo)).ok,true);
      assert.deepEqual(calls.map(c=>c.method),["sendMessage"]);
      assert.equal(signalDelivery(repo,sig).progress?.photo_message_id,old.delivery.progress.photo_message_id);
      assert.equal(repo.signalList(100).length,old.signal_count);
      assert.equal(repo.outboxList("ALL",100).length,old.outbox_count);
      fs.writeFileSync(path.join(root,"restart-retry.json"),JSON.stringify({label:old.label,calls,delivery:signalDelivery(repo,sig),signal_count:repo.signalList(100).length,outbox_count:repo.outboxList("ALL",100).length},null,2));
    }
    console.log(`LOCAL TEST ${action}: PASS; real local HTTP requests=${calls.length}; external HTTP=0`);
  } finally {globalThis.fetch=realFetch;await new Promise<void>(r=>server.close(()=>r()));history.close();closeRepo();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
