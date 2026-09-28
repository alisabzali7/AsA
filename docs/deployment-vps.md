# VPS Deployment (later — no redesign)

1. Same codebase. No database server to provision — storage is embedded SQLite
   (`better-sqlite3`). Set env (see .env.example + `ASA_PUBLIC_URL`, tokens) and
   mount a PERSISTENT VOLUME for `asa-data/`. Note: `better-sqlite3` is a native
   module needing a real filesystem, so the backend requires a Node host (not an
   edge runtime).
2. `npm ci && npm run build`, run `npm run start` under a supervisor (systemd Restart=always) or a single Docker process.
3. Reverse proxy (Caddy/nginx) with HTTPS; proxy `/` and `/api/*` including SSE (`/api/system/events?stream=1`): disable buffering (`proxy_buffering off`) and set long read timeouts.
4. Set `ASA_API_TOKEN` and pass the token into the browser settings only via header (never in URLs); restrict config writes further with an IP allowlist if desired.
5. Backups: snapshot the `asa-data/` volume (e.g. `sqlite3 asa.db ".backup"` or a
   volume snapshot). The outbox/journal/signals/news live in `asa.db` and survive
   restarts (verified acceptance gate). `brain.db` and `history.db` are
   REBUILDABLE — `npm run brain:ingest && npm run brain:mine`, then re-sync
   history from TTT — so backing them up is optional.
6. Healthchecks: `/api/system/health` (process+TTT+boot phase) and `/api/system/status` (full).
7. Rate considerations: the TTT budget is per-IP; a VPS IP is independent and must keep `TTT_RATE_PER_MIN` sane (24 default).


## Team 05 release/recovery gate

- Use the committed lockfile with `npm ci`; Node 22.22.3 was verified in this recovery. Native SQLite requires matching Node headers/compiler when a prebuilt binary is unavailable.
- Initialize the source-backed Brain (`npm run brain:ingest`) before interpreting strategy governance. Ingestion is not empirical validation or permission to publish. Do not bypass a non-live promotion result.
- The current application boots the market engine lazily through boot-aware API routes, including `GET /api/system/status`; `/api/system/health` alone does **not** initiate boot. A headless deployment must call status as part of its startup procedure. Verify `phase=running` and `live_scan.subscribed=true`, separately from market/provider health.
- Stop old application workers and back up the runtime SQLite DB before deploying. Schema v3 adds `telegram_outbox.attempt_claim`; v4 adds `signal_transitions`. Migrations are guarded, transactional and rerunnable; historical transitions are not backfilled. Run only the new worker version after migration; old workers do not implement the new lease/terminal guards.
- Publication now refuses old ad-hoc inputs without canonical setup/anchor identity, matching risk computation and chart dataset provenance. Rescan through the canonical pipeline rather than manually rewriting old signals.
- Never reset attempts, clear claims manually, mark SENT by hand, or requeue DEAD. Inspect `GET /api/signals/<id>` and `GET /api/system/notify`. Wait for a crashed worker's lease to expire. The next drain resumes persisted partial progress; ambiguous provider acceptance can duplicate a message because Telegram has no idempotency key.
- New signals require text **and** the exact decision chart. Missing/revised historical candles leave delivery incomplete; they do not change the signal's risk decision. Persist the history volume too when audit-grade historical chart reproducibility is required.
- Keep `TELEGRAM_DRY_RUN=1` until configuration and authorized provider tests have succeeded. No successful live Telegram delivery was verified in this sandbox. `SENT` is not `QUEUED`, `SENDING`, a claim, a dry-run, or an HTTP request attempt.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and the optional `scripts/verify-team05-ui.mjs` harness against the built server. See `docs/audit/TEAM05_REPORT.md` for evidence and limitations.

## Final closure release gates

See `docs/audit/TEAM05_FINAL_CLOSURE.md`: release readiness is **NOT_READY**, not implied by a successful build. Strict live risk now blocks incomplete venue constraints (including currently unavailable TTT minQty/minNotional) and configured loss ceilings without currency measurements. Do not invent values, substitute journal R, disable TLS verification or force strategy promotion to obtain a signal. Required source/policy/provider acceptance must be closed explicitly.

The optional `scripts/prepare-team05-local.mjs` compiles a **separate test-only** scenario with documented synthetic upstream seams and a local HTTP Telegram stub. It refuses a non-test destination or reseeding an existing database. Never point the production server at that database. `ASA_LOCAL_EVIDENCE=1` only displays a LOCAL TEST warning in the UI; it is not an admission bypass. Browser QA scripts are optional external-Playwright tools, not application dependencies.
