> Historical recovery record. Fresh final closure results and superseding release verdict: [TEAM05_FINAL_CLOSURE.md](TEAM05_FINAL_CLOSURE.md). Older totals/limitations below describe the earlier checkpoint.

# AsA Team 05 — integration recovery / release evidence

Date: 2026-09-26 UTC. This report describes the checked-out code and executed checks, not a production certification. **AsA remains advisory-only. No order/execution capability was added. No PR, push, merge, or commit was performed.**

Evidence categories: VERIFIED = directly exercised or inspected; INFERRED = supported but not fully exercised; UNKNOWN = insufficient authoritative evidence; BLOCKED = unavailable capability/dependency. The pre-edit matrix and capability discovery are in [TEAM05_RECOVERY.md](TEAM05_RECOVERY.md). Raw validation, reproductions, runtime responses and browser evidence are in [../evidence/team05](../evidence/team05); `manifest.json` binds their sizes and SHA-256 hashes.

## BASELINE

- Branch: `arena/01a0dcbf-asa`.
- HEAD, unchanged: `dcba86b5eb57dd65a5ba2a3f1005b6a7f217731e` (`chore: add AsA Agent Arsenal`).
- Initial working tree: clean, including untracked files. No pre-existing user edits to preserve. All final changes belong to this mission; generated databases, dependencies and build output remain outside Git.
- `npm test`: **47 files / 913 tests passed**, 112.30s.
- `npm run typecheck`, `npm run lint`, `npm run build`: **passed**.
- Initial dependency installation failed fetching native Node headers (`ECONNRESET`). Recovered with `npm_config_nodedir=/usr/local npm install --no-package-lock --no-audit --no-fund`, using installed headers. Node 22.22.3, npm 10.9.8.
- The requested `docs/roadmap/ASA_100_PERCENT_CONTRACT.md` **does not exist**. Exact completion units, IDs, definitions, statuses and numeric accounting are **UNKNOWN**, both BEFORE and AFTER. No other document has been substituted as the North Star.
- All seven named skills were read. Native filesystem/process tools and `git`/`gh` were available. No connected Context7/Playwright/Chrome MCP was exposed. `gh pr list --head arena/01a0dcbf-asa --json number,title,state` returned `[]`; no remote write followed.
- Baseline-green tests missed real boundary defects: caller-shaped PASS, stale publication, out-of-lease writes, unowned terminal mutation, stale delivery snapshots, double-counted attempts, stranded exhausted claims, permissive unknown admission inputs, missing chart/signal binding, HTTP-success-only acceptance, error-event acknowledgement and corrupt legacy provenance JSON.

## INTEGRATION_RECOVERY

### Actual path traced

`MARKET` (`market/engine.ts`, `market/candles.ts`, `market/history-store.ts`, `ttt/http.ts`)
→ `ANALYSIS` (`analysis/input.ts`: closed-bar identity/freshness)
→ `STRATEGY` (`strategy/runtime.ts`: `evaluateRuntime`)
→ `OPPORTUNITY` (`pipeline/orchestrator.ts`: `scanSymbol`; `brain/score.ts`: `admitOpportunity`)
→ `RISK` (`risk/live.ts`, `risk/engine.ts`, `risk/portfolio.ts`, `pipeline/live-gates.ts`)
→ `SIGNAL` (`publishSignal`, `signal-lifecycle.ts`, `db/sqlite.ts`)
→ `CHART` (`chart/evidence.ts`, `chart/source.ts`, `chart/render.ts`, chart API)
→ `OUTBOX` (same SQLite publication transaction, `signals.outbox_id`)
→ `TELEGRAM` (`notify/telegram.ts`: claim, progress, provider sub-steps)
→ `API/UI` (`api/signals`, `api/opportunities`, `api/system/notify`, `signals/page.tsx`)
→ `HUMAN` (advisory explanation, lifecycle, delivery/provenance; never execution).

Risk is computed before admission and re-evaluated again at final publication. The arrows describe provenance/authority, not a claim that every computation occurs strictly once in that sequence. The AI/psychology layers do not publish or execute.

### Defect → cause → structural repair → proof

