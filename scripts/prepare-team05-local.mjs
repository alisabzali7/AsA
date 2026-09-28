/**
 * Compile a strictly separate LOCAL TEST scenario. All source/policy overrides
 * below exist only in the generated test bundle; production source is never
 * patched. Data must live in a new directory with this exact basename.
 *
 * Usage: node scripts/prepare-team05-local.mjs /tmp/team05-local-evidence seed|retry
 */
import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const root = path.resolve(process.argv[2] ?? "_verify/team05-local-evidence");
if (path.basename(root) !== "team05-local-evidence") throw new Error("refusing non-test destination");
const action = process.argv[3] ?? "seed";
if (!["seed", "retry"].includes(action)) throw new Error("seed|retry only");
await fs.mkdir(root, { recursive: true });
if (action === "seed") {
  try {
    await fs.access(path.join(root, "asa.db"));
    throw new Error("test database already exists; use retry, not reseeding");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.writeFile(
    path.join(root, "LOCAL_TEST_ONLY.txt"),
    "SYNTHETIC market/strategy/account. Local HTTP Telegram stub, never real delivery.\n",
  );
} else {
  await fs.access(path.join(root, "LOCAL_TEST_ONLY.txt"));
}

const require = createRequire(import.meta.url);
const replaceExactly = (source, before, after, label) => {
  if (!source.includes(before)) throw new Error(`LOCAL TEST bundle seam not found: ${label}`);
  return source.replace(before, after);
};
const buildResult = await build({
  entryPoints: ["scripts/team05-local-scenario.ts"],
  outfile: path.join(root, "scenario.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  plugins: [
    {
      name: "LOCAL-TEST-ONLY",
      setup(b) {
        b.onResolve({ filter: /^better-sqlite3$/ }, () => ({
          path: require.resolve("better-sqlite3"),
          external: true,
        }));
        b.onLoad({ filter: /backtest\/promotion\.ts$/ }, async (args) => {
          let source = await fs.readFile(args.path, "utf8");
          source = replaceExactly(
            source,
            "export function promotedRuntimeStatus(",
            "function realPromotedRuntimeStatus(",
            "promotion",
          );
          source += '\nexport function promotedRuntimeStatus(id:string){return id==="STR-LOCAL-TEST"?"LIVE_ADVISORY_ONLY":realPromotedRuntimeStatus(id);}\n';
          return { contents: source, loader: "ts" };
        });
        b.onLoad({ filter: /risk\/policy\.ts$/ }, async (args) => {
          let source = await fs.readFile(args.path, "utf8");
          source = replaceExactly(
            source,
            "export function getProductionRiskPolicy(",
            "function realGetProductionRiskPolicy(",
            "risk policy",
          );
          source += `
export function getProductionRiskPolicy(){
  const sourcePolicy=selectableRiskPolicies().find(policy=>policy.policy_id==="RISK-DAILY-5PCT");
  if(!sourcePolicy)throw new Error("LOCAL TEST policy fixture is missing");
  return {...sourcePolicy,selection_status:"SELECTED",selected_by:"operator_pref",
    selection_reason:"LOCAL TEST ONLY: explicit fixture; production source eligibility remains blocked",
    policy_version:RISK_POLICY_VERSION,source_completeness:riskPolicyEligibility(sourcePolicy).source_completeness};
}
`;
          return { contents: source, loader: "ts" };
        });
        b.onLoad({ filter: /psychology\/gate\.ts$/ }, async (args) => {
          let source = await fs.readFile(args.path, "utf8");
          source = replaceExactly(
            source,
            "export function evaluatePsychologyGate(",
            "function realEvaluatePsychologyGate(",
            "psychology",
          );
          source += `
export function evaluatePsychologyGate(..._args:Parameters<typeof realEvaluatePsychologyGate>):ReturnType<typeof realEvaluatePsychologyGate>{
  return {verdict:"pass",score_penalty:0,blocks:[],penalties:[],flags:[],checklists_required:[],
    not_evaluated:[],evaluated:1,active_policy_ids:["LOCAL-TEST-ONLY"]};
}
`;
          return { contents: source, loader: "ts" };
        });
        b.onLoad({ filter: /strategy\/runtime\.ts$/ }, async (args) => {
          let source = await fs.readFile(args.path, "utf8");
          source = replaceExactly(
            source,
            "export function getRuntimeStrategy(",
            "function realGetRuntimeStrategy(",
            "synthetic runtime",
          );
          source += `
export function getRuntimeStrategy(id:string):ReturnType<typeof realGetRuntimeStrategy>{
  if(!id.startsWith("SET-LOCAL-TEST-"))return realGetRuntimeStrategy(id);
  return {strategy_id:"STR-LOCAL-TEST",setup_id:id,name:"LOCAL TEST synthetic strategy",family:"test",
    direction:"long",timeframe:"1h",min_bars:120,availability:"EXECUTABLE",blocked_reason:"LOCAL TEST ONLY",
    source_contract_status:"UNKNOWN",
    source_contract_blockers:["LOCAL TEST ONLY: no authoritative corpus source or semantic-parity validation"],
    strategy_version:"LOCAL-TEST",version:"LOCAL-TEST",rule_ids:[],rule_versions:[],
    source_refs:[{file:"LOCAL_TEST_ONLY.txt",start_line:1,end_line:1,quote:"SYNTHETIC market/strategy/account. Local HTTP Telegram stub, never real delivery."}],impl:null};
}
`;
          return { contents: source, loader: "ts" };
        });
        b.onLoad({ filter: /pipeline\/orchestrator\.ts$/ }, async (args) => {
          let source = await fs.readFile(args.path, "utf8");
          source = replaceExactly(
            source,
            `if (runtime.availability !== "EXECUTABLE" || runtime.source_contract_status !== "SOURCE_FAITHFUL" ||
      !Array.isArray(runtime.source_contract_blockers) || runtime.source_contract_blockers.length > 0) {`,
            `if (runtime.availability !== "EXECUTABLE" || (runtime.strategy_id !== "STR-LOCAL-TEST" &&
      (runtime.source_contract_status !== "SOURCE_FAITHFUL" || !Array.isArray(runtime.source_contract_blockers) || runtime.source_contract_blockers.length > 0))) {`,
            "isolated synthetic-source boundary",
          );
          source = replaceExactly(
            source,
            `if (opp.source_contract_status !== runtime.source_contract_status || !Array.isArray(opp.source_contract_blockers) || opp.source_contract_blockers.length > 0 ||
      opp.direction !== runtime.direction || opp.timeframe !== runtime.timeframe || opp.strategy_version !== runtime.strategy_version ||`,
            `if (opp.source_contract_status !== runtime.source_contract_status ||
      (runtime.strategy_id !== "STR-LOCAL-TEST" && (!Array.isArray(opp.source_contract_blockers) || opp.source_contract_blockers.length > 0)) ||
      opp.direction !== runtime.direction || opp.timeframe !== runtime.timeframe || opp.strategy_version !== runtime.strategy_version ||`,
            "isolated synthetic-source identity boundary",
          );
          return { contents: source, loader: "ts" };
        });
        b.onLoad({ filter: /pipeline\/live-gates\.ts$/ }, async (args) => {
          let source = await fs.readFile(args.path, "utf8");
          source = replaceExactly(source, "export function loadLiveGateContext(", "function realLoadLiveGateContext(", "synthetic account measurements");
          source += `
export function loadLiveGateContext(...args:Parameters<typeof realLoadLiveGateContext>){
  const context=realLoadLiveGateContext(...args);
  const unavailable=process.env.TEST_ACCOUNT_UNAVAILABLE==="1";
  return {...context,daily_realized_loss:unavailable?null:0,period_realized_loss:unavailable?null:0};
}
`;
          return { contents: source, loader: "ts" };
        });
      },
    },
  ],
});
void buildResult;

const run = spawnSync(process.execPath, [path.join(root, "scenario.cjs"), action, root], {
  stdio: "inherit",
  env: {
    ...process.env,
    ASA_DB_PATH: path.join(root, "asa.db"),
    ASA_HISTORY_DB_PATH: path.join(root, "history.db"),
    ASA_BRAIN_DB_PATH: path.join(root, "brain.db"),
    TELEGRAM_BOT_TOKEN: "LOCAL-TEST-NOT-A-TOKEN",
    TELEGRAM_CHAT_ID: "LOCAL-TEST",
    TELEGRAM_DRY_RUN: "0",
  },
});
process.exitCode = run.status ?? 1;
