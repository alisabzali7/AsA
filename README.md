# AsA — AI-Native Crypto Futures Intelligence Terminal

AsA watches the live futures market on **The True Trade (TTT)**, builds multi-timeframe market state (4H macro / 1H context / 15M trigger), evaluates the configured strategy plugins, reasons through the AI layer, applies a hard risk gate, renders annotated charts, and emits **advisory** signals. **AsA never executes trades. The human is always the executor.**

**Market truth: TTT only.** No Binance/TradingView/CoinGecko/etc anywhere in production paths. If TTT doesn't provide a metric, the UI shows UNAVAILABLE — never a substituted value.

## Quick start (local, Windows/macOS/Linux)

```bash
# 1. Install
npm install
# 2. Configure environment
copy .env.example .env        # Windows
# cp .env.example .env        # macOS/Linux
# 3. Build runtime state (SQLite via better-sqlite3 — created automatically).
#    Runtime DBs are NOT shipped; they are rebuilt from the source corpus.
npm run brain:ingest    # knowledge/raw/*.txt -> asa-data/brain.db (9,398 fragments)
npm run brain:mine      # narrative mining    -> atoms/components/candidates
npm run brain:validate  # real TTT replay     -> validation experiments + promotion verdicts
# 4. Run
npm run build && npm run start   # production
# npm run dev                    # development
# 5. Warm market history on demand (walks to the TTT venue boundary):
#    curl "$HOST/api/market/history?symbol=BTCUSDT&tf=1h&sync=full&limit=1"
```

Open http://localhost:3000. The engine boots at server start: TTT markets → backfill (144 series) → stats sweeps → analysis → scanning.

## Tests

```bash
npx vitest run         # unit + source-scan tests (see docs/testing.md)
```

## Strategy validation & promotion

A compiled strategy is a **candidate**, never a live strategy:
`executable ≠ validated ≠ promotable ≠ live eligible`.

```
Registry → Executable → Validation → OOS → Governance → Promotion → (Live)
```

Every stage is machine-checkable and every refusal is explainable:

- `npm run brain:validate` runs real historical backtests on TTT-derived data
  (in-sample → chronological OOS split → rolling walk-forward) and persists one
  append-only experiment per (strategy, symbol) **with its dataset identity**
  (venue base, capture time, artifact sha256, recomputed candle fingerprint) and
  the periods it covers.
- `src/lib/backtest/promotion.ts` is the ONE deterministic gate. It requires the
  strategy to exist and be executable, the governance state to be clean, the
  evidence provenance to be valid, the evidence to still describe the current
  build, every required metric to have been computed, the persisted verdict to be
  reproducible from the stored metrics, out-of-sample evidence to exist, and the
  quality ladder to support it. Otherwise the decision is `NOT_ELIGIBLE` with the
  exact failing checks.
- **UNKNOWN propagates.** A missing metric, an unreadable row, a missing
  provenance record or an absent Brain record is reported as a blocking
  `UNKNOWN` and is never treated as a pass.
- `GET /api/brain/validation` returns the A→F state per strategy
  (`exists / executable / has_validation_evidence / has_oos_evidence /
  promotion_eligible / live_eligible`) plus the failure/unknown reasons. No
  fabricated metrics are ever produced: a strategy with no evidence reports
  `NOT_VALIDATED`/`UNKNOWN` and stays disabled.

See `docs/brain/strategy-promotion.md`.

## What is measured vs derived vs unavailable

| Metric | State | Source |
|---|---|---|
| Last price (all discovered TTT markets) | MEASURED | `GET /futures/markets/stats` (1 request per sweep) + `…/trades` focus lane |
| Candles 5m/15m/30m/45m/1h/2h/4h/8h/1d | MEASURED | `GET /futures/udf/history` — all nine resolutions **native**, including 1D (`resolution=1D`) |
| 24h change / 24h volume | MEASURED | `/futures/markets/stats` |
| Funding rate + history | MEASURED | `/futures/markets/stats`, `/futures/markets/funding-history` |
| Open interest (current) | MEASURED | `/futures/markets/stats`; OI Δ/velocity **DERIVED** from AsA snapshot ring |
| Mark/index price | MEASURED | `/futures/markets/stats`; basis **DERIVED** |
| Order book, spread, depth imbalance | MEASURED/DERIVED | `/futures/markets/orderbook` (focus-symbol lane) |
| Trade tape | MEASURED | `/futures/markets/trades` (~50/call); **tape-side flow is PROXY — BID/ASK aggressor semantics unverified** |
| L/S ratio, CVD, liquidations | UNAVAILABLE | not established by verified public TTT interface |

## Architecture (docs/architecture.md)

```
TTT REST (documented public endpoints)
  → Scheduler (token bucket, priorities, coalescing, 429 backoff + circuit pause)
  → TTTAdapter (fetchers + UDF normalization/dedupe/validation)
  → MarketEngine (stats loop, tape lane, book lane, funding ingestion, candle scheduler, coverage, fairness, freshness)
  → Analysis (indicators/structure/regime/liquidity/fib) → MTF context → Psychology (measured vs proxy)
  → StrategySpec registry → Opportunity engine → Risk engine (HARD GATE) → AI router (heuristic default; Ollama/OpenAI-compatible optional)
  → Signal engine (durable) → final merged chart spec → Telegram outbox → human journal
  → Event bus → SSE → React web terminal (browser never talks to TTT directly)
```

Everything major is an interface seam: `StrategySpec`, AI provider router, `NewsConnector`, TTT adapter, and a `Repo` storage interface implemented by `better-sqlite3` (`src/db/`). Storage is deliberately swappable without touching business logic.

## Pages

Command Center `/` · Market `/market` · Terminal `/chart` · Opportunities `/opportunities` · Signals `/signals` · AI Brain `/ai` · AI Clone `/ai-clone` · Backtest `/backtest` · Psychology `/psychology` · Fundamental `/fundamental` · Research `/research` · System `/system` · Settings `/settings`.

Persian/English UI (`تنظیمات` toggle), RTL support. Footer: «سلام علی به شرکت چاپ پول تک نفره ات خوش اومدی».

## Key environment variables

See `.env.example`. Nothing secret ever enters the browser bundle; AI/Telegram/TTT credentials are server-side env only.

## Honesty policy

No fabricated prices/candles/indicators/AI state/Telegram state/backtest numbers. `85` is a deterministic **score**, never a calibrated probability. Latency numbers are measured (venue RTT, data age, pipeline, AI, signal, Telegram, chart update, event→UI). `SOURCE ≠ PROOF`.
