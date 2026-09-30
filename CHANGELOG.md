> **HISTORICAL CHANGELOG.** Entries describe the state at the time of each
> release. Older entries reference the former fixed 48-symbol universe, which
> has since been replaced by dynamic TTT discovery.

# Changelog

## Unreleased (2026-09-30) — delivery-failure honesty, provenance contradiction detection, verifiable runtime QA

Scope: advisory delivery state and decision-provenance truth. No execution path
exists before or after this change; AsA remains advisory-only.

### Fixed
- **One generic "poison payload" label covered two unrelated terminal causes.**
  An advisory whose linked signal had expired or gone terminal was dead-lettered
  with `poison payload: advisory text cannot be formatted (signal missing or no
  longer published)` even though its content was perfectly well-formed. Reproduced
  in the LOCAL TEST scenario database (`sig-77ee1c4aba1293c6` → outbox 3: DEAD,
  attempts 0) and visible through `/api/signals/<id>`.
  Rows now carry a stable `error_kind`: `POISON_PAYLOAD` (content can never be
  delivered), `LINK_NOT_DELIVERABLE` (policy-terminal link/identity failure),
  `TRANSPORT_REJECTED`, `TRANSPORT_BUDGET_EXHAUSTED`, `INTERRUPTED_AMBIGUOUS`,
  `INFRASTRUCTURE`, `NOT_CONFIGURED`, `DRY_RUN`. `SENT` clears the classification.
  Legacy rows keep `error_kind: NULL` — prose is never retro-classified
  (`schema_migrations` v5 adds the column by guarded `ALTER TABLE`).
- **The decision-window identity is stored twice and nothing compared the
  copies.** Tampering `provenance.data.snapshot.input_fingerprint` (leaving
  `chart_evidence.snapshot` intact) still produced
  `snapshot_check: {state: "VERIFIED"}` on `/api/charts`, so the API returned an
  unverified fingerprint beside a verified one with no contradiction reported.
  The two copies are now compared; `snapshot_identity` is exposed on the signals
  and opportunities APIs, and `/api/charts/<id>` refuses with
  **409 `contradictory decision provenance`** rather than rendering one copy.
- **The live-runtime UI suite crashed instead of stating its prerequisite.**
  `tests/runtime-opportunities.test.ts` threw
  `TypeError: Cannot read properties of null (reading 'symbol')` when the server
  was up but its database held no scenario rows — indistinguishable from a real
  UI regression. It now skips with an explicit seeding instruction when the
  database is empty, and fails with the exact missing case when rows exist but the
  required case does not (seeded-but-incomplete data cannot silently pass).

### Added
- `tests/cross-process-outbox.test.ts` — the repository's first suite that drives
  the REAL `SqliteRepo` from separate OS processes (esbuild bundle + child
  `node`): exclusive claim under 6-way contention, stale-owner write rejection,
  interrupted-final-attempt recovery (SENT vs DEAD), cross-process publication
  atomicity with no orphan outbox row, live-lease non-retryability, per-claim
  attempt accounting, forged-claim rejection.
- `tests/outbox-failure-taxonomy.test.ts`, `tests/snapshot-identity-contradiction.test.ts`
  — regression suites for the repairs above (unit + real chart-route invocation).
- `delivery.error_kind` and `snapshot_identity` in the signals/opportunities API
  payloads, surfaced in the signals UI (list and detail).

