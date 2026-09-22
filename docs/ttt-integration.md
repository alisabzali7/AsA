# TTT Integration

Base: `https://apiv2.thetruetrade.io` (`TTT_API_BASE`). Transport: REST polling — no verified public WebSocket is documented or used; AsA does not invent one.

| Endpoint (all public, verified live in this build) | Use in AsA |
|---|---|
| GET /futures/markets | instrument metadata (tick/step, leverage tiers, maintenance margin, maker/taker fee coefficients) — risk + symbol catalog |
| GET /futures/markets/stats | universe sweep: lastPrice, markPrice, indexPrice, fundingRate, nextFundingTime, 24h change/high/low, volumes, openInterest, openValue — ONE request per cycle |
| GET /futures/markets/trades?symbol= | focus-lane price + tape (server cap ≈50 records/call); tape-side semantics treated as PROXY/UNVERIFIED |
| GET /futures/markets/orderbook?symbol= | focus-lane book: bids/asks, spread, depth imbalance |
| GET /futures/markets/funding-history?symbol=&page= | funding ingestion (30 min), funding extremes window |
| GET /futures/udf/history?symbol=&resolution=&from=&to= | candles (native resolutions 1/5/15/30/45/60/120/240/480 **and 1D**; 1D is requested NATIVELY — an 8h-derived fallback exists only for an explicit unsupported-resolution/no-data response, never for an outage); up to ~5000 rows/call; observed lag ≈1 closed candle → close-grace + retry |
| GET /futures/quote-rates | quote asset rates (observability only) |

Authenticated endpoints (`/futures/assets`, `…/positions`, `…/orders`, `…/trades`): require a key. AsA does not implement them. Measured 2026-09-06: the venue edge answers HTTP 403 to ANY request carrying `X-API-Key`, including public routes that return 200 unsigned. The market-data transport therefore refuses to attach credentials (and refuses to follow redirects, so the host allow-list cannot be bypassed). Setting `TTT_API_KEY` / `TTT_API_SECRET` does not enable extra market data. Trading endpoints are never implemented (`/futures/orders` writes do not exist anywhere in the codebase).

Rate limiting: per key and per IP; 429 → the Scheduler backs off with jitter, pauses 12s, and adapts its budget (measured practical ceiling from AsA infrastructure ≈30 req/min/IP, default budget 24 req/min configurable via `TTT_RATE_PER_MIN`).

Signing (per official guide): `X-Signature = hex(HMAC-SHA256(secret, `${timestampMs}${UPPERCASE_METHOD}${URI_WITH_QUERY}`))`; `X-Timestamp` ms; ±30s window; body never signed. Implemented once in `src/lib/ttt/signer.ts` and unit-tested.

Error format: `{ errors: [{ message, field? }] }` — surfaced in engine error events.
