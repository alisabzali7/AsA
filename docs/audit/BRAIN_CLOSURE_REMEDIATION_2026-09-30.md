# AsA — full repository review, Brain closure and engineering remediation

**Review date:** 2026-09-30 UTC
**Base commit:** `15f92e6e6b40aa71679808a67b5a00b26aa4e073` (`main` — "UI rescue: premium depth system, Home recomposition, back-button overlays (#35)")
**Branch:** `arena/01a0f1a1-asa`
**Scope:** whole repository — Brain, strategy/setup/rule chain, runtime, risk, portfolio, psychology, backtest, validation, promotion, API surface, AI Clone, tests, project scripts.

This is a current audit record. Older reports in `docs/audit/` are retained
historical evidence; none of their claims were accepted without re-verification
against this HEAD.

---

## 1. Verified baseline (measured, not quoted)

Dependencies had to be built from source in this environment: `nodejs.org` and
`release-assets.githubusercontent.com` are unreachable, so `better-sqlite3`
neither downloaded a prebuild nor fetched node headers. It was compiled with
`node-gyp rebuild --nodedir=/usr/local` against the headers already installed in
the image. **No package version, lockfile entry or postinstall script was
changed to work around this.**

Baseline gate results at `15f92e6`, before any change:

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npx vitest run` | PASS — 88 files, 1 566 tests, 13 skipped |
| `npm run build` | PASS |
| `npm run closure:validate` | exit 0, `CLOSURE_BLOCKED_BY_SOURCE`, `implementation_errors: []` |

So the repository was **not** broken. The defects below are behavioural, and
every one of them was reproduced with a failing assertion before it was fixed.

### Genuinely executable strategies: **0 of 7 compiled setups**

| strategy_id | setup_id | availability | source contract |
|---|---|---|---|
| STR-RAW-2-581 | SET-STR-RAW-2-581 | RESEARCH_ONLY | INCOMPLETE |
| STR-RAW-2-803 | SET-STR-RAW-2-803 | RESEARCH_ONLY | INCOMPLETE |
| STR-RAW-2-926 | SET-STR-RAW-2-926 | RESEARCH_ONLY | INCOMPLETE |
| STR-RAW-2-1258 | SET-STR-RAW-2-1258-short | RESEARCH_ONLY | INCOMPLETE |
| STR-RAW-2-1258 | SET-STR-RAW-2-1258-long | RESEARCH_ONLY | INCOMPLETE |
| STR-RAW-4-2425 | SET-STR-RAW-4-2425 | RESEARCH_ONLY | INCOMPLETE |
| STR-RAW-4-2449 | SET-STR-RAW-4-2449 | RESEARCH_ONLY | INCOMPLETE |

**Why none of them is executable:** `EXECUTABLE` in
`src/lib/strategy/runtime.ts` requires `sourceContractStatusFor(id) ===
"SOURCE_FAITHFUL"`. Every contract in
`src/lib/strategy/compiled/source-contracts.json` is `INCOMPLETE` with
`semantic_validation.status: "NOT_PROVEN"`, because the supplied corpus itself
is incomplete: `RAW_1/2/4.txt` and both `USER_PSYCHOLOGY_*.txt` are explicitly
`TRUNCATED`; `RAW_3/5.txt` are `UNKNOWN` completeness. That is a **source**
blocker, not an implementation defect, and this pass did not paper over it.

Live eligibility is separately zero: the promotion gate finds no experiment
evidence at all (no `asa-data/brain.db` exists in a clean checkout), so
`live_eligible` is `false` everywhere.

---

## 2. Confirmed defects and the fixes

Each entry states the reproduction, the cause, the effect and the regression
test. All new tests live in `tests/remediation-2026-09-30.test.ts` unless noted.

### D1 — the promotion ladder advanced on a criterion it had never measured
**BLOCKING · unknown-treated-as-pass**

* **File / function:** `src/lib/backtest/validation.ts` → `qualityGate()`, consumed by `decidePromotion()`.
* **Reproduction:** `decidePromotion(m, oosM, null)` where both metric sets have
  `trade_count: 40 / 20`, `expectancy_r: 0.8` and `profit_factor: null`
  (`profit_factor` is `null` by construction whenever a run has zero losing
  trades — `computeMetrics` returns `null` when `grossLoss === 0`).
  Result **before the fix**: `to: "OOS_TESTED"`, `promoted: true`, while
  `unknown_reasons` simultaneously contained
  *"profit factor is not computed (null) — treating as UNKNOWN, not as a pass"*.
* **Cause:** the function recorded the UNKNOWN in `unknownReasons` and pushed an
  `UNKNOWN` check, but only `fails.length` controlled the return value. With no
  *measured* shortfall, `fails` was empty and the gate returned `true`.
* **Effect:** a strategy could climb `BACKTESTED → OOS_TESTED → WALK_FORWARD`
  and report `promoted: true` on evidence that was never computed. The
  downstream gate in `backtest/promotion.ts` still blocked live eligibility via
  its independent `required_metrics_computed` check, so nothing went live — but
  the persisted `empirical_status`, the `/api/brain/validation` dossier and the
  A→F stage were all overstated, and the module's own documented contract
  ("UNKNOWN … NEVER treated as PASS") was violated.
* **Fix:** `qualityGate` now tracks unmeasured criteria separately and returns
  `false` when any exists, with a reason that keeps UNKNOWN distinguishable from
  FAIL (`failure_reasons` stays empty; `unknown_reasons` explains). A
  `max_drawdown_r` that is not finite is treated the same way instead of being
  compared against a threshold.
* **Tests:** `D1` — three cases (UNKNOWN stops the ladder; it is recorded as
  UNKNOWN not FAIL; a fully measured run still advances to `OOS_TESTED`).

### D2 — a declared risk gate could be skipped without saying so
**risk · silent non-enforcement**

* **File / function:** `src/lib/risk/engine.ts` → `evaluateRisk()`, liquidation ESTIMATE block.
* **Reproduction:** entry 100 000, stop 90 000, equity 10 000, 1 % risk,
  `maintenanceMarginRate: 0.004` → estimated leverage 0.1×. `liq_estimate` and
  `liq_label` came back `null`, the verdict was `pass`, and **nothing** in
  `reasons` or `unenforced` mentioned liquidation.
* **Cause:** when `factor = 1/leverage − mm >= 1`, neither the long nor the short
  branch assigned `liq`, and the `else` that reports non-enforcement was only
  reached when the *inputs* were missing.
* **Effect:** the file header promises "liquidation … gate semantics are explicit
  and separately labelled". At sub-1× leverage the gate simply did not run and
  the output said "risk checks passed" with no trace of it.
* **Fix:** `RiskOutput` gained an always-present
  `liquidation_gate: { state, reason }` with
  `ENFORCED | NOT_APPLICABLE | UNENFORCEABLE`.
  `NOT_APPLICABLE` is used when the estimate lands at or beyond price zero (no
  liquidation is reachable) — that is a mathematical non-applicability, not
  missing data, so it deliberately does **not** enter `unenforced`, which
  `src/lib/risk/live.ts` converts into a hard live block. Missing inputs remain
  `UNENFORCEABLE` *and* stay in `unenforced`, so live fail-closed behaviour is
  unchanged. The field is propagated into the opportunity payload
  (`src/lib/pipeline/orchestrator.ts`) as an optional field, so API/UI consumers
  can show the real state instead of an unexplained blank.
* **Tests:** `D2` — five cases, including the invariant that an estimate exists
  *if and only if* the gate state is `ENFORCED`, and that a non-applicable gate
  is not misrouted into the live-blocking `unenforced` channel.
* **Note on an intermediate attempt:** routing this through `unenforced` was
  tried first and broke 40 tests across 7 files, because it turned ordinary
  low-leverage advisories into live blocks. That would have been a safety gate
  *mis*-applied, not strengthened; the labelled-state design was adopted instead.

### D3 — reported equity drawdown excluded the account's starting equity
**backtest metric honesty**

* **File / function:** `src/lib/backtest/strategy-runner.ts` → `computeMetrics()`.
* **Reproduction:** two positions, curve `[8 000, 10 000]`, initial equity
  `10 000`. `max_drawdown_pct` came back **0** for an account that had actually
  fallen 20 % from its opening balance.
* **Cause:** the peak was seeded from `curve[0]`, which is the equity *after*
  the first position closed. A losing first trade could therefore never register
  as a drawdown.
* **Effect:** `max_drawdown_pct` (surfaced on `/backtest` and stored in the
  experiment record) systematically understated risk. It is not one of
  `REQUIRED_METRICS`, so no promotion decision was altered — but a user-facing
  risk number was optimistic.
* **Fix:** the starting equity is now a curve point and seeds the peak. An
  absent curve still returns `null` (UNKNOWN), never `0`.
* **Tests:** `D3` — three cases (first-trade drawdown is 20 %; a rising curve is
  still 0 %; an absent curve stays `null`).

### D4 — a position's recorded outcome contradicted its own fills
**backtest provenance**

* **File / function:** `src/lib/backtest/strategy-runner.ts` → `runStrategyBacktest()`, hold-horizon branch.
* **Reproduction:** synthetic ladder run where target 1 fills and the remainder
  is closed by the hold horizon. Fill reasons were
  `entry at next bar open / target 1 / timeout`, and the outcome was recorded as
  `partial_then_stop`.
* **Cause:** the timeout branch reused the stop branch's label whenever
  `nextTargetIdx > 0`.
* **Effect:** every partial-then-timeout position was reported as a stop-out.
  Outcome statistics and any consumer grouping by outcome saw stops that never
  happened.
* **Fix:** a new `partial_then_timeout` outcome. Positions are not persisted in
  the experiment store (only metrics are), so this is an additive change to the
  in-memory/backtest-API shape only.
* **Tests:** `D4` — four cases, including a cross-scenario invariant that the
  outcome label of *every* produced position agrees with its final exit fill
  reason. `tests/strategy-engine.test.ts` was widened to accept the new literal.

### D5 — three divergent copies of "is this risk policy usable for research?"
**architecture · parallel sources of truth**

* **Files:** `src/lib/backtest/strategy-runner.ts`, `src/lib/backtest/engine.ts`,
  `src/app/api/research/backtest/route.ts`.
* **Cause:** the same five-part condition was written out three times. Only the
  runner's copy also rejected `runtime_status === "DISABLED"`.
* **Effect:** a DISABLED policy passed `runBacktest`'s and the route's
  validation, then hit the runner's `throw`. Instead of the structured
  `409` refusal the route is designed to give, the caller got a generic
  `500 backtest blocked: …`.
* **Fix:** one dependency-free module,
  `src/lib/risk/research-policy-gate.ts`, exporting
  `researchRiskPolicyBlockers()` / `researchRiskPolicyUsable()`. All three call
  sites now use it; the route additionally returns the named blockers in a
  `blocking` array. No condition was relaxed — one was *added* to the two
  weaker copies.
* **Tests:** `D5` — five cases, including that the runner refuses exactly what
  the predicate rejects.

### D6 — the frozen backend contract overstated executability
**documentation vs code**

* **File:** `BACKEND_FREEZE.md`, "Counts (authoritative)".
* **Reproduction:** the document stated *"executable setups **7** · disabled
  setups **0**"*. `listRuntimeStrategies()` reports **0 EXECUTABLE, 7
  RESEARCH_ONLY, 0 NON_COMPUTABLE, 0 DISABLED**.
* **Effect:** the frozen contract other documents and reviewers quote implied
  seven runnable strategies. The code has never agreed with that under the
  current source contracts.
* **Fix:** the document now states the real per-availability counts and records
  why the old number was wrong. **No code was changed** — the code was right.
* **Tests:** new file `tests/backend-freeze-contract.test.ts` derives the counts
  from the runtime registry and asserts the document states them, plus the
  substantive invariant that an `EXECUTABLE` setup must be `SOURCE_FAITHFUL` and
  every non-executable setup must carry at least one named blocker.

---

## 3. Verified-and-correct (checked, no change needed)

These were on the review list, were examined against HEAD, and were found sound.
They are listed so the absence of a fix is a finding, not an omission.

| Area | Evidence |
|---|---|
| Setup hard gate | `admitOpportunity` refuses anything but `setup_verdict === "PASS"`, and the verdict is a required typed input — no caller can omit it. |
| UNKNOWN exposure → zero risk | `evaluatePortfolio` keeps `open_risks: null` (book unavailable) and per-row `risk_amount: null` distinct from measured zero; an unknown group exposure is sticky and cannot be re-summed back to a number. |
| Missing risk policy → defaults | `getProductionRiskPolicy` returns an explicit `UNSELECTED`/`BLOCKED` policy with all-null limits; no fallback policy is ever chosen. |
| Psychology UNKNOWN passing | `evaluatePsychologyGate` activates a policy only when every cited source is `COMPLETE`; today none is, so the verdict is `unknown` and `admitOpportunity` refuses it outside explicitly separated research mode. |
| Runtime vs backtest drift | `backtest/engine.ts` is a thin adapter over `runStrategyBacktest`; live, research and replay share `evaluateCompiled`, `evaluateRisk`, `evaluatePortfolio`, `scoreFromEvaluation` and `admitOpportunity`. No second implementation exists. |
| Hidden backtest assumptions | `BacktestResult.assumptions` names entry timing, same-bar ambiguity policy, caller-supplied costs, position-vs-fill accounting, the hold horizon, unreconstructed daily/period loss, unreconstructed psychology and unmodelled funding. |
| Brain API vs Research API status | `/api/research/strategies` and `/api/brain/validation` both read `promotionReport()`; `executable` and `live_eligible` are separate fields and live requires `runtimeStatusFor() === "LIVE_ADVISORY_ONLY"`. |
| Live advisory bypass | `scanSymbol` sets `requires_live_eligibility: mode === "live"`, so an executable-but-unvalidated strategy cannot publish. |
| Live measurement fail-closed | `liveMeasurementBlocks` blocks live when the advisory book is unavailable or a configured loss limit has no measurement; `loadLiveGateContext` never substitutes `0`. |
| Open-book truncation | `signalOpenList` is queried with a `+1` sentinel; a truncated inventory yields `open_risks: null`, not a partial book. |
| Provenance contradiction | `snapshotIdentityCheck` reports `AGREED / SINGLE_SOURCE / CONTRADICTION / ABSENT` and refuses to resolve a contradiction by picking a copy. |
| Source-contract identity | The contract, its lock, the corpus bytes, the canonical index and the four bound implementation files are all sha256-verified at import; any mismatch collapses every strategy to `UNKNOWN`. |
| Canonical index substitution | `canonical_index.role` is pinned to `INDEX_ONLY` and the validator rejects a `COMPLETE` claim whose referenced binding is incomplete. |
| No-execution invariant | `src/lib/safety/no-execution.ts` plus the source scans in `tests/brain-safety.test.ts` remain intact; nothing in this change set adds an order path. |

---

## 4. Post-remediation gate results (measured)

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npx vitest run` | PASS — 89 files, **1 594 tests**, 13 skipped (+28 new) |
| `npm run build` | PASS |
| `npm run closure:validate` | exit 0 · `CLOSURE_BLOCKED_BY_SOURCE` · `implementation_errors: []` · focused suite PASS · all four required checks PASS |

