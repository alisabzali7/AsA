# AI Provider Extension Guide

Router: `src/lib/ai/index.ts`.

Providers:
1. **Heuristic (default)** — Deterministic evidence assembly over the same structured context. The UI labels this `HEURISTIC MODE · NOT AN LLM`.
2. **Local (Ollama gateway)** — set `OLLAMA_URL` (e.g. `http://127.0.0.1:11434`). Health (`/api/tags`) is PROBED; unreachable → honest fallback. Recommended quantized models for 4 GB VRAM: `qwen2.5:3b`, `llama3.2:3b` (configurable in Settings). Local-first: no internet required for AI when this provider is active.
3. **Cloud (OpenAI-compatible)** — `OPENAI_BASE_URL` + `OPENAI_API_KEY` (server-side only; key is never proxied to the browser).

Failover order with `provider=auto`: local → cloud → heuristic. A failed LLM yields `HEURISTIC FALLBACK · LLM FAILED` with the error, never a silent fake-online.

Contract: structured output only {verdict, direction, thesis, market_story, setup_quality, invalidation, confluences, contradictions, risks, confidence, evidence, annotations}. Enforcement:
- risk BLOCK forces `reject`; insufficient data forces `neutral`
- annotation geometry must lie inside the analyzed candle window (price bounds ±3%, timestamps within window) else it is dropped and counted
- audit rows in `asa_ai_calls` (model, latency, verdict, structured output) — chain-of-thought is never requested, stored, or shown

Adding a provider: implement the small fetch/parse block in `runAi` branch + add to `providerStatus`; the analysis engine and UI need no changes.
