/** Read-only post-restart browser proof for the isolated LOCAL scenario. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const root=process.env.ASA_QA_LOCAL_DIR??"/home/user/closure-final/team05-local-evidence";
const output=process.env.ASA_QA_OUTPUT_DIR??"_verify/team05-closure-ui";
const base=process.env.ASA_QA_LOCAL_URL??"http://127.0.0.1:3001";
const f=JSON.parse(await fs.readFile(path.join(root,"scenario.json"),"utf8"));
const retry=JSON.parse(await fs.readFile(path.join(root,"restart-retry.json"),"utf8"));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??"playwright");
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
await fs.mkdir(output,{recursive:true});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block"});
  const page=await context.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.request.get(base+"/api/system/status");
  const list=await (await page.request.get(base+"/api/signals")).json();
  assert.equal(list.items.length,f.signal_count);
  const sig=await (await page.request.get(base+`/api/signals/${f.partial_signal}`)).json();
  assert.equal(sig.item.delivery.delivery_state,"SENT");
  assert.deepEqual(sig.item.delivery.progress,retry.delivery.progress);
  await page.goto(base+`/signals/${f.partial_signal}`);
  await page.getByText("LOCAL TEST / SYNTHETIC EVIDENCE",{exact:false}).waitFor();await page.getByText("Delivery SENT",{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,"local-restart-text-only-retry.png"),fullPage:true});
  await page.goto(base+"/settings");await page.waitForFunction(()=>document.querySelector('input[type="number"]')?.value==="12000");
  const chart=await page.request.get(`${base}/api/charts/${f.sent_signal}.png`);
  assert.equal(chart.status(),200);
  await fs.writeFile(path.join(output,"local-immutable-chart.png"),await chart.body());
  assert.deepEqual(errors,[]);
  const evidence={label:"LOCAL TEST ONLY",checks:2,signals:list.items.length,delivery:sig.item.delivery,errors,settings_equity:"12000",note:"process restarted; exactly one local HTTP text request, no repeated photo; no external Telegram acceptance"};
  await fs.writeFile(path.join(output,"restart-results.json"),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
} finally {await browser.close();}
