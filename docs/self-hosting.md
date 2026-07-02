# Self-hosting Mantle — install & update from the published image

The consumer path: run Mantle from the published Docker image with one
command, configure everything else in the interface, and update by pulling.
No checkout, no build, no hand-edited env.

This is the **standard way to run Mantle**. The companion docs serve other
audiences: [`getting-started.md`](./getting-started.md) is the developer
checkout, [`deploy.md`](./deploy.md) is the operator reference for building
*your own* image and migrating data between machines, and
[`update-prod.md`](./update-prod.md) is the maintainer's registry-pull update loop.

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
(compose file, env template, Caddy + Postgres init files, backup + install
scripts) into `./mantle`, then delegates to the bundled
**`scripts/install.sh`** — the single configurator. That **generates the
secrets** (`SESSION_SECRET`, `MANTLE_MASTER_KEY`, DB + object-store
passwords) into a mode-600 `.env` (re-runs never rotate an existing master
key), **verifies your domain's DNS points at the box before enabling
HTTPS**, then `docker compose pull && docker compose up -d --wait` and a
**per-service sanity check** (every container's health + the app answering).
First boot downloads ~2 GB of images and runs DB migrations (the one-shot
`migrate` service gates every app service).

Then open `http://localhost` (or your domain), **create your account**, and
let the onboarding wizard do the rest — it starts with its own system-status
check, then walks you through your API key, model choices, voice, and
memory-search (embeddings) setup. Everything is configured in the
interface, not in files.

> **Embeddings:** semantic search uses an online embedder by default
> (`text-embedding-3-large`, chosen in the wizard's Memory step — it can
> reuse the same OpenRouter key as chat). The fully-local embedder is an
> opt-in profile for air-gapped setups:
> `docker compose --profile local-embedder up -d`, then select provider
> `local` in Settings → Embedding.

> **Back up two things:** the `data/` directory (it IS your brain — DB,
> object store, files) and the `.env` file (`MANTLE_MASTER_KEY` decrypts
> your stored API keys; lose it and the vault is unrecoverable).
> Scheduled DB backups are built in: `/settings/backups`.

### Manual install (no script)

Grab the `mantle-deploy-<version>.tar.gz` bundle from the
[releases page](https://github.com/crossworks-engineering/mantle/releases),
unpack it, and run the bundled configurator:

```bash
bash scripts/install.sh              # interactive (asks about a domain)
bash scripts/install.sh --domain mantle.example.com -y   # scripted
bash scripts/install.sh --check     # health-check an existing install
```

Fully by hand instead: `cp .env.prod.example .env`, fill in the two
mandatory secrets (each has its `openssl rand` one-liner next to it), set
**`MANTLE_STACK_DIR`** to this directory's host-absolute path
(`MANTLE_STACK_DIR=$(pwd -P)` — without it the in-app updater can't run),
and `docker compose up -d --wait`. The bundle and the image are versioned
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
`MANTLE_IMAGE_TAG=v0.108.0` in `.env`, and update by editing the tag +
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
then re-run the configurator with the domain:

```bash
cd mantle
bash scripts/install.sh --domain mantle.example.com -y
```

It verifies the A record actually points at this server **before** letting
Caddy request a certificate (so a DNS typo can't burn Let's Encrypt
attempts), sets `MANTLE_SITE_ADDRESS` + `MANTLE_PUBLIC_URL`, restarts what
changed, and re-runs the sanity check. Your secrets are untouched — re-runs
never rotate an existing key.

<details><summary>Manual alternative (edit .env by hand)</summary>

```
MANTLE_SITE_ADDRESS=mantle.example.com
MANTLE_PUBLIC_URL=https://mantle.example.com
```

then `docker compose up -d caddy web`. Caddy fetches the certificate
automatically.
</details>

## For maintainers — cutting a release

```bash
pnpm version:bump patch          # bumps package.json (root + apps/web)
git commit -am "release: v0.108.1"
git tag v0.108.1
git push origin main v0.108.1    # ← the tag push triggers .github/workflows/release.yml
```

CI builds the multi-arch image, pushes both tags to Docker Hub, and creates
the GitHub Release with the deploy bundle. Requires the `DOCKERHUB_USERNAME`
/ `DOCKERHUB_TOKEN` repo secrets (one-time setup).

## Updating from the interface

**Settings → Updates** shows the running build, checks GitHub for the latest
release, and updates in one click: the app writes a request onto a private
volume shared with the bundled **updater sidecar** (`mantle_updater`), which
performs `docker compose pull && docker compose up -d`, streams its log back
to the page, and the page reloads itself once the new version answers. The
chosen version tag is persisted to `.env` (`MANTLE_IMAGE_TAG`) so a later
manual `up` can't roll you back.

Requirements (the installer sets all of this up):

- `MANTLE_STACK_DIR` in `.env` = the stack directory's **host-absolute**
  path. Existing installs add one line, e.g. `MANTLE_STACK_DIR=/opt/mantle`,
  then `docker compose up -d updater`.
- The sidecar mounts the Docker socket — that is root-equivalent on the
  host, which is why it exposes **no ports** and executes exactly one
  hardcoded operation; the only input it accepts from the app is the image
  tag, validated against a character whitelist
  ([`infra/updater/updater.sh`](../infra/updater/updater.sh)). If that
  tradeoff isn't for you: don't start the `updater` service — the Updates
  page degrades to showing the two CLI commands.

Compose-file changes (a new service/mount in a release) still need the
release bundle swap described above — the sidecar updates *images*, not the
compose file itself; release notes call it out when it applies.

## What's deliberately NOT here

- **Multi-user.** Mantle is one brain per install, one account. The second
  user gets their own stack.
