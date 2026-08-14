# Updating a box (registry-pull)

> Titled for prod, but the procedure is the same for ANY box — the dev box
> included. Only the ssh alias and the stack directory change (dev's lives in
> `~/stack-rehearsal`, not `~/mantle`), which matters for step 3b's project
> name.

How to ship the latest tagged release to the Contabo prod box. Prod runs the
**CI-built multi-arch image** and updates by **pulling** it, no build, no rsync,
no source tree needed on the VPS.

> **Why this changed.** The old loop built the image *on the VPS* because the Mac
> builds **arm64** and the VPS runs **amd64**. That's retired: the
> [`release.yml`](../.github/workflows/release.yml) workflow now builds amd64 +
> arm64 in CI and pushes a single **multi-arch manifest**, so the amd64 VPS pulls
> the right arch directly. deploy.md §5 (registry-pull) is the authoritative
> model; this file is the box-specific runbook.

> **Box:** `ssh mantle-prod` (`cwe@jason.crossworks.network`), install dir
> `~/mantle`, serves https://jason.crossworks.network. Its `.env` pins
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
   runs `reconcileManifestOnBoot` (apps/web `instrumentation.ts`): once per
   APP_VERSION, on an already-provisioned brain, it syncs new seeded HTTP tools,
   new skills, and **tool-GROUP membership** to the manifest, and unions the
   persona's default groups onto enabled responders. So a release that adds a tool
   to an existing group (e.g. 0.28.0 added `route_map`/`mapbox_directions` to
   `location`) reaches the live responder with **no manual `seed:*` run**.
   Additive (never removes a grant), best-effort (never fails boot),
   production-only, opt-out via `MANTLE_DISABLE_BOOT_RECONCILE=1`.

Code is forward-and-back; **migrations are forward-only**: always dump first.

---

## Steps

```bash
# ── 0. (Mac) cut the release — the tag push triggers the CI image build ───────
cd ~/Projects/mantle && git checkout main
pnpm version:bump minor                       # patch / minor / major, by extent
git commit -am "release: v0.91.0"
git tag v0.91.0 && git push origin main v0.91.0
gh run watch "$(gh run list -w release -L1 --json databaseId -q '.[0].databaseId')" --exit-status

# ── 1. (VPS) BACK UP THE BRAIN — cheap insurance, mandatory before a migration ─
ssh mantle-prod 'cd ~/mantle && bash scripts/db-dump.sh'      # → backups/mantle-<ts>.dump

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
curl -sI https://jason.crossworks.network | head -3                         # 307 → /login, valid cert
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
  reports the new version (that's the *server*), and only the UI is stale. Hit
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
  production boxes hit this on the v0.79.0 split, apps/agent → apps/api).
- **telegram poller**: leave `worker_telegram` RUNNING (`restart: unless-stopped`).
  The dev/prod bot split (2026-06-02) means prod polls only `saskianewbot` and dev
  only `saskiadevbot`, disjoint tokens, no 409. If you ever re-share a token across
  dev+prod you'll get 409s again; the fix is separate bots, not stopping the worker.
  Keep apostle_paulus_bot / brianthecoder_bot / miaschoemanbot **disabled** on prod.
- **Caddyfile / infra changes** ride in the release **bundle**, not the image. Copy
  the updated `infra/caddy/Caddyfile` onto the box, then **restart** caddy
  (`docker restart mantle_caddy`), don't just reload. The file is bind-mounted
  (`./infra/caddy/Caddyfile:/etc/caddy/Caddyfile`); an in-place rewrite lands on a
  new inode while Docker keeps serving the original, so `caddy reload` reports
  `config is unchanged`. `docker compose up -d` won't recreate caddy on a
  mount-content change, restart it explicitly (re-resolves the path → new inode).
- **migrations are forward-only**: the pre-roll `db-dump` is the only way back.

## Rollback

```bash
# (VPS) pin MANTLE_IMAGE_TAG to the previous version in .env, then:
ssh mantle-prod 'cd ~/mantle && docker compose pull && docker compose up -d --wait'
# …and set it back to `latest` once a forward fix ships.
```

CI publishes every release as `:vX.Y.Z` **and** `:latest`, so a rollback is just
pinning the prior `vX.Y.Z`. **Code rolls back instantly; schema does not**: a
migration is forward-only, so to undo one, restore the pre-update dump into a
fresh DB (deploy.md §3b–c).
