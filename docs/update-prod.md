# Updating a box (registry-pull)

> Titled for prod, but the procedure is the same for ANY box — the dev box
> included. Only the ssh alias and the stack directory change (dev's lives in
> `~/stack-rehearsal`, not `~/mantle`), which matters for step 3b's project
> name.

How to ship the latest tagged release to the Contabo prod box. Prod runs the
**CI-built multi-arch image** and updates by **pulling** it, no build, no rsync,
no source tree needed on the VPS.

> **Why this changed.** The old loop built the image _on the VPS_ because the Mac
> builds **arm64** and the VPS runs **amd64**. That's retired: the
> [`release.yml`](../.github/workflows/release.yml) workflow now builds amd64 +
> arm64 in CI and pushes a single **multi-arch manifest**, so the amd64 VPS pulls
> the right arch directly. deploy.md §5 (registry-pull) is the authoritative
> model; this file is the box-specific runbook.

> **Box:** `ssh mantle-prod` (`<user>@<prod-host>`), install dir
> `~/mantle`, serves `https://<prod-host>`. Its `.env` pins
> `MANTLE_IMAGE_NAMESPACE=titanwest` + `MANTLE_IMAGE_TAG=<exact version tag>`
> (e.g. `v0.210.0`, NOT `:latest`; bump it as part of every update, step 2
> below). See deploy.md §0 for the full topology.

> ⚠️ **`~/mantle` is this box's path. Do not assume it on another box, and do
> not trust a `~/mantle` you find there.** Ask the running container where its
> stack lives, before `cd`-ing anywhere:
>
> ```bash
> ssh <box> 'docker inspect --format "{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}" mantle_web'
> ```
>
> On the dev box that answers `/home/cwe/stack-rehearsal`, while `~/mantle` is a
> **source checkout sitting on a feature branch**, whose `docker-compose.yml`
> names the image `titanwest/mantle` (the real one is `mantle-server`). Running
> the steps below verbatim there operates on a directory that is not the live
> stack, and can stand a second one up under a wrong image name. The label is the
> only authoritative answer; a directory that merely looks right is not evidence.

## What a release + update does

1. **tag & push** (Mac). `pnpm version:bump <patch|minor|major>` (by change
   extent), commit the `release: vX.Y.Z`, `git tag vX.Y.Z`, `git push origin main
vX.Y.Z`. The **tag push is the publish trigger**: nothing ships until it lands.
   `client-pair.tag` at the repo root names the mantle-client tag this release
   is tested with — the updater rolls the owner UI to it. When a new mantle-client
   release should reach the fleet, bump this file and cut a (patch) mantle
   release; that IS the distribution mechanism. (The reverse order at a
   contract change: mantle first — the tag publishes the npm contracts — then
   jackdaw pins them, then the NEXT mantle release records the new pair.)
2. **CI builds** ([`release.yml`](../.github/workflows/release.yml), fires on
   `v*`): builds amd64 + arm64 in parallel, pushes one multi-arch manifest tagged
   **both** `:vX.Y.Z` and `:latest`, then cuts a GitHub Release with generated
   notes + a `mantle-deploy-vX.Y.Z.tar.gz` bundle (compose, `.env.prod.example`,
   `infra/`, db scripts). ~5–6 min.
3. **VPS pull + roll**: `db-dump` → `docker compose pull` → `docker compose up -d
--wait`. The one-shot `migrate` service runs pending DB migrations first
   (gated), then web/api/workers recreate on the new image.
4. **manifest reconcile** (automatic, in the web image). On boot the web server
   runs `reconcileManifestOnBoot` (server/web `instrumentation.ts`): once per
   APP_VERSION, on an already-provisioned brain, it syncs new seeded HTTP tools,
   new skills, and **tool-GROUP membership** to the manifest, and unions the
   persona's default groups onto enabled responders. So a release that adds a tool
   to an existing group (e.g. 0.28.0 added `route_map`/`mapbox_directions` to
   `location`) reaches the live responder with **no manual `seed:*` run**.
   Additive (never removes a grant), best-effort (never fails boot),
   production-only, opt-out via `MANTLE_DISABLE_BOOT_RECONCILE=1`.

Code is forward-and-back; **migrations are forward-only**: always dump first.

---

## The standard roll: the updater, driven by `scripts/roll.sh`

Every box rolls through its own **updater** (the sidecar behind Settings >
Updates). From the Mac, `scripts/roll.sh` drives it for one box with the
fleet's guards built in, and stops loudly the moment one fails:

```bash
scripts/roll.sh --dry-run <box-label> vX.Y.Z   # preflight + counts, changes nothing
scripts/roll.sh <box-label> vX.Y.Z             # the roll
scripts/roll.sh --ssh <alias> [--stack <dir>] [--url <origin>] vX.Y.Z
```

The box comes from `.mantle-fleet.json` at the repo root (untracked, the same
file `pnpm status` reads; see `.mantle-fleet.example.json`): `ssh` (the alias),
`url` (for `/api/version`) and optionally `stack`. Without `stack` the script
asks the box's updater container for `MANTLE_STACK_DIR`, so it never trusts a
directory that merely looks right. Hostnames stay out of the repo.

What it does, in order:

1. Preflight: the updater is idle and no `request.json` is waiting.
2. Counts apps and sandboxes (Postgres) and app-db files (`*.sqlite` under
   `APP_DB_DIR` in `mantle_web`).
3. Backup: `MANTLE_DUMP_STRICT=1 bash scripts/db-dump.sh` on the box, checked
   by its own exit status (never through a pipe), and refused when any part
   reports "NOT backed up" (a box whose `db-dump.sh` predates strict mode).
   Skipped when the box's updater takes its own pre-roll backup (below);
   `roll.sh` then checks `update.log` for it after the roll.
4. Writes `request.json` holding only `{"target": "<tag>"}` into the updater's
   signal dir through a throwaway alpine container (the dir is root-owned),
   the same request the Update button writes.
5. Waits for a NEW `started_at` with this target and a `finished_at` (a
   same-tag re-roll shows the last run's `done` until the updater claims the
   request), then requires `"ok":true`.
6. Waits for `mantle_web` healthy. If it never is, it stops with exit 1, a
   banner saying the box is down, and the last 20 lines of the `mantle_web`
   log, every line, with secret values masked: URL credentials
   (`://[redacted]@`), Authorization and Cookie header values, the word after
   `Bearer`, a bare token wherever it stands (`sk-ant-`, `sk-or-`,
   `sk-proj-`, `sk-svcacct-`, `sk-admin-`, any `sk-` with 20 or more
   characters after it, `mtlk_...` dashes included, a JWT `eyJ...`, a
   Telegram bot token, a 64-hex string), and the value after a name holding
   key, token, secret, passw..., pwd, authorization, cookie, bearer or
   session, or the name pass exactly, when `=` or `:` follows that name
   directly (`MANTLE_API_TOKEN=...`, `SMTP_PASS=...`, `"apiKey": "..."`,
   `mantle_session=...`). A quoted value is masked to its real closing quote,
   past escaped ones. A URL password holding a `/` or an `@` is masked whole
   (any scheme when a `user:password` pair opens it), a `--password "two
words"` value whole, and a PEM or PGP private key block line by line; a
   BEGIN that does not end its line masks only the rest of that line, and a
   block masks at most 200 key-body lines, so the stack trace after an error
   that quotes a BEGIN still prints. Each line is cut to 2000 characters
   (` [cut]` marks it) and a cut line drops its last partial token, so a
   secret the cut runs through never prints its first half. Lines that
   explain the failure print whole:
   "SESSION_SECRET must be at least 32 characters", a stack frame like
   `secrets.ts:44:11`, a Zod `"Required"`, `connect ECONNREFUSED`, "tests
   passed:". Without perl on the machine running `roll.sh` the log is not
   shown at all; the banner says how to read it on the box. Nothing is rolled
   back automatically.
7. Counts again: **any drop in apps, sandboxes or app-db files stops with exit
   3** and a banner. Roll nothing else; the pre-roll backup is the way back.
8. Prints `/api/version`.

Exit codes: 0 rolled and verified, 1 a step failed (nothing was requested
when it failed before step 4), 2 usage, 3 counts dropped.

### What the updater does around every server roll

- **Backup first, or no roll.** Before it touches anything (the
  `MANTLE_IMAGE_TAG` write, the compose, Caddyfile and script refreshes, the
  pull, the up), the updater runs the box's `scripts/db-dump.sh` in strict
  mode: all four parts (Postgres, app-dbs, table-dbs, spaces) into
  `backups/pre-roll/` under the stack dir, owned by the stack dir's owner,
  mode 0600. It first checks the free disk: 1.5 x the last pre-roll set (or,
  the first time, the database size) plus `MANTLE_PRE_ROLL_MIN_FREE_MB`
  (default 4096, room for the pull that follows). When the check or the dump
  fails, the roll is **refused with nothing changed**: `status.json` says
  `"ok":false` and `roll refused, nothing changed: <reason>`, the Updates page
  shows it, and every file the failed dump wrote is removed. It keeps the
  newest `MANTLE_PRE_ROLL_KEEP` sets (default 3) and never touches the rest
  of `backups/` (your own dumps live there). An interface-only update
  (client tag alone) runs no migration and takes no backup.
  `MANTLE_PRE_ROLL_BACKUP=0` in `.env` switches it off, loudly in
  `update.log`; take your own backup then. These are `.env` settings: a
  request from the app cannot change them.
- **Old images go after an OK roll.** Nothing pruned images before this, and
  each release left a server and client pair (about 3.4 GB) behind. After an
  OK roll the updater removes old images of exactly `<ns>/mantle-server`,
  `<ns>/mantle-client`, `<ns>/mantle-parser` and `<ns>/mantle-media`, keeping
  the images each container ran before the roll (the rollback set), the ones
  they run now, and the two newest of each repository. `mantle-media` (the
  removed media sidecar) has no container after the roll that removes it:
  every image of it goes but the one it ran before that roll, which goes on
  the next. It never touches another repository (sandbox, rustfs, caddy,
  postgres), volumes or containers, never forces, and logs each removal to
  `update.log`; an image docker refuses to remove (still in use) is logged
  and kept. `MANTLE_IMAGE_PRUNE=0` in `.env` switches it off.
- **No roll below the client logins floor.** A request for a release
  version below v0.232.318 (a rollback) is **refused with nothing changed**
  (no backup, no pull, no `.env` write) while `auth.users` holds any client
  login, and also when the logins cannot be counted: older images treat
  every login that is not a member as an admin (see the rollback floors).
  `latest` and tags that are not a release version are never refused here.
  `MANTLE_ALLOW_BELOW_CLIENT_FLOOR=1` in `.env` rolls anyway, loudly in
  `update.log`. The check is the RUNNING updater's: the roll that first
  brings it still runs the old updater (below), so it guards the rolls
  after that one. A manual roll (pinning the tag by hand) bypasses it.
