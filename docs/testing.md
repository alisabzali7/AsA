# Testing Guide

Run: `npm ci && npx vitest run`

No database server or env var is required: suites that need the Brain build it
from `knowledge/raw/` + `knowledge/psychology/` (`npm run brain:ingest`) in a
temp directory, and those that need candles use the committed replay fixtures
under `tests/fixtures/replay/` and live venue fixtures under
`tests/fixtures/live/`.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, this full suite, the
production build and the deterministic closure validator
(`npm run closure:validate`) on every push/PR to `main`.

## Inventory (87 files, 1528 tests: 1516 run + 12 environment-gated skips)

The `runtime-*.test.ts` files are skipped when no browser runtime is available
(jsdom is used where possible); the skip is environmental, never a silently
weakened assertion.

- **Source & provenance closure** — `source-recovery` (source identity and
  recovery honesty), `source-contract-bindings` (compiled contracts vs runtime
  bindings), `mining-project` (deterministic mining), `closure` (end-to-end
  source-to-runtime closure), `rule-closure` (Brain rule registry ↔ runtime
  rule graph, both directions), `user-psychology-source` (psychology sources
  stay source-only), `conflict-resolution` (conflict groups decide by
  resolution, never by presence), `release-identity` (build identity
  propagation).
- **Committed artifact guards** — `audit-consistency` (the two empirical views
  in `MACHINE_READABLE_STATUS.json` stay coherent), `audit-staleness` (the
  committed audit artifacts describe the CURRENT contract/policy code — a stale
  `MACHINE_READABLE_STATUS.json`/`docs/brain/AUDIT.md` fails here).
- **Brain governance & safety** — `brain-governance` (ingest completeness,
  gating invariants), `brain-safety` (fail-closed store behavior),
  `brain-strategies-route` (Brain/research/runtime registries agree on
  executable status), `remediation` (pinned remediation outcomes).
- **Strategy & admission** — `strategy-engine` (compiled evaluation),
  `setup-admission-gate` (the setup PASS hard gate), `setup-guard-unknown`
  (UNKNOWN ≠ pass), `scanner-safety` (research scanner honesty),
  `strategy-promotion` (the deterministic promotion gate incl. legacy evidence
  rows), `validation-pipeline` (validation runs, dataset identity, splits),
  `backtest` (no-lookahead runner semantics), `freeze` (backend-freeze
  acceptance gates §H/§I).
- **Risk & psychology** — `risk-engine` (sizing/direction/venue honesty),
  `risk-settings` (policy selection: conflicts/incomplete source block),
  `open-book-coverage` (bounded advisory book cannot understate exposure).
- **Market truth** — `market-data`, `market-store`, `market-truth-pipeline`,
  `market-runtime-recovery`, `ttt-admission`, `ttt-closure`, `ttt-signer`,
  `udf-normalize`, `universe-tf`, `history-boundary`, `sync-concurrency`,
  `sync-lease`, `scheduler-guard`, `engine-health-truth`,
  `indicators-robustness`, `analysis-layer`, `bundle-contract`.
- **Decision → signal → delivery** — `decision-truth-recovery`,
  `opportunity-freshness`, `opportunity-view`, `signal-publish`,
  `live-signal-runtime`, `live-timeframe-coverage`, `telegram-claim-lease`,
  `telegram-partial-send`, `telegram-attempts-accounting`, `chart-telegram`,
  `chart-adapter-range`, `retention-news`.
- **Team suites** (pinned inter-team contracts) — `team02-*` (input integrity,
  causality, canonical validity, property invariants, chart overlay, release
  gate), `team05-*` (publication/delivery recovery, workers, closure gates,
  API failure truth), `team09-*` (decision-consumer contract, strategy
  regression counts), `team10-chart-e2e` (chart chain end-to-end).
- **App surfaces** — `ai-clone` (deterministic context, token quarantine),
  `system-config` (config POST atomicity), `provider-state-contract`,
  `resource-state`, `pwa-state`, `board-selectors`, `home-attention`,
  `cinematic-governance`, `i18n-scan` (footer exactness, prohibited-venue /
  PRNG / execution-surface scans, en/fa key-tree parity).

## Live integration

Live integration (not mocked): verified manually against the real TTT API
(markets, stats, orderbook, funding-history, UDF per resolution, quote-rates,
401 behavior on auth routes) and recorded in the delivery notes of the build
that performed them; committed fixtures under `tests/fixtures/live/` pin those
responses. Fixture-based backtests are marked FIXTURE in their output context
and never presented as edge proof.

## Closure validation

`npm run closure:validate` re-runs the focused closure suites plus typecheck,
lint, the full suite and the build, and verifies source/contract identities
against the committed lock. Its honest terminal state for the current corpus is
`CLOSURE_BLOCKED_BY_SOURCE` (five TRUNCATED transcripts, two UNKNOWN
completeness, six INCOMPLETE strategy contracts) — implementation errors fail
the run, source blockers are reported and never converted into a pass.
