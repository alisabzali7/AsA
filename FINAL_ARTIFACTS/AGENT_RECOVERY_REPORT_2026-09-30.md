# AsA — Autonomous Repository Recovery, Integration Hardening & Release Completion

**Date:** 2026-09-30 · **Base:** `97c6be1` (branch point) → rebased onto `070f4f2` · **Work commit:** `fd4c1ab` · **Merged as:** `8bb2e33` (PR #31) · **Session branch:** `arena/01a0f13f-asa`

Advisory-only system. No execution path exists before or after this work: AsA produces advisories for a human executor; it never places orders.

---

## EXECUTIVE_SUMMARY — FIXED / PARTIALLY_VERIFIED

Three real defects were found by driving the advisory pipeline end-to-end against the real database and HTTP surface, then repaired at their root and pinned by dedicated regression suites:

1. **Delivery-failure honesty (§17).** One generic "poison payload" label covered two unrelated terminal causes. An advisory whose linked signal had expired was dead-lettered as *"poison payload: advisory text cannot be formatted (signal missing or no longer published)"*. Outbox rows now persist a stable `error_kind` (migration v5).
2. **Contradictory decision provenance.** The decision window is stored twice and nothing compared the copies: tampering one copy still returned `snapshot_check: VERIFIED` from `/api/charts` while the API served the other, unverified fingerprint. The copies are now compared; `/api/charts/[id]` refuses with **409**.
3. **Runtime QA could not tell "no data" from "UI regression."** The opportunities runtime suite crashed with a `TypeError` on an empty database. It now skips with an explicit seeding instruction on an empty store, fails with the exact missing case on incomplete data, and asserts the answering-but-empty store as the honest `EMPTY` state.

Integration is now verifiable end-to-end on a synthetic-but-real pipeline (real `scanSymbol` → gates → publication transaction → outbox → local Telegram HTTP stub → delivery state → API → DOM), while release completion remains **constrained by upstream source completeness** (`CLOSURE_BLOCKED_BY_SOURCE`) and by the sandbox (no external market feed, no Telegram provider, no CI).

## BASELINE — VERIFIED

| Gate | At base `97c6be1` | On integrated HEAD (`fd4c1ab` → `8bb2e33`) |
|---|---|---|
| typecheck | PASS | PASS |
| lint | PASS | PASS |
| tests | 85 files · 1502 passed / 12 skipped | **91 files · 1561 passed / 13 skipped** (87 passed / 4 skipped files; 1574 total) |
| build | PASS | PASS (exit 0) |
| `closure:validate` | not run | **exit 0** — 20 files / 394 tests PASS; gates typecheck/lint/full_tests/build PASS; `implementation_errors: []`; `source_blockers` = documented truncation set |

Dependency baseline required a local-headers workaround (recorded): `npm_config_nodedir=/usr/local npm_config_build_from_source=true npm ci` — 477 packages, `better-sqlite3` 12.4.1 source-built (SQLite 3.50.4, ABI 127), Node v22.22.3.

## REPOSITORY_STATE — FOUND / VERIFIED

`asa` v6.0.1 · Next.js 16.3.3 · React 19.2.6 · TypeScript 5.9.3 · vitest 5.0.2 · better-sqlite3 12.4.1 · 202 source files · 91 test files · single SQLite storage seam · **no `.github/` workflows (no CI)**. Working tree clean at hand-off; branch pushed; PR merged.

## ARCHITECTURE — FOUND

TTT-only market ingress (`src/lib/ttt`, `src/lib/market`) → analysis/strategy with compiled source contracts (`src/lib/strategy/compiled`) → decision pipeline (`src/lib/pipeline/orchestrator.ts` as the single publication boundary, `live-gates.ts`, `freshness.ts`, `signal-lifecycle.ts`) → risk/policy and portfolio gates → chart evidence (`src/lib/chart/source.ts`, `evidence.ts`) → durable outbox + Telegram delivery (`src/lib/notify/telegram.ts`) → read-only API (`src/app/api/**`) → terminal UI (`src/app/**`) → human executor.

## INTEGRATION_RECOVERY — FIXED / PARTIALLY_VERIFIED

Traced chain, with the evidence actually obtained in this mission:

| Link | Status | Evidence |
|---|---|---|
| MARKET → DATA | PARTIALLY_VERIFIED | TTT unreachable from the sandbox (`000`); `/api/market/board` returns honest `NETWORK_FAILURE`; synthetic market used for the chain |
| DATA → ANALYSIS → STRATEGY | PARTIALLY_VERIFIED | exercised through the LOCAL TEST scenario bundle (`scanSymbol` real code path) |
| STRATEGY → OPPORTUNITY | VERIFIED | 5 stored opportunities in the scenario DB with risk/portfolio verdicts |
| OPPORTUNITY → ADMISSION | VERIFIED | `REJECTED` (risk BLOCK) and `REJECTED` (portfolio BLOCK) rows render as stored, never upgraded to READY |
| ADMISSION → RISK | VERIFIED | authoritative evaluation only; caller-supplied verdicts are not accepted at the boundary |
| RISK → SIGNAL | VERIFIED | 3 signals published; publication race across processes yields exactly 1 signal + 1 outbox, 0 orphans |
| SIGNAL → CHART/EVIDENCE | VERIFIED | chart JSON `VERIFIED`, PNG 200; dataset anchor `chart_source.sha256`; identity/anchor checks |
| SIGNAL → OUTBOX → CLAIM/LEASE | VERIFIED | atomic claim (1 winner under 6–8-way contention), stale-owner rejection, live-lease non-retryability |
| OUTBOX → TELEGRAM | PARTIALLY_VERIFIED | delivery semantics through a local HTTP stub only (no real provider from the sandbox) |
| TELEGRAM → DELIVERY STATE | VERIFIED | partial delivery, retry, terminal DEAD all observable with stable `error_kind` |
| DELIVERY → LIFECYCLE | VERIFIED | expired signal → `LINK_NOT_DELIVERABLE`, attempts 0, never sent |
| LIFECYCLE → PROVENANCE | FIXED | contradictory copies detected and refused (409) |
| PROVENANCE → API → UI | VERIFIED | `snapshot_identity`, delivery `error_kind`, provenance warning surfaced; runtime DOM suites green |
| UI → HUMAN | VERIFIED | advisory-only navigation (no order surface), i18n in en+fa |

## OPPORTUNITY — VERIFIED

`actionable = READY && fresh READY && no terminal linked signal`; UI downgrades a READY row whose signal is terminal and never upgrades a REJECTED row; the answering-but-empty store is asserted as `EMPTY — the backend answered…`, never a blank chip or a fabricated row.

## RISK — VERIFIED (hard gate holds)

Risk is a hard gate inside the publication boundary: no caller, AI, psychology, scoring, UI, Telegram, or fixture path can make a signal publishable by asserting `risk.verdict = "pass"`. The scenario demonstrates both a risk BLOCK (ETHUSDT) and a portfolio BLOCK with an explicit UNKNOWN (XRPUSDT: "daily realized loss or account equity UNKNOWN — selected daily limit cannot be evaluated"), and both remain unactionable through the API and UI. No bypass was found in the reviewed boundary.

## SIGNAL — VERIFIED

Lifecycle `candidate → qualified | blocked_by_risk | published | expired | invalidated`, enforced by `assertSignalTransition` plus append-only `signal_transitions`; identity fields immutable; `payload_json/score/outbox_id` frozen after a non-candidate state; terminal states cannot be resurrected (plain `INSERT`, never `INSERT OR REPLACE`); signal + outbox are written in ONE transaction.

## TELEGRAM — PARTIALLY_VERIFIED

Delivery semantics verified against a **local HTTP stub** (sandbox has no provider access): photo-then-text ordering, partial send persisted as `FAILED` with photo acceptance retained, restart retry resumes **text-only** (1 HTTP request, attempts 1 → 2, `SENT`), 5-attempt transport budget, 120 s claim lease, crash-window recovery (`COMPLETE → SENT` / `INCOMPLETE → DEAD · INTERRUPTED_AMBIGUOUS`), and the new failure taxonomy (`POISON_PAYLOAD`, `LINK_NOT_DELIVERABLE`, `TRANSPORT_REJECTED`, `TRANSPORT_BUDGET_EXHAUSTED`, `INTERRUPTED_AMBIGUOUS`, `INFRASTRUCTURE`, `NOT_CONFIGURED`, `DRY_RUN`). Real-provider acceptance remains unverified.

## IDEMPOTENCY — VERIFIED

Cross-process suite drives the real SQLite repository from separate OS processes: one winner per claim window; losers make no provider call; attempts counted once per claim; stale owners cannot mark, re-payload, count, or renew; forged claims consume no budget; interrupted final attempts are resolved by persisted progress.

## PROVENANCE — FIXED / VERIFIED

`snapshotIdentityCheck` compares `chart_evidence.snapshot` with `provenance.data.snapshot` (symbol, timeframe, `as_of_t`, `closed_bars`, `input_fingerprint`) → `AGREED | SINGLE_SOURCE | CONTRADICTION | ABSENT`, exposed on `/api/signals` and `/api/opportunities`; `/api/charts/[id]` answers **409 `contradictory decision provenance`** before rendering. Tamper matrix on the final build: provenance-copy tamper → 409 (JSON and PNG); zeroed `chart_source.sha256` → 409; pristine record → `VERIFIED` / `AGREED`. A stored-candle mutation was refused (409) on the pre-rebase build; the equivalent dataset-anchor guard was re-verified 409 on the final build.

## FRESHNESS — PARTIALLY_VERIFIED

`tfStalenessMs` = 2 bars, `opportunityFreshness` = 4 bars, fail-closed; expired anchors block delivery (`LINK_NOT_DELIVERABLE`) and downgrade UI rows. Freshness clock behaviour at the boundaries was exercised by the suite and the scenario, not re-measured with controlled clocks on the final build.

## FAILURE_RECOVERY — VERIFIED

Restart after partial delivery resumes without duplicating the photo; the interrupted-final-attempt window is resolved by persisted progress; terminal rows are never re-sent; a claimed-but-crashed row is reclaimable only after lease expiry; one row's infrastructure failure cannot strand the drain batch; `DEAD` is reachable only via genuine budget exhaustion or deterministic content/link defects.

## API — VERIFIED (probed surface)

Mutating routes fail closed (production + no `ASA_API_TOKEN` → 503), `DELETE` on journal → 405, unknown ids → 404, path traversal → 404, `limit` clamped, candles reject malformed symbols with 503 `NETWORK_FAILURE` rather than unhandled errors, delivery state + `error_kind` + `snapshot_identity` exposed read-only, charts 409 on contradiction. Not every route was individually re-probed.

## FRONTEND — VERIFIED

Four real-runtime DOM suites run the actual components against real servers with no fetch mocking: **12 passed / 1 skipped** against the seeded scenario store and **7 passed / 6 skipped** against the empty store (the empty direction asserts the `EMPTY` truth). No execution navigation exists (`/order`-style targets absent). i18n keys exist in both en and fa.

## OBSERVABILITY — PARTIALLY_VERIFIED

Delivery outcomes emit `system` events (sent / FAILED / DEAD with kind and attempt count); failure classes are now machine-readable in the DB and API instead of being prose-only; `/api/system/status` reports boot, market, Telegram, AI, and scheduler state honestly. No metrics/tracing backend exists — long-run observability is unproven.

## DATABASE — VERIFIED (tested surface)

Single adapter (`src/db/sqlite.ts`); migrations v1–v5 recorded append-only, v5 a guarded `ALTER` that records either outcome and leaves legacy rows `NULL`; transition audit table; identity immutability and terminal-state protection enforced in the write path; claim protocol implemented as an atomic conditional `UPDATE` (cross-process safe). Not verified: forward compatibility beyond v5, migration on very large databases, backup/restore drills.

## RUNTIME — VERIFIED

Production build boots (`boot_ms ≈ 3.4 s`), listens, and reports the real state: market `UNAVAILABLE` (TTT `NETWORK_FAILURE`), Telegram `NOT_CONFIGURED`, AI heuristic-only, scheduler budget visible (`18.38/24` per minute), live scan subscribed, `/api/signals` empty on an empty store. Scenario and tamper servers on `:3001`/`:3002` served SQLite-backed evidence; all long-running processes were started and stopped explicitly.

## SECURITY — PARTIALLY_VERIFIED

`guardMutation` on all mutating routes (fail-closed in production); no prohibited venue ids, no `Math.random`/faker in product code, no secrets or `process.env` in components/app code (enforced by the i18n-scan suite); RSS SSRF guard (PR #29) blocks private/link-local/metadata/credentialed URLs; no `signal → order → execution` identifiers anywhere; 0 TODO/FIXME/HACK in `src/`; 3 `: any`. Not performed: dependency CVE audit, penetration test, secrets-at-rest review.

## PERFORMANCE — UNKNOWN

No load, soak, or benchmark run was executed in this mission. The repository's own benchmark report was not re-verified. Scheduler budget behaviour was observed under an idle/empty store only.

## TESTS — VERIFIED

**91 files (87 passed / 4 skipped), 1574 tests (1561 passed / 13 skipped), exit 0**, plus a live-server direction that is not counted in the default run: runtime suites green against the seeded scenario (12 passed / 1 skipped) and the empty store (7 passed / 6 skipped). New suites: `outbox-failure-taxonomy` (12), `snapshot-identity-contradiction` (6), `cross-process-outbox` (7). A frozen migration-log assertion was repaired to be append-only rather than version-pinned.

## BUILD — VERIFIED

`npm run build` exits 0 on the integrated tree (Next.js production build, all routes compiled); typecheck and lint PASS.

## GITHUB — VERIFIED (CI: BLOCKED/NOT_CONFIGURED)

`gh` authenticated as the agent bot; history reconciled (PRs #19–#31; #22 closed; #28/#29/#30 merged before this work). **The repository has no `.github/` directory, therefore no CI workflows** — there is no automated check to be green, and none is claimed. GitHub-managed Dependabot/Pages remain repository settings, not build gates.

## PR — VERIFIED

PR #31 "Delivery-failure taxonomy, contradictory-provenance refusal, verifiable runtime QA" — body documents defects, evidence, verification commands and the no-CI fact — **merged**.

## MERGE — VERIFIED

Squash-merged as `8bb2e33` at 2026-09-30T08:04:10Z. The merged `main` tree was confirmed **identical** to the verified commit (`git diff fd4c1ab origin/main` → empty), so the verified artifact is exactly what main now contains.

## BLOCKERS

- **Source corpus completeness** — `CLOSURE_BLOCKED_BY_SOURCE`: RAW_1/2/4 `TRUNCATED`, RAW_3/5 `UNKNOWN`, both psychology sources `TRUNCATED`, promotion evidence `NOT_PRESENT`. Not fixable in-repo.
- **No external market feed** in the sandbox (TTT `000`) — live market verification impossible; synthetic LOCAL TEST used instead.
- **No Telegram provider** in the sandbox — provider acceptance can only be exercised through the local HTTP stub.
- **No CI configured** — the CI gate cannot be satisfied.
- **No browser** (Playwright/Chromium absent) — browser-based UI capture scripts cannot run.

## UNKNOWN

Real Telegram acceptance/latency; real TTT market behaviour (discovery, daily candles, derivation); performance under load; long-run scheduler/drain behaviour; whether the two provenance copies can ever diverge through application code (no writer path was found, but divergence detection now exists regardless); post-v5 migration behaviour on production-sized databases.

## REMAINING_RISKS

Upstream source truncation invalidates parity claims; zero strategies are live (none passed the OOS gate); market availability can silently make the terminal look empty (now honestly stated, but still a business risk); single-node SQLite and no CI mean regressions rely on local discipline; browser-based UI evidence remains un-achieved in this environment.

## DISTANCE_TO_100_PERCENT — 90 % ≈

Code/integration correctness on the traced chain is strong (defects found were fixed and pinned; the chain is verified end-to-end on a real synthetic pipeline). The remaining ~10 % is dominated by things this repository cannot fix alone: source-corpus completeness (governs closure), external provider/market verification, CI absence, and performance evidence. **100 % is not claimable and is not claimed.**

## FILES_CHANGED

`CHANGELOG.md`, `FINAL_STATUS.md`, `docs/api-contract.md`, `docs/testing.md`, `src/app/api/charts/[id]/route.ts`, `src/app/api/opportunities/route.ts`, `src/app/api/signals/[id]/route.ts`, `src/app/api/signals/route.ts`, `src/app/signals/page.tsx`, `src/db/repo.ts`, `src/db/sqlite.ts`, `src/lib/i18n/strings.ts`, `src/lib/notify/telegram.ts`, `src/lib/pipeline/provenance.ts`, `tests/cross-process-outbox.test.ts` (new), `tests/outbox-failure-taxonomy.test.ts` (new), `tests/snapshot-identity-contradiction.test.ts` (new), `tests/live-signal-runtime.test.ts`, `tests/runtime-opportunities.test.ts` (+ this report). No unrelated user work was modified.

## FINAL_STATUS

- **MISSION_STATUS:** COMPLETE_WITH_DOCUMENTED_CONSTRAINTS
- **SAFETY_STATUS:** SAFE — advisory-only; no execution path exists; risk gate holds (verified)
- **INTEGRATION_STATUS:** VERIFIED end-to-end on the synthetic-real chain; PARTIALLY_VERIFIED for live market/provider links
- **END_TO_END_STATUS:** VERIFIED (MARKET→…→OUTBOX→TELEGRAM→DELIVERY→LIFECYCLE→PROVENANCE→API→UI→HUMAN on the LOCAL TEST scenario; external links environment-blocked)
- **RELEASE_READINESS:** NOT_READY (CONSTRAINED_BY_SOURCE) — source corpus incomplete; zero live strategies; no CI
- **TEST_STATUS:** PASS — 91 files / 1574 tests (1561 passed, 13 skipped, 0 failed); closure validator exit 0
- **BUILD_STATUS:** PASS — build exit 0; typecheck PASS; lint PASS
- **CI_STATUS:** NOT_CONFIGURED (no workflows in the repository — nothing run, nothing claimed)
- **PR_STATUS:** MERGED (#31)
- **MERGE_STATUS:** MERGED — squash `8bb2e33`; merged tree identical to the verified commit
- **PUSH_STATUS:** PUSHED — `arena/01a0f13f-asa` on origin
- **UNRESOLVED_CRITICAL_ISSUES:** none found in the reviewed integration paths; source-corpus incompleteness is a release blocker, not a code defect
- **UNVERIFIED_CLAIMS:** real Telegram provider behaviour; live TTT market behaviour; performance; long-run runtime behaviour; post-v5 migrations at production scale
- **TOP_REMAINING_RISKS:** source truncation invalidating parity; zero live strategies; market availability; no CI; no browser-based verification
- **DISTANCE_TO_100_PERCENT:** ≈90 % — remaining gap is dominated by upstream source completeness and environment-limited verification
- **NEXT_REQUIRED_HUMAN_DECISION:** obtain the complete, untruncated source corpus (or accept a formally bounded advisory scope), provide a Telegram provider + market credentials for real verification, and decide whether CI workflows should be introduced
