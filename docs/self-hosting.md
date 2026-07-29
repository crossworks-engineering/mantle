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

> **Installing with an AI agent?** Point it at
> **https://mantle-ai.tech/ai-install.md** — a machine-oriented runbook of
> exactly this procedure (env contract, non-interactive flags, domain vs
> plain-IP, health checks, and the hard rules).

```bash
curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh | bash
```

With a domain (automatic HTTPS via the bundled Caddy):

```bash
MANTLE_DOMAIN=mantle.example.com bash -c "$(curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh)"
```

What it does — and all it does: checks Docker, downloads the deploy bundle
(both compose files, env template, Caddy + Postgres init files, backup + install
scripts) into `./mantle`, then delegates to the bundled
**`scripts/install.sh`** — the single configurator. That **generates the
secrets** (`SESSION_SECRET`, `MANTLE_MASTER_KEY`, DB + object-store
passwords) into a mode-600 `.env` (re-runs never rotate an existing master
key), **verifies your domain's DNS points at the box before enabling
HTTPS**, then `docker compose pull && docker compose up -d --wait` and a
**per-service sanity check** (every container's health + the app answering).
First boot downloads ~4 GB of images and runs DB migrations (the one-shot
`migrate` service gates every app service).

Before the pull it also checks free disk and memory and whether ports 80/443
are already held — the failures that otherwise surface halfway through a 2 GB
download. And the health check's verdict is the installer's verdict: when it
fails you get **"Installation incomplete"** and a non-zero exit, not a URL that
won't answer.

### Where it serves

The one-line command is non-interactive. Without `MANTLE_DOMAIN` it serves
**plain HTTP on :80 across the machine's network** — reach it at
`http://<server-ip>`. Run the configurator directly and it asks instead:

```bash
cd mantle && bash scripts/install.sh
```

```
  How should people reach this brain?

    1  A domain, with HTTPS       brain.example.com — the certificate issues itself
    2  This machine only          http://localhost — a laptop, or a box you tunnel into
    3  This machine's network     http://192.168.1.20 — LAN or VPN, no certificate
```

Same three choices as flags: `--domain <host>`, `--localhost`, `--lan`
(`--no-domain` remains an alias for the last), plus `--behind-proxy` for a box
that already runs a web server. **`--localhost` binds the front door to
`127.0.0.1`** via `MANTLE_BIND_ADDR` — worth knowing that this is the only
thing that actually keeps a brain off the network, because a published Docker
port bypasses the host firewall (Docker installs its own DNAT rules ahead of
it).

**If ports 80/443 are already taken**, what happens depends on whether a
certificate is involved. Without one (`--localhost`, `--lan`) the front door
just moves — 8080, 8081, … — and every address it prints carries the port. With
a domain it stops instead: Let's Encrypt answers HTTP-01 on port **80** and
TLS-ALPN-01 on **443**, so on any other port a certificate can never be issued,
and quietly moving would build an install that only looks finished. You're
offered a re-check after freeing the port, or `--behind-proxy` — Caddy on a
loopback port with your existing nginx/apache keeping :443 and forwarding to
`http://127.0.0.1:8080`. Both ports are overridable directly as
`MANTLE_HTTP_PORT` / `MANTLE_HTTPS_PORT`; Caddy always listens on 80/443 inside
its container, so nothing in the Caddyfile changes.

A domain is checked before TLS is enabled: every A **and** AAAA record is
compared against the box's public and local addresses (a NAT'd VPS legitimately
answers on a private one). If it doesn't point here you're offered a re-check,
plain HTTP for now, a different domain, or a clean stop — and under `-y` it
falls back to HTTP rather than letting Caddy burn that hostname's Let's Encrypt
rate limit on a request that cannot succeed.

Mantle runs as **two stacks**: the server (API, agent, workers, share/print
surfaces) and the owner UI — a separate zero-secret app. The installer brings
up both and points Caddy at them on ONE domain, path-routed, so there is
nothing extra to configure: `/api`, `/s` and `/print` go to the server, and
everything else — including sign-up — goes to the UI. You'd only split them
across two hostnames deliberately; see
[`upgrading-to-v0.202.md`](./upgrading-to-v0.202.md).

Then open the URL the installer prints when it finishes — `http://<server-ip>`
for the default one-liner, `http://localhost` for a `--localhost` install, or
your domain — **create your account**, and
let the onboarding wizard do the rest — it starts with its own system-status
check, then walks you through your API key, model choices, voice, and
memory-search (embeddings) setup. Everything is configured in the
interface, not in files.

> **Embeddings:** semantic search uses an online embedder by default
> (`text-embedding-3-large`, chosen in the wizard's Memory step — it can
> reuse the same OpenRouter key as chat). The fully-local embedder
> (bundled Ollama + EmbeddingGemma, ~3.3GB of image + model) is opt-in for
> air-gapped setups — nothing of it is pulled, started, or downloaded
> otherwise.
>
> ⚠️ **The local embedder needs a big box.** This is a deliberate default,
> not an oversight: under real ingest load (several files uploaded at once,
> each fanning out into many embedding calls) the CPU embedder degrades the
> whole stack on a standard VPS — tested to misbehave on a 16 GB / 8-core
> server. Only enable it on hardware comfortably above that (or a GPU), and
> keep `EXTRACT_CONCURRENCY=1` on CPU-only boxes. For everything
> else, online embedding is cheaper than the RAM it would take.
>
> Enable it **persistently** with `scripts/install.sh --local-embedder` (or
> `MANTLE_LOCAL_EMBEDDER=1` on the one-line installer): that adds
> `local-embedder` to `COMPOSE_PROFILES` in `.env`, so every later
> `docker compose pull/up` — including the built-in updater — keeps it. Then
> select provider `local` in Settings → Embedding. A one-off
> `docker compose --profile local-embedder up -d` also works but does NOT
> survive updates; prefer the flag. Turn it back off with
> `scripts/install.sh --no-local-embedder`.

