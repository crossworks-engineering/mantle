# Jackdaw split: implementation audit report

Audit of the P0→P4 repo split (per `split-audit-handover.md`), run 2026-08-14
at mantle v0.230.48 and jackdaw `main` (fresh clone). All five areas covered:
A runtime truth, B contract surface, C repo hygiene, D deploy posture, E
adversarial sweep. Every drift tripwire was empirically broken and confirmed
to trip; runtime was verified in a real browser against a real brain (a local
copy of the dev brain), which the split sessions never did.

**Verdict: the split is structurally sound.** Dependency direction holds, the
published packages are correct, the fleet back-compat contract holds (proven
by rendering `docker compose config` against pre-split tags; byte-identical
service sets), and the whole server-owned render surface (shares, islands,
print/PDF, fonts, avatars) plus the jackdaw owner UI work against a live
post-split brain. The defects found were all peripheral: a red CI job left
behind, a formatting break in `pnpm verify`, and stale references; every
clear-cut one is fixed in this branch.

## Fixes landed in this branch

| ID | Was | Fix |
|----|-----|-----|
| E1 (HIGH) | `build-check.yml` still ran the moved e2e suite, **mantle CI red on every push to main since the split** (runs 31745360824 → 31747511424) | e2e job + `e2e:split` root script removed |
| C1 (HIGH) | `pnpm verify` red at v0.230.48: prettier failure in `packages/content/src/invariants.test.ts` (introduced by dfefe0bb) | reformatted; verify's format gate green again |
| B1/D1 (MED) | `invariants.test.ts` did NOT pin the default compose service set: gating `postgres` behind a profile passed silently, the exact hazard the P4 docs claim the test guards | two new assertions: the 22-name profile-less default set of `docker-compose.yml` is pinned, and `docker-compose.core.yml`'s gate set is pinned to tika/browser + the six channel workers. Both proven to trip |
| E2 (MED) | Dockerfile deps stage missing `content-core`, `share-ui`, `voice-client` manifests; its own sync-check comment failed and cited dead trees | three COPY lines added; check command fixed; sync check passes |
| E3 (LOW) | `scripts/fonts-import.mjs` wrote into the deleted `client/web` (hard ENOENT on next real run) | `APPS = ['server/web']`, comment updated |
| E4 (LOW) | `pnpm-workspace.yaml` carried literal `electron: set this to true or false` placeholder junk from the cut commit | deleted |
| D2/D3 (COSMETIC) | updater.sh + install.sh comments still claimed client/server tag lockstep | rewritten to describe the MANTLE_CLIENT_IMAGE_TAG stream |
| D4 (COSMETIC) | `MANTLE_CLIENT_IMAGE_TAG` documented nowhere operator-facing | added to `.env.prod.example` + `docs/deploy.md` update snippet |
| C5 (COSMETIC) | `docs/themes.md`/`docs/scripts.md` pointed at `packages/web-ui` for the theme generator (it lives in `packages/share-ui`); `docs/versioning.md` claimed the bump touches deleted client manifests; two live links to the deleted `db-less-dev.md` | paths corrected; links now point at the jackdaw copy |

## A. Runtime truth: verified live (the split's untested half)

Post-split server (v0.230.48, `server/web` dev) against a real brain
(local copy: Postgres + MinIO + browser sidecar), plus the jackdaw owner UI
(fresh clone, packages from npm) detached against it via
`MANTLE_SERVER_ORIGIN`. All checks in a real browser unless noted.

- `GET /api/version` → `{"version":"0.230.48","contractVersion":1}` ✅
- **All nine /s share kinds render**: page (theme `darkmatter`, outline,
  owner fonts via inlined @font-face → `/fonts/library/*.woff2` all 200),
  note, table (interactive island; rows stream via `/s/<t>/rows`), formula
  (KaTeX + live calculator island: computed a discharge-rate result that
  matches a hand calculation via `/s/<t>/evaluate`), event, file (image
  preview streamed from MinIO), draw (excalidraw scene + fonts), folder,
  app (page + `/bundle` + runtime manifest serve; see the sandbox note
  below). Team-gate screens render styled. Zero asset 404s. ✅