`closure:validate` still reports `CLOSURE_BLOCKED_BY_SOURCE` with 13 source
blockers (5 truncated / 2 unknown-completeness corpus files, 6 `INCOMPLETE`
strategy contracts). That is the honest state of the supplied material and was
not upgraded.

`src/lib/strategy/compiled/source-contracts.json` and its lock were regenerated
with `scripts/update-source-contract-lock.mjs` because `strategy-runner.ts` is
one of the four sha256-bound implementation files. Only the hashes changed; no
status, blocker, source reference or eligibility field was touched.

---

## 5. Real, documented blockers (not fixed here, and why)

1. **The corpus is incomplete.** `RAW_1/2/4.txt` and both psychology files are
   marked `TRUNCATED`; `RAW_3/5.txt` are `UNKNOWN`. Semantic parity cannot be
   established from bytes that are not present, and reconstructing them would be
   fabrication. This is the single reason no strategy is `SOURCE_FAITHFUL`.
2. **No empirical evidence exists in a clean checkout.** `asa-data/brain.db` is
   not committed, so `npm run brain:audit` cannot run and the promotion gate has
   zero experiments to read. Every strategy is therefore `UNTESTED` and
   `live_eligible: false`. Generating evidence requires live TTT history.
3. **No outbound network for TTT / AI / Telegram in this environment.**
   `nodejs.org` and GitHub release assets are also blocked (see §1). No live
   market claim, probe result or provider verification is made in this report.