- **No roll to the workspaces switch on a box with clients that is not on
  workspaces yet.** A request for v0.239.90 or later (`latest` and tags that
  are not a release version count as later) is **refused with nothing
  changed** (no backup, no pull, no `.env` write) while the brain has an
  owner, no Admin workspace, and client logins or client-level items (plan
  21.9), and also when the database cannot be read. No `.env` knob: set the
  box up by hand first (below). `scripts/roll.sh` runs the same check (step
  2a) before it backs up. The check is the RUNNING updater's: a box whose
  updater predates it is not stopped by it, so roll such a box with
  `scripts/roll.sh`.
- **The first roll to a release with these steps still runs the OLD
  updater** (it refreshes itself at the end of an OK roll), so that one roll
  takes no updater backup and prunes nothing: `roll.sh` takes the backup
  itself on such a box.

## Manual roll over ssh (no updater)

The steps below are the fallback for a box without a working updater. They
skip everything the updater does (the compose, Caddyfile and script
refreshes, the pre-roll backup, the prune), so prefer the updater.

## Steps

```bash
# ── 0. (Mac) cut the release — the tag push triggers the CI image build ───────
cd ~/Projects/mantle && git checkout main
pnpm version:bump minor                       # patch / minor / major, by extent
git commit -am "release: v0.91.0"
git tag v0.91.0 && git push origin main v0.91.0
gh run watch "$(gh run list -w release -L1 --json databaseId -q '.[0].databaseId')" --exit-status

# ── 1. (VPS) BACK UP THE BRAIN — cheap insurance, mandatory before a migration ─
ssh mantle-prod 'cd ~/mantle && MANTLE_DUMP_STRICT=1 bash scripts/db-dump.sh'   # → backups/mantle-<ts>.dump
#   MANTLE_DUMP_STRICT=1: exit 3 when any of the four parts was NOT backed up
#   (without it a lost app-db, table-db or spaces part is loud but exits 0).
#   Check the exit status itself; never pipe the dump into grep or tail.
#   A full backup is FOUR files with one timestamp: mantle-<ts>.dump plus the
#   app-dbs, table-dbs and spaces .tgz archives. No spaces archive = the box
#   still runs a db-dump.sh from before 0.232.271 (a roll refreshes it); the
#   members' personal files are then not in that backup.

# ── 2. (VPS) pull the new multi-arch image (.env tracks :latest) ──────────────
ssh mantle-prod 'cd ~/mantle && docker compose pull'

# ── 3. (VPS) roll the stack — migrate runs first, then app services recreate ──
ssh mantle-prod 'cd ~/mantle && docker compose up -d --wait'
#   Do NOT stop worker_telegram (see Gotchas). For a service rename/add/remove,
#   see the topology-change gotcha — you need the bundle's compose + --remove-orphans.

# ── 3b. (VPS) roll the CLIENT stack — a SEPARATE compose file, easily missed ──
ssh mantle-prod 'cd ~/mantle && docker compose -f docker-compose.client.yml --project-directory . pull \
  && docker compose -f docker-compose.client.yml --project-directory . up -d --wait'
#   `--project-directory .` derives the project NAME from the directory, so on a
#   box whose stack is not in ~/mantle it lands under a different project than
#   the client is already registered as. Read the real one first and pass it:
#     docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' mantle_client_web
#     docker compose -p <that> -f docker-compose.client.yml pull && … up -d --wait
#   (Container names are hardcoded, so the wrong project still touches the right
#   container — it just relabels it, leaving two projects claiming one container.)
```

## Verify

```bash
ssh mantle-prod 'cd ~/mantle && docker compose ps'                          # all up/healthy
# BOTH images, side by side. The client is the one that silently stays behind,
# and it is the only one the user actually looks at — assert it explicitly
# rather than inferring the roll worked from the server being healthy.
ssh mantle-prod 'for c in mantle_web mantle_api mantle_client_web; do printf "%-20s %s\n" "$c" "$(docker inspect --format "{{.Config.Image}}" $c)"; done'
ssh mantle-prod 'docker exec mantle_web node -p "require(\"/app/package.json\").version"'   # == the shipped vX.Y.Z
ssh mantle-prod 'docker logs mantle_migrate 2>&1 | tail'                    # migration applied (or no-op)
ssh mantle-prod 'docker exec mantle_pg psql -U postgres -d postgres -tA -c "select count(*) from nodes"'  # unchanged
curl -sI https://<prod-host> | head -3                         # 307 → /login, valid cert
ssh mantle-prod 'docker exec mantle_pg psql -U postgres -d postgres -tA -c "select count(*) from pg_stat_activity"'  # flat ~20, not climbing
```

Then smoke-test the surface the release actually changed in the browser (and
`/debug` System vitals for stack health).

## Gotchas

