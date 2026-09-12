> **HISTORICAL DOCUMENT.** Point-in-time snapshot from an earlier build phase,
> retained for provenance. Figures such as "48 symbols" describe the universe as
> it was THEN; the production universe is now discovered dynamically from TTT.
> For current truth see `FINAL_STATUS.md` / `MACHINE_READABLE_STATUS.json`.

# AsA Implementation Contract v1

## Mission
AsA is an AI trading-intelligence and advisory system. It reads live market truth, the user's trading/psychology corpus, technical/structural evidence, futures data when actually available from TTT, risk rules, and current context; it produces scored opportunities and advisory signals. A human performs every trade, transfer, deposit, withdrawal, and account action.

## Immutable product rule
**NO EXECUTION.** There must be no order-placement implementation, execution button, execution endpoint, or hidden execution path. The system may say BUY/SELL as an advisory direction only and must visibly state that execution is human-controlled.

## Production market truth
All market/venue truth must come from **The True Trade (TTT)** only.
Do not use Binance, Bybit, OKX, TradingView, CoinGecko, Yahoo, or another exchange as a substitute market source. Educational mentions of other venues inside the user's corpus are historical/source context, not a production data permission.

Verified TTT public endpoints used by the existing project:
- `/futures/markets`
- `/futures/markets/stats`
- `/futures/markets/trades?symbol=`
- `/futures/markets/orderbook?symbol=`
- `/futures/markets/funding-history?symbol=&page=`
- `/futures/udf/history?symbol=&resolution=&from=&to=`
- `/futures/quote-rates`

Do not invent a public websocket protocol. REST polling is acceptable until a documented/verified TTT stream exists.

## Symbol universe
Exactly these 48 symbols:
`1000PEPEUSDT, 1000SHIBUSDT, AAVEUSDT, ADAUSDT, ALGOUSDT, APEUSDT, APTUSDT, ARBUSDT, ASTERUSDT, ATOMUSDT, AVAXUSDT, BANDUSDT, BCHUSDT, BNBUSDT, BTCUSDT, CAKEUSDT, DASHUSDT, DOGEUSDT, DOTUSDT, ENAUSDT, ETCUSDT, ETHUSDT, FETUSDT, FILUSDT, HBARUSDT, HYPEUSDT, ICPUSDT, INJUSDT, KSMUSDT, LINKUSDT, LTCUSDT, NEARUSDT, NOTUSDT, ONDOUSDT, OPUSDT, PAXGUSDT, QNTUSDT, SANDUSDT, SOLUSDT, SUIUSDT, TRUMPUSDT, TRXUSDT, UNIUSDT, VETUSDT, WLDUSDT, XLMUSDT, XRPUSDT, ZECUSDT`

**TONUSDT is permanently excluded.**

## Timeframes
Supported: 1m, 5m, 15m, 30m, 45m, 1h, 2h, 4h, 8h, 1d.
Core strategy hierarchy: **4H macro -> 1H context -> 15M setup/trigger**.
Use native TTT 1D when verified; otherwise derived series must be explicitly labeled DERIVED and never masqueraded as native.

## Data honesty
Never fill unavailable values with 0, invented numbers, or guessed semantics. Every market value needs provenance, timestamp, source, and freshness. States should distinguish CONNECTING / CONNECTED / LIVE / DEGRADED / STALE / UNAVAILABLE / NOT_CONFIGURED / INSUFFICIENT_DATA / ERROR / READY / REJECTED / COOLDOWN as appropriate.

Do not claim true buy-volume/sell-volume or aggressor-side semantics unless TTT explicitly supplies and AsA has verified that meaning. A raw trade tape size is not automatically buyer/seller volume.

OI/funding/orderbook/trades may be shown only when the TTT endpoint actually supplies them and the implementation labels the source and verification state.

## User corpus governance
The five TXT files are educational/source material, not a ready-made executable strategy file. Preserve:
- SOURCE_STATUS: SOURCE_VERIFIED, SOURCE_INFERRED, UNKNOWN, CONFLICT, CLAIM
- EMPIRICAL_STATUS: UNTESTED, BACKTESTED, OOS_TESTED, WALK_FORWARD, ROBUST, REJECTED
- RUNTIME_STATUS: DISABLED, CANDIDATE, PAPER, LIVE_ADVISORY_ONLY

