# Scripts

Every executable in the repo that isn't application code: the dev-stack
bring-up, the backup/restore pair, the installer, the maintenance and backfill
runners, the code generators, the git hooks and CI.

The rule of thumb for **where a thing lives**:

| Location | What lives there | How you run it |
|---|---|---|
| `scripts/` | Repo- and host-level operations — dev stack, worktrees, DB dump/restore, install/uninstall, version bump, fleet status | `bash scripts/<name>.sh`, mostly wrapped by a root `pnpm` alias |
| `server/web/scripts/*.ts` | Everything that talks to **the brain's data** — seeds, backfills, evals, repairs | `pnpm maintain <slug>` (preferred) or `pnpm -C server/web <alias>` |
| `packages/*/…` | Package-scoped tooling — migrations, the theme generator, the mini-app runtime build | `pnpm -C packages/<pkg> <alias>`, some re-exported at the root |
| `e2e/scripts/` | The hermetic end-to-end stack | `pnpm e2e` |
| `infra/updater/` | Ships **inside the image** — the in-app update sidecar | never invoked by hand |
| `scripts/git-hooks/` | `commit-msg` + `pre-push` gates | `git config core.hooksPath scripts/git-hooks`, once per clone |

Two conventions hold almost everywhere:

- **Scripts carry their own docs.** Every script opens with a comment block
  stating what it does, why it exists, and its usage. That header is the source
  of truth; this page is the map.
- **Destructive scripts ask first, and read the terminal.** `reset.sh`,
  `uninstall.sh --purge` and the installer prompt via `/dev/tty` rather than
  stdin, so a piped `curl … | bash` can't silently answer its own confirmations.

---

## 1. Daily development

### `pnpm start` → `scripts/up.sh`

The canonical bring-up. Idempotent, safe on a clean machine or an already-running
stack:

1. checks the Docker daemon,
2. checks `server/web/.env.local` exists (and prints the exact `cp .env.example …`
   fix if not),
3. `docker compose -f docker-compose.dev.yml up -d --wait` (postgres + minio + tika),
4. ensures the MinIO `mantle` bucket,
5. `pnpm -C packages/db migrate`,
6. `pnpm -C server/web pgboss:init` — creates the `pgboss` schema *before* the
   workers race each other to create it on a fresh DB,
7. `exec pnpm dev`.

> `pnpm up` is **pnpm's own alias for `update`** and shadows this script. Use
> `pnpm start` (or `pnpm run up` if you must).

It also refuses to continue if it finds the pre-2026-07 dev containers (compose
project `mantle`, container `mantle_pg` publishing `127.0.0.1:54323`), which
would hold the ports the current `mantle-dev` project needs.

```bash
pnpm start
```

### `pnpm dev` and the preflight

`pnpm dev` runs eleven processes under `concurrently` — web, client, api, mcp,
and the email / telegram / files / docs / events / maintenance / runs workers.
Its `predev` hook is `scripts/preflight-dev.sh`, which fails fast with an
actionable message instead of a `ECONNREFUSED 127.0.0.1:54323` stack trace 30
seconds into boot. It checks, in order: Docker running → `mantle_dev_pg` up and
healthy → Postgres accepting connections → the `pgboss` schema present. Silent
on success.

Individual processes have their own aliases: `dev:web`, `dev:api`, `dev:mcp`,
`dev:client`, `dev:worker`, `dev:telegram`, `dev:files`, `dev:docs`,
`dev:events`.

### `pnpm dev:fe` → `scripts/dev-frontend.sh`

Frontend-only development: runs `client/web` against a **deployed** brain — no
Docker, no Postgres, no workers. Reads `client/web/.env.detached.local` for
`MANTLE_REMOTE`, migrates the pre-carve `server/web/.env.detached.local` if it
finds one, and execs `next dev` with `MANTLE_SERVER_ORIGIN` pointed at the
remote. Extra args pass through (`pnpm dev:fe --port 3001`).

