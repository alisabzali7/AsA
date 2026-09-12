# AsA — Project Manifest

**Commit:** `c29fc81` · **Generated:** 2026-09-11 10:37 UTC
**Source:** 6.76 MB (273 files) · **Tests:** 389/389

## Structure

```
knowledge/raw/        SOURCE OF TRUTH — the 5-file corpus (immutable, tracked)
knowledge/canonical/  canonical knowledge pack (deterministic ingest input)
src/                  application (app/, lib/, components/, db/)
tests/                19 suites + replay/live fixtures
scripts/              ingest · mine · validate · audit · handoff · probes
docs/                 architecture · deployment · audit · brain · ttt · archive
asa-data/             RUNTIME ONLY — not in the repo, not in the handoff
```

## Source of truth vs generated

| Kind | Path | Rebuildable |
|---|---|---|
| SOURCE | `knowledge/`, `src/`, `tests/`, `scripts/`, `docs/`, configs | no |
| GENERATED | `asa-data/*.db`, `.next/`, `node_modules/`, `*.tsbuildinfo`, `.config/` | **yes** |

## Rebuild from a clean checkout

```bash
npm ci                  # 452 packages
npm run brain:ingest    # knowledge/raw -> brain.db (9,398 fragments)
npm run brain:mine      # narrative mining -> 8,591 atoms
npm run brain:validate  # OOS / walk-forward -> experiments table
npm run build && npm start
curl "$HOST/api/market/history?symbol=BTCUSDT&tf=1h&sync=full&limit=1"
```

## Environment variables (NAMES ONLY — no values shipped)

`TTT_BASE_URL` `TTT_API_KEY` `TTT_API_SECRET` · `ASA_DB_PATH` `ASA_BRAIN_DB_PATH`
`ASA_HISTORY_DB_PATH` `ASA_CORPUS_DIR` · `ASA_API_TOKEN` `ASA_ALLOW_UNAUTHENTICATED`
`ASA_RISK_POLICY_ID` `ASA_SCORE_THRESHOLD` `ASA_RISK_ACCOUNT_EQUITY`
`ASA_RISK_PER_TRADE_PCT` `ASA_RISK_MAX_LEVERAGE` · `AI_PROVIDER` `AI_BASE_URL`
`AI_API_KEY` `AI_MODEL` `OPENAI_API_KEY` · `TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID`
`TELEGRAM_DRY_RUN` · `NEWS_RSS_URL` `NEWS_POLL_MIN` · `ASA_GIT_COMMIT` `ASA_BUILD_ID`

Rotate TTT, AI and Telegram credentials before deploying.

## Current inventory

Markets **63** (source `ttt-dynamic`) · live strategies **0**
(none has passed the OOS gate) · TONUSDT permanently excluded ·
legacy 48 retained only as `LEGACY_48_REGRESSION_SET`.

## Open issues

See `FINAL_STATUS.md` → "Known issues".
