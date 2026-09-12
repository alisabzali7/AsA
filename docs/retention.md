# Data Retention Guide

Defaults:
- News/fundamental: rolling 30 days minimum (`RETENTION_NEWS_DAYS`). The scheduled job runs every 30 minutes (first run ~45s after boot), deletes ONLY rows older than the window, writes an auditable `asa_retention_runs` row (table, deleted count, cutoff, ok/error) and surfaces in System → Retention jobs.
- Candle series: in-memory, bounded to backfill targets (15M 700 / 1H 800 / 4H 900 + on-demand TFs); restart re-backfills from TTT (durable history intentionally not duplicated locally).
- Trade tape: in-memory (last ~50 trades for the focus symbol), TTT is the retention layer.
- OI snapshots: in-memory ring (≈1/min × 90 per symbol) — sufficient for 60m Δ/velocity, labeled DERIVED.
- Opportunities/signals/journal/AI audit/backtest jobs/outbox: durable, no deletion policy (keep-as-long-as-practical until an explicit policy says otherwise).
- Funding observations: durable (`asa_funding_observations`), no deletion policy.

All deletion jobs are idempotent, observable and auditable; no row is ever removed while inside its window.
