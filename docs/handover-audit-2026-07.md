# Session handover — pre-Pinnacle audit (2026-07-16/17)

**Branch `feat/audit-fixes`** (worktree `.claude/worktrees/audit-fixes`), 7
commits on top of `7ff039cd` (v0.140.0). Typecheck clean, ESLint 0 errors,
Prettier clean, **2161 tests green**. **NOT merged, NOT pushed, NOT released** —
Jason decides. Full audit report: dev-brain page `754184b8` (shared link
`https://dev.crossworks.network/s/f8dZCX1_jLnRWqGV8qIFXQ`). Running log +
complete remaining list: dev-brain task `de19ce14` (tag `audit`). Overall
system rating from the audit: **8.0 / 10**.

A five-reviewer audit ran over the monorepo across infrastructure, performance,
code quality, correctness, and one further dimension tracked separately in the
roadmap task. This handover covers what landed and what's left, excluding the
items tracked in `de19ce14`.

## What this branch delivers (done)

| Commit                | Area                     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `732e3898`            | data-integrity / backups | `app-broker` anchors the `APP_DB_DIR` fallback to the monorepo root (kills the dev split-brain that produced the NATREF table-500s; parity with `tabledb/paths.ts`). Scheduled backups now snapshot per-app SQLite (`app-dbs`) beside `pg_dump` + `table-dbs`, with rotation + status counts; `docker-compose.yml` mounts `table-dbs` + `app-dbs` into `worker_events` (which runs the backup tick) so the snapshot passes see real files. Mini-app schema DDL wrapped in a transaction (no half-applied/bricked schema).                                                                                                                                                                                                                                                                                             |
| `732e3898`            | reliability              | `worker_push` gets the `unhandledRejection` keep-alive backstop the other workers already had; `markPushed` hardened so a transient DB blip can't kill the worker mid-batch. `docker-compose.yml` gets `json-file` log rotation (10m×3) on every long-running service (disk-fill outage guard).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `0bc290bf` `d885ddb0` | CI quality gate          | The repo shipped a `.prettierrc.json` but was never formatted to it (785 files drifted) and ESLint had **no config** and never ran in CI. Now: full Prettier reformat (mechanical), `eslint.config.mjs` flat config (`@eslint/js` + `typescript-eslint` recommended, syntactic; react-hooks/@next wired for `apps/web`), and `Lint` + `Format check` steps in `build-check.yml`. The gate immediately caught a latent bug — a `tabledb` test wrote `.toBeNull` (property access, never called → dead assertion); corrected to `.toBeUndefined()`.                                                                                                                                                                                                                                                                     |
| `8e93248d` `f1212499` | performance              | Entity resolution was seq-scanning the owner's entity set per query and, at ingest, per @-mention. Trigram fuzzy now uses `name % $q` so the trigram GIN prefilters; the exact-resolve alias branch switched from `q = any(aliases)` to the containment form `aliases @> array[q]` so the array GIN is actually used (**live-verified via EXPLAIN — the scalar form does not use the index**). Redundant per-mention duplicate-probe dropped (`reconcileEntity` returns `{entity, created}`). Migration `0121` adds a GIN on `entities.aliases` + a partial `entity_edges (owner_id, relation) WHERE valid_to IS NULL`. Dashboard: unbounded `embedding_cache count(*)` → planner `reltuples` estimate (no scan); `/api/dashboard` bundle memoized per-user 5s. All plans confirmed against the local dev DB (54323). |

## What's left

Ordered by value for the Pinnacle pitch. None of these are started.

### 1. Operational alerting (highest-value gap)

The notification channels (Telegram, email) exist, but **nothing pushes an
alert** when a scheduled backup fails, a worker goes unhealthy, or the disk
fills. An enterprise operator expects to be told, not to discover it on the
settings page. Also: automated backups default to `enabled: false` — flip them
on during onboarding.

- Wire backup-failure / staleness + worker-unhealthy + disk-pressure signals
  into the existing notification path.
- `packages/content/src/backup.ts` already records failure status; it just
  isn't surfaced anywhere active.

### 2. Backup + container hardening

