# Jackdaw split — implementation audit handover

**Mission.** The frontend/brain repo split (P0 → P4) was designed and executed
across 2026-08-13/14, mostly in two sessions. Audit the implementation against
the INTENT below and report: what deviates, what silently regressed, what was
claimed but never verified. The full narrative lives in
`docs/plans/jackdaw-repo-split.md` (phases, decisions, lessons),
`docs/plans/brain-core-profile.md` (P4), and dev-brain page
`0853dd11-bac0-43c9-be0e-635578cfa1ed` + task `c978b023`.

## The intent being audited against

1. **mantle is the engine/brain, jackdaw is the product/frontend.** Internal
   `@mantle/*` names, `MANTLE_*` env, `mantle_*` containers are deliberate and
   stay. jackdaw = github.com/crossworks-engineering/jackdaw.
2. **Dependency direction is one-way**: mantle → npm (`@crossworks/*`) →
   jackdaw. Nothing in mantle may depend on jackdaw. Ever.
3. **The wire contract is published**: client-types (types + zero-dep contract
   modules), content-core (browser-safe content logic), voice-client
   (catalogs/providers), share-ui (share/docs surface + the FULL theme
   system), app-build. share-ui may import only client-types + content-core;
   the other three import no @mantle sibling at all. Enforced by eslint.
4. **The server owns everything it renders**: /s share pages, docs/appearance
   surfaces, avatars, fonts, and the theme generator — so headless brains and
   MCP agents get the complete brand from mantle alone.
5. **Fleet compatibility is sacred**: image name `mantle-client` kept; deploy
   bundle still ships `docker-compose.client.yml`; a bare
   `docker compose up -d` on an existing box behaves exactly as before the
   split and before the P4 core shape.
6. **Compatibility across repos is the contractVersion handshake**
   (`GET /api/version`), not tag lockstep. (Client-side enforcement is P3,
   deliberately not built yet.)

## Deliberate decisions — do NOT flag these as defects

- Contract package kept the name `@mantle/client-types` (no rename to
  `@mantle/contract`).
- jackdaw keeps `@mantle/*` import names everywhere; pnpm `npm:` aliases +
  `pnpm.overrides` map them to `@crossworks/*@<pin>`. Zero-churn cut by design.
- Theme generator lives in mantle/share-ui — this REVERSED an early plan line
  ("themes move to jackdaw"); Jason decided reversal explicitly.
