# AsA Architecture

## Layers (backend is the source of application truth)

1. **TTT gateway** (`src/lib/ttt/`) — the ONLY path to the venue.
   - `client.ts`: typed fetchers for documented public endpoints (markets, stats, trades, orderbook, funding-history, udf/history, quote-rates); UDF normalization (validation, timestamp alignment, sort, dedupe with duplicated-final-timestamp workaround, historical chunking, derived-TF synthesis labeled DERIVED).
   - `signer.ts`: `tttSign(secret, ms, METHOD, uri)` — lowercase hex HMAC-SHA256, body never signed. Unit-tested against an independently computed vector. Used only when `TTT_API_KEY/SECRET` exist; AsA never implements trading endpoints.
   - `client.ts/Scheduler`: token-bucket (`TTT_RATE_PER_MIN`, default 24 — measured practical ceiling ≈30 req/min/IP, shared across endpoints), priority classes P0 focus → P1 closes/on-demand → P2 sweeps → P3 backfill, request coalescing, adaptive budget on 429 with 12s circuit pause and recovery.
2. **MarketEngine** (`src/lib/market/engine.ts`) — stats-driven polling:
   - Universe stats loop (~7s, 1 request for 48 prices + funding + OI + mark/index + 24h stats).
   - Focus tape loop (~5s), focus orderbook loop (~10s), funding-history ingestion (30 min), candle-close scheduler (4H/1H/15M, +4s grace, retry only lagging symbols ×3), backfill worker (144 series, focus first).
   - Forming bars DERIVED from venue prices, reconciled by UDF. Coverage/gap/freshness/fairness metrics.
3. **Event bus** (`src/lib/events.ts`) → SSE (`/api/system/events?stream=1`). Typed v2 taxonomy: `price.updated`, `candle.closed`, `market.stats.updated`, `trade.received`, `orderbook.updated`, `funding.updated`, `analysis.updated`, `ai.state`, `ai.completed`, `opportunity.created/updated`, `signal.created/queued/sent/failed`, `news.created`, `backtest.completed`, `system.health.changed`, `system`.
4. **Analysis** (`src/lib/analysis/`) — EMA/RSI/ATR/ADX/volume, swings, BOS/CHoCH, S/R clusters, FVG, OBs, liquidity pools + sweeps, fib, regime label; MTF context (4H→1H→15M with ALIGNED/PARTIAL/CONFLICT/INSUFFICIENT); psychology with explicit MEASURED/DERIVED/PROXY/UNAVAILABLE; data-driven market story.
5. **StrategySpec** (`src/lib/strategy/`) — plugin interface; ONE definition drives live evaluation, explanation, backtest and signals. Shared `EXIT_POLICY` (staged 1R/2R/3R) is the regulator-consistent exit used everywhere.
6. **Risk engine** (`src/lib/risk/`) — deterministic HARD GATE: equity-proportional sizing, venue tier-aware leverage cap, stop distance, minRR, exposure/direction concentration/duplicate veto, liquidation ESTIMATE from TTT maintenance margin, fee model from TTT fee coefficients, daily-loss guard from human journal. AI cannot override.
7. **AI router** (`src/lib/ai/`) — provider-agnostic: heuristic (default, NOT AN LLM, deterministic evidence assembly), Local Ollama provider, OpenAI-compatible provider. Strict structured output, annotation geometry validation, risk/data-quality bypass impossible, audit log. Health is measured, never claimed.
8. **Pipeline orchestrator** (`src/lib/pipeline/orchestrator.ts`) — event-driven scans (15M close per symbol; startup/periodic full scans), opportunity lifecycle SCANNING→ANALYZING→CANDIDATE FOUND→RISK CHECK→READY/REJECTED/COOLDOWN, deterministic confidence with stored breakdown (explicitly NOT a probability), idempotent per symbol+direction+strategy+anchor candle, durable signals (PG), staged resolver on the same exit policy, Telegram outbox.
9. **Storage** (SQLite via `better-sqlite3`) — three separate databases: `brain.db` (corpus knowledge, rebuildable via `npm run brain:ingest`), `history.db` (durable TTT candles, rebuildable via history sync) and `asa.db` (runtime state: opportunities, signals, journal, telegram outbox, ai calls, config, system events, backtest jobs, news events, retention runs). Repository access is centralized behind the `Repo` interface (`src/db`); schema is created idempotently at open.
10. **Web terminal** (`src/app`, `src/components`) — SPA-like client state store + SSE bridge + chart renderer (lightweight-charts is a RENDERER; all data from the AsA API). No business logic in the browser.

## Data contracts

Every live market value travels with provenance (`source_name: ttt`, endpoint, fetched_at, event_ts, age). Locations: candles API (`source`, `provenance: NATIVE/DERIVED`), stats (`provenance.verification_state`), prices (`source: stats|trades`).

## Deployment shapes

Local (first-class): Next.js standalone process + local SQLite files + optional Ollama + browser. VPS (later, no redesign): same process behind a reverse proxy with HTTPS + env config. Note: `better-sqlite3` is a native module requiring a persistent filesystem, so the backend needs a Node-capable host (not an edge runtime).
