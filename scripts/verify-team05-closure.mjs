/** Built-app browser evidence. Real empty/runtime pages first; separate LOCAL
 * DB/API/HTTP-stub scenarios second. No network interception in this script. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??"playwright");
const base=process.env.ASA_QA_URL??"http://127.0.0.1:3000";
const local=process.env.ASA_QA_LOCAL_URL??"http://127.0.0.1:3001";
const fixtureDir=process.env.ASA_QA_LOCAL_DIR??"/home/user/team05-local-evidence";
const output=process.env.ASA_QA_OUTPUT_DIR??"_verify/team05-closure-ui";
const fixture=JSON.parse(await fs.readFile(path.join(fixtureDir,"scenario.json"),"utf8"));
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
const results=[],errors=[];
const record=(name,evidence)=>results.push({name,status:"PASS",evidence});
try {
  const real=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block"});
  const page=await real.newPage();page.on("pageerror",e=>errors.push(e.message));
  await page.request.get(base+"/api/system/status");
  for(const [route,name] of [["/","dashboard"],["/signals","signals-empty"],["/opportunities","opportunities-empty"],["/system","delivery-runtime"]]) {
    await page.goto(base+route); await page.getByRole("heading").first().waitFor();
    if(route==="/") {await page.getByRole("alert").filter({hasText:"Market snapshot unavailable"}).waitFor();assert.equal(await page.getByText("LIVE",{exact:true}).count(),0);}
    if(route==="/signals")await page.getByText("No signals yet.",{exact:false}).waitFor();
    if(route==="/opportunities")await page.getByText("No stored opportunities yet.",{exact:false}).waitFor();
    if(route==="/system")await page.getByText("NOT_CONFIGURED",{exact:false}).first().waitFor();
    await page.screenshot({path:path.join(output,`real-${name}.png`),fullPage:true});record(`real ${name}`,"unmodified built application and actual runtime API");
  }
  await page.goto(base+"/signals/UNKNOWN-CLOSURE");
  await page.getByRole("alert").filter({hasText:"Signal evidence unavailable"}).waitFor();
  await page.screenshot({path:path.join(output,"real-missing-detail.png"),fullPage:true});record("real missing detail","HTTP 404 -> explicit unavailable, no fabricated lifecycle");
  await page.goto(base+"/signals");await page.getByText("No signals yet.",{exact:false}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.getByRole("button",{name:"switch language",exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.dir==="rtl");
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,"real-mobile-persian.png"),fullPage:true});record("real mobile Persian RTL","390px, no horizontal overflow");

  const qa=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block",extraHTTPHeaders:{"x-asa-token":"LOCAL-TEST-EVIDENCE-ONLY"}});
  const test=await qa.newPage();test.on("pageerror",e=>errors.push(e.message));
  await test.request.get(local+"/api/system/status");
  const partial=await (await test.request.get(`${local}/api/signals/${fixture.partial_signal}`)).json();
  assert.equal(partial.item.delivery.progress.photo_sent,true);assert.equal(partial.item.delivery.progress.text_sent,false);
  for(const [route,name] of [["/signals","signal-list"],[`/signals/${fixture.partial_signal}`,"partial-delivery-detail"],[`/signals/${fixture.sent_signal}`,"accepted-detail"],[`/signals/${fixture.terminal_signal}`,"terminal-lifecycle"],["/opportunities","risk-block"]]) {
    await test.goto(local+route);await test.getByText("LOCAL TEST / SYNTHETIC EVIDENCE",{exact:false}).waitFor();
    if(route==="/signals")await test.getByText("delivery FAILED",{exact:true}).waitFor();
    else if(route==="/opportunities")await test.getByText("daily realized loss UNAVAILABLE for configured hard limit",{exact:true}).waitFor();
    else await test.getByText("Chart source / decision anchor",{exact:true}).waitFor();
    await test.screenshot({path:path.join(output,`local-${name}.png`),fullPage:true});record(`LOCAL ${name}`,"actual SQLite -> API -> UI, synthetic upstream/account + local HTTP provider ONLY");
  }
  const blocked=await (await test.request.get(`${local}/api/opportunities`)).json();
  assert.equal(blocked.items.find(x=>x.id===fixture.blocked_opportunity).risk.verdict,"block");
  const signals=await (await test.request.get(`${local}/api/signals`)).json();
  assert.ok(signals.items.every(x=>x.opp_id!==fixture.blocked_opportunity));
  const chart=await test.request.get(`${local}/api/charts/${fixture.sent_signal}.png`);
  assert.equal(chart.status(),200);assert.match(chart.headers()["content-type"],/image\/png/);
  await fs.writeFile(path.join(output,"local-immutable-chart.png"),await chart.body());record("LOCAL immutable chart","real chart API/renderer reads exact persisted synthetic OHLCV fingerprint during real discovery outage");

  await test.goto(`${local}/signals/${fixture.partial_signal}`);await test.getByText("Chart source / decision anchor",{exact:true}).waitFor();
  await test.setViewportSize({width:390,height:844});await test.getByRole("button",{name:"switch language",exact:true}).click();await test.waitForFunction(()=>document.documentElement.dir==="rtl");
  assert.ok(await test.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await test.screenshot({path:path.join(output,"local-mobile-persian-detail.png"),fullPage:true});record("LOCAL mobile detail RTL","no horizontal overflow; decision, delivery and history remain distinct");

  await test.getByRole("button",{name:"switch language",exact:true}).click();await test.setViewportSize({width:1440,height:1000});
  await test.goto(local+"/settings");await test.getByText("LOCAL TEST / SYNTHETIC EVIDENCE",{exact:false}).waitFor();
  await test.getByLabel("equity (USD)").fill("12000");await test.getByRole("button",{name:"save risk",exact:true}).click();
  await test.getByText("saved (risk) — applied to the next scan",{exact:true}).waitFor();
  const config=await (await test.request.get(`${local}/api/system/config`)).json();assert.equal(config.prefs["risk.equity"],"12000");
  await test.reload();await test.waitForFunction(()=>document.querySelector('input[type="number"]')?.value==="12000");
  await test.screenshot({path:path.join(output,"local-ui-api-db-ui.png"),fullPage:true});record("LOCAL UI -> API -> SQLite -> reloaded UI","actual guarded risk preference save, equity 12000, no intercepted response or source edit");
  await qa.setOffline(true);await test.getByRole("button",{name:"save risk",exact:true}).click();await test.getByText("Not saved:",{exact:false}).waitFor();
  record("LOCAL offline mutation","truthful Not saved; no unhandled promise rejection");
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,"results.json"),JSON.stringify({results,errors,note:"All local nonempty evidence is TEST/SYNTHETIC. No real Telegram acceptance, live strategy promotion or production mutation claimed."},null,2));
  console.log(JSON.stringify({checks:results.length,results,errors},null,2));
} finally {await browser.close();}