| Defect / broken invariant | Root cause / owning boundary | Repair and files | Regression / validation | Remaining limitation |
|---|---|---|---|---|
| Forged or stale PASS could publish | Publisher trusted `{verdict:'pass',reasons:[]}` without evaluating current server inputs | Shared `risk/live.ts` assembles server-owned inputs; publisher compares the authoritative engine result, rejects malformed levels, stale/future source time, inconsistent identity and absent/mismatched chart evidence. `risk/engine.ts` blocks invalid runtime numerics. | `signal-publish`, `risk-engine`: invalid-stop PASS, changed equity, missing/unknown/malformed risk, policy/result disagreement, renamed ID | Not a cryptographic database-tamper defense; application/database access remains trusted. Risk policy still explicitly reports unavailable venue constraints. |
| Unknown admission became success | Typed enums/booleans treated as runtime validation | `brain/score.ts` rejects unknown risk/portfolio/psychology/conflict/freshness and non-finite scores; preserves distinct reasons | Seven adversarial input failures reproduced before repair; setup/admission and full suite pass | Existing psychology `not_evaluated` / portfolio `unenforced` policy semantics preserved, not rewritten into invented methodology. |
| Candidate activation race / terminal mutation | Lifecycle read occurred before transaction; repository accepted arbitrary updates | `BEGIN IMMEDIATE` covers lifecycle read and enqueue/write; canonical transition guard; immutable identity/decision; v4 transition audit | Separate worker connections activate one candidate: one signal, one outbox, one publication transition; terminal resurrection refused | SQLite filesystem is trusted; no claim about arbitrary direct SQL writers or distributed DB deployment. |
| Same logical opportunity could be renamed | Publisher accepted arbitrary supplied opportunity IDs | Enforce `idFor(symbol,tf,direction,setup,anchor)` and cross-timeframe anchor consistency | Renamed replay produces no second signal/outbox | Legacy identities are retained; new ad-hoc publisher inputs now require canonical provenance. |
| Worker could write after expiry; stale preflight could revive SENT | Ownership writes checked token only; unowned writes unconditional | `sqlite.ts`: token+claim time+unexpired lease+retryable state on writes; unowned preflight cannot mutate claimed/terminal rows; renewal before every sub-step | Reclaim, expired-before-reclaim, stale-owner mutation, two-worker claim, slow photo/lease-loss tests | Provider request already accepted/in flight cannot be recalled after lease loss. |
| Retry duplicated an accepted photo | Worker used caller's old row payload after acquiring ownership | `telegram.ts` reloads authoritative row after claim; remembers each sub-step | Deliberately stale row passed twice; both partial-send orderings; restart/worker tests | Acceptance followed by failed local persistence remains inherently ambiguous. |
| Retry budget consumed twice or stranded after final crash | Count helper not idempotent; exhausted rows excluded forever | v3 `attempt_claim`; once per acquired cycle; drain recovers expired exhausted rows to SENT only if every acceptance was persisted, otherwise DEAD | Same-cycle double count; reused worker token/new cycle; exhausted crash with/without complete progress | Counter is committed immediately before provider call: a crash in that unavoidable instruction window conservatively spends an attempt. |
| HTTP 200 was falsely SENT | Transport checked only HTTP status | Require HTTP success and Telegram body `ok:true`; oversize full-text payloads DEAD instead of silently truncating | HTTP 200/`ok:false`, 5xx, timeout-style/throwing transport and partial-send tests | Provider message IDs and exact provider error descriptions are not retained; outcomes remain step-level booleans/errors. |
| Wrong/revised/missing chart could accompany text or become text-only success | Mutable opportunity lookup; current candles; photo requirement inferred only after successful render | Immutable signal snapshot reference; chart required at enqueue; exact anchor and SHA-256 OHLCV dataset reference; historical cache verification/refetch | Rescanned opportunity contamination, revised OHLCV, missing history/text success then chart retry, wrong symbol, chart API snapshot tests | If original candles cannot be recovered, chart stays incomplete; no invented image. Legacy optional-photo contract is explicitly weaker. |
| Failed/reordered events suppressed recovery | Error result acknowledged close; older completion overwrote watermark | `live-scan.ts`: no acknowledgement on error/not-evaluated/refused; monotonic completed watermark | Error then same-bar replay recovers; older event ignored; restart/replay tests | Event bus is in-process/non-durable; missed intermediate historical events are not replayed as current advice. |
| Boot backfill could precede scanner subscription | Discovery could enqueue candles before listener attachment | `market/engine.ts`: subscribe and expire at boot before discovery; non-overlapping interval callbacks | Startup-order assertion in market recovery test; real started runtime reports subscribed | Engine remains lazy-started through boot-aware routes; documented status warm-up is required for headless deployments. |
| API hid corruption, stale lifecycle or true notification state | Null JSON crash; double decode; timer-only expiry; counts sampled at 500; dry-run text overclaimed QUEUED | Safe parser/status, cold-read expiry with transactional recheck, exact SQL counts, per-test-row delivery state, corrected notify wording | `team05-api`: null payload, percent parameter, malformed action/body, cold expiry, >500 rows, unconfigured dry-run | No automatic/manual execution API was added; production mutation guard remains fail-closed. |
| UI displayed empty success on error and hid provenance | Loading/error discarded, misleading linear lifecycle text | `signals/page.tsx`: separate loading/error/empty/stale/offline states, partial progress and provenance link, canonical state names | Eight browser checks including real empty API response and explicitly intercepted test states; screenshots inspected | Not a complete UI redesign/accessibility audit; some existing/new explanatory strings remain English in Persian mode. |
| Research/live projection disagreement | Opportunity upsert changed payload mode but not scalar mode | `sqlite.ts` updates mode while retaining creation time | Research→live same-anchor persistence regression reproduced then passes | Does not rewrite strategy identity/methodology. |