- **The owner UI is a SECOND stack, `docker compose up` does not roll it.**
  Since the v0.200.0 split the client image (`mantle-client`, the zero-secret
  owner UI) is driven by `docker-compose.client.yml`, which the default project
  never loads. A plain `docker compose pull && up -d` leaves `mantle_client_web`
  on the OLD image, silently: every container reports healthy, `/api/version`
  reports the new version (that's the _server_), and only the UI is stale. Hit
  on the v0.203.0 roll, where the release's two fixes were both client-side, so
  the roll would have shipped nothing a user could see. Always run step 3b, and
  verify with `docker ps` that `mantle_client_web` shows the new tag, the
  version endpoint cannot tell you.
- **The box may pin an explicit tag, not `latest`.** Check
  `grep MANTLE_IMAGE_TAG .env` before pulling; if it names a version, bump it
  or `pull` re-fetches the old one and `up -d` is a no-op that looks like
  success.
- **The client tag is paired, not lockstep (post-split).** The owner UI
  versions on jackdaw's own stream; each server image embeds the client tag it
  was tested with (`/app/release/client-tag`). The updater applies that pairing
  and records what it set in `data/update-signal/client-tag.auto`; a
  `MANTLE_CLIENT_IMAGE_TAG` it did NOT write is treated as a user pin and left
  alone. Manual rolls: set the paired tag yourself before step 3b, or the
  client compose resolves `latest`.
- **status.json keeps the PREVIOUS run's result until the new run claims it.**
  Polling for `"phase":"done"` right after writing `request.json` can match the
  LAST update's terminal status and report success for a roll that hasn't
  started. Match the TARGET VERSION in the status line, and confirm with the
  image tags (the Verify block) — never the phase alone.
- **Compose is release-owned (v0.142+)**: updates driven by the in-app
  **updater** auto-refresh a pristine `docker-compose.yml` from the target
  image, so compose-level changes (new services, healthchecks, mounts) land
  with the roll (deploy.md §5b). The MANUAL ssh loop above skips that refresh:
  on a release that changed compose, either update via `/settings/updates`
  instead, or run `scripts/compose-adopt.sh --apply` after bumping the tag.
  `/settings/updates` shows the compose state (in sync / stale / drifted);
  box-local customization belongs in `docker-compose.override.yml` + `.env`,
  never in the canonical file.
- **Postgres `max_connections` 200 to 450 (the release after v0.300.9).**
  The value is in the postgres `command` of the canonical compose. The roll
  that brings it changes the postgres container's config, so `up -d`
  recreates `mantle_pg`: Postgres restarts once, with a few seconds of
  connection errors while the app containers recreate around it. No data
  changes and no migration. It lands only where the compose refresh lands:
  a box whose `docker-compose.yml` is modified (or has no baseline) keeps
  200, and a `command:` under `postgres:` in `docker-compose.override.yml`
  wins over the canonical one. None of the fleet boxes had either on
  2026-10-12 (their overrides set only `image` and `environment` for
  postgres). Check after the roll:
  `docker exec mantle_pg psql -U postgres -tAc 'show max_connections'`
  must print 450. A manual roll needs `scripts/compose-adopt.sh --apply`
  first, as for every compose change. Sizing: deploy.md §0a.
- **Topology-change releases** (a renamed / added / removed service in
  `docker-compose.yml`) also need `docker compose up -d --wait
--remove-orphans`, otherwise a renamed service's old container keeps running
  under its former name (the updater passes `--remove-orphans` already; both
  production boxes hit this on the v0.79.0 split, server/api → server/api).
- **telegram poller**: leave `worker_telegram` RUNNING (`restart: unless-stopped`).
  The dev/prod bot split (2026-06-02) means prod polls only `saskianewbot` and dev
  only `saskiadevbot`, disjoint tokens, no 409. If you ever re-share a token across
  dev+prod you'll get 409s again; the fix is separate bots, not stopping the worker.
  Keep study_example_bot / coder_example_bot / family_example_bot **disabled** on prod.
- **Caddyfile / infra changes** ride in the release **bundle**, not the image. Copy
  the updated `infra/caddy/Caddyfile` onto the box, then **restart** caddy
  (`docker restart mantle_caddy`), don't just reload. The file is bind-mounted
  (`./infra/caddy/Caddyfile:/etc/caddy/Caddyfile`); an in-place rewrite lands on a
  new inode while Docker keeps serving the original, so `caddy reload` reports
  `config is unchanged`. `docker compose up -d` won't recreate caddy on a
  mount-content change, restart it explicitly (re-resolves the path → new inode).
  Releases that changed the Caddyfile: **v0.232.122+** (body cap moved to
  `{$MANTLE_MAX_BODY_SIZE:1GB}` and JSON access logging on stdout). Both are
  defaults, no `.env` change needed; set `MANTLE_MAX_BODY_SIZE` / `MANTLE_MAX_UPLOAD_MB`
  only to tune. Boxes on the same-origin shape copy `Caddyfile.same-origin`.
  **v0.232.124+** adds the `infra/caddy/conf.d/` drop-in import and mount: keep
  box-local routes there, not in the Caddyfile, so a roll cannot wipe them.
  **v0.232.126+** makes the Caddyfile release-owned: the updater refreshes
  `infra/caddy/Caddyfile` and `infra/caddy/shapes/*.caddy` from the target
  image (pristine-vs-baseline, like compose) and recreates caddy itself, so
  the hand copy above is history from the NEXT roll on. The roll that brings
  v0.232.126 still runs the OLD updater (self-refresh lag), so on that one
  roll do the copy by hand or run `scripts/compose-adopt.sh --apply` in the
  stack dir afterwards (seeds the baselines too; run it with sudo, the roll
  creates `infra/caddy/shapes` root-owned and the script refuses to touch the
  Caddyfile when it cannot write the shapes), then
  `docker compose up -d --no-deps --force-recreate caddy`. The shape is
  `MANTLE_CADDY_SHAPE` in `.env` (default same-origin, what every box runs);
  `Caddyfile.same-origin` no longer exists.
- **migrations are forward-only**: the pre-roll `db-dump` is the only way back.
  See the rollback floors below.

## Long maintenance jobs on a box

Run a long `pnpm maintain` task (`chunk-windows --apply`, `re-embed`,
`extract-backfill`) with `scripts/box-maintain.sh`, never with
`docker exec ... mantle_web` and never with `nohup` over ssh:

```sh
scripts/box-maintain.sh <box> chunk-windows --apply --yes --parallel=16
scripts/box-maintain.sh <box> --follow
```

It starts a throwaway `maint-<task>` container from mantle_web's own image,
env and network, with its own memory limit, outside mantle_web's process
tree, and refuses a second run on the same box. The log stays on the box in
`~/maint-logs/` after the container removes itself. Why and how:
[maintenance-runner.md](./maintenance-runner.md), "Long runs on a box".

## Rolling across the client logins releases (history)

The client logins releases (v0.232.318 to v0.232.350, migrations 0186 to 0200) are behind every box we run. Their roll notes (the client level, the
sign-in links and codes, the client space quotas, client apps) are in the
repository history before workspaces W8f. Client logins themselves are
gone since W8a (below, and [client-logins.md](./client-logins.md)); the
rollback floor they set still stands (Rollback, below).

## Rolling to the Recall R5 release (page-built maps retired, migration 0209)

R5 removes page-built (v1) Recall maps: maps compiled from a page tree whose
root carries the `recall` tag. From the moment the R5 code runs, a map is
only ever a native `recall` item and no page-built map is served, whether or
not 0209 has run yet. `recall` and `prompt` become ordinary page tags, and
0209 deletes every `recall_maps` row with `node_id` NULL (their cards go
with them).

**What must be true on a box before this release reaches it:**

1. `select slug, title from recall_maps where node_id is null;` returns
   **zero rows**. (A box before Recall v2 has no `node_id` column: there,
   every row is page-built.) Zero is the only state that passes: while a v1
   row exists no native map can hold its slug, current or former
   (`recall_maps_owner_slug_uq`), so "a native map answers it" cannot be
   true yet. `scripts/roll.sh` checks this and refuses the box; set
   `ROLL_ALLOW_V1_RECALL=1` only for a map the owner agreed may go.
2. No page tree root still carries the `recall` tag. Untag them on EVERY
   box, not only dev: a tagged tree left behind recompiles on a rollback
   (below).

   ```sql
   select id, title from nodes
    where type = 'page' and parent_id is null and 'recall' = any(tags);
   ```

3. Migration 0208 is already applied (0209's `when` is higher: a box that
   applied 0209 first would skip 0208 for ever).
4. The client paired with it is the jackdaw R5 client (older clients probe
   `GET /api/recall/pages/:id` on every page open and log a 404).
5. Skills and notes that remember a v1 CARD slug were checked too; the
   query in (1) covers map slugs only.

**Retiring a page-built map by hand** (on a release that still has the v1
code, so before this one):

1. Untag the map's root page (remove `recall`) through the owner editor or
   the owner page route (`PATCH /api/pages/:id`). It must go through the
   page write path: the v1 hook there drops the compiled map and frees its
   slug. A raw SQL update of `nodes.tags` does not run the hook.
2. Give the native map the old slug as a former slug: `recall_map_set_slug`
   (or `PATCH /api/recall/maps/:id { slug }`) to the old slug, then back to
   the native slug. The old one stays in `former_slugs` and keeps resolving.
3. Confirm with `recall_open(<old slug>)`: it lands on the native map.
4. Remove the `prompt` tag from the old source pages.

On dev that is four maps: `mantle-registry-start-here` (to `architecture`),
`mantle-status-workflow` (to `status-workflow`), `jackdaw-ui-standards` (to
`ui-standards`) and `recall-workshop-test-map` (a test map: untag only).
jason-prod has one test map (`recall-test-page`), for the owner to decide.

**The demo site box**: the demo branch seeds its Recall map the v1 way
(tagged pages). Before main with R5 is merged into `demo`, the demo seeder
must create its map through `POST /api/recall/maps` and the card routes, or
0209 deletes the seeded map there and the public demo's Recall is empty
(dev-brain task 64c99b44).

**The migrate log** shows `recall R5: deleting N page-built map(s): ...`.
With the checks above done it says 0 on every box; anything else, read the
slugs.

**Rolling back** to the release before R5 keeps the schema working
(`last_compile_ok` and `last_compile_report` stay, unused), but the `recall`
and `prompt` tags become live again there. Under R5 an agent may set them,
and under the old release the next commit of such a page compiles it into a
served map or prompt. Before rolling back, list and untag them:

```sql
select id, title, tags from nodes where type = 'page' and tags && '{recall,prompt}';
```

A v1 map compiled after a rollback survives a roll forward (0209 does not
run twice), so check (1) again after any rollback. The follow-up migration
that drops `last_compile_*` repeats the `node_id` NULL delete and sets
`node_id` NOT NULL.

## Rolling to the workspaces switch (W5b2, migration 0261)

From this release the grants alone decide who reads and writes what: 0261
archives and freezes the item levels, turns the level bridge off and makes
its rows plain grants, all inside one transaction that ends in the switch
guard (`mantle_ws_switch_guard()`, 23514 on any read, fact or write gained;
nothing is written then). Open links are checked once, by 0262, right after
it fills each link's served list from the levels.

**A box with clients.** A brain that is not on workspaces because it has
client logins or client-level items (plan 21.9) is not switched by 0261 and
keeps its levels, but the code of this release reads no level: its members,
clients and assistants would read nothing. (Since W8a such a box has only
former clients: its manual switch also needs
`SET LOCAL mantle.ws_former_clients = 'reviewed'` in the same transaction,
below.) `scripts/roll.sh` (step 2a) and
the updater refuse a roll to v0.239.90 or later on such a box (above). Set
its workspaces up by hand first (plan 21.9), then roll; once it has its
Admin workspace the check passes. The SQL is plain and reads the
schema the box has today (from v0.239.35 on); to see what it sees:
`scripts/roll.sh --dry-run <box-label> <tag>`.

**Re-run the reach proof on a fresh copy right before each box's roll.**
The proof compares the grants with the levels: a grant made by hand since
W5b1 that a level does not explain (for example a direct grant to a
workspace other than Team) is a gained read, and the switch guard stops the
migration on the box (23514, the migration rolls back and the web container
does not come up healthy). So, for each box, right before its roll and not
days before:

1. Take a fresh dump of the box
   (`MANTLE_DUMP_STRICT=1 bash scripts/db-dump.sh`) and restore it into a
   throwaway Postgres on the workstation (never the Mac, never the box).
2. Run the release's migrations on the copy. 0261 ends in the switch
   guard and 0262 in the link check: both must pass (the migrate log shows
   `0261 proof:` rows and no 23514). A box with clients is not switched by
   0261: do its hand setup on the copy and run
   `select * from mantle_ws_migrate_locked()` there; it must pass too.
3. Time the switch on the copy: `\timing` in psql around
   `select * from mantle_ws_migrate_locked()`, or the time of the 0261 step
   in the migrate log. A switch at a later start (below) has 30 s for its
   DDL, counted from the switch itself (0263). If the copy's switch takes
   near or over 30 s, plan a manual run on the box instead of the boot
   switch: `SET mantle.ws_switch_budget = '10 minutes';` then
   `select * from mantle_ws_migrate_locked();` in one session (the setting
   takes 1 second to 1 hour; a bad value means 30 s; never ALTER DATABASE
   or ALTER ROLE for it, below). The 10 s head wait comes before the budget
   and is not counted in it.
4. Only then roll the box. A 23514 in step 2 names what would be gained
   (`select * from mantle_ws_reach_diff() where section = 'reach-fail'` on
   the copy before 0261 lists it): take that grant back (or give the item
   the level that explains it) on the box first, and repeat from step 1.

**The switch at a later start.** A brain switched after the roll (a fresh
install whose owner signed up later, or a client box set up by hand, then
`select * from mantle_ws_migrate_locked()`) runs the same switch at boot.
The head wait (the lock on the head of every brain item, taken first)
takes at most 10 s, or the budget when that is shorter, and is not counted
in the budget. The switch's DDL has a time budget of 30 s that starts at
the switch, not before it (0263: the grant work of a fresh brain does not
spend it). So a switch at boot holds the brain for at most about 10 s, plus
the grant work, plus the budget. Under a budget only the deadline ends the
retries (a budget of 10 minutes gets its 10 minutes); a plain migration
still stops after 12 tries. When the switch runs past its budget (55P03)
or the guard refuses (23514), the whole transaction rolls back: the brain
stays on the old model, the integrity row "workspaces: not migrated"
stays, the server log says why, and the next start tries again. A manual
run may give it more time: `SET mantle.ws_switch_budget = '10 minutes';`
first (1 second to 1 hour), in the same session.

The budget setting is a convention, not a permission: any role may SET it
in its own session. What limits who runs the switch is only that EXECUTE
on `mantle_ws_migrate_locked()` is revoked from PUBLIC. Set it with `SET`
in the session of the manual run and nowhere else. Do not use `ALTER
DATABASE ... SET mantle.ws_switch_budget` or `ALTER ROLE ... SET`: either
would also apply at every boot, so the boot switch would hold the brain for
that long. The same goes for `mantle.ws_ddl_retry_pause` (the pause between
busy tries, which tests shorten): never `ALTER DATABASE ... SET` or `ALTER
ROLE ... SET` it either, or every migration retries busy tables with that
pause. Under a budget the pause never drops below 1 s whatever it says.

**Review states (W5c, migration 0264).** The review routes are gone, so
0264 settles what they left, without loss (plan 9.3): every row of
space_items, space_submissions and space_item_bundles is copied to an
`archive_*` table first; submitted, returned and taken items become drafts
(sharing, accepted items and the trash stay); the submission and bundle
rows go. Personal items stay in their spaces until W6b, so no grant is
written: `space_item_homes` records each item's home (its login's private
workspace, "Name (only you)", or a "Former user" workspace with no users,
one per former user, when the login is gone; an accepted item whose author
was erased before 0264 keeps its brain home) and the Admin and Team grants
W6b writes. Its `snapshot` flag says where W6b makes the author's snapshot
copy of an accepted item: only into a private or Former user workspace,
never into Admin, Team or another brain workspace. Those grants and homes
follow what is live (sharing, the trash, the logins): a member can still
share or trash an app until W6b, and a login deleted after 0264 leaves its
private workspace behind, so each run of `select * from
mantle_ws_review_off()` refreshes the grants, renames such a workspace
"Former user" (no name left, its earlier events lose the name and
description too) and keeps the items in it, and W6b runs it first. A box not on workspaces is archived and resolved now; its homes are
recorded when it switches. On the copy, `select * from
mantle_ws_review_homes_check()` must show no item without a home, nothing
left in review and no row not archived.

