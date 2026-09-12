# API Contract (v1, JSON, defensive parsing)

Groups:
- SYSTEM: GET /api/system/health | /api/system/status | /api/system/events (GET json ?limit=; SSE ?stream=1) | /api/system/config (GET/POST sections risk|ai|general) | /api/system/config/risk (GET/POST) | /api/system/config/ai (GET/POST) | /api/system/logs
- MARKET: GET /api/market/symbols | /prices | /candles?symbol&tf&limit&focus=1 | /trades?symbol | /stats?symbol? | /board | /coverage | /orderbook?symbol&refresh=1 | /derivatives?symbol | /deriv_features
- ANALYSIS: GET /api/analysis/{symbol}/{tf} (typed IntelligenceBundle) | POST /api/ai/analyze {symbol, timeframe}
- AI: GET /api/ai/status | POST /api/ai-clone {question, symbol}
- PSYCHOLOGY: GET /api/psychology/summary
- FUNDAMENTAL: GET /api/fundamental/news?days&symbol&kind
- OPPORTUNITIES: GET /api/opportunities
- SIGNALS: GET /api/signals | GET /api/signals/{id} | GET/POST /api/signals/journal | DELETE /api/signals/journal/{idOrOpp}
- RESEARCH: GET /api/research/hypotheses | /api/research/strategies | /api/research/ai-calls | POST /api/research/backtest | GET /api/research/backtest/{job_id}
- CHARTS: GET /api/charts/{sigIdOrOppId}.json (final merged annotation spec shared by web + Telegram)

Conventions: unavailable → `{ available: false, state, reason }`; never `0` for unknown; freshness as ages + RTTs in every payload; states from the state taxonomy (CONNECTING/CONNECTED/LIVE/DEGRADED/STALE/UNAVAILABLE/NOT_CONFIGURED/INSUFFICIENT_DATA/ERROR/READY/REJECTED/COOLDOWN).

Write protection: if `ASA_API_TOKEN` is set, mutating routes (config POST, journal POST/DELETE, ai analyze, ai-clone) require header `x-asa-token`. Local default: open (documented), token recommended on shared machines/VPS.

Versioning: additive-only within v1; breaking changes under new route suffix.