## OPPORTUNITY

- Existing repository vocabulary: `SCANNING`, `ANALYZING`, `CANDIDATE`, `RISK_CHECK`, `READY`, `REJECTED`, `COOLDOWN`, `EXPIRED`. Not every vocabulary member has an implemented production transition; no complete opportunity state machine is claimed.
- `scanSymbol` requires executable strategy implementation and enough closed bars; setup outcome must be PASS before opportunity persistence. Admission additionally gates measured freshness, risk, portfolio, psychology, score, conflicts and live promotion.
- Non-PASS setup returns an explicit outcome/reason, not a publishable opportunity. Admission-rejected opportunities persist reasons; `READY` is not inferred from freshness.
- Publisher now also requires canonical setup/anchor identity, valid source timing, real risk re-evaluation, and matching chart/dataset provenance.
- `psychology.not_evaluated` now survives into the opportunity snapshot instead of disappearing. Unavailable policy measurements are not claimed as measured zeros.
- Entry points: engine close-refresh and first-sighting candle events → live scanner → canonical scan; no second decision pipeline introduced.

## RISK

- Authority: `evaluateRisk`, with inputs from server policy, preferences and current catalog assembled in `evaluateLiveRisk`; portfolio and psychology remain upstream admission constraints.
- Final publisher accepts only explicit PASS with string reasons and numbers matching current authoritative evaluation; risk failure cannot be overridden by READY, score, AI, psychology, UI or Telegram.
- Tested negatives: block/reject/deny/unknown/missing/malformed/unavailable, invalid direction/numerics, forged PASS over bad stop, stale result after equity change, future/stale source, contradictory hard block.
- Policy numbers were not changed. Existing source-conflict selection remains in `risk/policy.ts`. Missing venue minQty/minNotional and other unavailable constraints remain explicitly unenforced, not invented.
- There is no public signal-publication POST route. Storage adapters remain trusted application infrastructure, not an authorization layer against arbitrary code/SQL access.

## SIGNAL

| Current state | Allowed state changes |
|---|---|
| candidate | qualified, blocked_by_risk, published, expired, invalidated |
| qualified | blocked_by_risk, published, expired, invalidated |
| published | expired, invalidated, closed, archived, blocked_by_risk |
| blocked_by_risk / expired / invalidated / closed / archived | no state changes |
| unknown | no state changes |

Same-state updates are idempotent; terminal no-op writes do not rewrite timestamps. Terminal mutation and decision/identity rewriting are refused. `publishActionFor` still classifies unknown state as terminal/fail-safe. Publication itself remains the sole production signal-create/activate caller.

One natural-key opportunity maps to one signal; candidate identity and `created_ms` survive activation. Lifecycle transitions are recorded transactionally in `signal_transitions`, with actual observation time, not reconstructed legacy dates. New chart evidence and OHLCV fingerprint are in the immutable decision snapshot; outbox ID remains a stable reference. Expiry uses source anchor and row timeframe, not a recent update timestamp; cold API reads cannot leave obviously stale rows presented as active.

Invalidation/close/archive transitions are guarded and tested. A complete automatic market-triggered invalidation/closure business policy is **UNKNOWN**; none was invented.

## TELEGRAM

