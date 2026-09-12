> **HISTORICAL DOCUMENT.** Point-in-time snapshot from an earlier build phase,
> retained for provenance. Figures such as "48 symbols" describe the universe as
> it was THEN; the production universe is now discovered dynamically from TTT.
> For current truth see `FINAL_STATUS.md` / `MACHINE_READABLE_STATUS.json`.

# Credential Integration Report — 2026-09-06

First window in which real credentials (`uploads/api.txt`) were supplied. This
document records **what the credentials actually unlock**, measured against the
live providers. Every claim below is backed by a response captured in this
window; the machine-readable artifact is
[`docs/evidence/capability-probe-2026-09-06.json`](evidence/capability-probe-2026-09-06.json)
(reproduce with `npm run probe:caps`).

**Secrecy:** no secret value appears in this repo, in logs, in the UI, or in any
artifact. `.env.local` and `uploads/` are gitignored and untracked. The probe
reports only presence and length (`PRESENT len=40`), and the Telegram chat id is
masked (`523***15`). Nothing was echoed back to the operator.

**Execution safety is unchanged and absolute.** The credentials may carry a
trade scope; AsA still has no order, position, leverage, transfer, or withdraw
path. The TTT transport refuses any non-GET/HEAD method at the source, and the
capability probe deliberately lists **no** execution route.

---

## 1. TTT — verdict: `KEY_HEADER_REJECTED_AT_EDGE`

The most consequential finding of the window, and it is a negative result.

| Request | Headers | Status |
|---|---|---|
| `/futures/markets/stats` | none | **200** |
| `/futures/markets/stats` | full signed set | **403** |
| `/futures/markets/stats` | `X-API-Key` only | **403** |
| `/futures/markets/stats` | `X-Timestamp` only | **200** |
| `/futures/markets/stats` | `X-Signature` only | **200** |
| `/futures/markets/stats` | bogus `X-API-Key` | **403** |
| `/futures/account`, `/account/balance`, `/account/summary`, `/balance`, `/user/info` | full signed set | **403** (nginx HTML error page) |

Header isolation proves the rejection is triggered by the **presence of
`X-API-Key`**, not by a bad signature or a clock skew — a bogus key and the real
key produce the identical 403, and the timestamp/signature headers alone are
harmless. The response body is an nginx error page, i.e. the request is dropped
at the edge before reaching the API.

**Consequence — a live bug was found and fixed.** `src/lib/ttt/client.ts` built
its `AUTH` object from `TTT_HAS_KEY`, so simply populating `TTT_API_KEY` in the
environment would have signed **every** market-data request and turned the whole
market surface into 403s. Market data is now unconditionally unsigned:

```ts
const AUTH: { apiKey: string; apiSecret: string } | undefined = undefined;
export const TTT_KEYS_PRESENT_BUT_UNUSED = TTT_HAS_KEY;
```

Two regression tests in `tests/ttt-signer.test.ts` lock this invariant so a
future edit cannot silently reintroduce it.

**Authenticated read capability: none available.** No probed private read route
is reachable with these credentials, so no account/position/balance surface can
be built honestly. AsA continues to treat TTT as a public market-data source.

## 2. AI — verdict: `ONLINE`

- Gateway `/models` → **200 in 187 ms**, **313 models** offered.
- Configured model `gpt-4o-mini` is **present in the catalogue**.
- End-to-end `POST /api/ai/analyze` (BTCUSDT 15m, provider `openai`) → label
  **`OPENAI`**, `error: null`, latency **3 827 ms**, with a populated thesis,
  market story, invalidation, confluences, contradictions and evidence
  citations.

Health is now a real lifecycle rather than a boolean
(`NOT_CONFIGURED → CONNECTING → ONLINE / DEGRADED / ERROR`). `ONLINE` requires
both a reachable catalogue **and** the configured model being present in it; a
reachable provider missing the model reports `DEGRADED` with the reason, because
we do not assert a capability we have not observed.

Two honesty bugs were found by running the real provider and fixed:

1. **`neutral` was treated as a validation failure.** `coerceAiResponse`
   returned `null` for `direction: "neutral"`, so a perfectly successful call
   was mislabeled `HEURISTIC FALLBACK · LLM FAILED` with
   `error: "structured output failed validation"`. `neutral` is a valid stance
   (no setup asserted) and is now accepted.
2. **The prompt never stated the output schema.** `response_format:
   json_object` only guarantees *valid* JSON, not the right *shape* — the
   provider legitimately returned `{}` and the app reported an empty analysis as
   a success. The system prompt now specifies every required key, and an
   emptiness guard rejects a response with no summary, thesis, or evidence so it
   falls back to the labeled heuristic instead of presenting a hollow shell.

## 3. Telegram — verdict: `ONLINE`, delivery proven

- `getMe` → **200 in 465 ms**, bot **@alisabzalitrade_bot** (id ends 4864).
- Connected state is now **measured, never assumed**: `telegramState()` reports
  `CONNECTING` until a probe has actually run in this process, `ERROR` with the
  provider reason on failure, `DEGRADED` when reachable but `DRY_RUN=1`, and
  `ONLINE`/`CONNECTED` only after a successful `getMe`.
- New operator endpoint `GET|POST /api/system/notify` reports notifier state and
  outbox counts, and can enqueue a single advisory test row.

**Durability was proven, not asserted.** With `TELEGRAM_DRY_RUN=1` a test row
was enqueued and correctly left `QUEUED` (`sent: 0`, response text stating
plainly that nothing was sent). `TELEGRAM_DRY_RUN` was then set to `0` and a
second test issued: `attempted: 2, sent: 2` — the **backlogged dry-run row was
delivered along with the new one**, and the outbox settled at
`QUEUED 0 / SENT 2 / FAILED 0 / DEAD 0`. That is the durable-outbox contract
demonstrated end to end.

`TELEGRAM_DRY_RUN` has been returned to `1` (safe default) after the test. The
message body is advisory text only and carries the standing disclaimer: *AsA
never executes. Human decides.*

---

## Gates after these changes

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| `eslint .` | clean |
| `vitest` | **68/68** across 9 files (was 66; +2 credential-safety regressions) |
| `npm run build` | passes |
| `/api/system/status` | market **LIVE 48/48**, unsigned requests |

## Honest limitations

- No TTT authenticated read exists for these credentials, so there is still no
  account, balance, or position surface — and none is faked.
- `AI_OPENAI_MODEL` availability is verified against the catalogue only; a model
  listed in `/models` could still fail at call time, which surfaces as a labeled
  heuristic fallback rather than a silent success.
- The Telegram probe caches for 60 s and the AI probe for 15 s, so a provider
  that dies mid-interval is reported stale until the next probe.
- `POST /api/system/config` and the new `/api/system/notify` are open without a
  token unless `ASA_API_TOKEN` is set — pre-existing documented limitation,
  unchanged here.
