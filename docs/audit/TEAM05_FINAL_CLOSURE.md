# Team 05 — final autonomous closure

**2026-09-26 · local final changeset · advisory only**

This is a fresh closure investigation, not a reissue of the previous recovery report. The previous report is historical evidence. Final validation and artifact inventory are recorded below and in the linked package. **No production readiness or 100% completion is claimed.**

- [Visual system snapshot and screenshot gallery](../evidence/team05-closure/index.html)
- [Machine-readable runtime evidence](../evidence/team05-closure/runtime.json)
- [Validation record](../evidence/team05-closure/validation.txt)
- [Complete changed-file inventory](TEAM05_FINAL_FILES.md)
- [Evidence hashes](../evidence/team05-closure/manifest.json)

## BASELINE

VERIFIED: `/home/user/AsA`, branch `arena/01a0dcbf-asa`, HEAD `dcba86b5eb57dd65a5ba2a3f1005b6a7f217731e`. Existing recovery edits and untracked work were preserved. No reset, clean, branch switch, commit, push, PR, merge or release was performed.

The fresh pre-edit full suite **failed: 972 passed / 1 failed, 50 files, 100.83s**. The failure was `ttt-admission.test.ts`, assertion J: two consecutive scheduler snapshots reported budgets 999 and 999.02 because real time advanced and refilled tokens. It was not evidence of two scheduler instances. The repair injects a fixed scheduler clock while retaining exact equality and request/grant assertions. Initial targeted verification was 7 files / 86 tests PASS; initial typecheck, lint and production build PASS. Initial browser suite: 8 checks PASS. These baseline results are not substituted for final results.

Authority search: reread all seven arsenal skills; implementation contract, architecture/API/deployment documents, Team05 reports and source-fidelity material. Extracted the **entire 50-page archived Master Build Bible** and **20-page TTT reference**, rather than stopping at a PDF tool's page limit. Searched local paths/text, manifests, archives, canonical/raw knowledge, all local refs and unreachable blobs. The checkout is **shallow**; its one available commit is not proof of absent remote history. Read-only GitHub searches additionally covered **21 remote branch heads/trees and all 21 branch histories for the exact roadmap path**, plus releases. No matching roadmap commit or release asset was found. RAW_1/2/4 blobs were identical across the remote candidates and local files. Archived authority manifests reference absent originals/packages, not retrievable complete sources. The historical Bible/implementation contract are useful architectural authority, but not an authorized current 100% denominator.

## INTEGRATION_RECOVERY

The audited chain is:

`TTT market → closed-bar analysis → executable strategy/setup → opportunity/admission → current hard risk → immutable signal → chart/explanation → transactional outbox → atomic claim/lease → provider substeps → lifecycle/provenance → API → human UI`

The publisher now rechecks **stored decision identity/content, current promotion, server risk inputs, discovery/instrument constraints, the complete advisory book and current psychology inside the same IMMEDIATE transaction** as signal/outbox creation. Numeric PASS alone or caller-supplied READY is not authorization. No public endpoint directly publishes a caller-supplied opportunity. SQLite/runtime code is a trusted server boundary, not a cryptographic defense against an administrator rewriting the database.

| Boundary | Owner / canonical identity | Failure, retry and observability proof |
|---|---|---|
| Venue → store | TTT GET/HEAD transport; symbol/timeframe/native source | Unknown discovery stays unavailable; no alternate venue; admission budget tests, boot/recovery tests, real TLS diagnostics |
| Store → analysis | Closed bars and source-close timestamp | Forming/stale/mismatched series rejected; analysis/market-truth suite |
| Strategy → opportunity | Setup PASS, strategy/setup/anchor natural key | Promotion is distinct from executability; real promotion remains ineligible; synthetic seam isolated |
| Opportunity → risk | Server prefs/policy, active discovered instrument, complete constraints | Malformed prefs, stale discovery, missing constraints and required loss measurements fail closed |
| Risk → signal | Exact stored decision + re-evaluation under write lock | Unknown/forged/stale PASS refused; changing psychology/portfolio rechecked; final refusal persisted as REJECTED |
| Signal → chart | Immutable decision + ordered OHLCV SHA256, range/count/anchor | Revised/partial cache refused or refetched; no different/current dataset substitution |
| Signal → outbox | UNIQUE opportunity key; one transaction | One logical signal/outbox; insert conflict/busy rollback; no terminal resurrection |
| Outbox → provider | Atomic token/time lease + once-per-cycle attempt marker | Wrong/stale worker cannot write progress; crash recovery retains accepted substeps; five-cycle budget |
| Delivery → provenance | Stable link validated against signal/opportunity identity | Cross-linked or missing modern row is UNLINKED, not another signal's SENT |
| DB → API | Parse status, recorded transition history, current outbox | Corrupt JSON, cold expiry, unknown IDs, terminal-linked opportunity and exact aggregate counts tested |
| API → human | Polling state, detail view, independent health, RTL | Loading/error/offline/stale states, real API UI save/reload, no false SSE→market health |

