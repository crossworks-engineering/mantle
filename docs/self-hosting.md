# Self-hosting Mantle — install & update from the published image

The consumer path: run Mantle from the published Docker image with one
command, configure everything else in the interface, and update by pulling.
No checkout, no build, no hand-edited env.

This is the **standard way to run Mantle**. The companion docs serve other
audiences: [`getting-started.md`](./getting-started.md) is the developer
checkout, [`deploy.md`](./deploy.md) is the operator reference for building
*your own* image and migrating data between machines, and
[`update-prod.md`](./update-prod.md) is the maintainer's build-on-VPS loop.

## Requirements

- Docker Engine + the compose plugin (`docker compose version` works)
- ~4 GB RAM / 2 vCPU / 40 GB disk to be comfortable (measured sizing:
  [`deploy.md`](./deploy.md) §0a)
- Optional, for HTTPS: a domain with an A record pointing at the box and
  ports 80/443 open

## Install (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh | bash
```

With a domain (automatic HTTPS via the bundled Caddy):

```bash
MANTLE_DOMAIN=mantle.example.com bash -c "$(curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh)"
```

What it does — and all it does: checks Docker, downloads the deploy bundle
(compose file, env template, Caddy + Postgres init files, backup scripts)
into `./mantle`, **generates the secrets** (`SESSION_SECRET`,
`MANTLE_MASTER_KEY`, DB + object-store passwords) into a mode-600 `.env`,
then `docker compose pull && docker compose up -d --wait`. First boot
downloads ~2 GB of images, runs DB migrations (the one-shot `migrate`
service gates every app service), and pulls the bundled local embedder
(~300 MB, EmbeddingGemma — semantic search works with no cloud key).

Then open `http://localhost` (or your domain), **create your account**, and
let the onboarding wizard do the rest — assistant, API keys, email,
Telegram are all configured in the interface, not in files.

> **Back up two things:** the `data/` directory (it IS your brain — DB,
> object store, files) and the `.env` file (`MANTLE_MASTER_KEY` decrypts
> your stored API keys; lose it and the vault is unrecoverable).
> Scheduled DB backups are built in: `/settings/backups`.

### Manual install (no script)

Grab the `mantle-deploy-<version>.tar.gz` bundle from the
[releases page](https://github.com/crossworks-engineering/mantle/releases),
unpack it, `cp .env.prod.example .env`, fill in the two mandatory secrets
(each has its `openssl rand` one-liner next to it), and
`docker compose up -d --wait`. The bundle and the image are versioned
together — a release's compose always matches its image.

## Updating

Releases are tagged `vX.Y.Z`; every release publishes the image to Docker
Hub (`titanwest/mantle:vX.Y.Z` + `latest`, amd64 + arm64) and attaches the
matching deploy bundle.

**Routine update** (image only — the common case):

```bash
cd mantle
docker compose pull && docker compose up -d --wait
```

Migrations run automatically before the app services restart (the `migrate`
gate), so a schema-bearing release applies itself. The whole roll is
~a minute of downtime.

**Pinned versions** (recommended once you depend on it): set
`MANTLE_IMAGE_TAG=v0.20.66` in `.env`, and update by editing the tag +
`pull` + `up -d --wait`. `latest` is convenience; pins are reproducible.

**When release notes say the compose changed** (new service, new mount):
download that release's bundle and replace `docker-compose.yml` + `infra/`
(your `.env` and `data/` are never part of the bundle), then `pull` +
`up -d --wait`. Re-running `install.sh` does the same thing — it never
overwrites an existing `.env`.

**Before any update**, cheap insurance:

```bash
bash scripts/db-dump.sh        # → backups/mantle-<ts>.dump
```

### Rollback

```bash
# set MANTLE_IMAGE_TAG back to the previous version in .env, then
docker compose pull && docker compose up -d --wait
```

Code rolls back instantly. **Schema does not** — migrations are
forward-only, so rolling back across a migration means restoring the
pre-update dump (`scripts/db-restore.sh`, see [`deploy.md`](./deploy.md)
§3b–c). This is why the dump-first habit matters.

## Adding HTTPS later

Started on localhost and want a domain? Point DNS at the box, open 80/443,
set in `.env`:

```
MANTLE_SITE_ADDRESS=mantle.example.com
MANTLE_PUBLIC_URL=https://mantle.example.com
```

then `docker compose up -d caddy web`. Caddy fetches the certificate
automatically.

## For maintainers — cutting a release

```bash
pnpm version:bump patch          # bumps package.json (root + apps/web)
git commit -am "release: v0.20.67"
git tag v0.20.67
git push origin main v0.20.67    # ← the tag push triggers .github/workflows/release.yml
```

CI builds the multi-arch image, pushes both tags to Docker Hub, and creates
the GitHub Release with the deploy bundle. Requires the `DOCKERHUB_USERNAME`
/ `DOCKERHUB_TOKEN` repo secrets (one-time setup).

## What's deliberately NOT here (yet)

- **In-app update button.** The planned shape: the app compares its running
  version against GitHub releases and shows an "update available" banner; a
  socket-mounted updater sidecar performs the pull+roll on request. Until
  then, updating is the two-command pull above (or point
  [Watchtower](https://containrrr.dev/watchtower/) at the stack for
  unattended updates).
- **Multi-user.** Mantle is one brain per install, one account. The second
  user gets their own stack.