**Informational apps.** The informational switch (`dataReadOnly`) writes
no grant (contract change 36): while it is on nobody beyond Admin writes
the app's data, whatever the grants' Write says; off, the grants' Write
decides. An app that was informational at the switch keeps the Team row
the bridge gave it (Write off): turning it off later does not give the
team Write until an admin turns Write on in the app's Grant Access panel.

**Deleted apps (W6a).** Purging or restoring a deleted app follows the
workspace it was homed in: its last snapshot (taken at the delete) stores
that workspace, and only a Moderator of it may purge or restore the app. A
snapshot taken before W6a stores none and so does not say where the app
lived: only the brain's owner may purge or restore that app. Any other
Admin user gets 403 (reason `item-workspace`).

## Rolling to the spaces fold (W6b, migration 0267)

0267 folds every personal space into the brain, in one transaction that
ends in its own proof (23514 rolls it all back; nothing is written then).
It runs `mantle_ws_review_off()` first, so the homes and the Admin and Team
grants it writes come from live sharing, the live trash and the live
logins. Then every row a personal space owns (except its kind roots, which
stay in the space, empty) becomes a brain item: `owner_id` = the brain,
homed in the workspace 0264 recorded (the login's private workspace, or a
Former user workspace), with exactly the grants that home names, Write off.

- **Rows change, bytes do not.** A member's file keeps its bytes in its
  space's directory (`data.space_file` names it; the brain's file readers,
  rename and move honour it) and moves from `space_files` to `files`. An app
  keeps its app row, its data, its app-db file and its history (every table
  that names the space as owner moves with it; storage paths are kept).
- **Names.** A folder path or slug the brain already has gets a short
  suffix, never an overwrite; `space_fold_items` records every move (old
  and new path and slug, the grants, the sharing and trash at the move).
  A file's name (`data.filename`, which the brain's readers, the files
  watcher and a delete build the tree path from) is made unique in its
  folder ignoring case: a member's `report.pdf` beside a brain
  `Report.pdf` becomes `report-<6 hex>.pdf`, its slug with it. A folded
  file's delete never unlinks a tree file, and the files watcher ignores
  folded rows; an overwrite of one puts its new bytes in the tree.
- **Archived homes.** An item whose recorded home is its live author's
  private workspace that was archived since 0264 goes to the author's
  live private workspace when it has one, else that workspace is
  un-archived (a `spaces_fold.unarchived` workspace event; the migrate log
  counts them).
- **Trashed apps (owner decision).** An app in its author's trash moves
  into that author's private workspace only (no Admin or Team grant), live,
  marked `data.trashedBeforeFold` (and `trashedAt`) so the author finds it
  and may delete it. Nothing of it is removed.
- **No LLM work.** The move is an UPDATE (no extractor notify); each moved
  item without an embedding is stamped `data.extract_skipped` (reason
  `spaces_fold`), so the boot drain and the sweep do not queue it. Check on
  the copy that the extract queue count is unchanged.
- **The space role is retired.** Every migrate sets `mantle_view_space`
  (and a per-database `mantle_view_space_<db>` login, where one exists)
  NOLOGIN with no password, and makes the shared role NOLOGIN on a fresh
  cluster (the old migrations grant to it); its grants and policies stay until W8. The
  personal-space routes answer 410.
- **Members write through the owner routes** (contract "W6b CONTRACT" in
  the build reports): a create lands in `?ws=` when the login moderates it,
  else in the folder it is made in when the login may edit that, else in
  the login's private workspace (made on its first write that may make an
  item: a create, an edit, a move or a copy; never a delete, a pin or an
  opened mark). Kind roots stay
  homed as before.
- **Snapshot copies (plan S3).** For each `space_item_homes` row with
  `snapshot` (an accepted item homed in a private or Former user
  workspace), the app makes the author's read-only copy in that workspace
  from the accepted version, redacted at the author's level, marked
  `data.snapshot_of` and `data.extract_skipped` (`snapshot_copy`), with no
  extractor notify. It runs at every boot after the workspaces migration
  (idempotent) and by hand: `pnpm maintain snapshot-copies` (dry run), then
  `--go`. When every wanted copy exists, the accepted `space_items` rows
  (archived by 0267) go. A file the brain changed since its accept has no
  accepted bytes left and gets no copy (counted). A copy is **read only
  for everyone, its author included** (CEO decision): the database refuses
  any change to it, a move out of its private workspace and any new grant
  (0267's triggers); its author may delete it. The item responses carry
  `readOnly: true`. One run at a time (an advisory lock), and each copy is
  stamped in its own insert.
- **Member app deletes wait for the owner** (CEO decision). A delete by any
  login other than the brain's owner is recorded in its `pre_delete`
  snapshot (`meta.keepForOwner`): the nightly `app-trash-purge` skips it,
  and only the owner deletes it for good (403 for anyone else).
- **Admin-only app switches.** `PATCH /api/apps/:id` refuses `trustTools`,
  `mcpAccess` and `dataReadOnly` for a member or a client (403
  `admin-only`); an app a member makes there starts at team rules with its
  author named.

**A brain that skips the switch** (clients present, or no anchor yet;
21.9): 0267 moves nothing there, yet the personal-space routes answer 410
all the same. Its members **cannot reach their own personal items** (the
space routes are gone and nothing is folded) until the brain is switched
onto workspaces by hand (`select * from mantle_ws_migrate()`, which runs the
fold at its end). Do not roll W6b to such a box without planning that
switch; say so to its owner first. W9 (the final switch for the remaining
boxes) must carry this note too.

On the copy before each box's roll: run the migrations, then
`select * from mantle_ws_spaces_fold_check()` must show 0 for "items left
in a personal space", "kind roots left with children", "space_items rows
other than accepted", "moved items without their home", "personal
spaces not archived" and "folded files sharing a name in their folder";
the migrate log's `0267:` rows list the moves, the
grants and the assistants' gains (Admin: the submitted and left-behind
items, Team: the team-shared drafts, signed off in 9.3). Then run
`pnpm maintain snapshot-copies` on the copy: "wanted" equals "made" plus
the counted skips.

## Rolling to the Admin assistant and owner MCP in a scope (W7a)

No migration. The Admin assistant (web chat, owner Telegram bots, runs,
heartbeats and the agents it calls) and the owner MCP surface (OAuth, API
keys, peers bound to an Admin login, stdio as the owner) stop reading the
whole brain on the system pool:

- **The Admin assistant** runs its turns in a scope of the Admin workspace.
  It reads what Admin holds (the Journal, About the user, entity names and
  its own history too), never another user's private workspace. It writes
  as an Admin user does, checked against Admin. A turn that answers no
  login (a heartbeat, a run, an owner Telegram bot) acts for the brain
  owner.
- **The owner MCP surface** runs every call in the calling login's
  workspaces, as that user's own screens do.
- **Admin tools** (model pools, assistants and tool groups, connectors,
  Telegram, mail, peers, sandboxes, secrets, the team access log) run only
  for a user of Admin whose matching area is on, then on the system pool.