- The e2e suite moved wholesale to jackdaw (it may not currently run there —
  that is a known follow-up, assess but don't treat as a surprise).
- Docker image `mantle-client` built by jackdaw CI on jackdaw's own version
  stream (v0.1.0, `latest`); rename is a P5 decision, not made.
- `docker-compose.core.yml` is an override file gating browser + the six
  channel workers behind a `full` profile; `install.sh --core` persists
  absolute-path `COMPOSE_FILE`; `--helpers` re-adds tika + browser.

## Known-open items — verify they are still the ONLY gaps, don't re-discover

- P3: client-side contractVersion comparison + banner (server half shipped).
- jackdaw tooling: no bump/merge scripts, no CI verify (typecheck/lint/test)
  workflow; release build uses QEMU (slow) instead of native arm runners.
- mantle-side test asserting `server/web/public/fonts` matches the
  client-types `display-fonts` registry (the old two-app byte-parity test
  retired at the cut; jackdaw asserts only its own payload now).
- publish-contract.yml header comment still names three packages (five
  publish) — cosmetic.
- P4 live validation on a small box (RSS measurement vs the 4 GB claim).
- jackdaw's eslint.config.mjs / vitest.config.ts still carry inert
  mantle-specific blocks and globs — cleanup, not correctness.
- ~/Projects/jackdaw clone + old worktree teardown (housekeeping).

## Audit areas, highest value first

### A. Runtime truth (nothing here was browser-verified during the split)
All split-session proof was typecheck/tests/builds. Verify against a REAL
brain (dev box, or bring one up):
- /s share links for each kind: page, note, table (interactive island),
  formula (+ live calculator island), event, file, draw, app (mini-app
  sandbox iframe), folder. Styles, themes, fonts, dark mode must all render
  (share-runtime bundle + share-ui SSR).
- /print PDF export; docs/help pages; the avatar API route.
- `GET /api/version` returns `contractVersion: 1`.
- jackdaw owner UI against that brain (`MANTLE_SERVER_ORIGIN` detached mode):
  login, pages editor, tables grid, formulas detail (moved type imports),
  events, inbox/accounts screens (redacted-account DTOs — ISO-string dates vs
  the old Date-typed lies: check date rendering on accounts/sync screens),
  team reader (share presenters from the published package), appearance
  settings (themes/fonts from @crossworks/share-ui), debug screens
  (metrics/journey/studio — ~70 moved view DTOs).

### B. Contract surface correctness
- For each of the five npm packages at the published pin: unpack the tarball
  (`npm pack`), check the name rename applied, `src/` present, and that every
  `@mantle/*` name in its `dependencies` is covered by jackdaw's overrides
  (app-build → share-ui; share-ui → client-types + content-core).
- Publish cadence policy: packages published at 0.230.43; mantle main has
  moved on (unpushed releases). Confirm the intended policy holds: publishing
  happens on pushed v* tags only, jackdaw bumps pins deliberately, and the
  publish workflow is verified working from CI (rerun on v0.230.43 fails
  ONLY with "cannot publish over", never OTP/auth).
- Drift tripwires actually trip: EXCALIDRAW_ENGINE (test in each repo),
  key-set guards for PublicEmailAccount/SyncRun/PublicMsAccount,
  `satisfies` on TASK_STATUSES/TASK_PRIORITIES, kit.test.ts protocol mirror,
  themes drift test (`themes:check`), the P4 compose invariants test.
  Technique: temporarily break each one locally and confirm the suite fails.
- Boundary lint is live, not decorative: add a `@mantle/db` import to a
  client-tier file in jackdaw and to packages/share-ui in mantle; both must
  error. Confirm `@server/*` is banned in jackdaw.

### C. Repo hygiene (both sides)
- mantle: zero tracked files under client/, packages/web-ui, e2e, brand;
  no non-comment `@mantle/web-ui` or `@server/` references; Dockerfile,
  release.yml, bump-version.mjs, merge-branch.sh, eslint, vitest configs all
  pruned coherently; `pnpm verify` green.
- jackdaw: full verify green from a CLEAN clone (install from npm only);
  history spot-checks (`git log --follow` on a few moved files);
  transpilePackages lists both name sets; app-runtime prebuild runs via tsx.
- Cross-repo docs: grep both repos' docs/ for paths that no longer exist
  (packages/web-ui/..., client/web/... in mantle docs; packages/share-ui/...,
  server/... in jackdaw docs). db-less-dev.md moved to jackdaw — confirm
  nothing in mantle still points at the deleted copy.

### D. Deploy posture
- Deploy bundle (release.yml "Assemble deploy bundle" step + install.sh
  fetch list): contains docker-compose.yml, docker-compose.client.yml,
  docker-compose.core.yml; bootstrap + updater paths agree with P4's
  COMPOSE_FILE mechanics (absolute paths).
- Back-compat proof: `docker compose config` on a simulated EXISTING box .env
  (no COMPOSE_FILE, no profiles) must produce the same service set as before
  the split (invariants test covers this — confirm it actually asserts the
  full default service list, not a subset).
- The `latest` client-tag posture: existing boxes updating today pull
  jackdaw-built `mantle-client:latest` against a possibly older server. Until
  P3 lands, nothing warns on mismatch. Assess the realistic blast radius and
  whether MANTLE_CLIENT_IMAGE_TAG should be pinned in fleet .envs NOW as an
  interim guard — this is a recommendation to make, not a decision taken.

### E. The share of the split nobody watched
Adversarial sweep for anything the split sessions may have missed: files that
reference moved modules through unusual paths (raw strings, dynamic imports,
scripts, compose commands, .github workflows, docs code fences), server code
that silently depended on client/web's public/ assets, tsconfig path aliases
in either repo that resolve outside the repo, and any test that became
vacuous (asserts against a list that is now empty, scans a directory that no
longer exists but swallows ENOENT).

## Output expected

A findings report ranked by severity, each finding with concrete evidence
(file:line / command output) and a proposed fix; classify every item as
DEFECT / KNOWN-FOLLOW-UP (matches the list above) / COSMETIC. Land fixes for
clear-cut small defects in the same session (worktree + merge-branch.sh as
usual); bigger ones become dev-brain tasks. Write the report to
`docs/plans/split-audit-report.md`, append the summary to dev-brain page
`0853dd11-bac0-43c9-be0e-635578cfa1ed` (commit the page), and update task
`c978b023` — via the `bdcda805…` MCP connector (verify it is the dev brain).

## Rules of the road

- Fresh worktree (`scripts/new-worktree.sh split-audit`); merge via
  `scripts/merge-branch.sh`; push only when asked.
- jackdaw work: clone to `~/Projects/jackdaw` if not present (do NOT reuse
  session scratchpads).
- Repo is public — no hostnames/IPs/client names in commits or docs.
- Never run compose from a worktree; the dev stack belongs to the original
  clone. Deploys/pushes to fleet boxes need Jason's confirmation.
