# Security Guide

- Secrets exist ONLY in env (`DATABASE_URL`, `TTT_API_*`, `OPENAI_API_KEY/AI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ASA_API_TOKEN`). No secret is read by client code; only `NEXT_PUBLIC_*` would ever reach the browser (none are used).
- TTT trader-scope key: the documented `trade-futures` scope combines reads+trading. AsA never implements trading endpoints, never holds that key by default, and if configured uses it read-only via `signer.ts`; never add transfer/withdrawal scopes.
- Telegram: bot token server-side; only formatted advisory text is sent; no inline execution buttons.
- Inputs: every POST validates payloads; symbol allow-list (canonical 48); TF allow-list; config sanitizers clamp numeric ranges; string fields length-capped; no shell/file paths from API params.
- Write endpoints: optional `x-asa-token` header (see api-contract.md).
- No CSRF surface beyond local POST APIs (same-origin, no cookies used for auth today); if cookie auth is added later, CSRF tokens are mandatory.
- Logs are structured and never include secrets; settings display masks configured services by state only (CONFIGURED/NOT CONFIGURED).
- Production-source scan (`tests/no-fake-scan.test.ts`) asserts: no prohibited venue strings (binance/coingecko/coinmarketcap/bybit/okx/tradingview realtime), no `Math.random`/`faker`, no order-creation code paths.
