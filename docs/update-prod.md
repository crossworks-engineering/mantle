# Updating production (registry-pull)

How to ship the latest tagged release to the Contabo prod box. Prod runs the
**CI-built multi-arch image** and updates by **pulling** it — no build, no rsync,
no source tree needed on the VPS.

> **Why this changed.** The old loop built the image *on the VPS* because the Mac
> builds **arm64** and the VPS runs **amd64**. That's retired: the
> [`release.yml`](../.github/workflows/release.yml) workflow now builds amd64 +
> arm64 in CI and pushes a single **multi-arch manifest**, so the amd64 VPS pulls
> the right arch directly. deploy.md §5 (registry-pull) is the authoritative
> model; this file is the box-specific runbook.

> **Box:** `ssh mantle-prod` (`cwe@jason.crossworks.network`), install dir
> `~/mantle`, serves https://jason.crossworks.network. Its `.env` pins
> `MANTLE_IMAGE_NAMESPACE=titanwest` + `MANTLE_IMAGE_TAG=latest`. See deploy.md §0
> for the full topology.

## What a release + update does

1. **tag & push** (Mac). `pnpm version:bump <patch|minor|major>` (by change
   extent), commit the `release: vX.Y.Z`, `git tag vX.Y.Z`, `git push origin main
   vX.Y.Z`. The **tag push is the publish trigger** — nothing ships until it lands.
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

Code is forward-and-back; **migrations are forward-only** — always dump first.

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
```

## Verify

```bash
ssh mantle-prod 'cd ~/mantle && docker compose ps'                          # all up/healthy
ssh mantle-prod 'docker exec mantle_web sh -c "grep -m1 version /app/apps/web/package.json"'  # == the shipped vX.Y.Z
ssh mantle-prod 'docker logs mantle_migrate 2>&1 | tail'                    # migration applied (or no-op)
ssh mantle-prod 'docker exec mantle_pg psql -U postgres -d postgres -tA -c "select count(*) from nodes"'  # unchanged
curl -sI https://jason.crossworks.network | head -3                         # 307 → /login, valid cert
ssh mantle-prod 'docker exec mantle_pg psql -U postgres -d postgres -tA -c "select count(*) from pg_stat_activity"'  # flat ~20, not climbing
```
Then smoke-test the surface the release actually changed in the browser (and
`/debug` System vitals for stack health).

## Gotchas

- **Topology-change releases** (a renamed / added / removed service in
  `docker-compose.yml`) need the **release bundle's compose swapped onto the box**
  before the roll, plus `docker compose up -d --wait --remove-orphans` — otherwise
  a renamed service's old container keeps running under its former name. Grab the
  compose from that release's `mantle-deploy-vX.Y.Z.tar.gz`. Both production boxes
  hit this on the v0.79.0 split (apps/agent → apps/api).
- **telegram poller**: leave `worker_telegram` RUNNING (`restart: unless-stopped`).
  The dev/prod bot split (2026-06-02) means prod polls only `saskianewbot` and dev
  only `saskiadevbot` — disjoint tokens, no 409. If you ever re-share a token across
  dev+prod you'll get 409s again; the fix is separate bots, not stopping the worker.
  Keep apostle_paulus_bot / brianthecoder_bot / miaschoemanbot **disabled** on prod.
- **Caddyfile / infra changes** ride in the release **bundle**, not the image. Copy
  the updated `infra/caddy/Caddyfile` onto the box, then **restart** caddy
  (`docker restart mantle_caddy`) — don't just reload. The file is bind-mounted
  (`./infra/caddy/Caddyfile:/etc/caddy/Caddyfile`); an in-place rewrite lands on a
  new inode while Docker keeps serving the original, so `caddy reload` reports
  `config is unchanged`. `docker compose up -d` won't recreate caddy on a
  mount-content change — restart it explicitly (re-resolves the path → new inode).
- **migrations are forward-only** — the pre-roll `db-dump` is the only way back.

## Rollback

```bash
# (VPS) pin MANTLE_IMAGE_TAG to the previous version in .env, then:
ssh mantle-prod 'cd ~/mantle && docker compose pull && docker compose up -d --wait'
# …and set it back to `latest` once a forward fix ships.
```

CI publishes every release as `:vX.Y.Z` **and** `:latest`, so a rollback is just
pinning the prior `vX.Y.Z`. **Code rolls back instantly; schema does not** — a
migration is forward-only, so to undo one, restore the pre-update dump into a
fresh DB (deploy.md §3b–c).
