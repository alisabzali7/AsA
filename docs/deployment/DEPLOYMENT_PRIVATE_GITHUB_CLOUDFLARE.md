# AsA — Private GitHub + Cloudflare Deployment

**Scope:** private source, protected preview, private backend. No secrets, no
Brain corpus, and no SQLite database ever leaves the server.

> **A private GitHub repo does NOT make a Cloudflare preview private.**
> They are unrelated controls. Repository visibility governs *source access*;
> Cloudflare Access governs *URL access*. Both must be configured.

---

## 1. Architecture

```
PRIVATE GITHUB REPO            (source only — no runtime data, no secrets)
        │  push
        ▼
CLOUDFLARE PAGES               (frontend build)
        │  protected by
        ▼
CLOUDFLARE ACCESS              (email/OTP or IdP; blocks the public preview URL)
        │  authenticated fetch (relative /api/*)
        ▼
PRIVATE BACKEND                (Node.js — Next.js server, better-sqlite3)
        │  GET/HEAD only
        ▼
TTT  https://apiv2.thetruetrade.io
```

**Why the backend cannot be Pages/Workers:** AsA uses `better-sqlite3`, a native
module with a persistent filesystem (`brain.db`, `history.db`, `asa.db`).
Cloudflare Workers have no native modules and no persistent local FS. Do **not**
attempt to port the backend to Workers — host it on a Node-capable service
(Fly.io, Railway, Render, a VPS, or a container).

## 2. Private GitHub repository

```bash
git init                              # already initialised
git remote add origin git@github.com:<you>/asa.git
git push -u origin master
git push origin --tags                # backend-freeze-v1, market-data-freeze-v1
```

Repository settings:
- **Visibility: Private.**
- Branch protection on `master`: require PR, require status checks.
- Enable secret scanning and push protection.
- Add **no** repository secrets that the frontend build could echo into HTML.

Confirm before the first push:

```bash
git ls-files | grep -E '\.env|\.db$|asa-data/' || echo "clean"
```

## 3. What must never be committed or deployed to the edge

| Never | Where it belongs |
|---|---|
| `.env.local`, any credential | server environment variables |
| `asa-data/*.db`, `-wal`, `-shm` | server volume (rebuildable) |
| TTT key/secret, AI key, Telegram token | server only |
| `knowledge/raw/*` (the corpus) | server only — never in the client bundle |
| `.git/` | not inside handoff ZIPs |

`knowledge/` **is** tracked in the private repo (it is source-of-truth), but it
must never be imported by client-side code. The Brain is reached only through
`/api/brain/*`.

## 4. Cloudflare Pages

Build settings: build command `npm run build`, Node 20.
Set **only** public values as Pages environment variables. `NEXT_PUBLIC_*` is
visible in the browser — never place a credential there.

Recommended: the frontend calls **relative** `/api/*` paths and Cloudflare
proxies them to the private backend origin, so the backend URL is never in the
client bundle.

## 5. Cloudflare Access (this is what makes the preview private)

1. Zero Trust → Access → Applications → **Add a self-hosted application**.
2. Application domain: your Pages domain **and** `*.pages.dev` preview subdomains.
3. Policy: *Allow* → include your email address(es) or an IdP group.
4. Session duration: 24h or shorter.
5. Verify in a private window that an unauthenticated visit is challenged.

Also protect the backend origin so it cannot be reached directly:
- put the backend behind Cloudflare Tunnel (`cloudflared`), **or**
- allow-list Cloudflare egress IPs at the host firewall, **or**
- require a shared `x-asa-token` on every request (already enforced for
  mutations, and it fails closed in production).

## 6. Backend hardening checklist

- `ASA_API_TOKEN` **must** be set in production — mutations return **503**
  without it (fail-closed, `validateSecurityConfig()`).
- CORS: allow only the Pages origin; do not use `*`.
- Rate limiting at the Cloudflare edge on `/api/*`.
- TTT host allow-list is enforced in code; there is no fallback exchange.
- No-execution invariant: the TTT transport accepts `GET`/`HEAD` only.

## 7. Environment variables (NAMES ONLY — never commit values)

**Server (private):** `TTT_BASE_URL` `TTT_API_KEY` `TTT_API_SECRET`
`ASA_DB_PATH` `ASA_BRAIN_DB_PATH` `ASA_HISTORY_DB_PATH` `ASA_CORPUS_DIR`
`ASA_API_TOKEN` `ASA_RISK_POLICY_ID` `ASA_SCORE_THRESHOLD`
`ASA_RISK_ACCOUNT_EQUITY` `ASA_RISK_PER_TRADE_PCT` `ASA_RISK_MAX_LEVERAGE`
`AI_PROVIDER` `AI_BASE_URL` `AI_API_KEY` `AI_MODEL` `OPENAI_API_KEY`
`TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID` `TELEGRAM_DRY_RUN` `NEWS_RSS_URL`
`NEWS_POLL_MIN` `ASA_GIT_COMMIT` `ASA_BUILD_ID` `ASA_ALLOW_UNAUTHENTICATED`

**Edge/frontend:** none that are secret.

## 8. First deployment — rebuild runtime state

Runtime databases are intentionally absent from the repo. On the server:

```bash
npm ci
npm run brain:ingest     # corpus -> brain.db (9,398 fragments)
npm run brain:mine       # narrative mining -> atoms/components/candidates
npm run brain:audit      # audit + machine-readable status
npm run build
npm start
# then warm history (walks to the TTT boundary, no fixed-N ceiling):
curl "$HOST/api/market/history?symbol=BTCUSDT&tf=1h&sync=full&limit=1"
```

## 9. Verify the deployment is actually private

```bash
curl -sI https://<preview>.pages.dev | head -1   # expect an Access challenge
curl -s  https://<backend>/api/system/status     # expect blocked or 401/503
curl -s https://<preview>.pages.dev/_next/static/... | grep -c "TTT_API"  # expect 0
```