4. **Psychology policies are all inactive by design.** Every `PSY-*` policy
   cites a `TRUNCATED` source, so `evaluatePsychologyGate` reports
   `not_evaluated` rather than passing. This is correct fail-closed behaviour
   and is resolved only by complete source material.
5. **No browser/device verification.** No Playwright, Chromium or Puppeteer
   binary is available, so no UI screenshot, gesture or PWA-install claim is
   made.

---

## 6. Knowledge-chain status at this HEAD

**Strategy chain** — `USER SOURCE → CONCEPT → STRATEGY → SETUP → RULE → SPEC →
COMPILED RULE → VALIDATION → DECISION`

| Link | Status | Evidence |
|---|---|---|
| USER SOURCE | `PARTIAL` | 7 corpus files, sha256-pinned; 5 TRUNCATED, 2 UNKNOWN completeness |
| CONCEPT / STRATEGY | `COMPLETE` for the 6 compiled ids | `source-contracts.json` strategies with line-bounded `source_refs` |
| SETUP | `COMPLETE` | 7 setups in `COMPILED_STRATEGIES`, version- and rule-bound |
| RULE | `COMPLETE` | rule ids/versions verified against the compiled runtime by `validateSourceContractRuntimeBindings` |
| SPEC → COMPILED RULE | `PARTIAL` | contracts exist and are identity-verified, but every `contract_status` is `INCOMPLETE` |
| VALIDATION | `NOT_PRESENT` | `semantic_validation.status: "NOT_PROVEN"` for all 6; no experiment rows exist |
| DECISION | `BLOCKED` | runtime availability `RESEARCH_ONLY`; live admission additionally requires `LIVE_ADVISORY_ONLY` |

