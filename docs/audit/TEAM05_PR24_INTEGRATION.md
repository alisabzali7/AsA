# PR #24 — main integration and merge validation

2026-09-27. User explicitly requested merging PR #24, superseding the earlier local-only/no-merge instruction. This document records validation before the GitHub merge; GitHub's PR timeline is authoritative for the eventual merge result.

## Inputs and preservation

- PR head before integration: `c6681bec72088d31c53530c66a3d3a87d15125ae`.
- Initial integration base: `8959ae328aa81721906503319f04bd4e7dcfff3c` (Team02 and frontend work).
- Latest base: `5f7154c92c5307e48d07158798d9ff3a2fea0fd6` (dependency PR #23, received during validation).
- Work remained on `arena/01a0dcbf-asa`. The restored dirty workspace's 104 files were byte-identical to the published PR head; a tar backup outside Git and a named stash preserved them before fast-forwarding to that head.
- No wholesale ours/theirs resolution: newer frontend architecture, chart snapshot validation, analysis/history changes and dependency updates are retained alongside Team05 protections.

## Conflict resolution

Eleven conflicted paths: `docs/api-contract.md`, `package-lock.json`, `src/app/api/charts/[id]/route.ts`, `src/app/{opportunities,settings,signals}/page.tsx`, `src/app/page.tsx`, `src/components/chrome.tsx`, and `src/lib/{market/engine,notify/telegram,pipeline/orchestrator}.ts`.

- **Chart/publication:** retain Team02 `DecisionSnapshot`, fingerprint verification, legacy disclosure and API snapshot headers; also retain Team05 exact ordered OHLCV SHA256, immutable signal lookup, mandatory chart+text, authoritative current risk/promotion/book/psychology and atomic lifecycle/outbox persistence. The LOCAL browser workflow asserts both `snapshot_check=VERIFIED` and `decision_dataset_verified=true`.
- **Delivery:** render only the verified/explicitly legacy decision window; preserve claim/lease ownership, once-per-cycle transport accounting, actual optional provider IDs and text-only retry. No provider exactly-once claim.
- **Health:** failed discovery without a snapshot reports UNAVAILABLE; retain newer source-staleness checks even when fetches succeed. Dashboard live count excludes stale rows, and its LIVE claim additionally requires the health verdict, not just a recent sweep.
- **Frontend:** retain the newer shell/navigation, resource-state classifier, authenticated mutation helper, persisted form hydration, toasts, RTL and technical charts. Restore Team05 signal detail/provenance links, terminal-linked opportunity state, admission-block reasons and the LOCAL evidence banner.
- **Browser boundary:** move only the canonical state vocabulary into `src/lib/domain/signal-states.ts`, re-exported by the server lifecycle module. The browser does not import the pipeline's expiry/transition code. The existing import-topology regression passes unchanged.
- **Integration fixes:** mobile topbar flex sizing/wrapping prevents overflow at 390px; Settings sends only edited fields, retaining blank input for server rejection instead of turning untouched `null` drafts into zero. A new API regression and actual UI/API round trip verify untouched preferences are preserved.
- **Dependencies:** lockfile preserves upstream resolutions plus the existing explicit esbuild dev dependency. Retain PR #23's Next 16.3.3, PostCSS 8.5.28 and Vitest 3.2.6. `next-env.d.ts` includes Next's generated root-params reference.
- **Documentation/scripts:** API additions are combined, and browser selectors match the new UI. Failed refresh now discloses cached age while withholding current delivery cards rather than presenting cached delivery as current.

## Final verification

| Check | Result |
|---|---|
| `npm test` with built real runtime reachable | **1,425 passed; 74 files; zero skipped; 145.13s** |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS, Next 16.3.3 |
| Browser state / real+LOCAL workflow / restart scripts | **8 + 15 + 2 = 25 checks PASS**, zero uncaught page errors |
| LOCAL loopback HTTP seed / fresh-process retry | 4 requests / 1 text-only request; zero external requests; unchanged 3 signals / 3 outbox rows |
| Browser chart verification | Team02 snapshot VERIFIED and Team05 exact dataset verified |
| UI → guarded API → DB → reload | Equity 12000; untouched risk preferences unchanged; offline mutation visibly refused |
| Narrow mobile Persian RTL | Real signals and LOCAL detail: no horizontal overflow; screenshots inspected |

Fresh evidence: [`docs/evidence/team05-pr24-merge`](../evidence/team05-pr24-merge/), including exact validation output, browser results, LOCAL scenario/retry, screenshots, npm audit and SHA-256 manifest. Initial failed checks are disclosed in `validation.txt`; they are not counted as final passes. Runtime DOM tests emit React `act()` warnings, though all assertions pass.

Native dependency setup initially failed because the sandbox could not download Node headers; rebuilding against installed `/usr/local` headers succeeded without disabling TLS verification. Browser tools/libraries and databases remain outside Git.

## Limits and release status

This is a code integration/merge, **not a deployment or production-readiness approval**. TTT egress, real Telegram acceptance/configuration, empirical promotion, measured currency losses, verified venue minimum constraints, complete originals and production authentication remain gates. Advisory-only/no execution remains invariant.

The current `npm audit` reports **two moderate development-tool findings** (`vitest` / `@vitest/mocker`), zero high/critical findings. No unrelated forced dependency upgrade was applied. This is not a claim of zero vulnerabilities.

The newer main contains `docs/roadmap/ASA_100_PERCENT_CONTRACT.md`, explicitly a **restored completion-unit form**, not the missing original denominator. Completion accounting remains UNKNOWN; it does not authorize a fabricated percentage.

`TEAM05_FINAL_CLOSURE.md`, its inventory and the `team05` / `team05-closure` manifests/screenshots retain their pre-integration historical meaning. Their source hashes describe that earlier changeset, not the merged source; do not treat their old UI snapshots, test counts or no-push/no-PR statements as current status. This integration record supersedes those claims for PR #24's merged code.
