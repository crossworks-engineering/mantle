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
   `client-pair.tag` at the repo root names the jackdaw client tag this release
   is tested with — the updater rolls the owner UI to it. When a new jackdaw
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
6. Waits for `mantle_web` healthy.
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
  OK roll the updater removes old images of exactly `<ns>/mantle-server` and
  `<ns>/mantle-client`, keeping the images each container ran before the roll
  (the rollback pair), the ones they run now, and the two newest of each
  repository. It never touches another repository (sandbox, rustfs, caddy,
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

## Rolling a box from v0.232.315 to the client logins releases

The first roll past v0.232.315 brings client logins (v0.232.318 on). It is
an ordinary roll through the updater (`scripts/roll.sh`): migrations 0186
(needs-you notices), 0187 (the client level) and 0188 (client sign-in
links), and any later ones, land together in the one migrate, each in its
own transaction. **No manual step.** 0186 and 0187 take short exclusive
locks on `nodes`, `auth.users`, `agents`, `tool_groups` and `space_items`
with a 30 s lock timeout: on a busy box a timeout fails the migrate and the
roll reports an error. Each migration is all or nothing (one that ran stays,
and the code before it runs on it); roll again when it is quieter.

Before the roll, and again after, read the box's counts (read-only: one
READ ONLY transaction, rolled back):

```bash
ssh <box> "docker exec -i mantle_pg psql -U postgres -d postgres -X -q" < scripts/client-level-counts.sql
```

It lists the logins by role, the client-level items, the links on them (and
on folders above them), the public items and where their level came from,
and the agents and tool groups at client or public. Look at section 4 first:
an agent or tool group at client reads **client items only** after 0187
(decision 3), not public ones any more.

What admins see change:

- **Access popover.** Client means "signed-in clients (and the team)", with
  no link box; Public is the only level with an open link. Setting an item
  to client removes its open link. Lowering a page, drawing or note lists
  the embedded items that go down with it; a client item embedded in
  something set to public goes to public with it.
- **Shared links** (Team admin) show each link's level. The old client
  links retired in client logins C3 (v0.232.328): they answer "Sign in as
  a client" now, and Shared links lists them under Retired client links.
- **What clients see** (Team admin): every client-level item, its old link,
  the addresses a page was emailed to and the team or admin items it names.
  Acknowledge it before the first client login: Add client and Issue sign-in
  link (Team admin > Clients, v0.232.320 on) stay disabled until then, and
  again once a new item goes to client.
- **Needs-you notices**: a live "N waiting" notice for submissions, left
  behind items and team requests (0186).
- **The share tools refuse client items**: `node_share`, `page_share`,
  `POST /api/shares` and the email link answer `client-links-retired`
  (the email tool sends the page without a link and says why).
- The member Library lists client items too, with a Client badge.

After this roll the box has the rollback floor below: never below
v0.232.318 once a client login exists.

## Rolling to v0.232.333 (client logins C2/C2b audit fixes)

An ordinary roll through the updater (`scripts/roll.sh`). What to know:

- **Migration 0193 is cheap.** Two nullable columns on
  `client_signin_codes` (`sent_at`, `send_error`) and two small new tables
  (`client_signin_code_skips`, `client_signin_sender_folders`). Nothing is
  rewritten; it keeps the 30 s lock timeout of the migrations before it.
- **Emailed codes open at the deploy stop working.** A code is stored as an
  HMAC now (keyed from `SESSION_SECRET`), and a code stored before is not,
  so it no longer matches. A client who asked just before the roll asks
  again. An old open code still holds back a new one for the same email and
  address until it expires, 10 minutes at most. Sign-in links are not
  affected.
- **New sign-in links and invites carry `#code=`.** The owner UI must be
  the paired jackdaw release that reads the code from the fragment: the
  release's `client-pair.tag` must name it (v0.6.174 reads only `?code=`
  and opens a `#code=` link with no code). The updater rolls the client to
  the pair; a manual roll must too (step 3b). Links issued before carry
  `?code=` and keep working.
- **The Caddyfile changed**: the access log redacts sign-in codes and drops
  the Referer header, and `/client-signin` and `/invite` are served with
  `Referrer-Policy: no-referrer`. The shapes did not change. The updater
  refreshes the Caddyfile and recreates caddy with the roll, unless the
  box's Caddyfile has local edits or no baseline (drift: `update.log` says
  `CADDYFILE NOT REFRESHED`, and `pnpm status` shows it). Then replace it by
  hand: move the box's own routes into `infra/caddy/conf.d/`, copy the
  release's `infra/caddy/Caddyfile` over it (or run
  `sudo sh scripts/compose-adopt.sh --apply` in the stack dir), and
  `docker compose up -d --no-deps --force-recreate caddy`.

- **A sign-in sender chosen before keeps working**, and is not checked
  again for a Sent folder. The folders that choice left out of mail sync
  were not recorded (the record starts with 0193), so choosing None or
  another sender later does not put them back: take them off the account's
  excluded folders by hand if they should sync again.

The operator guide: [client-logins.md](./client-logins.md).

## Rolling to v0.232.342 (client logins C5) and its audit fixes