- Persisted states: `QUEUED`, `FAILED`, `SENT`, `DEAD`. `SENDING` is an API projection of a live claim, not a separate misleading persisted success state.
- Atomic claim: unique cycle token, claim timestamp, persisted 120-second lease; renew while still owner before every provider sub-step. Expired/reclaimed owners cannot mutate, count, renew or start the next sub-step.
- Budget: five logical transport cycles. Photo+text is one attempt per acquired cycle. Inspection, config absence, dry-run, poison preflight and lost claim before transport spend zero.
- Retry reloads progress, persists photo requirement before transport, then persists each acceptance. Either photo-success/text-failure or photo-failure/text-success resumes only the missing part. Full SENT requires the complete contract.
- New signals require chart+text from enqueue; source snapshot/identity/time/dataset are checked. Required unavailable chart never becomes optional. Terminal/stale linked legacy signals are also refused.
- Deterministic parse/format/identity/oversize poison is DEAD without provider budget. Required historical data unavailability can recover and remains incomplete; current-signal expiry eventually refuses obsolete delivery. DEAD/SENT are non-retryable and cannot be revived by preflight.
- Final-attempt crash: persisted full acceptance can finalize SENT; ambiguous acceptance finalizes DEAD after lease expiry. Error explains ambiguity, not fake certainty.
- Provider semantics are controlled at-least-once, **not exactly-once**. The test explicitly demonstrates duplicate photo after provider acceptance followed by a failed local progress write.
- Actual external Telegram delivery is **BLOCKED / NOT CONFIGURED** in this sandbox. No real provider acceptance was fabricated.

## IDEMPOTENCY

Canonical key: `sha1(symbol|timeframe|direction|setup_id|anchor_open_seconds).slice(0,16)`, then `sig-<opportunity-id>` for newly created signals. An already-existing candidate ID remains authoritative on activation.

SQLite PK/unique `signals.opp_id` plus `BEGIN IMMEDIATE` across lifecycle reads and atomic outbox+signal+audit writes enforce publication identity. Tests use separate worker isolates and SQLite connections, not only promises sharing a connection. Duplicate event/request-like publisher replay and renamed IDs are covered. Crash/restart progress persists on the same outbox ID; per-cycle attempts are idempotent in storage.

Operator `notify action=test` intentionally creates a test notification per invocation; there is no invented API idempotency-key policy for those unrelated test messages.

## PROVENANCE

New scan snapshots contain symbol/timeframe, source anchor, strategy/setup, rules/evidence/source refs, score decomposition, psychology/portfolio availability, risk numbers/reasons, chart annotations and `chart_source {from_s,to_s,bars,sha256}`. SHA-256 covers ordered `[t,o,h,l,c,v]` tuples actually used for the decision, not a decorative current chart.

Signal→outbox reference is persisted in the publication transaction. Outbox→signal reference selects the immutable decision for transport. Delivery state/progress/errors are read live; no copied mutable delivery state on signals. API detail exposes recorded transition history; UI links to it and labels partial delivery and legacy links.

Legacy null outbox references use `legacy_payload_match`, guarded against malformed JSON. Missing modern references remain UNLINKED. Legacy historical chart completeness, unrecorded prior transitions and provider message IDs are not fabricated. Missing original candle versions can prevent historical chart reproduction, even though the stored fingerprint still proves which dataset was required.

## FRESHNESS

- Analysis drops forming bars and measures age from the last closed bar's close time. Existing admission policy is two bars of that strategy's timeframe.
- New publication enforces the same two-bar source window. Opportunity display and signal expiry retain their existing four-bar window; these are distinct purposes, not silently merged business policies.
- Unknown timeframe, null/non-finite/future source timestamps fail closed. Domain timeframe registry is now the duration authority.
- Canonical ID/anchor and chart bar must agree across timeframe. Revised OHLCV cannot produce an unverified replacement chart.
- Startup subscription precedes backfill; repeated/old events and scan errors are handled deterministically. Restart first-sighting scans the current usable bar, not a fabricated replay of every missed historical opportunity.
- No historical catch-up trading/execution policy was added.

## FAILURE_RECOVERY