Before rolling, compare reach on a dev copy: what each Admin login and the
Admin assistant read before and after must only lose items no Admin grant
holds (a member's private items). The emergency switch this release had
(`MANTLE_ADMIN_READS=system`) went in arch A7: see "Rolling to A7" below.

## Rolling to logins carry nothing (W8a, migration 0272)

An ordinary roll through the updater (`scripts/roll.sh`). Migration 0272
archives every client login (`archive_client_logins`), disables it, ends
its sessions, revokes its device tokens, API keys and OAuth grants, unbinds
its peers, and keeps it as a disabled member row. The email-code tables and
the retired static login tokens are archived as metadata and dropped. Every
archive is counted (a mismatch rolls the migration back), every drop is
RESTRICT, and a second run changes nothing. The whole model:
[workspaces.md](./workspaces.md); the operator detail:
[client-logins.md](./client-logins.md).

A brain not on workspaces yet that ever had a client login reports
"clients present" and is never switched at boot. `scripts/roll.sh` and the
updater refuse to roll such a box to v0.239.90 or later ("Rolling to the
workspaces switch", above), so this path is only for a box that did not
come through that gate. Set its workspaces up by hand, then run the switch
by hand in one transaction, as the database superuser (EXECUTE on
`mantle_ws_migrate_locked()` is revoked from PUBLIC):

```sql
BEGIN;
SET LOCAL mantle.ws_former_clients = 'reviewed';
-- a large brain: SET LOCAL mantle.ws_switch_budget = '10 minutes';
SELECT * FROM mantle_ws_migrate_locked();
-- a row with section 'skip' means nothing was switched: ROLLBACK
COMMIT;
```

The setting covers former client logins only. Client level items (on
`nodes`, an `audience`, `inherited_level` or `embedded_level` of `client`)
still block the switch: clear them first. Before COMMIT, check that the
result has no `skip` row; one names why the brain was not switched. Time
the switch on a copy first and give a large brain a budget, as "The switch
at a later start" above says.

## Switching a box to the runtime role (arch A9)

From the release that carries A9, every migrate makes `mantle_owner`,
`mantle_system` and `mantle_runtime` (and `mantle_system_narrow`, which
nothing runs on yet), hands the tables to `mantle_owner` and
grants the runtime role its rights; nothing changes for the app until the box
sets `MANTLE_DB_RUNTIME_ROLE=1` in its `.env` (only then does migrate give
`mantle_runtime` a login). Per box, with the owner's go and
a fresh backup first: the steps, the checks and the rollback are in
[runtime-role.md](runtime-role.md). Hand psql below stays the superuser.

## The narrow system route on by default (S7b) and its kill switch

From the release that carries S7b part b3, `MANTLE_NARROW_SYSTEM` is on
when unset: the system work of an Admin area exit runs as
`mantle_system_narrow`, on a pool that logs in as it (migrate gives the role
its login at the roll). Before the fleet flip, the box counts must read 0 on
the box (`scripts/arch-scoreboard-box.sh`; the list is in
docs/_archive/plan-v3-s7b-handover.md, part b3).

The release shape (which release carries the default to a box, and after
which day's counts) is decided by the CEO per box, and written here
before that box rolls.

The kill switch, per box, no image change. It takes a full
`docker compose up -d`: migrate must run first to take the role's login,
so restarting the app containers alone is not enough:

```sh
# ~/mantle/.env
MANTLE_NARROW_SYSTEM=0      # off and false read the same
docker compose up -d        # migrate first (the role loses its login), then the app
docker logs mantle_web 2>&1 | grep 'narrow system route'   # "... narrow system route off"
```

To turn it back on, remove the line (or set `1`) and `docker compose up -d`
again. The detail, and what a fresh install and per-database mode do, is in
[runtime-role.md](runtime-role.md), "The kill switch".

## Hand psql on a box: name the operator actor (arch A2a, migration 0275)

Every statement carries who it runs as (docs/actors.md). The app sets it
itself. An operator who writes with psql by hand names the session first:

```sql
select mantle_operator_actor('fix-slug');   -- a short reason, lower case
```

The session then runs as `system:operator:fix-slug` until it ends. Without
it, a write on an item table (nodes, pages, tables, grants, shares and the
other item tables) is an actor miss: psql prints `NOTICE: mantle actor miss:
UPDATE on nodes`. In `warn` a miss only logs. In `on` (A2b, migration 0277) the write is refused: `ERROR: mantle actor check: UPDATE on nodes
with no actor`. Name the session first.

The four workspace tables (workspaces, workspace_users, workspace_events,
workspace_resources) are written by definers that check the acting login
(plan v3.2 S2a, migration 0307). `system:operator:*` is no acting login and
no system work there: those definers refuse it. Repair them with the named
command (`ws:clear-member-ticks`), or write the table by hand as the
superuser, the session named as above.

The check has three steps, set per box in the database (the box setting
wins; a session can only make it stricter). Change it only with
`mantle_set_actor_check`, as the superuser that runs the migrations (a
custom setting set with ALTER DATABASE needs a superuser; the database
owner is not enough), connected to the brain's database:

```sql
select mantle_set_actor_check('on');    -- off, warn, on (on since 0301)
select mantle_actor_check_mode();
select count(*) filter (where enabled) as enabled, count(*) as tables
  from mantle_actor_check_tables();      -- warn, on: all enabled; off: 0
```

The function sets the database setting and switches the item-table
triggers in one transaction. With the check off the triggers are disabled,
so a write calls no trigger. Do not use a bare `alter database ... set
mantle.actor_check`: it leaves the triggers in the old state (the
integrity row `actor_check_drift` and one warning at app start show it).
The function locks every item table it changes at once and never waits for
a lock: if a table is busy it tries again 5 times, 200 ms apart, then fails
with `55P03` and nothing changed. While it holds the locks, new writes on
those tables queue for a moment. Run it when the box is quiet, and run it
again if it fails.

After you change the setting, restart the app processes (web, api,
workers, mcp). The app reads the setting about once a minute, but each
pooled connection keeps the value the database had when the connection
opened, and the item-table trigger reads that value first. Without a
restart, old connections keep the old mode. In warn it logs each miss to
`actor_check_misses` (at most 100 rows an hour per check) and one console
line per miss and caller an hour. Read them with numbers only:

```sql
select source, check_name, count(*) from actor_check_misses
 where at > now() - interval '1 day' group by 1, 2 order by 3 desc;
```

In warn the app sends each write of the system pool outside a transaction
on a reserved connection with a session SET of the actor in the same send,
then a RESET after the write has answered (the caller does not wait for
it; the connection goes back to the pool after the RESET). It sets the
actor in each transaction with its first statement (no extra round
trip). A read runs
plain. Measure the cost on the box before and after you turn warn on:
record the p95 latency of the hot routes (tree, item open, search, chat turn
start, MCP call, page save) and the pool wait (`pg_stat_activity` rows of
the brain waiting on `ClientRead` versus active, and the app's slow-request
log) for the same load, before and after. With the check off nothing
changes: no new query and no new round trip.

`on` refuses a statement with no actor, in the app and in the database
(A2b). Since migration 0301 every box runs it on (below, "The checks'
floor"): lowering it needs a reason, `select mantle_set_actor_check('warn',
50, 'why');`, then restart the app processes.

## Rolling to the write role (arch A2b2a, migration 0278)

The first migrate after 0278 gives the write role (`mantle_write_user`)
its row rules and write checks. It changes the rules table by table, each
in its own short transaction: it waits at most 3 s for a table's lock and
tries 8 times, 1 s apart. On a busy box the log can show a retry. If a
table still cannot be locked, migrate stops with a lock timeout (55P03):
run it again. A later migrate that changes nothing takes no table lock.
No app process uses the role yet, so nothing else changes.

## Login writes on the write role (arch A2b2b, migration 0279)

From A2b2b on, web and api send a login's scoped writes (a member's write
request, an Admin turn) to the write role while the box is `warn` or `on`.
A box that is `off` runs every write as before: nothing changes there. On a
`warn` or `on` box each of the two processes opens up to 3 connections as
`mantle_write_user` (6 of its limit of 20) after the roll. Since
2026-10-16 the runs worker, the Telegram poller and the stdio MCP server
send theirs there too (a run item's tool call, an approval tapped in
Telegram, a stdio MCP call), up to 2 connections each: 10 of the 20 on a
box, plus 2 per stdio server started on it.

The first migrate with 0279 also makes the gap writer (`mantle_gap_writer`,
NOLOGIN) and gives each gap table that has row level security a row rule
for it (`node_snapshots`, `profiles`, `recall_maps`, `recall_nodes`,
`recall_revisions`, `shares`). Each rule is its own short transaction that
takes the table's ACCESS EXCLUSIVE lock: it waits at most 3 s and tries 8
times, 1 s apart, as for 0278. If a table stays busy, migrate exits 1 after
0279 and its functions are committed, with the message "could not take the
lock to change the mantle_gap_writer row rule on <table> ... run migrate
again": run migrate again. It is idempotent; a later run that changes
nothing takes no table lock. A restore makes `mantle_gap_writer` first
(`scripts/db-restore.sh`), as the viewer roles.

In `warn`, a write the role refuses on its own checks is logged and runs
(`actor_check_misses`, as above). A write to a gap table the role holds no
right on runs again on the system pool and is logged as `write-role-gap`;
in `on` that rerun is checked (the write role's rules, the gap tables
written as `mantle_gap_writer`). Any other right the role does not hold is
a 500 in `warn` and `on`, and a `write-role-gap` row too. Read them with
numbers only:

```sql
select check_name, count(*) from actor_check_misses
 where check_name = 'write-role-gap' and at > now() - interval '1 day' group by 1;
```

Going back (an emergency only since 0301, with a reason: "The checks'
floor" below) is `select mantle_set_actor_check('off', 50, 'why');` and a
restart of the app processes: every write is on the system pool again.

## The edit check (arch A3a, migrations 0280 and 0281)

The database checks writes behind its own switch, `mantle.edit_check`:
`off` (the default, every box after the roll), `warn` or `on`
([edit-check.md](./edit-check.md)). The roll changes nothing on a box: the
first migrate after 0281 makes the edit check's triggers (one short
transaction per table, as for 0278) and leaves them disabled while the box
is `off`, so a write calls none of them. On a box whose actor check is
`warn` or `on` the roll also moves the history rows, the Recall tables and
the public links to the write role (their row rules apply there, as on
every other item table).

The check only bites where the actor check is `warn` or `on`: set that
first. Then, as the superuser that runs the migrations, connected to the
brain's database:

```sql
select mantle_set_edit_check('on');    -- off, warn, on (on since 0301)
select mantle_edit_check_mode();
select count(*) filter (where enabled) as enabled, count(*) as triggers
  from mantle_edit_check_tables();     -- warn, on: all enabled; off: 0
```

As `mantle_set_actor_check`, it sets the database setting and switches the
triggers in one transaction and needs a restart of the app processes to
reach every pooled connection. It takes every table's lock at once and
never waits on one: it tries 50 times, 200 ms apart (about 10 s), then
fails with `55P03` and nothing changed. A second argument sets the tries
(`select mantle_set_edit_check('warn', 150);`); `mantle_set_actor_check`
takes the same. On a busy box (the extractor writing, autovacuum after a
big import) give it more tries; if it still fails, pause the writers for
the moment of the switch: `docker compose stop worker_files
worker_maintenance api`, switch, then `docker compose start worker_files
worker_maintenance api` (the api runs the extract queue; chat pauses with
it for those seconds). Do not use a bare `alter database ... set
mantle.edit_check`.

In `warn` every write the check would refuse runs and is logged as an actor
miss whose check name starts with `edit:`. Read them with numbers only:

```sql
select left(check_name, 40) as what, count(*) from actor_check_misses
 where check_name like 'edit:%' and at > now() - interval '1 day'
 group by 1 order by 2 desc;
```

Expect, until each is decided: a member with a Write grant who changes an
app's code (owner decision D4: a Moderator of the app's home does), a
contact share made by a login that is not an Admin user. `on` refuses with
a 403. Do not set `on` on any box before its `edit:` misses are zero, and
never on the Pinnacle showcase box before 2026-10-16 (D4 lands after it).
Going back (an emergency only since 0301, with a reason: "The checks'
floor" below) is `select mantle_set_edit_check('warn', 50, 'why');` and a
restart of the app processes (web, api, workers, mcp): a pooled connection keeps the
setting it opened with, and the check reads the higher of the two until
it is restarted.

## Store brokers (arch A3b, migration 0283)

Nothing to switch: the roll changes how the brain writes table workbooks and
app database restores ([store-brokers.md](./store-brokers.md)). Migration
0283 adds `tables.draft_path` (it points every unsaved draft at its file)
and `app_databases.write_seq`, with no table rewrite.

- **New file names.** From the roll on, a table's workbooks and an app
  restore's database take a new name with each revision
  (`<node>.r-<token>.sqlite`); the row names the current one. Old names stay
  valid while a row points at them.
- **The nightly sweep** (maintenance task `store-sweep`) removes an old
  revision only: a file of a table or app whose row names ANOTHER file that
  is on disk, once it has been unreferenced on two runs an hour apart. With
  the nightly run that is the second night: until then they take disk (a
  commit of a large table holds two copies for up to about two days). Each
  run removes at most the larger of 500 files and half a store, the oldest
  first; the rest go on the next nights ("deferred", not a failure). It
  never removes a file whose item has no row (a deleted item's, an app's
  from long ago: reported), a draft from before the roll
  (`<node>.draft.sqlite`: reported for ever once its table is committed;
  remove one by hand after checking no row's `draft_path` names it), nor
  any file of an item whose row names a file that is missing. For a week
  after a restore (below) it holds a store: nothing removed, the run done
  and saying `HELD until <date>`. It removes NOTHING in a store, and the run
  shows failed, when a row names a file outside the store's folder (the
  maintenance container must mount `app-dbs`: the compose file of this
  release does), when no row names any file (a wrong database), or when a
  row names an older revision than on the last run (a restore that put no
  hold down: read the dry run `pnpm -C server/web store:sweep --allow-many`,
  then `--apply --allow-many`).
  `pnpm -C server/web store:sweep` shows what is due and what is kept;
  `--apply` removes it.
- **Backups and restores.** The backup runs `pg_dump` first, then the app
  databases, then the table workbooks, while the brain keeps writing. A
  write that lands in between moves a row to a NEW file after the dump
  recorded the old one, so each archive holds, besides the files the rows
  name, every revision the sweep had not yet marked unreferenced when the
  dump started: the old revision is still there (the sweep keeps it for at
  least an hour), so the file the dump's row names is in the archive.
  Restore Postgres first, then the files, as before.
- **After a restore the sweep is held.** `scripts/db-restore.sh` (at
  `$MANTLE_DATA_DIR/table-dbs` and `app-dbs`, made if missing) and
  `scripts/app-dbs-restore.sh` write `.store-sweep-hold` at the store root
  and remove `.store-sweep.json` there, before they restore anything:
  restored rows may name older revisions than the files on disk, and the
  sweep would read the newer ones as old revisions. The nightly sweep holds
  the store for a week (a done run that says HELD), and a backup in that
  week keeps every revision. ANY other restore (a manual `pg_restore`, an
  untar of `mantle-table-dbs-<ts>.tgz`) must do the same by hand first:
  `touch <root>/.store-sweep-hold` and `rm <root>/.store-sweep.json` for
  each store root (`db-restore.sh` honours `TABLE_DB_DIR` and `APP_DB_DIR`
  when set). Once the restored files are checked, read the dry run
  `pnpm -C server/web store:sweep --allow-many` (no `--apply`; without
  `--allow-many` a held store only says HELD), then run it with
  `--apply --allow-many`, or remove the hold files.

## Team is a normal workspace (migration 0286)

Owner decision 2026-10-13: the only built-in workspace with rules of its own
is Admin. This is a rule change, not a staged check: it applies the moment a
box rolls, whatever `MANTLE_ACTOR_CHECK` and `MANTLE_EDIT_CHECK` say, so the
boxes running both checks off get it in full. Do not roll the showcase box
until after the showcase, and only with the owner's go.

What migration 0286 does on a box (one statement per brain, under a 30 s
lock wait, re-runnable):

- **Team stays as it is**: its name, items, homes, grants, users, Moderator
  ticks, assistant, connectors and landing page are untouched. It loses its
  built-in mark (`bridge_key` and `admin_moderated` cleared) and gets the
  icon it already showed (`lucide:users`) when none was picked. One
  `workspace_events` row (`workspace.update`, no actor, `by` "migration
  0286") records it.
- **New logins join no Team.** An invite or **Add login** gives a member
  login no workspace (its private one comes when needed); an admin login
  joins Admin as a Moderator, as before. The login bridge no longer removes
  Team rows either: a login that stops being an admin or a member keeps
  them.
- **Only Admin users tick Moderator, or remove a Moderator**, on every
  workspace: a Moderator who is not an Admin user can no longer make
  someone a Moderator, take the tick away, or remove another Moderator
  (403 `admin_only`); they still add users and remove plain users, and
  anyone may leave. The maker of a new workspace is still its Moderator.
- **Team renames and archives like any workspace** (archive is still
  refused while an item has its home there), and its look follows the
  rename rule. Only "Admin" stays a reserved name.
- A member who chats without naming an assistant gets the assistant of
  their oldest workspace beyond Admin that has one: Team's on such a box,
  so nothing changes there.
- **A member-built app with no holder beyond Admin reads nothing** after
  the roll (it read Team until now). The count below finds them; the fix is
  to share each one with a workspace again (its Grant Access panel).

### Before the roll: count (read only, numbers only)

The box still runs the older image, so run this in psql (it names no
person, no title and no id):

```sql
begin read only;
select
  -- Team Moderators who are not Admin users (the ticks the switch gave).
  -- An Admin user: a live login in the live Admin workspace with the users
  -- area on (adminUserSql in packages/db/src/admin-user.ts).
  (select count(*) from workspace_users u
     join workspaces t on t.id = u.workspace_id and t.owner_id = mantle_brain_id()
                      and t.bridge_key = 'team'
    where u.moderator
      and not exists (select 1 from workspace_users au
                        join workspaces aw on aw.id = au.workspace_id and aw.is_admin
                                          and aw.archived_at is null
                                          and aw.owner_id = mantle_brain_id()
                        join auth.users al on al.id = au.login_id and al.disabled_at is null
                       where au.login_id = u.login_id
                         and coalesce(au.limits -> 'areas' ->> 'users', '') <> 'false'))
    as team_member_moderators,
  -- member-built apps with no live holder workspace beyond Admin
  (select count(*) from apps a
     join nodes n on n.id = a.node_id and n.type = 'app'
    where a.author_level = 'team' and n.owner_id = mantle_brain_id()
      and not exists (select 1 from workspaces w
                       where w.id = any(n.read_ws) and not w.is_admin
                         and w.archived_at is null
                         and w.owner_id = mantle_brain_id())) as member_apps_without_holder;
rollback;
```

Note both numbers for the box: they are the second and fourth numbers
`ws:team-check` prints after the roll. If `member_apps_without_holder` is above 0,
plan the re-share: an Admin user shares each such app with the workspace
that should run it, right after the roll (before the roll it still runs
through Team, so nothing is lost while you wait).

### Right after the roll: clear the member ticks

The same counts, from the new image, where the operator commands run
(plus the Moderators over every shared workspace):

```bash
pnpm -C server/web ws:team-check
```

Then an Admin user clears the Moderator tick of every Team user who should
only read and use Team (every member had it since the workspaces switch).
Either on **Settings > Workspaces > Team**, one row at a time, or in one go:

```bash
pnpm -C server/web ws:clear-member-ticks --workspace former-team           # dry run: counts
pnpm -C server/web ws:clear-member-ticks --workspace former-team --apply   # clear them
```

The command clears the tick of every user who is not an Admin user, keeps
the Admin users' ticks, keeps at least one Moderator, never removes a row,
and writes one `user.moderator` event per change. `--workspace <id>` takes
any other workspace the same way. A member who should keep moderating Team
gets the tick back from an Admin user on the workspace screen.
`ws:team-check` then shows 0 for Team, or 1 when no Admin user moderates
Team and the member added first kept the tick (the workspace keeps a
Moderator); an Admin user can make themselves a Moderator there and clear
that one too. If it still shows member-built apps without a holder,
re-share them now.

The command is one-shot: run it once, right after the roll. Run again, it
clears every tick an Admin user has set since on purpose, as it cannot tell
those from the ticks the switch gave.

What the operator tells the users of the box: "Team is now a workspace like
any other. Everyone keeps reading what they read. From now on only an admin
can make someone a Moderator or remove one, and new people are added to
workspaces by an admin." When `member_apps_without_holder` was above 0, add:
"An app a member built that no workspace holds stops working until an admin
shares it with a workspace again." Re-share those apps before you say it.

Check after the roll (read only, numbers only):

```sql
select count(*) from workspaces where not is_admin and bridge_key is not null;  -- 0
select count(*) from workspace_events
 where action = 'workspace.update' and subject->>'by' = 'migration 0286';        -- 1 (0 on a brain with no Team)
```

Rolling the image back alone leaves Team normal, and the older image finds
no Team by its mark: a member's chat that names no assistant is refused
("Team chat isn't provisioned") and the old member home answers nothing,
until the newer image is back. Roll forward; do not put the mark back by
hand.

## Rolling to A7: the switch-over code goes (migration 0295)

Arch A7 (docs/actors.md, "Remove the switch-over code (A7)"). For a box on
workspaces nothing a user sees changes. Before the roll:

- **The box must be on workspaces.** roll.sh's preflight says "workspaces:
  nothing stops the switch here" on such a box. A brain that is not (a box
  that reports "clients present") no longer starts: the web process logs
  the reason and exits. Switch it by hand first
  ([workspaces.md](./workspaces.md), "Operator notes"), then roll.
- **`MANTLE_ADMIN_READS` is gone.** A box that still sets it in `.env` is
  scoped as every box is (the value is not read); remove the line.
- **Migration 0297** adds one definer (`mantle_item_others_read`), with no
  lock on a table and no row change: over MCP an API key or a linked brain
  could change the content of an item a workspace outside its login's
  workspaces holds until it.
- **Migration 0296** adds one definer (`mantle_mail_branch_holds`), with no
  lock on a table and no row change: an area-limited API key's lists of
  pages, notes and tables answered 500 on a brain on workspaces until it.
- **Migration 0295** takes the `nodes` table's ACCESS EXCLUSIVE lock once
  (a 3 s wait, 20 tries) to make the three level CHECKs again, NOT VALID
  (no scan of `nodes` under the lock: the old CHECKs, the same rule, proved
  the rows), and drops `mantle_workspace_kind`. No row changes;
  re-runnable.
- **The 410 stubs** go in the release's last commit(s), only when every box
  showed no hit for one release. Count them per box, numbers only (counted
  on the box): `scripts/arch-scoreboard-box.sh <alias>`; ten counts, all 0.

## Admin writes on the write role (F4, migrations 0298 and 0299)

F4 (docs/actors.md, "Admin writes on the write role (F4)"): every login's
write request, an Admin user's and the owner's included, runs in its
workspaces on the write role while the actor check is warn or on.

- **Migration 0298** ticks Moderator on the Admin workspace for every
  Admin user who was not one (owner decision: every Admin user is a
  Moderator of Admin, always), one `workspace_events` row each
  (`user.moderator`, `by` "migration 0298"). Without the tick such a user's
  edits of Admin-homed items and its creates into Admin are refused on
  the write role. Count them on the box before the roll, numbers only:
  `select count(*) from workspace_users u join workspaces w on w.id =
u.workspace_id and w.is_admin join auth.users l on l.id = u.login_id and
l.role = 'admin' where not u.moderator;` (after the roll: 0).
- **Migration 0299** adds one definer (`mantle_mail_backfill_accounts`),
  with no lock on a table and no row change: adding a contact, or an
  address to one, queued no backfill of past mail in a request or an
  assistant's turn until it.

## The checks' floor (migration 0301, the pre-check removal)

From this release the tools' TypeScript item pre-checks go, family by
family (docs/actors.md, "Pre-check deletion"): the database's actor check
and edit check are then the only check of a tool's write to an item. Every
box runs both `on`. Roll this release only on a box whose two checks are
already on (`scripts/arch-scoreboard-box.sh <alias>` prints both, or
`select mantle_actor_check_mode(), mantle_edit_check_mode();`: both `on`).
A box that is not would be raised at the roll's migrate (below).

- **Lowering needs a reason.** `mantle_set_actor_check`,
  `mantle_set_edit_check` and `mantle_set_check` refuse to lower a check
  (on to warn or off, warn to off) without one: `ERROR: mantle_set_check:
lowering mantle.edit_check from on to warn needs a reason`, nothing
  changed. For an emergency (a check that refuses what it must not, until a
  fix ships), as the superuser that runs the migrations:

  ```sql
  select mantle_set_edit_check('warn', 50, 'a stuck import, task 1234');
  select mantle_check_lowered();  -- when, which check, from, to, who, why
  ```

  The lowering is a `WARNING` in the Postgres log, the record stays in the
  database setting `mantle.check_lowered`, every app process logs a
  `[db] SECURITY:` line naming it at its start and within a minute of a
  change, and the integrity row `check_floor` shows it. Below on, a tool's
  write the database would refuse is MADE: put it back as soon as you can,
  `select mantle_set_edit_check('on');` and a restart of the app
  processes. With both checks on again the record is cleared.

- **Migrate raises a check below on that no record covers.** A new
  database, a restore (`scripts/db-restore.sh`: a dropped database keeps no
  setting) and a bare `ALTER DATABASE ... RESET mantle.actor_check` all
  leave a check below on with no reason recorded: the next migrate (every
  `docker compose up`) raises it to on, the actor check first, and logs
  `actor check: off -> on`. The record holds one entry per lowered check,
  and an entry covers its check at the mode it recorded or above: a check
  an operator lowered to warn with a reason is left in warn, with a warning,
  but taken lower by hand (a bare `ALTER DATABASE` to off) it is raised
  again. A switch that cannot take its locks in time (`55P03`) is a
  warning, never a failed migrate: run `select mantle_set_edit_check('on');`
  by hand when the box is quiet. `MANTLE_CHECK_FLOOR` says what migrate
  does: `raise` (the default; the image sets it) or `keep` (below).
- **The roll refuses a box that is not on.** `scripts/roll.sh` (step 2d)
  and the in-app Update button (the updater) refuse a roll to a release
  that ships the floor on a box whose actor or edit check is not on, before
  the backup and before anything changes, unless the box's stack `.env`
  says `MANTLE_CHECK_FLOOR=keep`. Neither names a release number: roll.sh
  reads the target's tag in its own checkout (a migration named
  `*_check_mode_floor.sql` in the tag's tree), the updater pulls the
  target image and reads its migrations. A target they cannot tell
  (`latest`, a tag the checkout has not fetched, an image that cannot be
  pulled) counts as shipping the floor. A box whose checks are both on is
  never asked. Turn the checks on first (docs/edit-check.md), or keep the
  box below on on purpose (below). `scripts/roll.sh --dry-run <box> <tag>`
  shows the answer and changes nothing. A box whose updater is older than
  this check is not stopped by its Update button on the first such roll:
  roll it with `scripts/roll.sh`.

### Keep one box below on, on purpose

For a box that must stay in warn (or off) across a roll (a check that
refuses what it must not there, until a fix ships), as the operator:

1. Lower it with a reason, as above
   (`select mantle_set_edit_check('warn', 50, 'why, ticket');`). The record
   alone keeps it at that mode through every migrate.
2. For a box whose database has no record (a restore, a new install) or
   where the mode was set by hand, add to the stack's `.env`:

   ```sh
   MANTLE_CHECK_FLOOR=keep
   MANTLE_CHECK_FLOOR_REASON=why, in a few words, and the ticket
   ```

   The next migrate leaves each check below on as it is, logs
   `WARNING MANTLE_CHECK_FLOOR=keep: the edit check left below on, recorded:`
   with the `[db] SECURITY:` line, and records an entry per check
   (`mantle.edit_check kept at warn by <user>: MANTLE_CHECK_FLOOR=keep at
migrate, <reason>`) in `mantle_check_lowered()`. `scripts/roll.sh` lets
   the roll through and says so. Every app process keeps logging its
   `[db] SECURITY:` line and the integrity row `check_floor` shows the
   record, for as long as the box is below on.

3. To end it: `select mantle_set_edit_check('on');` (and the actor check),
   then take the two lines out of `.env`. A recorded entry outlives the env
   line: removing `keep` alone does not raise a check its entry covers.

Below on, a tool's write the database would refuse is made (the tools'
item pre-checks are gone): keep it as short as you can.

- **A restore.** After `scripts/db-restore.sh` the stack's migrate sets
  both checks on; nothing to set by hand. Rolling back to an image from
  before 0301 over a restored database leaves the checks off (that image's
  migrate does not raise them); that image still has its pre-checks.

## Going up to 0330 (the role follows Admin membership, plan v3.2 S8b)

From migration 0330 a seat in the Admin workspace alone makes a login an
Admin user (before, the role column AND the seat). So its migrate refuses
(42501; 0330 writes nothing, the schema stays the older image's) while any
login holds an Admin seat without role admin: an enabled one, a disabled
one (it would be an Admin user on its re-enable) and a former client
alike. The other drift (role admin without a seat) is narrower and only a
NOTICE.

**A refused migrate leaves the site down.** Every service waits on
`mantle_migrate`, so after a refused 0330 nothing starts until the older
tag is pinned back in `.env` (`MANTLE_IMAGE_TAG`) and the stack is up
again (the Rollback steps below, without the revert: 0330 never went in).
`scripts/roll.sh` prints the tail of the `mantle_migrate` log when a roll
is not ok (`docker logs mantle_migrate 2>&1 | grep 'mantle S8b'` on the
box shows the count).

So a roll is refused BEFORE it starts while that count is above 0 and the
target ships 0330: `scripts/roll.sh` step 2e and the updater
(`s8b_seat_refusal`) ask the same plain SQL of the box's current schema,
numbers only, and refuse with the count. The updater that decides is the
running one: roll a box whose updater predates the check with
`scripts/roll.sh`. Read `scripts/arch-scoreboard-box.sh` first as well
(`s8b_precondition_met yes`).

The repair, on the older image, before rolling again:

1. **Take each such login out of Admin** (the Admin workspace's users, or
   `mantle_ws_remove_user`). This is the default: the login was no Admin
   user before 0330 and stays none.
2. Only a login that SHOULD be an Admin user: give it role admin instead
   (the Users screen's promotion). That makes it an Admin user from 0330
   on; it is a grant, not a fix.

The logins, by id only (as the superuser, on the box):
`select l.id from auth.users l join workspace_users u on u.login_id = l.id join workspaces w on w.id = u.workspace_id and w.owner_id = mantle_brain_id() and w.is_admin and w.archived_at is null where l.role <> 'admin';`

## Going up to 0331 and 0332 (Present, the canvas workspace)

Migration 0331 adds the `present` node type; 0332 adds the `presents` and
`present_revisions` tables with their row security, actor and edit checks
(each following the box mode, as the loops leave them), and puts `present`
into `mantle_kind_class` and the folder depth check. Nothing to do before
the roll: both only add.

- **The browser sidecar is required for Present.** Every canvas save is
  drawn there (`BROWSER_WS_ENDPOINT`), and each render connects with its own
  launch flags (no name resolution, a dead proxy, no direct WebRTC UDP), so
  the sidecar must be browserless, which takes `launch` from the URL. Without
  a sidecar a canvas still saves and runs, but nothing can be drawn or
  exported.
- **Rolling back below it:** optional; the older image works with both in
  place. The reverts (`packages/db/rollback/0332_presents.revert.sql`, then
  `0331_node_type_present.revert.sql`) only take the two off the ledger and
  keep every canvas, so going up again picks them up as they were.

## Going up to 0333 (Present in Pages)

Migration 0333 makes a Present canvas that a page or a note embeds an embed
edge, as a drawing is: the page and note embed triggers read `presentId`
and the `present:` picture. It changes two parsers and makes the edges of
the pages and notes that already embed a canvas. Nothing to do before the
roll.

- **What it changes for readers:** nothing by itself. The Grant Access
  panel then offers an embedded canvas under "Grant these too", as it
  offers a drawing.
- **Rolling back below it:** optional; the older image works with it in
  place. The revert (`packages/db/rollback/0333_present_embeds.revert.sql`)
  puts 0208's parsers back and takes 0333 off the ledger.

## Going up to 0334 (the login bridge goes, plan v3.2 S8d)

Migration 0334 drops `mantle_bridge_login`, which nothing has called since
0330's image and which took a login out of Admin only when its role said
member (0330 refused its migrate while any such seat stood, so it deleted
nothing). Nothing to do before the roll.

- **What it changes for readers:** nothing.
- **Rolling back below it:** optional; the older image calls no bridge.
  The revert (`packages/db/rollback/0334_s8d_drop_bridge_login.revert.sql`)
  puts 0330's body, owner and rights back and takes 0334 off the ledger.
  Going below 0330 as well: this revert first (0330's reads the bridge's
  owner), then 0330's (below).

## Going up to 0338 (the canvas data store, DWG phase 7a)

Migration 0338 adds `canvas_data`: the small JSON values a Present canvas
keeps through `mantle.data` (meeting marks, saved layouts, suggestions,
votes), with a row rule for the workspace role, and its only two writers,
the definers `mantle_canvas_data_put` and `mantle_canvas_data_delete`
(the write role runs them; the runtime role reads the table and never
writes it). It only adds a table (with its indexes) and two functions.
Nothing to do before the roll.

- **What it changes for readers:** nothing until a canvas calls
  `mantle.data`. The owner UI forwards those calls once it pins the
  share-ui release that carries the bridge (CanvasSandbox); before that a
  canvas's data calls are not answered and time out.
- **Rolling back below it:** optional; the older image never reads the
  table nor calls its definers. The revert
  (`packages/db/rollback/0338_canvas_data.revert.sql`) takes 0338 off the
  ledger and keeps every stored value, the indexes and both functions.

## Rolling to the parser service (Tika and the media sidecar go)

This release replaces two sidecars with one core service: the parser
(`mantle-parser`, container `mantle_parser`, [parser.md](parser.md)) reads
every file the brain receives, in its own container with a memory limit and
no route out. Apache Tika (`mantle_tika`) and the media sidecar
(`mantle_media`, yt-dlp) are gone. No migration.

- **The roll pulls `<ns>/mantle-parser`** with the server image (every box
  runs it, no profile) and no longer pulls `apache/tika` or
  `<ns>/mantle-media`. The parser image carries Python, the CAD tools and
  ffmpeg, so it is the bigger download of the two on the first roll.
- **The old containers go with the roll.** The roll runs `up -d
--remove-orphans`, which removes `mantle_tika` and `mantle_media` once the
  refreshed compose no longer defines them. A box rolled by hand without
  `--remove-orphans` keeps them running for nothing; remove them by name:

  ```bash
  docker rm -f mantle_tika mantle_media
  ```

  The updater prunes the old `mantle-media` images over the next two rolls;
  the `apache/tika` image is not this product's repository and stays until
  you remove it (`docker image ls apache/tika`, then `docker rmi` by name).

- **`PARSER_TOKEN`.** The first roll to this release is run by the updater
  of the release before it, which does not know the token: the parser
  serves without one on its internal network until the next roll, whose
  updater writes it into `.env` (`ensure_parser_token`) and recreates the
  parser and the app containers with it. To have it at once, set it by
  hand before the roll: `PARSER_TOKEN=$(openssl rand -hex 32)` in `.env`.
  A fresh install (`scripts/install.sh`) writes one.
- **Settings that changed.** `MEDIA_SIDECAR_TOKEN`, `MEDIA_MEM_LIMIT`,
  `MEDIA_MAX_CONCURRENT`, `MEDIA_MAX_UPLOAD_BYTES` and `TIKA_URL` are no
  longer read; leave them or delete them. `MEDIA_MAX_STT_DURATION_S`,
  `MEDIA_MAX_AUDIO_BYTES` and `MEDIA_MAX_VIDEO_BYTES` are still read, as the
  old names of `VIDEO_INGEST_MAX_*`. A `media` left in `COMPOSE_PROFILES`
  names no service any more and is harmless. Settings > Services no longer
  lists Media, and Helpers (a core box) is the PDF-export browser alone. New, all optional: `PARSER_MEM_LIMIT` (default
  `2g`), `PARSER_CPUS` (default 2), `PARSER_MAX_JOBS`, `PARSER_QUEUE_MAX`,
  `PARSER_MAX_UPLOAD_MB`, `PARSER_CLIENT_CONCURRENCY`.
- **What reads less than before.** Legacy Visio `.vsd` files are no longer
  read (Tika did): the extractor asks for a `.vsdx` export. Pictures inside
  `.xls` and `.xlsb` workbooks are no longer extracted (their text and
  grids still read). `video_ingest` no longer fetches links: download the
  video and upload the file. Everything else Tika read (.doc, .ppt, .odt,
  .ods, .odp, .rtf, .epub, the legacy sheets) is read by anydoc in the
  parser.
- **After the roll:** the health screen (with an owner UI release that
  knows the parser) shows the parser up or down in place of the Tika and
  media pills; `docker ps` shows `mantle_parser`
  healthy and no `mantle_tika` or `mantle_media`. A document that fails the
  parser twice records `document_unreadable` rather than looping.
- **Rolling back below it:** the older compose brings Tika (and the media
  sidecar, if its profile is still set) back; `PARSER_TOKEN` in `.env` is
  ignored, and a `mantle_parser` container is removed as an orphan.

## Rollback

```bash
# (VPS) pin MANTLE_IMAGE_TAG to the previous version in .env, then:
ssh mantle-prod 'cd ~/mantle && docker compose pull && docker compose up -d --wait'
# …and set it back to `latest` once a forward fix ships.
```

CI publishes every release as `:vX.Y.Z` **and** `:latest`, so a rollback is just
pinning the prior `vX.Y.Z`. **Code rolls back instantly; schema does not**: a
migration is forward-only, so to undo one, restore the pre-update dump into a
fresh DB (deploy.md §3b–c). The updater's dumps are in `backups/pre-roll/`
(newest three), restored with `scripts/db-restore.sh` like any other. It
restores into a pristine database and exits 2, without "Restore complete",
when the result has no logins, no role CHECK, a missing viewer policy or a
missing trigger: do not start the app then. It exits 3 when the checks pass
but `pg_restore` reported an error it cannot explain (docs/backups.md).

**Rollback floors.** Pinning an older tag is safe only while that code still
matches the schema. Never roll back below:

- **v0.232.301 once migration 0178 ran** (it drops `contact_team_tokens`):
  v0.232.300 still reads that table for invite redeem and the Team admin
  Members tab, and both fail. The pre-roll backup is the only way back.
- **v0.232.255 once personal items exist** (migration 0165; the extractor's
  owner check, docs/member-logins.md).
- **v0.232.318 once any client login exists** (`auth.users.role =
'client'`): older images treat every login that is not a member as an
  admin, so each client would sign in as an admin. The updater refuses such
  a roll (above); pinning the tag by hand does not ask. Check first:
  `docker exec mantle_pg psql -U postgres -d postgres -Atc "select count(*)
from auth.users where role = 'client'"`.

- **The store brokers release (arch A3b, migration 0283) is not a safe
  rollback floor to cross.** An older image does not read `tables.draft_path`:
  every draft saved since the roll (named `<node>.r-<token>.draft.sqlite`)
  is invisible to it, and its next save writes a draft beside the published
  file that the newer image never reads. It also treats the published file a
  row names as its own to change, where this release keeps each revision
  unchanged (a commit's history entry may be a hard link to it). Before
  pinning an older tag: commit or discard every open table draft (`select
count(*) from tables where draft_path is not null` must be 0), and expect
  app restores made since the roll to stay where they are (the older image
  follows `storage_path` and reads them). If drafts were lost, restore the
  pre-roll backup (the dump and the table and app database archives) instead.

- **Below the workspace definers (plan v3.2 S2a a1+a2, migration 0307):**
  run its revert first, or the older image refuses every create that lands
  in a private workspace and attaches no assistant at signup or onboarding.
  0307 ships in its own release (S8a's 0306 in the one before it), so a
  one-image rollback crosses only 0307. While the newer image is still up
  (the file is in its image, not in the stack directory), as the superuser,
  in one transaction: `docker exec mantle_web cat /app/packages/db/rollback/0307_ws_user_definers.revert.sql | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1`. Then pin the older tag straight away (or stop
  mantle_web first): a mantle_web restart in between runs its boot migrate
  and applies 0307 again. The revert puts back the four functions the older
  image calls and takes 0307 off the ledger, so the next roll forward
  applies it again (why and the proof: the S2a a1+a2 handover in
  docs/_archive/).

- **Below the workspace row definers (plan v3.2 S2b, migration 0309):** the
  older image works with 0309 in place (0309 only adds functions), so the
  revert is optional. To leave the catalog as the older image shipped it,
  while the newer image is still up, as the superuser, in one transaction:
  `docker exec mantle_web cat /app/packages/db/rollback/0309_ws_row_definers.revert.sql | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1`.
  Then pin the older tag straight away (or stop mantle_web first): until the
  pin the newer image's workspace rename, landing app and archive are
  refused, and a restart in between applies 0309 again. The revert drops
  0309's five functions and takes it off the ledger (the S2b handover in
  docs/_archive/).

- **Below the folder trail (plan v3.2 S13, migration 0311):** the older
  image works with 0311 in place (0311 only adds one read function), so the
  revert is optional. To leave the catalog as the older image shipped it,
  while the newer image is still up, as the superuser, in one transaction:
  `docker exec mantle_web cat /app/packages/db/rollback/0311_folder_trail_definer.revert.sql | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1`.
  Then pin the older tag straight away (or stop mantle_web first): until the
  pin the newer image's tree and Files folder reads fail for a member, and a
  restart in between applies 0311 again. The revert drops the function and
  takes 0311 off the ledger (the S13 handover in docs/_archive/).

- **Below the narrow system role's containment (plan v3.2 S7b parts b2
  and b3, migrations 0315 to 0329):** with `MANTLE_NARROW_SYSTEM` off (`0`;
  unset reads on from b3, off on the b2 image in production)
  the image one back works with them in place: no revert (an image older
  than one back needs the reverts below whatever the switch). With it on,
  pinning the b2 image (one back) needs only 0329's and 0328's reverts
  (0329 first: it only changes the counter's function, but its ledger row
  goes before 0328's): b2's own
  migrations (0315 to 0327) give the narrow role its held readers, and
  0328's wider hold would refuse the push device deletes b2
  sends outside the spot (fail closed). An image older than b2 lacks the
  held readers too, so its sign-in and sign-out holds refuse every write
  they guard. Then pin in one of two ways. Either set
  `MANTLE_NARROW_SYSTEM=0` in the same `.env` edit as `MANTLE_IMAGE_TAG` and
  run one `docker compose up -d` for both, so no container of the older
  image runs with the switch on; or revert first (0329 then 0328 for b2; 0329
  down to 0315 for an image older than b2), newest first, each file in its
  own transaction, while the newer image is still up, as the superuser
  (the loop below is the full list; stop after 0328 for b2):
  `for f in 0329_narrow_counter_enabled 0328_narrow_hold_wider 0327_narrow_lockout_and_ledger_tokens 0326_member_turn_ledger_definers 0325_narrow_off_on_insert 0324_narrow_enable_off 0323_narrow_message_rules 0322_identity_gateway 0321_narrow_row_rules 0320_narrow_would_refuse 0319_narrow_one_way_columns 0318_narrow_observe_definer_frames 0317_promotion_agent_definers 0316_structure_item_definer 0315_acting_login_definers; do docker exec mantle_web cat /app/packages/db/rollback/$f.revert.sql | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 || break; done`,
  then pin the older tag straight away (or stop mantle_web first): a
  restart in between applies them again. Each revert takes its migration
  off the ledger. Why and the order: docs/runtime-role.md (reverting the
  narrow migrations by hand). After b3 flips the default, the fallback on a
  box is the switch alone (`MANTLE_NARROW_SYSTEM=0` and a full
  `docker compose up -d`), not a pin.

- **Below the role following Admin membership (plan v3.2 S8b, migration
  0330):** the revert is **mandatory**. With 0330 in place the older
  image's role change and admin login create are refused (the role guard lets only the membership
  definers write `auth.users.role`), and where its pool is the superuser
  its promotions land outside Admin (the bridge only demotes since 0330).
  While the newer image is still up, as the superuser, in one transaction:
  `docker exec mantle_web cat /app/packages/db/rollback/0330_s8b_role_follows_membership.revert.sql | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1`.
  Then pin the older tag straight away (or stop mantle_web first): a
  restart in between applies 0330 again. The revert drops the guard, puts
  back the bridge that adds, the bodies the older image ran, the bridge
  functions and triggers 0330 dropped and `mantle_role_drift`'s older
  count, drops 0330's new functions and takes it off the ledger: the
  catalog is the older image's again (the S8b handover in docs/_archive/).
  To go below b2 or b3 as well, this revert comes first, then theirs (the
  entry above). From an image with 0334, its revert comes before this one
  ("Going up to 0334" above). Going up to 0330: "Going up to 0330" above.

Below a floor, restore the pre-roll backup taken before the migration instead
of pinning the tag.