- **share-runtime bundle**: styles.css / islands.js / katex (+fonts) all
  served by server/web's own generated `public/`, self-sufficient. ✅
- `/print/pages/<id>` renders (session-gated), and
  `/api/export/<id>?format=pdf` produced a real 271 KB `%PDF` through the
  headless-chromium sidecar; docx export also works. ✅
- `/api/help/<topic>` serves the on-disk guide topics; agent avatar route
  server-renders SVG via `@mantle/share-ui/avatar` (404 `no_avatar`
  fallback confirmed intentional). ✅
- **jackdaw owner UI against the post-split brain**: shell + auth, Pages
  (92-page list, rich doc render), Tables (grid, sheet tabs, dates render
  correctly), Formulas detail (moved type imports fine), Events, accounts
  screen (empty state; this brain has no email accounts, so the
  ISO-string date rendering on sync rows could not be exercised; see
  follow-ups), Appearance (43 themes + font pickers + 34 avatar styles
  from the published packages), Studio (DAG canvas, composed prompt,
  history), debug/journey + overview (moved view DTOs render), Team gate.
  All API traffic 200 over CORS. ✅
- **Dark mode**: share pages render the share owner's theme regardless of
  `prefers-color-scheme`; compared against the pre-split production
  server: identical behavior, so not a regression. The owner UI's
  light/dark/system mode switch works.

**Pre-existing observations (NOT split regressions; both reproduce
identically on a v0.230.27 control server run against the same brain):**

1. **Mini-app share sandbox stalls at "Loading…"** after `/bundle` and
   `/app-runtime/manifest.json` load (200): the sandboxed srcdoc iframe
   never fetches its import-map modules. Reproduced in two different
   browsers, on post-split AND pre-split servers. Needs a check on a
   production box (may be dev-server-specific); if it reproduces there it
   is a real bug, but it is not the split's.
2. **Detached-dev auth stand-in 500s instead of 401s**: unauthenticated
   API hits in dev's detached mode pass an undefined user into queries
   (`params: [undefined, …]`, postgres `UNDEFINED_VALUE`). Cosmetic noise
   on the login screen; dev-only code path.

## B. Contract surface: correct; every tripwire trips

- Five tarballs at `@crossworks/*@0.230.43`: rename applied, `src/`
  shipped, dependency graph exactly as designed (app-build→share-ui;
  share-ui→client-types+content-core; other three zero @mantle deps).
  Every `@mantle/*` dep is double-covered (self-alias in the tarball +
  jackdaw `pnpm.overrides` all pinned 0.230.43).
- Publish cadence: `publish-contract.yml` fires on pushed `v*` tags only;
  CI run for v0.230.43 fails ONLY with "cannot publish over previously
  published versions" (the v0.230.41 run shows the historical OTP error,
  since fixed); the 2FA-bypass token is proven working from CI.
- Tripwires, each broken locally, each FAILED as designed, each restored:
  EXCALIDRAW_ENGINE (both repos), the three DTO key-set guards
  (PublicEmailAccount / SyncRun / PublicMsAccount), the
  TASK_STATUSES/TASK_PRIORITIES `satisfies` guards, the app-bridge kit-to-protocol
  mirror (mantle `kit.test.ts` + jackdaw `protocol.test.ts`
  against the published module), themes drift (`themes:check` AND the CI
  vitest `theme-generator.test.ts`, no gap), compose invariants (now
  hardened, see B1/D1 above).
- Boundary lint is live in both repos: `@mantle/db` into mantle share-ui
  errors; `@mantle/db` (even type-only) and `@server/*` into jackdaw
  client tier both error.
- New COSMETIC: all five tarballs ship a stray `tsconfig.tsbuildinfo`;
  exclude before the next publish.

## C. Repo hygiene: green after the fixes above

- mantle: zero tracked files under client/ web-ui/ e2e/ brand/; no live
  `@mantle/web-ui` / `@server/` references; full vitest suite 4023 passed.
  (`pnpm verify` was red on the C1 formatting break, fixed here.)