| Required attack | Result | Evidence / limit |
|---|---|---|
| duplicate signal | FIXED / PASS | canonical ID, UNIQUE opp_id, separate-worker activation, repeated publish |
| stale signal | FIXED / PASS | publisher refusal, source expiry, cold API expiry, delivery terminal/freshness checks |
| replayed event | FIXED / PASS | repeated close coalescing; error replay recovers; restart dedupe reset still one outbox |
| race | FIXED / PASS | two worker SQLite claim and activation tests; temporal owner conditions |
| lost outbox | PASS | transaction rollback and unique-conflict injection leave neither companion outbox nor partial signal/audit |
| stuck lease | FIXED / PASS | expiry/reclaim, stale-owner rejection, final-budget crash terminalization |
| partial Telegram | FIXED / PASS | both photo/text partial orders; resume missing step; required chart unavailable never SENT |
| retry duplication | PARTIAL | stale snapshot fixed; provider accepted/local persistence lost still permits duplicate (explicitly demonstrated) |
| provenance loss | FIXED / PARTIAL | stable links/snapshot/fingerprint/audit tested; pre-existing historical information cannot be recovered |
| invalid transition | FIXED / PASS | terminal→active forbidden, unknown state fail-safe, terminal payload immutable |
| risk bypass | FIXED / PASS | final authoritative re-evaluation and malformed/contradictory/admission tests; scoped to production publisher path |
| API mismatch | FIXED / PASS | corrupt payload, double decode, cold expiry, exact counts, row-specific delivery, browser error/partial states |
| external failure | PASS in harness; BLOCKED live | HTTP/JSON rejection, network throws and provider failure tests; live TTT network failure / Telegram unconfigured |
| persistence failure | PASS | real SQLITE_BUSY, UNIQUE conflict, transaction rollback, migration and corruption tests |
| restart | PASS locally / PARTIAL live | separate-worker reopen/progress, lease recovery, built-server restart + source ingestion; no real Telegram mid-send process kill |

The full adversarial universe is not exhaustively proven: hardware/power-loss durability, every legacy corruption combination, sustained multi-host contention, and real provider acceptance during an OS-level crash remain UNKNOWN. SQLite WAL `synchronous=NORMAL` was not changed into a power-loss guarantee.

## RUNTIME

- Built production Next server ran on `0.0.0.0:3000`, including restart after real source ingestion. Native Arena preview is available; browser code uses relative API URLs.
- Boot-aware route `/api/system/status` initialized the engine. Actual runtime: `booted=true`, `live_scan.subscribed=true`; no scan/publication fabricated while market data was unavailable.
- TTT: `universe.state=NETWORK_FAILURE`, count 0. Telegram: `NOT_CONFIGURED`, dry-run true. Signals/opportunities: actual empty responses. Missing signal: HTTP 404. Production notifier POST with missing configured API auth: HTTP 503, denied.
- Runtime SQLite `PRAGMA integrity_check`: `ok`; schema versions `[1,2,3,4]` persisted across restart.
- Actual `npm run brain:ingest -- --json` in the isolated runtime DB: 9,398 lines, 104 source strategy records, 31 machine rules, no ingest errors; source hashes/line counts captured. `coverage_ok=true` means ingestion covered the available text, **not** source completeness: files 1.txt, 2.txt and 4.txt are explicitly marked upstream-truncated.
- After ingestion/restart: seven executable runtime definitions, zero compiled-lineage violations, **zero live-eligible definitions**. The real promotion gate reports absent empirical/OOS/versioned evidence; it was not overridden.
- Scan events include measured scan wall time, which may include fetches. No pure-compute latency benchmark or target attainment is claimed. Internal-vs-external latency was not instrumented sufficiently for such a claim.

## TESTS

Final checks (not sums across repeated runs):

| Command | Result |
|---|---|
| `npm test` | **50 files / 973 tests passed**, 105.13s |
| Targeted command below | **16 files / 217 tests passed**, 21.23s |
| Browser command below | **8 checks passed**, zero uncaught page errors |
| `ASA_DB_PATH=/home/user/asa-runtime/asa.db ASA_HISTORY_DB_PATH=/home/user/asa-runtime/history.db ASA_BRAIN_DB_PATH=/home/user/asa-runtime/brain.db npm run brain:ingest -- --json` | exit 0, no ingest errors; upstream truncation remains declared |
| Runtime HTTP smoke / restart / SQLite integrity | responses and schema facts in `runtime.json` |

```sh
npx vitest run tests/signal-publish.test.ts tests/telegram-partial-send.test.ts tests/telegram-claim-lease.test.ts tests/telegram-attempts-accounting.test.ts tests/live-signal-runtime.test.ts tests/live-timeframe-coverage.test.ts tests/opportunity-freshness.test.ts tests/setup-admission-gate.test.ts tests/risk-engine.test.ts tests/team05-persistence-recovery.test.ts tests/team05-workers.test.ts tests/team05-api.test.ts tests/market-runtime-recovery.test.ts tests/decision-truth-recovery.test.ts tests/chart-telegram.test.ts tests/audit-regressions.test.ts

LD_LIBRARY_PATH=/home/user/asa-browser/lib \
PLAYWRIGHT_MODULE=/home/user/asa-browser/node_modules/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/tmp/chromium \
ASA_QA_OUTPUT_DIR=/home/user/asa-ui-evidence \
node scripts/verify-team05-ui.mjs
```

