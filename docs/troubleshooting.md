# Troubleshooting

- **DEGRADED with 429s**: TTT rate limit (≈30 req/min/IP). The scheduler adapts automatically; raise `TTT_RATE_PER_MIN` only if your IP allows more; otherwise wait for budget recovery (System → TTT request budget).
- **4H x/48 for a while**: expected during initial backfill within the budget; per-close retries only refill lagging symbols. If a symbol never fills, inspect System → Errors for a venue-side no_data response.
- **Chart shows "TTT history delayed 1 closed bar"**: known venue behavior (UDF lags ~1 closed candle); tape-derived forming bar keeps the chart live, labels DERIVED, and UDF reconciliation follows.
- **AI = HEURISTIC MODE**: no provider reachable. This is the honest default, not an error. Configure Ollama or a cloud key to enable a real LLM.
- **Telegram NOT CONFIGURED**: set `TELEGRAM_BOT_TOKEN/CHAT_ID`. Dry-run default keeps messages in the outbox without sending.
- **Backend unreachable (banner)**: Next.js server is down; no fake market is shown. Restart and watch `/api/health`.
- **Settings save fails 401**: `ASA_API_TOKEN` is configured — send the token (`x-asa-token` header; Settings instructs).