### Documentation
- `docs/testing.md` rewritten from the measured suite (it claimed "389 tests,
  19 files"; the checkout runs 1574 tests / 91 files) with the live-server
  prerequisites, the scenario runbook, and the currently BLOCKED external
  browser QA.
- `FINAL_STATUS.md` marked as a point-in-time record: it asserted a commit and
  test counts that do not describe the current tree.
- `docs/api-contract.md` documents the taxonomy, the provenance-agreement states,
  and the 409 refusal.

## 6.1 (2026-09-06) — real credentials wired

First window with live credentials supplied. All claims below are backed by
captured responses; see `docs/CREDENTIAL_INTEGRATION.md` and
`docs/evidence/capability-probe-2026-09-06.json` (`npm run probe:caps`).

### Fixed
- **Market data broke when a TTT key was present.** `client.ts` derived its
  `AUTH` object from `TTT_HAS_KEY`, and the venue edge returns 403 to ANY
  request carrying `X-API-Key` — including public routes that answer 200
  unsigned. Market requests are now unconditionally unsigned; two regression
  tests lock the invariant.
- **AI `neutral` stance was reported as a failure.** `coerceAiResponse`
  rejected `direction: "neutral"`, mislabeling successful completions as
  `HEURISTIC FALLBACK · LLM FAILED`. `neutral` is now a valid stance.
- **Empty LLM responses were reported as analyses.** The system prompt now
  states the full output schema (`json_object` guarantees valid JSON, not the
  right shape), and an emptiness guard forces a labeled heuristic fallback.

### Added
- `scripts/probe-capabilities.mjs` + `npm run probe:caps` — read-only credential
  capability probe (TTT auth, AI catalogue, Telegram `getMe`). GET-only; never
  places an order or sends a message; prints secret length only.
- Honest AI health lifecycle: `NOT_CONFIGURED / CONNECTING / ONLINE / DEGRADED /
  ERROR`, where `ONLINE` requires the configured model to be present in the
  provider catalogue.
- Real Telegram probe (`getMe`) behind `telegramState()` / `telegramStateLive()`
  with masked chat id and bot username; connected state is measured, never
  inferred from configuration.
- `GET|POST /api/system/notify` — notifier state, outbox counts, and an advisory
  test/drain action.
- `.env` and `.env.local` are now both loaded with Next.js precedence so dev,
  tests, and scripts see identical configuration.

### Verified
- TTT: `KEY_HEADER_REJECTED_AT_EDGE`; no authenticated read route available.
- AI: 313 models, `gpt-4o-mini` available, live `/api/ai/analyze` labeled OPENAI.
- Telegram: bot online; dry-run row held `QUEUED`, then delivered with the new
  row after `DRY_RUN=0` (`attempted 2 / sent 2`) — durable outbox proven.
- Gates: typecheck clean, lint clean, **68/68** tests, build passes,
  `/api/system/status` market LIVE 48/48.

## 6.0 (2026-09-05 close)
- Verification window: full-repo typecheck clean, eslint clean, 66/66 vitest green (9 files), production `next build` passes (prerender Suspense fix on /chart).
- Fixed severe scheduler defect found under runtime load: token bucket never refilled (budget froze after the first ~24 requests; cold fetches stalled 100s+). Continuous lazy refill at configured/min, frozen during 429 circuit pauses; cold candle fetches back to ~0.2-0.25s.
- Backtest depth: per-request windows up to 5000 bars (was fixed 700); reference-strategy macro warmup (64x4h) reachable by single-window runs; window-truncation warnings seeded into lineage. Real-data run (BTCUSDT 14d, 2144 bars): 395 trades, 57.5% win, PF 1.22, +23.74% gross, honest caveats in warnings.
- Test-suite hardening: hermetic repo injection for ingestNews; corrected fixture arithmetic in risk/backtest/udf tests; last-wins duplicate handling implemented to match documented contract (real venue repeats final ts); comment-aware source scans; segment-exact execution-surface inventory (31 advisory/read routes; orderbook is a data feed, not an order route).
- React 19 purity lint fixes (setState-in-effect, render-time impure calls) across chrome/lang/hooks/market-board/chart pages; live flash diffing moved into poll callbacks.
- Repo hygiene: untracked `.npm` cache (139 tracked files, ~1.3MB); runtime DB `asa-data/` gitignored.

## 5.1 v2.0 (this build)
## 5.1 v2.0 (this build)
- Discovered + integrated documented public TTT endpoints: `/futures/markets/stats` (full-universe price/funding/OI/mark/index/24h in ONE call), `/futures/markets/orderbook`, `/futures/markets/funding-history`, `/futures/quote-rates` → universe lanes rebuilt around the stats sweep (48/48 fresh with 1 request/cycle), real derivatives capability registry (funding, OI, mark, index, basis DERIVED, book MEASURED; L/S + CVD + liquidations remain UNAVAILABLE).
- TTT HMAC-SHA256 signer (`tttSign`) + unit tests; auth routes remain NOT CONFIGURED by default.
- Central scheduler upgrade: request coalescing; adaptive budget with 429 pause/recovery; queue priorities exposed.
- Fundamental engine v1 (connector interface, RSS connector, dedupe, 30-day rolling auditable retention).
- AI Clone (grounded assistant: FACT/RULE/INTERPRETATION/HYPOTHESIS/UNAVAILABLE tags).
- Psychology page (universe funding/OI stack), Backtest page (same StrategySpec as live), expanded System page (fairness, retention, auth, book, funding), i18n en/fa + RTL + required footer line.
- Gap detection on series; freshness thresholds simplified to stats cadence; fairness metrics per symbol.
- Vitest suite: 9 files, 31 tests incl. signer vector, normalization, structure geometry, risk veto, no-fake source scan.

## 5.0 (initial)
- TTT-only engine, analysis/structure/regime/MTF, strategy registry, risk gate, AI router (heuristic default), opportunity/signal pipeline, Telegram outbox, manual journal, research registry, command-center web terminal.