**Psychology chain** — `USER PSYCHOLOGY → PRINCIPLE → COGNITIVE MODEL → RUNTIME
CONTEXT → DECISION CONSTRAINT`

| Link | Status | Evidence |
|---|---|---|
| USER PSYCHOLOGY | `PARTIAL` | 2 files, both TRUNCATED, sha256-pinned in `USER_PSYCHOLOGY_SOURCES` |
| PRINCIPLE | `COMPLETE` (as source-only) | `USER_PSYCHOLOGY_SOURCE_RULES`, each `formalization_status: SOURCE_ONLY`, `executable: false` |
| COGNITIVE MODEL | `NOT_PRESENT` | no trait inference exists; `user_traits_inferred: false` is asserted by `/api/psychology/summary` |
| RUNTIME CONTEXT | `PARTIAL` | `loadLiveGateContext` measures journal-derived state; daily/period account-currency loss is `UNAVAILABLE` by construction |
| DECISION CONSTRAINT | `BLOCKED` | no `PSY-*` policy is active while cited sources are not COMPLETE; the gate returns `unknown` and admission refuses |

No field was moved from `UNKNOWN` to a value in this pass, because no additional
source material was available to justify one.

---

## 7. Changed files

| File | Change |
|---|---|
| `src/lib/backtest/validation.ts` | D1 — `qualityGate` stops the ladder on an unmeasured criterion |
| `src/lib/risk/engine.ts` | D2 — always-present `liquidation_gate` state + reason |
| `src/lib/pipeline/orchestrator.ts` | D2 — propagate `liquidation_gate` into the opportunity payload |
| `src/lib/backtest/strategy-runner.ts` | D3 — drawdown includes starting equity · D4 — `partial_then_timeout` · D5 — use the shared policy gate |
| `src/lib/backtest/engine.ts` | D5 — use the shared policy gate (adds the DISABLED check it was missing) |
| `src/app/api/research/backtest/route.ts` | D5 — use the shared policy gate, return named blockers |
| `src/lib/risk/research-policy-gate.ts` | **new** — the single definition of a research-usable risk policy |
| `src/lib/strategy/compiled/source-contracts.json` / `.lock.json` | regenerated sha256 bindings for `strategy-runner.ts` |
| `BACKEND_FREEZE.md` | D6 — corrected authoritative counts, with the reason recorded |
| `tests/remediation-2026-09-30.test.ts` | **new** — 20 regressions for D1–D5 |
| `tests/backend-freeze-contract.test.ts` | **new** — 8 assertions pinning the document to the runtime registry |
| `tests/fixtures/strategy/synthetic-ladder-strategy.ts` | **new** — test-only deterministic runner harness (not registered, makes no source claim) |
| `tests/strategy-engine.test.ts` | widened the outcome vocabulary for D4 |
| `docs/audit/BRAIN_CLOSURE_REMEDIATION_2026-09-30.md` | this report |

## 8. What was explicitly not done

* No trading rule, threshold or psychological trait was invented; nothing was
  read from general knowledge.
* No strategy was declared executable, promoted, or moved toward live.
* No `UNKNOWN` was converted into a pass or a zero — D1 does the opposite.
* No test was deleted, skipped or weakened. The only existing-test edit widens
  an outcome vocabulary to match a corrected behaviour (D4), and the reason is
  recorded here and in the test.
* No safety gate or source-fidelity criterion was relaxed. D5 tightened two of
  three call sites; the D2 first attempt was reverted precisely because it would
  have blocked correct advisories.
* No order-execution capability was added anywhere.
* No secret, token or credential appears in the code, the tests or this report.