### Fresh defects / structural repairs

| Finding and invariant | Repair and regression | Integration/recovery impact |
|---|---|---|
| Flaky scheduler identity assertion compared moving clock snapshots | Inject scheduler clock, preserve exact check | Stable test without weakening actual admission enforcement |
| Open book sampled only newest 500 signals | Complete active-row query; 501 newer terminal rows reproduction | Older active exposure cannot disappear behind UI pagination |
| Unknown active risk notional treated as zero | Book becomes unavailable; live gate refuses | No invented spare heat; operator repairs corrupt/incomplete evidence |
| Publication trusted stale upstream promotion/psychology/portfolio | Re-read/re-evaluate under publication transaction | Different workers cannot both spend the final portfolio slot |
| Default configured daily/period ceilings were skipped when currency loss was unknown | Live-only required-measurement guard | Default production publication is BLOCKED, not a fabricated unused budget |
| Missing/inactive/stale venue metadata and incomplete engine constraints could still produce live PASS | Discovery membership/READY check; complete finite constraints; no `unenforced` live PASS | Unsupported minimum quantity/notional remain unavailable and block live publication; no inferred values |
| Corrupt risk preferences could silently fall back | Raw persisted-value validation; atomic malformed config rejection | No permissive fallback from malformed server state |
| Provider acceptance IDs discarded | Persist actual optional photo/text IDs and local acceptance times with each progress write | IDs survive text-only retry; absent legacy/provider IDs stay UNKNOWN |
| Wrong outbox reference could borrow delivery state | Validate linked kind, opportunity and signal | Broken/corrupt/cross-linked lineage cannot claim SENT |
| Terminal signal left linked historical READY opportunity actionable; final refusal could remain READY | Expose linked signal state; suppress terminal actionability; persist final refusal | API/UI truth follows lifecycle without rewriting immutable signal history |
| PNG had no readable identity/level labels | Deterministic bitmap symbol/timeframe/side, level prices/epistemic kinds/off-scale/anchor labels | Detached image is identifiable; same evidence and exact dataset, no extra dependencies |
| Dashboard used SSE connectivity as health and showed unavailable board as empty | Read actual health; explicit unavailable/error/loading; count genuinely live rows | Connectivity never manufactures live market evidence |
| Detail/provenance was raw JSON only; mobile nav crowded view | Human-readable decision/delivery/history/source page; scrollable mobile nav; LTR technical JSON in RTL | Browser-inspected desktop/mobile, explicit legacy/unknown fields |
| Settings/journal network failures could reject silently; risk form reset to constants after reload | Visible failed mutation; persisted settings hydrate form | Real UI → guarded API → DB → reloaded UI; offline mutation proof |

Existing recovery invariants were also re-audited and rerun, including source-anchor expiry, immutable lifecycle, migrations v3/v4, mandatory image+text, temporal ownership, final-budget recovery, replay acknowledgement and startup subscription order. See the historical report for its original finding chronology; its older totals/verdict are not current closure evidence.

## OPPORTUNITY

VERIFIED: setup PASS remains necessary; high score/AI explanation is not a substitute. Unknown/derived/stale inputs cannot become live admission. Canonical identity includes symbol, timeframe, direction, setup and anchor. The stored opportunity must agree with the supplied publication decision, including serialized evidence, not merely its ID.