The full suite includes safety/source guards, strategy/admission, market recovery, transport accounting, rollback, migration, lifecycle, API and regression coverage. New separate-worker tests use real SQLite connections. Integration tests run the real scan→risk→publisher→SQLite→chart→outbox→API path with synthetic test strategies/data and intercepted Telegram HTTP; promotion is stubbed only for named synthetic integration fixtures. Production data/provider success is not inferred from these tests.

Browser: the real API/empty UI and mobile Persian/RTL were exercised; loading, HTTP 503, partial delivery, failed refresh and offline states use clearly labeled browser-only interception. No synthetic signal was inserted into the preview DB. Screenshots were inspected. Initial browser setup failed via CDN and then due to missing NSS libraries; resolved using an npm-packaged Chromium binary and its bundled libraries outside the repository. One initial harness selector used visible text rather than the button's actual accessible name; corrected and final checks rerun.

Positive publisher fixtures now use genuine risk computation and canonical/chart identities. The old test that published a five-hour-old signal to test expiry now publishes fresh, advances time and verifies expiry. Tests were strengthened, not weakened to accept unsafe production behavior.

## BUILD

Final `npm run typecheck`, `npm run lint`, `npm run build`: **PASS**, exit 0, with raw output in `validation.txt`. `npm ci --dry-run --ignore-scripts --no-audit --no-fund`: PASS; this is explicitly a lockfile-resolution dry run, not a claim of another clean native install.

Added a lockfile and explicit pinned esbuild dev dependency, also already used by repository ingestion scripts; separate-worker tests use it to bundle the real code into isolated workers. No version of the decision/strategy methodology was changed. No remote CI run or production deployment was performed/claimed.

## BLOCKERS

1. **Missing required North Star contract.** Evidence: absent exact path. Affects completion accounting and mission certification. Owner: roadmap/product integration owner. Safe implementation/testing can continue; no percentage or invented IDs supplied.
2. **Live provider proof unavailable.** Actual TTT `NETWORK_FAILURE` and Telegram `NOT_CONFIGURED`. Affects live external market→delivery proof, not isolated repository validation. Owner: deployment/Team 01 connectivity and Team 05 notifier configuration. Do not paste credentials into chat; configuration belongs in secure deployment settings.
3. **No live-promoted strategy evidence.** Actual post-ingest registry: 0/7 live eligible, real promotion blockers list missing empirical/OOS evidence. Owner: Team 03 validation/governance. Team 05 must not rewrite strategy rules or forge promotion to make a demo send.
4. **Upstream source truncation.** Ingestion identifies source files 1/2/4 as truncated. Affects full source-completeness/policy certification. Owner: source corpus / Team 03 methodology. Ingestion of available material succeeds, but missing original text cannot be invented.

### INTERFACE REQUEST — live promotion evidence

- Owner Team: Team 03 (strategy validation/governance).
- Current Interface: `promotedRuntimeStatus` / `promotionReport`, consumed by admission and `/api/research/strategies`.
- Observed Problem: after source ingestion, current runtime definitions have lineage but lack eligible validation/OOS evidence.
- Required Behavior: real reproducible experiments satisfying the existing promotion gate, not a status override.
- Required Fields/Semantics: version-matched dataset provenance, computed required metrics, reproducible verdict, OOS evidence, governance ceiling allowing live.
- Why Team 05 Cannot Safely Repair Internally: fabricating evidence or changing rule methodology would violate ownership and the advisory safety contract.
- Compatibility Impact: none; use the existing evidence/promotion interface.
- Blocking/Non-Blocking: blocking real live-advisory success demonstration; non-blocking for safe rejection and recovery tests.

## UNKNOWN

- Exact roadmap completion units/statuses and numeric distance to 100%.
- Full original content of truncated source files and any missing product policies.
- Complete automatic invalidation/closure policy beyond current guarded states; no invented state transition trigger.
- Live Telegram provider acceptance and live end-to-end signal under a legitimately promoted strategy.
- Historical facts absent from legacy rows; original candle revisions if the historical store has overwritten them; provider message IDs not retained.
- Power-loss/host-filesystem durability and sustained production contention. No latency target attainment or coverage percentage was measured.
- Full desktop/mobile accessibility and complete Persian translation remain outside the eight scoped browser checks.

## DISTANCE_TO_100_PERCENT