- jackdaw from the clean clone: `pnpm install --frozen-lockfile` resolves
  every `@mantle/*` from the npm registry (no workspace/file links),
  verify green in ~23 s (33 files / 294 tests), `next build` green.
  Per-file history reaches back pre-cut (`git log --follow` spot-checks).
  transpilePackages lists both name sets; app-runtime prebuild runs via
  tsx.
- Fonts: `server/web/public/fonts/library` is byte-identical
  (aggregate md5) to jackdaw's copy and matches the `display-fonts`
  registry exactly, 21 files + licences, no orphans; the missing guard
  test (known-open) currently has nothing to catch.

## D. Deploy posture: back-compat proven

- Deploy bundle (release.yml + bootstrap install.sh) ships all three
  composes + baselines; `install.sh --core` persists absolute-path
  `COMPOSE_FILE`; the updater refreshes all three release-owned composes
  and runs compose with `--project-directory`, verified working from
  cwd=/ in simulation.
- **Back-compat rendering proof**: bare `docker compose config` with an
  existing-box .env produces the SAME 22 services as pre-split tag
  v0.230.8 and as the pre-P4 commit (diff empty). Core shape = 14
  services; `helpers` adds exactly tika+browser; `full` restores all 22.
- `docker-compose.client.yml` pulls `mantle-client` pinned by
  `MANTLE_CLIENT_IMAGE_TAG:-latest`; the brain compose has no dependency
  on it (a broken client only 502s its own vhost).
- **Recommendation (decision for Jason, not taken)**: until P3's
  contractVersion banner ships, pin `MANTLE_CLIENT_IMAGE_TAG` (currently
  jackdaw v0.1.0) in each fleet box's stack `.env` and treat bumping it
  as part of the jackdaw release checklist. Skew cannot corrupt data (the
  client is stateless; the server validates writes), but a newer client
  against an older pinned server fails per-screen with no warning, and
  the boxes most at risk are exactly the ones that pinned the server for
  stability while every client update still pulls `latest`. The docs/env
  plumbing for the pin landed in this branch (D4).

## E. Adversarial sweep: clean beyond the fixed items

Swept: raw-string/dynamic references to moved trees, scripts, workflows,
compose commands, tsconfig aliases (nothing escapes either repo), vacuous
tests (ran the suspects; none pass on empty discovery; jackdaw's
dir-scanning font test scans its own real payload), contract package
source hygiene (no node-only APIs in browser packages, no relative import
escapes), server public/ self-sufficiency (app-runtime, share-runtime,
excalidraw assets all generated in-repo), CI caches/artifacts (none for
moved paths outside the deleted e2e job).

Remaining COSMETIC (not fixed here, none load-bearing):
`.gitignore`/`.dockerignore` dead client entries; `.env.example:8`
mentions the removed `pnpm dev:fe`; `readme-stats.mjs` client/e2e LOC
buckets always 0; `share-ui/themes/preview.html` + the generated
themes.css header still say web-ui (fixing the header means regenerating
themes.css; bundle with the next theme change); Dockerfile electron
comments; `docs/desktop.md` runnable command on a moved tree; ~70
dead-path mentions across 16 mantle feature docs (suggest one "now lives
in jackdaw" pass); `docs/ui-style-guide.md` duplicated byte-identical in
both repos (pick an owner).

## Known-open items: confirmed still the only gaps

All seven from the handover re-verified, nothing new behind them:
P3 client-side handshake; jackdaw tooling (no bump/merge/CI-verify;
sharpened: `docs/db-less-dev.md` in jackdaw instructs `pnpm dev:fe` +
`scripts/dev-frontend.sh`, neither of which exists in either repo now;
the working detached invocation is `MANTLE_SERVER_ORIGIN=<brain> pnpm -C
client/web dev`); the mantle-side fonts↔registry test (data currently
in parity, above); publish-contract header comment; P4 live-box
validation (RSS vs 4 GB); jackdaw's inert eslint/vitest blocks; the
`~/Projects/jackdaw` clone now exists (this audit created it).