Final publication refusal is stored as REJECTED with the exact reason, and the scanner retains `publish_refused` telemetry rather than acknowledging an infrastructure refusal as a successful bar. A historical READY decision linked to an expired/closed/unknown-terminal signal is **not actionable**. `actionable` is a stored admission/freshness/lifecycle projection, **not** a newly evaluated risk certificate or execution permission.

## RISK

VERIFIED: `evaluateLiveRisk` is the shared scan/final-publication assembly. It requires current READY discovery and operational membership; active instrument metadata; valid measured constraints; finite direction-safe entry/stop/target/account/policy inputs; valid persisted overrides; and a non-disabled/non-invalid policy selection. Engine `unenforced` constraints cannot authorize live PASS. Stored reasons/numbers/unenforced accounting must match re-evaluation.

The complete advisory book is read inside the write transaction. No missing notional is coerced to zero. A separate-worker test starts with four active advisories under a five-position policy: two qualified candidates race; **one publishes, one is blocked**, leaving five active advisories and one new outbox row.

POLICY_BLOCKER: the actual journal records R-multiples, not account-currency daily/period loss. No conversion or fake zero was added. The default policy's specified loss limits therefore block real live publication. TTT's verified public contract does not expose minimum order quantity/notional; production ingestion leaves them unknown, and strict live risk blocks. Synthetic tests supply explicitly synthetic complete constraints/loss measurements. They are not provider facts or an implicit policy waiver.

## SIGNAL

VERIFIED: one canonical publication path; one opportunity → one immutable signal → one outbox. Signal activation, outbox linkage and transition audit are atomic. Activated identity/decision cannot be overwritten; terminal states never resurrect. Publication events are emitted after commit. Decision state remains separate from delivery state and human action.

There are **zero real-runtime signals/opportunities/outbox rows** in the final inspected runtime. The separate LOCAL instance contains three synthetic signals (two published, one expired), five opportunities (three admitted at decision time, two rejected), and three outbox rows. This is deliberate evidence, not production signal generation.

## TELEGRAM

VERIFIED locally: HTTP success **and** JSON `ok:true` are required; failed/non-JSON/provider-declined responses do not become SENT. New signals require both their immutable chart and full advisory text. A missing mandatory chart cannot become text-only SENT. Poison/oversized payloads are dead-lettered before transport. IDs returned by the provider are preserved; no ID is fabricated if absent.

The LOCAL harness runs the actual Telegram adapter against a real local HTTP server through an isolated fetch seam. Initial requests: photo accepted, text HTTP 502, then another signal's photo+text accepted. After process stop/reopen, the partial row sends **one text request and zero photo requests**, retains its original photo ID, and reaches SENT at two logical transport attempts. Runtime servers themselves remain dry-run/unconfigured; LOCAL stored SENT means local stub acceptance only.

BLOCKED live: no Telegram bot/chat configuration is present. Direct sandbox TLS to the public Telegram host also resets, but no authenticated bot request was attempted. This is not proof of provider acceptance or provider outage. No secrets were requested, generated as real credentials, printed or committed.

## IDEMPOTENCY

VERIFIED: unique opportunity key, plain INSERT (never replace), IMMEDIATE transaction, lifecycle-aware idempotent no-op, separate-worker single activation and single claim winner, and durable reopen tests. Distinct candidate workers serialize against current portfolio exposure.

The LOCAL restart drill preserved **3 signals / 3 outbox rows**; only delivery progress changed. Claims and final-budget recovery do not recreate opportunities/signals. **Provider delivery is at-least-once**, not exactly-once: acceptance followed by process death before the progress write can duplicate a substep. A regression explicitly preserves this ambiguity rather than hiding it.

## PROVENANCE

VERIFIED: modern signal↔opportunity↔outbox identity validation; immutable risk/explanation/source snapshot; recorded lifecycle transitions; accepted photo/text IDs and local acceptance times; exact ordered OHLCV SHA256/range/count. Historical charts can be inspected during discovery outage from verified persisted candles; this does not admit a new live market or switch venue.

