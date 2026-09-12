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
6. Healthchecks: `/api/health` (process+TTT+backfill) and `/api/system/status` (full).
7. Rate considerations: the TTT budget is per-IP; a VPS IP is independent and must keep `TTT_RATE_PER_MIN` sane (24 default).
