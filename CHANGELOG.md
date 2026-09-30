> **HISTORICAL CHANGELOG.** Entries describe the state at the time of each
> release. Older entries reference the former fixed 48-symbol universe, which
> has since been replaced by dynamic TTT discovery.

# Changelog

## Unreleased — audit-artifact freshness, executable-status clarity, CI

### Fixed
- **Committed audit artifacts went stale.** `MACHINE_READABLE_STATUS.json`
  still carried the sha256 of a previous `source-contracts.json`
  (`13cb5ec0…`) instead of the checked-in contract (`26acf24e…`), and
  `docs/brain/AUDIT.md`'s psychology policy matrix omitted the
  `runtime status is DISABLED` eligibility reason the current policy registry
  produces. Both artifacts were regenerated from the current code
  (`npm run brain:ingest && npm run brain:audit`) and a new
  `tests/audit-staleness.test.ts` fails loudly if they ever describe a
  contract/policy registry that is no longer the shipped one.
- **"Executable" could be misread across the strategy APIs.**
  `GET /api/brain/strategies` exposed `has_executable_spec: true` for the six
  compiled strategies while `GET /api/research/strategies` correctly reported
  `executable: false` (they are RESEARCH_ONLY). The Brain endpoint now also
  exposes the runtime registry's own verdict (`runtime_availability`, null
  when no compiled runtime definition exists) and `research_computable` with
  exactly the research endpoint's semantics, its note defines
  `has_executable_spec` as "a compiled implementation binding exists — NOT
  executable or live-eligible", and the registry table header was relabelled
  from "spec" to "compiled" showing the runtime availability.
  `tests/brain-strategies-route.test.ts` pins agreement across the Brain,
  Research and runtime surfaces.
- **Documentation drift.** `README.md` and `docs/architecture.md` referenced a
  `StrategySpec` interface that no longer exists (the seam is the Brain-backed
  runtime registry + `StrategyDefinition` contract) and described a `minRR`
  risk veto the engine deliberately does not have (R:R is reported; the corpus
  states no threshold). `docs/testing.md` still described a 389-test/19-file
  suite (now 87 files / 1528 tests) and `docs/IMPLEMENTATION_STATUS.md` pointed
  to `FINAL_STATUS.md` (a 2026-09-11 snapshot) as "current truth".

### Added
- **CI (`.github/workflows/ci.yml`).** The repository had no test CI at all —
  only the GitHub Pages deployment ran on `main`. Every push/PR to `main` now
  runs typecheck, lint, the full vitest suite, the production build, and the
  deterministic closure validator (`npm run closure:validate`; its honest
  current status `CLOSURE_BLOCKED_BY_SOURCE` exits 0, implementation errors
  fail).
- `tests/i18n-scan.test.ts` now enforces full en/fa key-tree parity
  (568 keys each) — `t()` silently falls back to English for a missing Persian
  key, so parity was previously only a convention.

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