Legacy history before audit capture and absent provider IDs remain UNKNOWN. `payload_status=PARSED` means an object was parsed, not complete historical lineage. The DB is not cryptographically tamper-proof. Full localized prose is retained in SVG/caption/structured evidence; the dependency-free PNG uses canonical ASCII identity/level labels.

## FRESHNESS

VERIFIED: one domain timeframe registry; new publication requires source freshness within two bars; advisory display/lifecycle expiry remains four bars. Future/non-finite/missing anchors and unknown timeframes fail closed. Row `updated_ms`, HTTP fetch time and a worker restart never refresh an old source anchor. Cold API reads persist expiry without requiring an engine timer. Stale discovery also prevents live risk PASS.

UI failed refresh preserves last received state with explicit stale/error labels, not a fresh confirmation. Browser offline state is separate from TTT unavailability and delivery state.

## FAILURE_RECOVERY

| Attack / failure | Outcome | Proof / recovery |
|---|---|---|
| Missing/block/unknown/forged/inconsistent risk, changed equity | PASS (refused) | signal publication and closure gate tests; no outbox |
| Missing stored decision, tampered explanation, unpromoted strategy | FIXED | final boundary regression; authoritative stored/current gates |
| Missing risk notional; active row behind 501 terminal records | FIXED | two fresh pre-fix failing reproductions, then passing regressions |
| Changed psychology/opposing exposure/final slot race | FIXED | current-gate tests and independent worker SQLite connections |
| Unsupported minimum constraints / unknown configured currency losses | BLOCKED safely | explicit live risk/admission refusal; no invented measurements |
| Terminal lifecycle/rescan and linked READY UI | FIXED | immutable terminal rows, persisted refusal, API `actionable:false` |
| Duplicate close/store event, first backfill, 1d strategy/restart catch-up | PASS | real engine/scanner tests with labeled upstream fixtures |
| SQLITE_BUSY, duplicate insert, legacy migration, reopen | PASS | rollback, v3/v4 migration/idempotency and recovery tests |
| Two consumers, future/expired claim, stale-owner write, final attempt crash | PASS | claim/lease suite, worker race and persistence tests |
| Photo accepted/text failed, text accepted/chart unavailable | PASS | resumes only missing substep; never prematurely SENT |
| HTTP 401/429/502, timeout, invalid JSON, `ok:false` | PASS locally | provider matrix in delivery regressions, no real Telegram claim |
| Accepted request followed by progress write loss | PARTIAL by design | documented at-least-once duplicate ambiguity, not exactly-once |
| Revised OHLCV / partial historical cache / mismatched identity | PASS | SHA256 validation, safe refetch/refusal, immutable API chart |
| Corrupt JSON / cross-linked outbox / invalid percent route ID | PASS | unavailable/UNLINKED/404 instead of invented state or decoding 500 |
| API settings malformed values / unauthorized mutation | FIXED / PASS | atomic 400; actual real-instance 503, LOCAL missing-token 401 |
| Browser loading/503/stale/offline/reload/RTL | PASS | separate browser artifacts, labeled interceptions and actual API workflows |

Recovery does not mean bypass: unavailable sources/measurements remain blocked. Mixed old/new workers are not a supported rollout; stop all workers, back up all SQLite files consistently, deploy together, verify migrations/integrity, then restart. Do not downgrade into old lease semantics. WAL `synchronous=NORMAL` is not a power-loss durability certification.

## RUNTIME

VERIFIED: built Next.js production servers bound to `0.0.0.0`, real instance port 3000 and isolated LOCAL TEST instance port 3001. Actual status/health/signals/opportunities/notifier/strategy/config routes were queried. Both database integrity checks returned `ok`; schema migrations 1–4 are present. Process restarts and fresh API reads were exercised.

Real runtime: engine booted, scanner subscribed, TTT universe `NETWORK_FAILURE`/0; health correctly `UNAVAILABLE`, not endless successful CONNECTING or SSE-derived LIVE. Seven executable strategy/setup entries (six distinct strategy IDs) are visible; **zero live eligible**. Telegram `NOT_CONFIGURED`, dry-run true. Real production mutation without configured token returns **503 fail-closed**; LOCAL tokenless mutation returns **401**.