Ordinary rolls through the updater (`scripts/roll.sh`). The C5 release pairs
with the jackdaw C5 client (the release's `client-pair.tag`): members on an
older client see client requests they cannot open. What to know:

- **Migration 0194 takes short exclusive locks** on `space_items`,
  `node_comments` and `nodes` (a new column and two triggers on
  `space_items`, policies on all three, and the `node_comments` scope
  CHECK dropped and added again, which reads the whole table once). It
  keeps the 30 s lock timeout: on a busy box a timeout fails the migrate
  and the roll reports an error; roll again when it is quieter. The
  `author_role` backfill is one UPDATE over `space_items`.
- **Rolling back to v0.232.341** after 0194 leaves behind: comments with
  author kind `client` and scope `client` in `node_comments` (an admin
  still sees them on the item), `space_submissions` rows, and
  `space_items.author_role`. 341 reads none of them and has no client
  space route. The floor below still holds.
- **Migration 0195 (the C5 audit fixes) is cheap.** Two small new tables
  (`client_comment_ledger`, `client_quota_refusals`), new versions of the
  client total functions, and one partial index on `node_comments` (its
  build blocks comment writes for as long as it takes, seconds on any box
  we run). Nothing is rewritten; 30 s lock timeout.
- **Page and note text now count** toward each client's 200 MB and the
  brain-wide client total, and so does a deleted client's space until its
  purge. A box whose clients were near 5 GB of files may refuse client
  uploads right after the roll: read Team admin > Clients (or
  `GET /api/team-admin/clients/storage`) and raise
  `MANTLE_CLIENT_SPACES_TOTAL_BYTES` in `.env` if the disk has room
  ([client-logins.md](./client-logins.md) section 9).
- **Request bodies have a ceiling.** A JSON body over 8 MB (64 KB on
  `/api/auth/*`, 128 MB on the owner's document routes and MCP) is refused
  with 413 before it is read. Uploads keep their own caps and Caddy's 1 GB.
- **Comment threads answer the newest 100** with `hasMore`; a client older
  than the paired release shows those only, with no way to read further
  back.
- **Migration 0188 has no lock timeout** (client sign-in links, v0.232.318):
  its foreign keys take SHARE ROW EXCLUSIVE on `auth.users` and wait for as
  long as any open transaction holds that table. It ran on every box long
  ago and is never edited (migrations are forward-only). A box rolling from
  before v0.232.318 should roll with no long transaction open: a stuck
  migrate there is a lock wait, not an error.

## Rolling to v0.232.350 (client logins C6 and the whole-tier audit fixes)

Boxes on v0.232.338 get C6 (v0.232.346 to 348) and these fixes in one roll,
through the updater (`scripts/roll.sh`). The release pairs with the jackdaw
client in `client-pair.tag`. What changes for a box:

- **Who writes apps (C6, migration 0198).** Only admins create, change,
  build, publish, share or delete apps. A team-level or client-level app is
  a shared workspace: members write team AND client apps (before C6 they
  wrote team apps only), and client logins write client apps. An app whose
  data should stay read only for them needs the **Informational** switch on
  its app page (`apps.data_read_only`, default off for every existing app).
  Before the roll, list the apps this affects and decide per app:

  ```sql
  select n.id, n.title, n.audience from nodes n
   where n.type = 'app' and n.audience in ('team', 'client') order by 2;
  ```

- **Client-level apps run the client tool rules for every runner**, an
  admin's and a member's run included (only `client_shared_list`,
  `client_shared_search`, `client_shared_open`). A client-level app that
  declared other tools now gets an error for them; the author warnings on
  `app_tools_set`, `app_publish` and `access_set` name each one. Team,
  admin and public apps keep their runner's rules.
- **App databases are bounded**: one file grows to at most 256 MB
  (`APP_SQL_MAX_DB_MB` in `.env`; `docker-compose.yml` passes it, so the
  roll refreshes compose), a reply to at most 8 MB, and one caller runs one
  statement at a time. A write past the cap fails with "database or disk is
  full" and rolls back. Check the largest app database before the roll
  (`du -sh <stack>/data/app-dbs/*/*`) and raise the setting if one is near.
- **Exports of client apps** (a brain Table mirrored from a client-level
  app, or one a client wrote) index at retrieval depth only and commit at
  most once per 10 minutes. Facts extracted from such a Table before the
  roll stay until it is re-extracted.
- **The app access log** keeps 90 days (`app-access-log-reap` in the
  maintenance runner), logs a caller's reads at most once a minute per app,
  and client broker calls no longer write an `api.write` audit row.
- **App write tools are owner only**: `app_create`, `app_build`,
  `app_db_seed` and the other app write tools refuse a team or client
  surface and MCP callers that are not the owner.
- **Deleting a client login** also deletes that client's comments; its chat
  thread goes with the login as before. Disable keeps both.
- **Migrations**, all re-runnable with a 30 s lock timeout:
  - 0196 adds `space_items.taken_title` and fills it for taken items (one
    UPDATE).
  - 0197 adds three small admin-level tables (`client_sourced_nodes`,
    `conversation_taints`, `client_request_filings`).
  - 0198 adds `apps.data_read_only` (a metadata-only default).
  - 0199 adds `app_databases.client_written_at` (metadata only).
  - 0200 adds a trigger on `auth.users` that refuses any role change to or
    from `client` (a short lock on `auth.users`).
- **Rolling back** to v0.232.338 leaves the new columns, tables and the
  trigger in place; 338 reads none of them and never changes a client's
  role. Its members lose write access to client apps again.

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

Below a floor, restore the pre-roll backup taken before the migration instead
of pinning the tag.