**BEFORE:** `docs/roadmap/ASA_100_PERCENT_CONTRACT.md` absent → exact relevant IDs/units/statuses **UNKNOWN**.

**AFTER:** same required file still absent → exact completion accounting **UNKNOWN**. This mission intentionally does not create a substitute roadmap or claim a percentage.

Evidence-backed remaining distance: supply authoritative contract; restore/configure live providers; obtain genuine Team 03 promotion evidence; resolve upstream source completeness; execute authorized live advisory delivery/restart validation; settle any missing automatic lifecycle policy; perform operational durability/performance validation. Repaired repository invariants and 973 passing tests are evidence, not a conversion to “100%”.

## FILES_CHANGED

The complete per-file inventory is appended below after final status inspection. Ownership here denotes scope of this repair, not invented formal team CODEOWNERS metadata. No strategy implementation, source corpus, AI model or exchange execution code was changed.

| File | Scope / ownership | Reason / migration-test-doc impact |
|---|---|---|
| `docs/api-contract.md` | Shared API documentation | Document payload/lifecycle/delivery/chart additions and compatibility. |
| `docs/audit/TEAM05_RECOVERY.md` | T05 audit documentation | Preserve pre-edit baseline, skills/capabilities and contract matrix. |
| `docs/audit/TEAM05_REPORT.md` | T05 audit documentation | Final defect/repair/proof/limitation report and complete inventory. |
| `docs/deployment-vps.md` | Shared deployment documentation | Correct health route; document lazy boot, guarded migrations, mixed-version-worker risk and recovery gates. |
| `docs/evidence/team05/browser.json` | T05 verification evidence | Eight actual browser-check results, explicitly distinguishing intercepted fixtures. |
| `docs/evidence/team05/manifest.json` | T05 verification evidence | SHA-256 and byte-size inventory of evidence artifacts. |
| `docs/evidence/team05/real-mobile-rtl.png` | T05 verification evidence | Inspected screenshot of real empty-state API/UI, 390px Persian/RTL. |
| `docs/evidence/team05/reproductions.txt` | T05 verification evidence | Actual failing-before-repair regression output, including newly exposed partial-cache recovery regression. |
| `docs/evidence/team05/runtime.json` | T05 verification evidence | Actual HTTP/SQLite/restart/ingestion/governance observations, including explicit external blockers. |
| `docs/evidence/team05/test-only-partial.png` | T05 verification evidence | Inspected screenshot of browser-only partial-delivery fixture; not production delivery. |
| `docs/evidence/team05/validation.txt` | T05 verification evidence | Exact executed baseline/final test, typecheck, lint, build and lockfile-resolution output. |
| `package-lock.json` | Shared release tooling | New reproducible npm dependency graph; enables documented npm ci. |
| `package.json` | Shared release tooling | Pin esbuild used by existing ingestion and new isolated-worker verification; no runtime decision dependency change. |
| `scripts/verify-team05-ui.mjs` | T05 verification tooling | Reproducible optional browser checks; nonempty states are isolated test interception only. |
| `src/app/api/charts/[id]/route.ts` | Shared chart API / T05 integration | Immutable signal evidence, exact anchor/dataset verification, recover partial historical cache, explicit refusal. |
| `src/app/api/opportunities/route.ts` | T05 opportunity API | Report null/corrupt payload as unavailable instead of crashing or acting on it. |
| `src/app/api/signals/[id]/route.ts` | T05 signal API | Avoid double decode, expose recorded lifecycle, cold-read expiry and unavailable legacy payload. |
| `src/app/api/signals/route.ts` | T05 signal API | Cold-read expiry, canonical states, explicit payload availability. |
| `src/app/api/system/notify/route.ts` | T05 notifier API | Exact state counts and row-specific truthful test/dry-run results. |
| `src/app/signals/page.tsx` | Shared frontend / T05 integration | Separate loading/error/empty/stale, canonical lifecycle, partial-delivery and provenance visibility. |
| `src/db/repo.ts` | T05 scope / shared storage contract | Add renewal, exact counts and recorded lifecycle history interfaces; clarify owner/attempt semantics. |
| `src/db/sqlite.ts` | T05 scope / shared persistence | Temporal ownership, per-cycle count, terminal recovery, atomic lifecycle/identity guards, audit; migrations v3/v4; mode projection and JSON-safe fallback. |
| `src/lib/brain/score.ts` | Shared T03/T05 admission boundary | Fail closed on malformed/unknown gate inputs; no strategy rule or threshold changes. |
| `src/lib/chart/evidence.ts` | Shared chart integration | Select only candles ending at the exact decision bar. |
| `src/lib/chart/source.ts` | T05 chart provenance | Stable SHA-256 reference to exact ordered decision OHLCV; reject revisions/incomplete datasets. |
| `src/lib/market/engine.ts` | Shared T01/T05 runtime wiring | Subscribe before boot backfill, expire at startup, prevent overlapping interval callbacks; no market-methodology edits. |
| `src/lib/notify/telegram.ts` | T05 transport/outbox | Authoritative reread, temporal lease renewal, provider JSON acceptance, immutable chart/decision validation, partial progress, honest attempts and legacy terminal refusal. |
| `src/lib/pipeline/freshness.ts` | Shared freshness contract | Use domain timeframe registry; fail closed on unknown/future/invalid timestamps. |
| `src/lib/pipeline/live-scan.ts` | T05 orchestration | Do not acknowledge failed scans; monotonic completed-bar watermark. |
| `src/lib/pipeline/orchestrator.ts` | T05 orchestration/publication | Final live-risk revalidation, canonical identity, required chart fingerprint, immediate publication transaction, source/audit integration. |
| `src/lib/pipeline/provenance.ts` | T05 API provenance | Explicit JSON availability and no silent modern-link replacement. |
| `src/lib/pipeline/signal-lifecycle.ts` | T05 lifecycle / shared API/UI vocabulary | Canonical transitions, terminal guards and transactionally rechecked source expiry for scheduler/API. |
| `src/lib/risk/engine.ts` | T05 risk boundary | Runtime numeric/direction validation; same sizing methodology and limits. |
| `src/lib/risk/live.ts` | T05 risk integration | One server-owned policy/preferences/catalog input assembler shared by scan and publisher. |
| `tests/audit-regressions.test.ts` | T05/shared regression tests | Use real SQLite for pagination expiry, correct inspected-vs-attempted contract, genuine risk/canonical publication fixtures. |
| `tests/decision-truth-recovery.test.ts` | T05/shared regression tests | Valid publication fixtures; publish fresh before expiry test; unavailable JSON regression. |
| `tests/fixtures/publication-opportunity.ts` | T05 test-only fixture | Canonical synthetic publication identity/chart-source reference; never used by production. |
| `tests/live-signal-runtime.test.ts` | T05/shared regression tests | Error replay/order, immutable/source-verified charts, required-chart partial recovery, terminal/mismatch delivery; update migration proof. |
| `tests/market-runtime-recovery.test.ts` | T05/shared regression tests | Assert live scanner subscription exists before initial backfill enqueue. |
| `tests/opportunity-freshness.test.ts` | T05/shared regression tests | Require fail-closed unknown timeframe, preserve all supported windows. |
| `tests/risk-engine.test.ts` | T05/shared regression tests | Runtime malformed numeric/direction risk matrix. |
| `tests/setup-admission-gate.test.ts` | T05/shared regression tests | Adversarial unknown/malformed gate values must not admit. |
| `tests/signal-publish.test.ts` | T05/shared regression tests | Real risk result and canonical fixtures; forged/stale/policy-changed/renamed/incomplete evidence refusals. |
| `tests/team05-api.test.ts` | T05/shared regression tests | Actual route/service/SQLite tests for malformed JSON, cold expiry, percent IDs, configuration/dry-run and >500 counts. |
| `tests/team05-persistence-recovery.test.ts` | T05/shared regression tests | Expired/unowned writes, count idempotency, final crash recovery, corrupt JSON, lifecycle audit/rollback, mode consistency. |
| `tests/team05-workers.test.ts` | T05/shared regression tests | Separate JS/SQLite workers: activation/claim races, reopen, real SQLITE_BUSY and unique-conflict rollback. |
| `tests/telegram-partial-send.test.ts` | T05/shared regression tests | Stale row replay, HTTP JSON rejection, timeout/401/429/502, lease loss, acceptance/write-loss ambiguity, terminal legacy. |

## FINAL EXECUTIVE VERDICT

The repository has materially stronger, tested integration boundaries. No known reproduced Team 05 publication/outbox defect from this audit is left intentionally unfixed. Nevertheless, this is not a fully verified live system: the required roadmap is missing, external providers are not operationally proven, and the real strategy promotion gate correctly prevents publication. Release is not certified.

MISSION_STATUS:
PARTIAL

SAFETY_STATUS:
PASS

END_TO_END_STATUS:
PARTIAL

RELEASE_READINESS:
NOT_READY

PR_CREATED:
NO

PUSHED:
NO

MERGED:
NO