Network diagnosis: DNS resolves; direct curl (including IPv4/TLS1.2) and Node fail before secure TLS establishment (`ECONNRESET` / curl 35). Separately, the web connector successfully read a public TTT catalog chunk from the canonical endpoint. Therefore the evidence supports an application-sandbox network-path blocker, **not a total TTT outage**. No TLS verification disabling, alternate exchange, pasted market snapshot or fabricated continuous feed was used. Public-read connector reachability is not runtime recovery. Periodic same-provider discovery recovery remains supported and tested.

## TESTS

VERIFIED final commands:

| Check | Exact result |
|---|---|
| `npm test` | **51 files / 987 tests PASS**, 108.43s |
| Targeted 16-file Team05/transport/market/risk/chart matrix | **226 tests PASS**, 24.14s |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS |
| Browser state suite | 8 checks PASS |
| Real + LOCAL built-app browser suite | 15 checks PASS |
| Post-restart browser checks | 2 checks PASS (see restart artifact) |

The final full suite is 14 tests larger than the fresh 973-test baseline. Counts are observations, not completion percentages.

Test categories include publication/admission, engine/scanner timeframes/replay, risk arithmetic and malformed input, source freshness, immutable charts, claim/lease/partial-send/provider failures, SQL migration/rollback/reopen/concurrency, APIs, configuration and UI evidence. Synthetic seams are explicit: only named test promotion, synthetic market/complete constraints, synthetic account measurements and local/stub provider responses. Boundary-only tests do not prove empirical strategy validity. No CI run was claimed.

## BUILD

Final `npm run typecheck`, `npm run lint`, `npm run build` and `git diff --check` are recorded in `validation.txt`. The final production build includes `/signals/[id]`. External Playwright/Chromium/PDF tooling lives outside source dependencies; the existing exact esbuild development dependency/lockfile supports reproducible isolated worker and LOCAL harness compilation. No browser or provider runtime is falsely reported as a production dependency.

## BROWSER_VISUAL_QA

**25 browser checks** across three scripts: 8 state/failure checks, 15 real/LOCAL built-app checks, and 2 post-restart checks. The restart record and image are packaged separately from the pre-retry FAILED view; the two states are not conflated.

Actual real-runtime screenshots: dashboard with unavailable market, empty signals, empty opportunities, delivery/runtime system view, missing signal detail, mobile Persian RTL. Separate LOCAL screenshots: signal list, immutable risk/detail, photo-accepted/text-pending delivery, accepted delivery, expired lifecycle, explicit risk/unknown-loss blocks, immutable PNG, mobile detail RTL, persisted settings round trip, restarted text-only retry. Browser-intercepted loading/error/stale/offline scenarios carry a visible TEST ONLY banner and do not alter server data.

Visual inspection led to concrete fixes: dashboard truth, mobile navigation width, LTR technical JSON inside RTL, readable PNG identity/levels, and terminal opportunity actionability. No horizontal overflow at 390px in the exercised signal/detail views; no uncaught page errors in the recorded runs. This is not a full WCAG audit, full Persian translation or all-device certification.

## FINAL_SYSTEM_SNAPSHOT

[Open the human-auditable snapshot](../evidence/team05-closure/index.html). It separates **real unavailable runtime**, **verified local safety/integration**, and **synthetic provider/account/strategy evidence**, with linked screenshots, architecture, delivery steps and release gates.

The safe state is **NO TRADE / NO SIGNAL** when required evidence is incomplete. Publication is server-controlled and atomic; Telegram is a downstream advisory delivery mechanism; UI/operator actions cannot authorize execution. No order, broker, position mutation, futures execution or Telegram execution command was added.

## BLOCKERS

