> Historical recovery record. Fresh final closure results and superseding release verdict: [TEAM05_FINAL_CLOSURE.md](TEAM05_FINAL_CLOSURE.md). Older totals/limitations below describe the earlier checkpoint.

# Team 05 recovery evidence — 2026-09-26

## Baseline / capabilities (recorded before production edits)
- Branch `arena/01a0dcbf-asa`; HEAD `dcba86b5eb57dd65a5ba2a3f1005b6a7f217731e`; clean tracked and untracked worktree.
- `docs/roadmap/ASA_100_PERCENT_CONTRACT.md` does not exist. BEFORE/AFTER completion units, IDs and percentages: UNKNOWN. No substitute contract invented.
- Read all seven requested `_agent_arsenal/.agents/skills/asa-*/SKILL.md` files (orchestration, debugging, fullstack, git-release, visual QA, source fidelity, MCP hygiene).
- Available: native filesystem/process tools, Node 22.22.3, npm 10.9.8, git, gh. `gh pr list --head arena/01a0dcbf-asa --json number,title,state` returned `[]`. No connected Context7/Playwright/Chrome MCP exposed. No browser executable discovered initially. No remote writes authorized/performed.
- Initial command accidentally ran in `/home/user`, outside repository; rerun in `/home/user/AsA`; no files modified by that command.
- `npm install --no-package-lock --no-audit --no-fund` failed: native SQLite header download ECONNRESET. `npm_config_nodedir=/usr/local npm install --no-package-lock --no-audit --no-fund` passed using installed headers (446 packages). Dependency lock absent at baseline; versions pinned only at direct dependency layer.
- `npm test`: 47 files, 913 tests PASS, 112.30s.
- `npm run typecheck`: PASS. `npm run lint`: PASS. `npm run build`: PASS.
- Raw baseline outputs: `/home/user/asa-baseline-{tests,typecheck,lint,build}.log` (workspace evidence, not committed build artifacts).

## Pre-implementation contract matrix
| Boundary / owner | Producer → consumer | Identity / state / persistence | Failure / retry | Provenance / evidence |
|---|---|---|---|---|
| Market (T01) | `market/engine.ts`, `candles.ts` → `analysis/input.ts` | symbol × declared timeframe, closed candle source timestamp, durable history + memory | market scheduler bounded retries; stale input not admitted | `market-runtime-recovery`, `history-boundary`, `analysis-layer` tests |
| Analysis/strategy (T02/03) | `prepareAnalysisInput` → `strategy/runtime.evaluateRuntime` | setup, bar time, rules, levels | insufficient/unknown/blocked rules fail closed | `setup-admission-gate`, `setup-guard-unknown` |
| Admission (T05/shared) | `pipeline/orchestrator.scanSymbol` → `brain/score.admitOpportunity` | hash(symbol, tf, direction, setup, anchor); opportunity upsert | setup PASS, psychology, portfolio, risk, score; REJECTED/EXPIRED preserved | `live-signal-runtime`, `decision-truth-recovery` |
| Risk/publication (T05) | `risk/engine.evaluateRisk` → `publishSignal` | READY, pass object, unique signals.opp_id | current final gate only shape/verdict; **mismatch: forged pass + stale opportunity accepted** | `signal-publish` baseline does not attack authenticity/freshness |
| Signal/storage (T05) | publisher → SQLite signal + outbox | transaction; unique opp_id; candidate/qualified→published | **mismatch: lifecycle read before transaction; signalUpdate has no terminal guard** | rollback/idempotency tests; activation race not covered |
| Chart (T05/shared) | opportunity chart_evidence → chart API/Telegram renderer | symbol/tf checked, mutable opportunity lookup | **mismatch: new signal delivery contract can silently omit failed chart; no signal snapshot binding** | `chart-telegram`, `telegram-partial-send` |
| Outbox (T05) | publisher → `notify/telegram.deliverOutboxRow` | QUEUED/FAILED→SENT/DEAD; token+lease | **mismatch: stale input payload read after claim; owner writes ignore deadline; unclaimed writes unconditional; exhausted crash stranded** | `telegram-claim-lease`, attempts-accounting |
| Transport (T05) | outbox → Telegram sendPhoto/sendMessage | per-step booleans, 1 attempt per cycle, 5 max | timeouts; partial retry; acceptance/local crash inherently ambiguous | mocked provider tests, no exactly-once provider claim |
| Runtime (T05/T01) | engine start → candle.closed/candles.updated → live scanner; 60s drain | per-bar in-flight coalescing; per-process event ring | restart first-sighting catch-up; **error results deduped as completed; old completions regress watermark** | live-timeframe/runtime suites |
| API/UI (T05/shared) | `/api/signals`, `/api/opportunities`, `/api/system/notify` → pages | delivery read from outbox, legacy payload match | **malformed legacy JSON can break provenance SQL; UI empty hides loading/failure** | API tests, browser verification pending |

## Scope / decision log
Repair verified boundary defects without changing strategy methodology or adding execution capability. Production truth remains external-provider-dependent. Existing tests use synthetic PASS objects; positive publisher fixtures must move to genuine engine results rather than retaining a bypass. Preserve four-bar display/expiry vs two-bar admission as separately documented existing policies. No fabricated roadmap completion or production provider evidence.

## Final state pointer

See `TEAM05_REPORT.md` for the complete after-state, per-defect proof, exact final commands/counts, remaining interface request, unknowns and file inventory. Final local suite: 50 files / 973 tests; targeted: 16 files / 217 tests; browser: 8 scoped checks. Typecheck/lint/build passed. Provider-complete live end-to-end and roadmap completion remain unverified/blocked, not green.

Browser capability was recovered after the initial discovery: the standard CDN download failed; an npm-packaged Chromium plus bundled NSS libraries launched through locally installed Playwright (outside repository dependencies). This is actual shell-driven browser automation, not a claimed connected MCP.