> **Back up two things:** the `data/` directory (it IS your brain — DB,
> object store, files) and the `.env` file (`MANTLE_MASTER_KEY` decrypts
> your stored API keys; lose it and the vault is unrecoverable).
> Scheduled DB backups are built in: `/settings/backups`.

### Manual install (no script)

Grab the `mantle-deploy-<version>.tar.gz` bundle from the
[releases page](https://github.com/crossworks-engineering/mantle/releases),
unpack it, and run the bundled configurator:

```bash
bash scripts/install.sh              # interactive (asks how it should be reached)
bash scripts/install.sh --domain mantle.example.com -y   # scripted, HTTPS
bash scripts/install.sh --localhost -y                   # scripted, loopback only
bash scripts/install.sh --lan -y                         # scripted, HTTP on the network
bash scripts/install.sh --check     # health-check an existing install
```

Fully by hand instead: `cp .env.prod.example .env`, fill in the two
mandatory secrets (each has its `openssl rand` one-liner next to it), set
**`MANTLE_STACK_DIR`** to this directory's host-absolute path
(`MANTLE_STACK_DIR=$(pwd -P)` — without it the in-app updater can't run),
set `MANTLE_SERVER_ORIGIN` to your public origin (the owner UI reaches the
API over HTTP and needs an absolute address), then bring up **both** stacks
and the front door:

```bash
cp infra/caddy/Caddyfile.same-origin infra/caddy/Caddyfile
docker compose up -d --wait
docker compose -f docker-compose.client.yml --project-directory . up -d --wait
docker compose up -d --force-recreate caddy   # now that client-web exists
```

Skipping the second stack leaves a healthy backend with **no interface** —
sign-up lives in the owner UI, so the server app alone will only show you a
"this has moved" card. The bundle and the images are versioned together — a
release's compose always matches its images, and the two images are lockstep
on one `MANTLE_IMAGE_TAG`.

## Updating

Releases are tagged `vX.Y.Z`; every release publishes the image to Docker
Hub (`titanwest/mantle:vX.Y.Z` + `latest`, amd64 + arm64) and attaches the
matching deploy bundle.

> **Two upgrades need their own runbook — a routine `pull` will not do them:**
>
> - **v0.202.x — the server/client split.** Mantle now ships TWO images
>   (`mantle-server` + `mantle-client`) and the front door gains routing.
>   Follow [`upgrading-to-v0.202.md`](./upgrading-to-v0.202.md) (env, compose
>   adoption, start order, Caddy).
> - **PostgreSQL 17 → 18.** A new major refuses to start on an old major's
>   data directory. Follow [`postgres-18-upgrade.md`](./postgres-18-upgrade.md)
>   — and note its warning about scheduled backups needing v0.202.1+.
>
> Do them on separate days, verifying in between.

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

## Checking an install

```bash
bash scripts/install.sh --check
```

Reports every container in both stacks, then proves the app is actually
serving. Worth knowing what that means, because the obvious version of this
check is misleading:

- It probes the **front door** — the address you'd actually open — not the
  loopback debug port. An install whose Caddy serves nothing can otherwise pass
  on a port only reachable from the box itself.
- It confirms **Mantle** is what answered, by reading `/api/auth/bootstrap-state`
  rather than trusting a status code. A leftover container or a stray dev server
  on the same port answers a bare probe happily — and Mantle's own root response
  is a `307` to `/login`, so a status code cannot tell them apart.
- It fails a container that is running but **attached to no network**, or one
  whose **published port never bound**. Docker abandons a container's entire
  network setup when it can't program a published port; the container keeps
  running and keeps reporting healthy — its healthcheck only probes inside
  itself — while being unable to reach postgres or be reached by Caddy.

## Adding HTTPS later

Started without a domain and want one? Point DNS at the box, open 80/443,
then re-run the configurator with the domain:

```bash
cd mantle
bash scripts/install.sh --domain mantle.example.com -y
```

It verifies the records actually point at this server **before** letting
Caddy request a certificate (so a DNS typo can't burn Let's Encrypt
attempts), sets `MANTLE_SITE_ADDRESS` + `MANTLE_PUBLIC_URL`, restarts what
changed, and re-runs the sanity check. Your secrets are untouched — re-runs
never rotate an existing key.

Going the other way — a domain back to loopback, say for a box you'll only
tunnel into — is the same command with `--localhost`.

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

- **Multi-tenancy.** Mantle is one brain per install. It takes more than one
  **login** (Settings → Logins) — a second way *in*, not a second world: every
  login is a peer with identical access to the same brain, the same data and
  the same settings, distinguished only by the audit trail. Anyone who needs
  their own content gets their own stack.

  Worth stating plainly because assuming otherwise has produced real bugs:
  treating a login as an account with its own world gave us per-login brand
  preferences written to a row nothing read (v0.205.4), and per-login
  onboarding that walked an added login into the first-run wizard (v0.205.5).
  A new preference must answer "does this describe the BRAIN or the PERSON?" —
  `BRAIN_PREFERENCE_KEYS` + `packages/content/src/brain-preferences.test.ts`
  force the question. The trust boundary that DOES separate people is
  contacts/members ([team-chat.md](team-chat.md)), not logins.