| ID / class / owner | Evidence and impact | Required closure, without bypass |
|---|---|---|
| E1 EXTERNAL_BLOCKER · runtime/network | Direct canonical TTT TLS reset; separate connector public read works | Restore supported sandbox/deployment egress; obtain fresh runtime discovery/stats/candles and repeat live chain |
| E2 EXTERNAL_BLOCKER · notifier/operator | No bot/chat configuration; no authenticated acceptance | Configure through approved secret storage, resolve network path, verify getMe + real photo/text acceptance and IDs; never paste credentials into chat |
| E3 EXTERNAL/GOVERNANCE · Strategy/Team03 | 7 executable entries, 0 live eligible | Real version-matched empirical/OOS/walk-forward and governance evidence; executable is not promoted |
| P1 POLICY/DATA_BLOCKER · Risk/governance | Journal lacks currency loss; default daily/period guards cannot be measured | Define/approve an authoritative measured loss source and period semantics; keep blocked meanwhile |
| P2 POLICY/PROVIDER_BLOCKER · Risk/market | Public TTT minimum quantity/notional absent | Verified constraint source or explicit reviewed contract change; strict live PASS remains unavailable, never infer limits |
| E4 SOURCE_BLOCKER · source custodian | RAW_1/2/4 truncated; all found branch copies identical | Supply verifiable complete originals; preserve current raw hashes/methodology until then |
| E5 CONTRACT_BLOCKER · acceptance authority | Exact roadmap absent in local/broad/remote searches | Supply authoritative current acceptance denominator or approved equivalent; no invented 100% accounting |
| E6 DEPLOYMENT_GATE · operator | Production mutation token absent; writes refuse 503 | Configure API auth/reverse proxy using secret storage before operator write workflows; no open production override added |

These are not hidden behind green tests. No release is approved while they remain open.

## UNKNOWN

Original omitted source content; authorized 100% denominator; real promoted-strategy outcomes; live account-loss measurements; missing venue minimum constraints; real Telegram message acceptance/human receipt; history predating lifecycle capture; missing legacy provider IDs; crash-point provider acceptance before durable progress; host/power-loss durability; complete accessibility/localization and production latency/SLO achievement. Local test elapsed times are measurements of checks, not performance targets met.

## DISTANCE_TO_100_PERCENT

**COMPLETION_ACCOUNTING = UNKNOWN. SOURCE_COMPLETENESS = BLOCKED.** No percentage is calculated from passing tests, file counts, executable strategy counts or available-text ingestion coverage.

| Acceptance area | Accounting |
|---|---|
| Local A valid advisory, B risk block, C partial retry, D worker race, E restart, F UI/API/DB/UI | Demonstrated with explicit LOCAL/SYNTHETIC seams and actual persistence/HTTP/browser |
| Final code/tests/build/runtime inspection | Verified within the recorded scope |
| Real live-provider full chain | Blocked / not demonstrated |
| Source completeness and full empirical promotion | Blocked |
| Contract-defined overall completion | Unknown denominator |

Stop rationale: the owned defects found in the audited Team05 safety/integration boundaries are repaired and regression-tested; no known P0/P1 bypass remains in that scope. Unavailable required evidence is now explicitly refused. Further live acceptance requires the listed external/policy/source authority, not a guessed implementation or fake success.

## FILES_CHANGED

The cumulative changeset includes preserved prior recovery work plus this closure's repairs, tests, optional LOCAL/browser scripts and documentation/evidence. [TEAM05_FINAL_FILES.md](TEAM05_FINAL_FILES.md) enumerates every changed/untracked deliverable with its purpose. Generated DBs, browser binaries, PDF extractions, remote source copies and bundles are kept outside the Git changeset. Original knowledge files are unchanged. No deletion of user work or repository metadata occurred.

## FINAL_EXECUTIVE_VERDICT

```text
MISSION_STATUS: PARTIAL
SAFETY_STATUS: PASS
INTEGRATION_STATUS: PASS
RUNTIME_STATUS: PARTIAL
TELEGRAM_STATUS: PARTIAL
PROVENANCE_STATUS: PASS
BROWSER_VISUAL_STATUS: PASS
TEST_STATUS: PASS
BUILD_STATUS: PASS
RELEASE_READINESS: NOT_READY
LIVE_EXTERNAL_VERIFICATION: PARTIAL
PR_CREATED: NO
PUSHED: NO
MERGED: NO
```

PASS for safety/integration/provenance/browser means the documented local implementation, attack and visual scope—not real-provider or empirical acceptance. The public TTT connector read is the limited external verification; the real application chain is not live-verified. **Deliverable: LOCAL FINAL CHANGESET + EVIDENCE PACKAGE. Do not release as a complete live advisory system until the blockers are closed.**