The remote must CORS-allowlist the dev origin (`MANTLE_API_CORS_ORIGINS`; the
wildcard is never honoured on `/api/auth`). **Mutations are live against that
brain** — point it at a test box, not prod. Setup and troubleshooting:
[db-less-dev.md](./db-less-dev.md).

### `pnpm reset` → `scripts/reset.sh`

"Start over." Requires typing `wipe` to confirm, then: takes a best-effort
backup via `db-dump.sh`, `docker compose down -v`, deletes the bind-mounted
`$MANTLE_DATA_DIR/{postgres,minio}` (from inside an Alpine container, since
Postgres' files are container-uid-owned on Linux), comments out the now-stale
`ALLOWED_USER_ID` in `.env.local` so the next signup becomes owner, then execs
`up.sh`.

Keeps: `.env.local`, `MANTLE_FILES_ROOT`, production containers and data, the
source tree.

### Infra-only aliases

`pnpm infra:up` / `infra:down` / `infra:logs` / `infra:psql` operate on
`docker-compose.dev.yml` directly, without the app processes. `pnpm stop` /
`pnpm down` bring the dev stack down.

---

## 2. Worktrees

Parallel sessions must not share the original checkout — see the
[repo guidance](../CLAUDE.md#worktrees-are-the-default-for-parallel-work) for
why (branch switched under another session, intermingled edits, a shared
`node_modules` breaking imports).

### `scripts/new-worktree.sh <name> [base]`

Forks a branch, adds the worktree under the **original clone's**
`.claude/worktrees/<slug>` (resolved via `git rev-parse --git-common-dir`, so it
works from inside another worktree), copies `.env.local`, and runs `pnpm install`
(hardlinked from the shared store — seconds).

Name handling: `remote-mcp` → branch `feat/remote-mcp`; pass a `kind/slug` like
`fix/login` to set the prefix yourself. Base defaults to `main`. Refuses if the
directory or branch already exists.

```bash
scripts/new-worktree.sh remote-mcp
```

### `scripts/rm-worktree.sh <slug> [-f]`

Removes the worktree, **keeps the branch** (delete it separately once merged).
Refuses when the tree is dirty unless you pass `-f`.

---

## 3. Database: dump, restore, tunnel

### `pnpm db:dump` → `scripts/db-dump.sh`

Backs up **all three halves** of a running stack's state into `./backups`:

| Output | What | Restore with |
|---|---|---|
| `mantle-<ts>.dump` | Postgres (`pg_dump -Fc --no-owner`) | `scripts/db-restore.sh` |
| `mantle-app-dbs-<ts>.tgz` | per-app SQLite (`/apps` databases) | `scripts/app-dbs-restore.sh` |
| `mantle-table-dbs-<ts>.tgz` | file-backed table workbooks (`TABLE_DB_DIR`) | untar into `$MANTLE_DATA_DIR/table-dbs` |

The SQLite halves live on a **separate volume from Postgres**, so `pg_dump`
alone would silently miss them. They're snapshotted with `VACUUM INTO` inside
the app container (consistent under concurrent writes) and tarred to the host.
Failures there are loud but non-fatal — a hiccup must not invalidate the
Postgres dump, and must never be silent.

Container autodetection: `mantle_dev_pg` on dev machines, `mantle_pg` on
deployed boxes; it **refuses to guess** when both are running. Override with
`MANTLE_PG_CONTAINER` / `MANTLE_APP_CONTAINER`.

### `pnpm db:restore <dump>` → `scripts/db-restore.sh`

The standard way to move a brain to a new machine. Order matters:

```bash
docker compose pull
docker compose up -d postgres --wait     # init creates extensions + auth schema
scripts/db-restore.sh backups/mantle-<ts>.dump
docker compose up -d --wait              # migrate is now a no-op
```

Because the init scripts pre-create `auth`, `auth.users` and the extensions,
`pg_restore` prints benign "already exists" notices for those — expected. The
script doesn't trust the exit code; it verifies by counting `public.nodes`
afterwards. It **refuses to restore over a populated brain**. Don't forget the
file bytes: rsync `$MANTLE_DATA_DIR/{files,minio}` across too.

### `scripts/app-dbs-restore.sh <tgz>`

Extracts per-app SQLite snapshots into the container's `APP_DB_DIR`
(`/data/app-dbs`) — exactly the `<owner>/<app>.sqlite` paths the `app_databases`
registry rows point at. Restore Postgres **first** (the registry rows must
exist), then `docker compose up -d --wait`, then this, with apps idle.

### `pnpm db:tunnel` / `db:tunnel:down` → `scripts/prod-db-tunnel.sh [up|down|status]`

SSH-forwards a remote Mantle's **data plane** — Postgres *and* MinIO — to local
ports, so a local dev server runs as a thin client over the deployed brain
([remote-db-dev.md](./remote-db-dev.md)). Those containers publish no host
ports, so the script resolves their container IPs over SSH **every run** (they
change when a container is recreated). Both forwards ride one SSH connection, so
`down` drops them together.

Config via env: `PROD_SSH_HOST` (default `mantle-prod`), `MANTLE_PG_CONTAINER`,
`MANTLE_MINIO_CONTAINER`, `PROD_DB_LOCAL_PORT` (55432), `PROD_S3_LOCAL_PORT`
(9100). Holds no secrets — DB password and S3 keys stay in `.env.local`.

### `pnpm tailscale:serve` → `scripts/prod-tailscale-serve.sh [up|status|reset]`

The tunnel-free alternative: `tailscale serve --tcp` on the remote node
publishes Postgres (5432) and MinIO (9000) on the tailnet by MagicDNS. Same
container-IP re-resolution problem, same solution — re-run `up` after a redeploy
if the endpoints stop answering. **This is a standing exposure** to every device
on your tailnet (scope with ACLs); `reset` removes it.

---

## 4. Install, update, uninstall

### `install.sh` (repo root) — the one-liner

The public bootstrap, fetched over `curl`. It only: checks docker + the compose
plugin, downloads the deploy bundle (compose file, `.env.prod.example`,
`infra/caddy`, `infra/postgres/init`, the db + install scripts), delegates to
`scripts/install.sh`, and prints where to sign up.

```bash
curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh | bash
```

Env options: `MANTLE_HOME` (install dir), `MANTLE_DOMAIN` (auto-HTTPS),
`MANTLE_CHANNEL` (git ref — a release tag pins compose+infra to that release),
`MANTLE_REPO_RAW` (forks/CI), `MANTLE_SKIP_START` (scaffold without launching).

> `VAR=x curl … | bash` does **not** reach the bash on the right of the pipe.
> Export first, or use `bash -c "$(curl -fsSL …)"`.

### `scripts/install.sh` — the configurator

The real installer, and the only thing that writes `.env`. Idempotent and safe
to re-run: it generates only the secrets that are **missing**, so a re-run never
rotates `MANTLE_MASTER_KEY` and orphans your sealed secrets. It asks how the
brain should be reached and settles every consequence (listen address, origins,
what to open at the end) in one place; for a domain it proves DNS points *here*
before enabling TLS, so a typo costs nothing instead of burning Let's Encrypt's
issuance limit. It checks disk, memory and ports before the ~2 GB pull, and ends
on the sanity check's verdict — exiting non-zero when it fails rather than
printing "complete" over a broken install.

Key flags (`--help` for the full list):

| Flag | Effect |
|---|---|
| `--domain <host>` | HTTPS via Caddy/Let's Encrypt |
| `--localhost` | loopback only, HTTP on `127.0.0.1:80` |
| `--lan` (`--no-domain`) | HTTP on `:80`, reachable on the network |
| `--behind-proxy` | Caddy on `127.0.0.1:8080`; your nginx/apache terminates TLS |
| `--data-dir` / `--stack-dir` / `--image-tag` | `MANTLE_DATA_DIR`, `MANTLE_STACK_DIR`, `MANTLE_IMAGE_TAG` |
| `--local-embedder` / `--no-local-embedder` | bundled Ollama + EmbeddingGemma (persists via `COMPOSE_PROFILES`; needs a large box) |
| `--sandboxes` / `--no-sandboxes` | CLI sandboxes for the coder agent ([sandboxes.md](./sandboxes.md)); on by default for a fresh install |
| `-y`, `--skip-up`, `--sanity`/`--check` | scripted run, write-`.env`-only, health-check-only |

### `scripts/sanity.sh` — "is it actually serving?"

Inspects every container in the compose project, reports health, treats the
known one-shots (`migrate`, `createbuckets`, `ollama_pull`) as OK when they
exited cleanly, flags services that were never *created* (a stack missing its
web container otherwise reads as "all good"), folds in the separate
`mantle-client` project (a healthy backend with no usable interface must not
pass), then confirms the app answers over HTTP. Exit 0 = all good.

Runs standalone or via `install.sh --check`. Env: `MANTLE_COMPOSE_PROJECT`
(default `mantle`, falls back to `mantle-dev`), `MANTLE_CLIENT_PROJECT`,
`MANTLE_STACK_DIR`, `MANTLE_ENV_FILE`.

### `scripts/uninstall.sh`

Two deliberately separated operations:

- **default** — removes containers, networks and named volumes. Your data dir
  and `.env` are untouched, so `scripts/install.sh` brings the same brain
  straight back (all real state is bind-mounted; the only named volumes are a
  tailscale socket and Caddy's cert cache).
- **`--purge`** — also deletes the data directory and `.env`. That's the brain
  **plus `MANTLE_MASTER_KEY`**, which decrypts every stored API key and mailbox
  password. No undo.

Also `--images` (frees ~4 GB), `--stack-dir`, `--data-dir`, `--dry-run`, `-y`.
Never touches the `mantle-dev` project.

### `scripts/compose-adopt.sh [--apply]`

One-time adoption of the release-owned compose contract on boxes installed
before v0.142, which have no `docker-compose.yml.release` baseline and so are
skipped by the updater ("no-baseline" in `/settings/updates`). Run from the
stack dir: it extracts the canonical compose embedded in the image the box is
configured for, diffs it, and with `--apply` saves the current file as
`docker-compose.yml.pre-adopt.<ts>` and installs the canonical as both the live
file and the baseline. Move any box-local customization into
`docker-compose.override.yml` **before** applying. Converge with
`docker compose up -d --remove-orphans`.

### `infra/updater/updater.sh` — never run by hand

The execution half of in-app updates, shipped inside the image. The web app
*detects* a release and *requests* the update by writing `/signal/request.json`
to a private volume; this sidecar polls for it and performs exactly one fixed
operation — `docker compose pull && up -d` for every service **except itself**
(recreating its own container mid-command would SIGKILL the rollout). It holds
the Docker socket, so the mitigations are deliberate: listens on nothing, runs
one hardcoded command, validates only the image tag, and is the official docker
CLI image. It self-refreshes into the canonical copy from the target image after
each update. Status surfaces at `/signal/{status.json,stack.json,update.log}`.

**Don't "improve" it into a general remote executor.**

### `pnpm prod:build-push` → `scripts/docker-build-push.sh`

Builds and pushes the single Mantle image (every runtime service is the same
image — they differ only in the compose `command:`). Requires
`MANTLE_IMAGE_NAMESPACE`; `MANTLE_IMAGE_TAG` defaults to `latest`. Resolves the
git SHA and build time and bakes them in (shown next to the wordmark and at
`/api/version`), since `.git` isn't in the build context.

In normal operation you don't run this — a version tag push triggers
`.github/workflows/release.yml`, which builds both images multi-arch. This is
the manual path (and how you'd push from a VPS).

### `scripts/sync-test-box.sh [box]`

Rsyncs the working tree to a box running the source-run override
(`~/mantle-src` + `docker-compose.dev-src.yml`), where the dev servers
hot-reload on sync — no image build. Box-local dirs (`node_modules`, `.next`,
`.pnpm-store`, `.env*`, `data`) are excluded from `--delete`, so a sync never
clobbers the box's install or env. Handles root-owned regenerated files either
via passwordless sudo or a docker `chown` helper.

---

## 5. Diagnostics

### `pnpm status` → `scripts/status.mjs`

Derived truth about where the repo and fleet stand — the antidote to stale
coordination notes. Prints worktrees, branches not merged into main (local and
every remote), local ahead/behind, and probes fleet boxes over HTTP and peer dev
machines over SSH.

```bash
pnpm status              # human-readable
pnpm status --json       # machine-readable
pnpm status --no-fleet   # skip HTTP probes
pnpm status --no-peers   # skip the ssh probe
pnpm status --local      # pure git, no network
```

**Fleet hosts are not in the file and must never be** — this repo is public.
Point it at your own fleet with `MANTLE_FLEET="dev=https://a.example,…"` or an
untracked `.mantle-fleet.json` (see `.mantle-fleet.example.json`). Without
either, the fleet section is skipped.

What the script deliberately does *not* carry: intent — decisions, what's
waiting on a human, why something was parked. That belongs on the dev brain.

### `scripts/trace-node.sh [node-uuid]`

Traces one node through every layer of the brain: the `content_store` row and
any specialised table, the `content_index` fields (summary / embedding /
entities / tsv), profile facts, graph edges, and the extractor trace trail.
Read-only. With no id it lists the 10 newest nodes. Companion doc:
[data-flow-tracing.md](./data-flow-tracing.md).

---

## 6. Brain data: maintenance, seeds, backfills, evals

All of these live in `server/web/scripts/*.ts` and run under `tsx` with
`--env-file-if-exists=./.env.local`.

### `pnpm maintain` — the front door

One entrypoint over the maintenance task registry
(`server/web/lib/maintenance/registry.ts`), replacing a sprawl of per-script
aliases:

```bash
pnpm maintain                      # list live tasks, grouped by kind
pnpm maintain list --all           # include retired backfills
pnpm maintain info <slug>          # flags, env, cost, notes
pnpm maintain <slug> [flags…]      # run it
pnpm maintain <slug> --apply       # generic --apply → the task's own live flag
```

Safety rails: live runs of model-spending tasks need `--yes`, retired backfills
need `--force-retired`, and missing `requiresEnv` vars fail before the script
spawns. Full detail — including the nightly cron and the `/settings` UI tab — in
[maintenance-runner.md](./maintenance-runner.md).

Registry kinds: **recurring hygiene** (`entities-dedupe`, `backup-app-dbs`,
`backup-table-dbs`, `traces-reap`) · **remedies** (`dedupe-edges`) · **ops**
(`re-embed`, `extract-backfill`, `rotate-master-key`, `sync-now`,
`imap-folders`, `pgboss-init`) · **retired backfills** (the rest).

### Operational scripts

| Script / alias | What it does |
|---|---|
| `pgboss:init` | Materialises the `pgboss` schema once, before any worker starts — otherwise four queues race to create it on a fresh DB and lose |
| `re-embed` | Re-embeds every stored vector after an embedding-model change (the text didn't change; the vectors are now in the wrong space) |
| `rotate:master-key` | Re-seals every encrypted-at-rest column under a new key (set `MANTLE_MASTER_KEY_NEXT`, run, then promote) |
| `sync-now` | One-shot synchronous IMAP sync of every enabled account, bypassing pg-boss |
| `imap-folders` | Prints every folder on every account and marks which are in scope |
| `extract:backfill` | Re-fires `node_ingested` for nodes with no summary/embedding |
| `traces:reap` | Reaps abandoned traces for every owner (the cron-schedulable twin of the owner-scoped UI sweep) |
| `entities:dedupe` | Near-duplicate entity consolidation — free, pure DB, **dry-run by default** |
| `dedupe:edges` | Collapses duplicate `mentioned_in` edges from before the extractor became idempotent |
| `apps:push` | Pushes a local directory of mini-app source in, builds it, optionally publishes — the headless twin of `/api/apps/import` |
| `backup-app-dbs.ts` / `backup-table-dbs.ts` | `VACUUM INTO` snapshots; run **inside** the container by `db-dump.sh`, not by hand |

### Seeds

`seed:*` aliases seed agents, skills and tool groups onto an **existing** brain.
Fresh installs get all of this from the system manifest via onboarding — these
are the backfill path for boxes that predate a feature. The manifest is the
single source of truth; most seed scripts are thin `applyManifest` wrappers
([system-integrity.md](./system-integrity.md)).

Agents: `seed:remy` (recall), `seed:researcher` (web search), `seed:reader`
(URL reading), `seed:docs` (indexed documentation), `seed:pages`, `seed:tables`,
`seed:toolsmith` (API integrations), `seed:appsmith` (mini-apps), `seed:coder`
(terminal access).
Skills/config: `seed:tables-skill`, `seed:rich-writing`, `seed:tool-groups`,
`seed:location`, `seed:telegram`, `seed:heartbeat-demo`, `seed:brain-health`.

### Backfills and one-off repairs

Historical, mostly retired — reachable through `pnpm maintain … --force-retired`,
which is the point: they're recorded rather than deleted, so the "why did this
row look like that" question has an answer. Includes `relations-backfill`,
`regenerate-digests`, `backfill:digest-embeddings`, `backfill:block-ids`,
`backfill:conversation`, `backfill:email-salience`, `classify:backfill`,
`widen:content-hits`, `purge:noncontact`, `merge-part-tables`,
`retire-table-blobs`, and `pnpm backfill:rfc-msg-id` (in `packages/email`).

### Evals

| Alias | Question it answers |
|---|---|
| `pnpm -C server/web eval:recall` | "Is the librarian any good?" — a gold set of (query → expected node) run through the real retrieval code, scored recall@k + MRR ([recall-eval.md](./recall-eval.md)) |
| `pnpm -C server/web eval:runs` | "Is the judge any good?" — the runner-queue audit step, the quality gate of the whole runner |

Case files live in `server/web/scripts/eval/`.

---

## 7. Code generation

These write files that are committed or built; you rarely invoke them directly
because they're wired into `predev` / `prebuild` / `pretypecheck`.

| Script | Emits | Wired into |
|---|---|---|
| `server/web/scripts/gen-route-manifest.ts` | `server/route-manifest.gen.ts` from the `app/**/route.ts` tree — the bridge from Next's file-per-route convention to Hono | `predev`, `build`, `pretypecheck` |
| `server/web/scripts/build-share-runtime.ts` | `public/share-runtime/` — CSS + JS for the server-rendered `/s` share pages and `/print` | `predev`, `build` |
| `packages/app-build/scripts/build-runtime.ts` | the shared mini-app runtime into each app's `public/app-runtime/` | `predev`/`prebuild` in both `server/web` and `client/web` |
| `packages/web-ui/themes/generate.mjs` | `styles/themes.css` + the picker registry from `seeds.mjs` | `pnpm themes:build`; `--check` fails on drift (CI), `--report` prints per-token ΔE against a baseline |
| `scripts/generate-notices.mjs` | `THIRD-PARTY-NOTICES.md` from the production dependency tree, with verbatim license texts | `pnpm licenses:notices` — re-run after any dependency change |

**Never hand-edit theme colours** — `themes.css` is generated. See
[themes.md](./themes.md).

---

## 8. Release

### `pnpm version:bump <patch|minor|major|x.y.z>` → `scripts/bump-version.mjs`

The root `package.json` `version` is the single source of truth;
`server/web` and `client/web` are kept in lockstep so they never drift.
`patch`/`minor`/`major` operate on the numeric core and **drop** any
pre-release tag — pass it back explicitly (`0.20.0-alpha`) to keep it.

```bash
pnpm version:bump patch
git commit -am "release: v<new>" && git tag v<new>
```

Bump before every merge to main so the version climbs. See
[versioning.md](./versioning.md).

### `pnpm verify` and the git hooks

`pnpm verify` = `typecheck` (all packages) + `lint` + `format:check` + `vitest run`.
It's what CI runs and what the pre-push hook runs.

```bash
git config core.hooksPath scripts/git-hooks   # once per clone/worktree
```

That one setting enables both hooks in `scripts/git-hooks/`:

- **`commit-msg`** — strips `Co-Authored-By: Claude …` and
  `🤖 Generated with [Claude Code]` trailers. The repo is public and these
  commits are Jason's work; GitHub renders those trailers as a real co-author on
  the commit and in the contributors graph. Anchored fixed-string matches, so a
  commit body that legitimately discusses Claude is untouched. Write messages
  without the trailers anyway — the hook is the backstop, not the rule.
- **`pre-push`** — runs `pnpm verify` before a push. Bypass with `--no-verify`.

They live under `scripts/` rather than `.git/hooks/` so they're versioned and
survive fresh worktrees.

### CI

| Workflow | Trigger | What |
|---|---|---|
| `.github/workflows/build-check.yml` | push to `feat/**` or `main`, PRs to `main` | typecheck + lint + format + vitest + the **production build** (the webpack/edge-runtime gate `tsc` and vitest miss). Hermetic — no Postgres/MinIO. Does not build images. |
| `.github/workflows/release.yml` | push of a `v*` tag | builds `mantle-server` + `mantle-client` for amd64 and arm64 on native runners in parallel, merges digests into multi-arch manifests on Docker Hub, and cuts a GitHub Release carrying the deploy bundle so compose and image are versioned together |

Release needs the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repo secrets.

---

## 9. End-to-end tests

### `pnpm e2e` → `e2e/scripts/run-local.sh`

Boots a hermetic stack, runs Playwright, tears down. Throwaway pg/minio/browser
on non-default ports, the web app on `:3900` and the client on `:3901`, and a
**fresh owner created through real signup + onboarding** by the suite's
global-setup. Env is set explicitly so `server/web/.env.local` — which `next dev`
always loads, and which may point at a real brain — can't leak in.

```bash
pnpm e2e          # full cycle: up → migrate → web → test → down
e2e/scripts/run-local.sh up     # infra + migrations + web, for iterating
e2e/scripts/run-local.sh test   # run the suite against an up'd stack
e2e/scripts/run-local.sh down   # stop web + wipe the stack
```

`pnpm e2e:same` / `pnpm e2e:split` run the same-origin and split-origin
Playwright projects against an already-running stack.

---

## 10. Adding a script

- **Put it where its blast radius is.** Host/repo operations go in `scripts/`;
  anything that reads or writes brain data goes in `server/web/scripts/` and
  gets a registry entry so `pnpm maintain` can find it.
- **Register it, don't alias it.** New data scripts belong in
  `lib/maintenance/registry.ts` (with `kind`, cost, `requiresEnv`, and a dry-run
  or apply flag) rather than as another `package.json` line.
- **Write the header block.** What it does, *why it exists*, usage, and the trap
  that bit you. Every script here does; it's the reason this page can be a map
  instead of a manual.
- **Default to safe.** Dry-run by default for anything that mutates in bulk;
  confirm destructive actions from `/dev/tty`; make re-runs idempotent.
- **Autodetect the container, refuse to guess.** The `mantle_pg` /
  `mantle_dev_pg` pick-or-refuse helper in `db-dump.sh` is the pattern.
- **No hostnames, IPs or client names.** The repo is public — take them from env
  or an untracked config, the way `status.mjs` does.