`VERIFIED` in the source pack means the source/extraction is verified, not that the trading claim is empirically proven.

Unknown entry/exit/SL/TP/RR/timeframe details remain UNKNOWN until supported by source evidence or a separately documented design decision. Conflicting source rules must remain visible as conflicts; the AI must not silently reconcile them.

Do not turn psychology routines, journaling, security procedures, generic frameworks, anti-strategies, future-session teaching, or educational commentary into executable signal rules.

## Strategy architecture
Use a layered model:
`RAW_SOURCE -> CANONICAL_KNOWLEDGE -> PRIMITIVES -> FEATURES -> RULES -> SETUPS -> STRATEGIES -> SCORE -> RISK -> OPPORTUNITY -> SIGNAL`

Avoid a giant pile of near-duplicate strategy classes. The current canonical pack contains 55 normalized records from 75 explicit strategy-name mentions. Use reusable primitives for RSI, Fibonacci, swings, BOS/CHoCH, S/R, FVG, OB, liquidity, candlestick structures, divergence, momentum, etc.

One `StrategySpec` should define strategy evaluation, explanation, backtest behavior, and signal rationale so behavior cannot drift between modules.

## Score semantics
The requested opportunity threshold is **score > 85**. Call it a score, not a probability, unless an explicit calibration process later proves probabilistic meaning. Store score breakdown and evidence.

## AI
The AI is a reasoning/explanation layer on top of deterministic market/strategy/risk evidence. It must not invent market facts, override hard risk gates, or promote unknown source claims to facts. Structured output should include evidence, contradictions, missing data, strategy match, setup, invalidation, risk summary, and reasons for rejection.

## Psychology
Implement the user's psychology/standards as a distinct layer. It can be a hard gate or soft penalty only when the source supports that behavior. Examples from the corpus include avoiding revenge trading/chasing and maintaining standards, but exact wording/thresholds must stay source-derived.

## Fundamental/news
News/events should be updated about every 30 minutes when a real source is configured, stored with timestamps/source/importance, and retained for a rolling 30-day window. Never fabricate headlines/events.

## Opportunities and signals
The system must evaluate the 48-symbol universe continuously, with focus/close lanes that respect TTT rate limits. Opportunities need deterministic lifecycle and idempotency. A signal must contain symbol, direction, timeframe, strategy, entry logic, invalidation/SL when known, targets/exit logic when known, score, risk result, data freshness, evidence, and timestamp.

## Chart
Chart is central to AsA. It must use real TTT candles/history, not demo bars. It should support the requested timeframe set and the 4H/1H/15M hierarchy. Draw only analysis objects actually produced by the engine: Fibonacci, S/R, trendlines with multiple styles including dashed/dotted where appropriate, FVG, OB, liquidity, structure, and signal annotations. Do not show an indicator merely to decorate the chart.

The final signal annotation model must be shared between the Web chart and Telegram rendering so they cannot disagree.

## Telegram
Telegram is advisory only. The final signal message must include the opportunity/signal details and, when a signal is materialized, the final annotated chart image. Never include trade execution buttons or execution links. Delivery state must be truthful.

## UI
Product direction: premium obsidian/black + champagne-gold, chart-centric, less admin-terminal feel. Persian and English are first-class; Persian RTL text must read naturally. Required footer:
`سلام علی به شرکت چاپ پول تک نفره ات خوش اومدی`
Include the small red ping in the header and preserve the requested opening dollar/torn-entry visual where practical without damaging performance or accessibility.

## Reliability
No fake/mock statuses. No fake success. Measure TTT/AI/Telegram latency as real request RTT. Show stale/degraded/error states honestly. Favor durable storage for opportunities/signals/news/outbox/audit data.

## Deployment
The same app should run locally and on a simple VPS without architecture rewrite. Secrets are environment-driven. No secret is exposed to the browser or committed.
