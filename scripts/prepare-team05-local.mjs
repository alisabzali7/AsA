/** Compile a strictly separate LOCAL TEST scenario. No production seam is added.
 * Usage: node scripts/prepare-team05-local.mjs /home/user/team05-local-evidence seed|retry
 * Data must live in a new directory with that exact basename, never the live DB.
 */
import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const root=path.resolve(process.argv[2] ?? "_verify/team05-local-evidence");
if(path.basename(root)!=="team05-local-evidence") throw new Error("refusing non-test destination");
const action=process.argv[3] ?? "seed";
if(!["seed","retry"].includes(action)) throw new Error("seed|retry only");
await fs.mkdir(root,{recursive:true});
if(action==="seed") {
  try {await fs.access(path.join(root,"asa.db")); throw new Error("test database already exists; use retry, not reseeding");}
  catch(e) {if(e.code!=="ENOENT") throw e;}
  await fs.writeFile(path.join(root,"LOCAL_TEST_ONLY.txt"),"SYNTHETIC market/strategy/account. Local HTTP Telegram stub, never real delivery.\n");
} else await fs.access(path.join(root,"LOCAL_TEST_ONLY.txt"));
const require=createRequire(import.meta.url);
await build({entryPoints:["scripts/team05-local-scenario.ts"],outfile:path.join(root,"scenario.cjs"),bundle:true,platform:"node",format:"cjs",logLevel:"silent",plugins:[
  {name:"LOCAL-TEST-ONLY",setup(b){
    b.onResolve({filter:/^better-sqlite3$/},()=>({path:require.resolve("better-sqlite3"),external:true}));
    b.onLoad({filter:/backtest\/promotion\.ts$/},async a=>({contents:(await fs.readFile(a.path,"utf8")).replace("export function promotedRuntimeStatus(","function realStatus(")+'\nexport function promotedRuntimeStatus(id:string){return id==="STR-LOCAL-TEST"?"LIVE_ADVISORY_ONLY":realStatus(id);}',loader:"ts"}));
    b.onLoad({filter:/pipeline\/live-gates\.ts$/},async a=>({contents:(await fs.readFile(a.path,"utf8")).replace("export function loadLiveGateContext(","function realContext(")+'\nexport function loadLiveGateContext(...args:Parameters<typeof realContext>){const c=realContext(...args); return {...c,daily_realized_loss:process.env.TEST_ACCOUNT_UNAVAILABLE==="1"?null:0,period_realized_loss:process.env.TEST_ACCOUNT_UNAVAILABLE==="1"?null:0};}',loader:"ts"}));
  }}]});
const run=spawnSync(process.execPath,[path.join(root,"scenario.cjs"),action,root],{stdio:"inherit",env:{...process.env,
  ASA_DB_PATH:path.join(root,"asa.db"),ASA_HISTORY_DB_PATH:path.join(root,"history.db"),ASA_BRAIN_DB_PATH:path.join(root,"brain.db"),
  TELEGRAM_BOT_TOKEN:"LOCAL-TEST-NOT-A-TOKEN",TELEGRAM_CHAT_ID:"LOCAL-TEST",TELEGRAM_DRY_RUN:"0"}});
process.exitCode=run.status??1;