- **Custom backup location footgun** (`backup.ts:84`): a location outside a
  mounted path is `mkdir -p`'d inside the container and reports `ok: true`, so
  every "successful" dump is destroyed on the next container recreate. Reject
  (or warn on) non-mounted paths.
- Pin `minio:latest` / `ollama:latest` to specific versions in
  `docker-compose.yml` (both are pulled by the update path; a breaking upstream
  release lands mid-update). Tika + tailscale are already pinned.
- Add cheap liveness probes to the `api` service + the seven workers (only
  `web` has a healthcheck today), and container memory limits sized to the
  documented minimum spec.

### 3. Page draft concurrency (now multi-person-reachable)

Page drafts have **no concurrency control** — `saveDraft` unconditionally
overwrites `draft_doc`, `commitPage` clears it unconditionally. Two autosaves
(desktop + phone, or a user + the Pages agent) interleave into a silent
last-write-wins lost update. Tables already solved this with a `draft_rev`
etag + a registry `SELECT … FOR UPDATE`; mirror that on pages
(`packages/content/src/pages.ts` `saveDraft` / `commitPage`). Higher priority
now that team-shares make pages multi-person.

### 4. Lint backlog burn-down, then ratchet

The gate ships green with **78 warnings** deliberately non-blocking: 61
`no-unused-vars` (real dead code — `noUnusedLocals` is off in tsconfig, so
ESLint is the only thing catching it), 13 `react-hooks/exhaustive-deps`
(vestigial suppressions worth re-triaging — each is a potential stale-closure
bug), 4 `no-explicit-any`. Burn these down, then flip the cleanup rules from
`warn` to `error` in `eslint.config.mjs` so CI blocks new drift. Follow-up:
add the type-aware rules (`no-floating-promises`, `no-misused-promises`) once
the base gate has settled.

### 5. Structural cleanup (code quality)

- **God-functions on hot paths:** `extractNode` (~1,285 lines,
  `apps/api/src/agent/extractor.ts`) does skip-gating → body load → chunk →
  embed → facts → entities in one function; and the Telegram turn pipeline in
  `apps/api/src/agent/runtime.ts` re-implements `assistant-runtime`'s
  `runTurn` (~1,000 lines of parallel orchestration → parity-drift risk every
  time one is fixed). Extract per-stage seams / route Telegram through the
  shared runtime.
- **Copy-paste with drift:** `str()`/`strArr()` coercion helpers duplicated 29×
  under `packages/tools/src`; `slugify` duplicated 10× across `apps/web` with
  behavioral divergence (tools/skills allow `_` + cap 64; files strip `_` no
  cap → the "same" normalization yields different slugs on different screens).
  Centralize each.

### 6. Sync-worker test coverage

The Microsoft and calendar sync workers mutate user data on a timer with almost
no test net (`packages/microsoft` 1 test file / 17 source; `packages/calendar`
0 / 5). Highest-leverage place to add coverage before Pinnacle usage grows.

> A few additional hardening follow-ups (not in this handover) are tracked in
> dev-brain task `de19ce14` — check there for the complete list before
> considering the audit closed.

## Deploy caveats when this branch ships

1. **`docker-compose.yml` changed** (the `worker_events` mounts + the
   `x-logging` anchor) — boxes on a tag-only `registry-pull` will NOT pick these
   up. Needs a **compose refresh**, same drift class as the original table-dbs
   mount (see memory `mantle-deploy-compose-drift`).
2. **Migration `0121`** applies two forward-only indexes (`create index if not
exists`, non-CONCURRENTLY, tiny lock on small tables). Back up first per the
   usual gate. Already applied to the local dev DB on 54323 during verification.
3. **Perf verification was on the local dev clone** (204 entities / 749 edges).
   The index _availability_ and query correctness are proven by EXPLAIN, but the
   planner only switches the composite exact-resolve OR to a BitmapOr at scale
   (thousands of entities). Re-check plans on a large real corpus after deploy.

## Suggested next move

Review the branch (or run `/code-review` again), then merge `--no-ff` from the
integrator and cut a release. Start the remaining list at **#1 (ops alerting)**
— it's the single highest-trust item for the pitch and reuses infrastructure
that already exists.
