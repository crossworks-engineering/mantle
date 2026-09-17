# Installation

This is the one install page. Everything else that mentions installing Mantle
points here.

Mantle is **self-hosted**: you run it on your own machine. Two paths:

- **On a Linux server (recommended)**: always-on, reachable from anywhere, HTTPS.
- **A developer checkout** on your Mac or Linux desktop, for hacking on it.

> **Why a server is the better home.** Mantle is most useful when it is *always
> running*: that is what lets it sync your email, answer on Telegram, fire event
> reminders, and run proactive [heartbeats](04-configuring/03-heartbeats.md) while
> you are away. A laptop sleeps, changes networks, and is not reachable from
> outside your house, so background ingest and reminders stall. Run it on a small
> server for real use.

---

## What you get: two stacks

Since the 2026-08 repo split a Mantle install is **two Docker Compose projects**
on one box, sharing one `.env`:

| Project | File | What it runs |
|---|---|---|
| `mantle` | `docker-compose.yml` | the **brain**: Postgres, MinIO, the API and MCP server, the ingest workers, Caddy (the front door), the updater and autoheal sidecars, Tika and a headless browser for documents. Image `titanwest/mantle-server`. |
| `mantle-client` | `docker-compose.client.yml` | the **owner UI**: one small container, image `titanwest/mantle-client`, built from the separate [jackdaw](https://github.com/crossworks-engineering/jackdaw) repo. Sign-up and every owner screen live here. |

The installer brings up both and points Caddy at them on one address,
path-routed: `/api`, `/s` and `/print` go to the brain, everything else
(including sign-up) goes to the UI. **Skip the second project and you have a
healthy brain with no screen**: the first visit shows a "this has moved" card and
there is no way to create an account. That is only what you want for a deliberate
headless box driven over MCP or the API (`--no-client`).

The brain stack defines 26 services. A default full install starts 23 of them
plus the client container: the video/CAD sidecar and the local embedder stay off
unless you turn them on (below).

---

## What you need

- A **Linux server** with **Docker Engine + the Compose plugin**
  (`docker compose version` works), plus `openssl` and `curl`. Postgres, object
  storage and the document parser all run as containers the installer pulls.
- **Disk**: under 5 GB free the installer stops; under 20 GB it warns. The
  first pull is about 2 GB of images. 40 GB is comfortable once documents and
  backups grow.
- **RAM**: the installer warns below 3.5 GB. Be realistic about the shape:
  - the **full shape** (every worker, Tika, the PDF browser) has memory caps that
    sum to roughly 15 GB. Caps are ceilings, not reservations, so it boots on
    less, but under real ingest load it wants 8 GB or more.
  - the **core shape** (`--core`) is built for a 2 vCPU / 4 GB box: API, MCP,
    share pages, file and docs ingest, backups. It sheds the channel workers and
    the doc helpers. Measured sizing is in [deploy.md](../deploy.md) §0a.
- For automatic HTTPS: a **domain** with an A record pointing at the server and
  ports **80/443** open. Without one you get plain HTTP on the server's network.
- A **model provider key**. One **OpenRouter** key runs chat, extraction, search,
  embeddings, voice and vision. You paste it into the onboarding wizard after
  install, never into a file.

---

## Install with the one-liner

On the server:

```bash
curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh | bash
```

### It asks questions

When a terminal is attached the installer **prompts** (it reads `/dev/tty`, so
`curl | bash` still asks). On a fresh box it asks, in order:

1. **How the brain is reached**: a domain with HTTPS (the default answer), this
   machine only (`http://localhost`), or this machine's network (`http://<ip>`).
   A domain is checked against this box's addresses *before* any certificate is
   requested, so a DNS typo cannot burn the Let's Encrypt rate limit.
2. **Shape**: the full stack, or the small core shape (offered as the default when
   the box has under 6 GB of RAM). On a core box it also asks about the doc helpers.
3. **CLI sandboxes**: default yes on the full shape, no on core.
4. **The local embedder**: default no.
5. **The owner web UI**: default yes.

Then it shows a review table and asks "Go ahead?". A re-run on an existing box
skips the component questions and keeps `.env` as it is; change a component
later with the flags listed under `scripts/install.sh --help`.

### Silent installs

Set `MANTLE_YES=1` (or run with no terminal, as CI does) and it asks nothing:
plain **HTTP on port 80 across the machine's network**, full shape, sandboxes
on, online embeddings, UI on. Give it a domain and it enables HTTPS instead:

```bash
# Silent, HTTPS on a domain (point the A record here and open 80/443 first):
MANTLE_YES=1 MANTLE_DOMAIN=mantle.example.com \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh)"
```

> **Use the `bash -c "$(curl …)"` form when you pass variables.** In
> `MANTLE_DOMAIN=… curl … | bash` the variable is set for `curl`, not for the
> `bash` on the right of the pipe, so the script never sees it. Exporting first
> works too.

### What it fetches

The default channel is the **latest release tag**: the installer downloads that
release's signed deploy bundle and verifies it against `SHA256SUMS`, then pins
the image tag to the same version so compose and image can never drift apart.
`MANTLE_CHANNEL=main` (or any branch) switches to an unverified file-by-file
fetch of the current tree, for testing unreleased changes.

The bundle is `docker-compose.yml`, `docker-compose.client.yml`,
`docker-compose.core.yml`, `.env.prod.example`, the Caddyfile and its shapes, the
Postgres init SQL, the updater script, and the operator scripts (`install`,
`sanity`, `db-dump`, `db-restore`, `compose-adopt`, `uninstall`). Each gets a
`.release` baseline so the in-app updater can refresh it on later releases.

### Environment variables it honours

| Variable | Effect |
|---|---|
| `MANTLE_HOME` | install directory (default `./mantle`) |
| `MANTLE_DOMAIN` | serve this hostname with automatic HTTPS |
| `MANTLE_CHANNEL` | release tag or branch to fetch (default: latest release) |
| `MANTLE_YES=1` | never prompt; take the defaults above |
| `MANTLE_SKIP_START=1` | write `.env` and the bundle, do not pull or start |
| `MANTLE_LOCAL_EMBEDDER=1` | bundle the local embedder (see Embeddings) |
| `MANTLE_SANDBOXES=0` / `1` | force CLI sandboxes off or on |
| `MANTLE_CORE=1` | install the core shape |
| `MANTLE_CLIENT=0` | headless: no owner UI, no sign-up screen |

The same choices exist as flags on the bundled configurator, which the
one-liner delegates to and which you re-run later to change a box
(`scripts/install.sh --domain …`, `--core`, `--no-sandboxes`, `--local-embedder`,
`--no-client`, `--check`).

### What it does

Checks Docker, disk, memory and whether ports 80/443 are free. Generates the
secrets that are missing (`MANTLE_MASTER_KEY`, `SESSION_SECRET`,
`POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) into a mode-600 `.env`;
a re-run never rotates an existing master key. Writes `MANTLE_SERVER_ORIGIN`
(the address the browser reaches the API on), `MANTLE_CADDY_SHAPE=same-origin`,
`MANTLE_STACK_DIR` (needed by the in-app updater) and `MANTLE_DATA_DIR`. Pulls
the images, brings the brain up through the migrate gate, brings the client up,
recreates Caddy so it can route to the client, then runs a per-service sanity
check. If that check fails it prints **"Installation incomplete"** and exits
non-zero rather than a URL that will not answer.

> **Back up the generated `.env`.** `MANTLE_MASTER_KEY` encrypts your stored
> API keys and mailbox passwords at rest. Lose it and that vault is unrecoverable.

When it finishes it prints the address to open. Continue at
[First run](#first-run-create-your-account).

### If port 80 is already taken

Without a certificate (`--localhost`, `--lan`) the front door moves to 8080,
8081 and so on, and every printed address carries the port. With a domain it
stops instead: Let's Encrypt answers HTTP-01 on port 80 and TLS-ALPN-01 on 443,
so on any other port no certificate can be issued. You are offered a re-check
after freeing the port, or `--behind-proxy`: Caddy on a loopback port while your
existing nginx or apache keeps 443 and forwards to `http://127.0.0.1:8080` with
the `Host` header.

**"This machine only" means it.** It sets `MANTLE_BIND_ADDR=127.0.0.1`. A
published Docker port bypasses the host firewall (Docker writes its own DNAT
rules), so binding loopback is the only thing that actually keeps a laptop
brain off the network.

---

## Sandboxes

**On by default on a fresh full install** (off by default on a core box). The
`sandboxes` compose profile adds one service, `sandboxd`, which holds the Docker
socket and creates isolated containers for the coder agent to work in. The
installer generates `SANDBOXD_TOKEN`, sets `MANTLE_SANDBOXES_HOST_DIR` to
`<data-dir>/sandboxes` (host-absolute, a hard requirement), and pre-pulls the
base image `titanwest/mantle-sandbox:24.04-v2`.

Nothing is installed on the host. Sandboxes are hardened runc containers
(`cap-drop ALL`, `no-new-privileges`, 1 GB RAM, 1 CPU, 512 pids each), on their
own bridge network with no route to Postgres, MinIO or the app. Limits default
to 3 sandboxes and a 10 GB disk budget.

Turn them off at install with `--no-sandboxes` (or `MANTLE_SANDBOXES=0` on the
one-liner), or later with `scripts/install.sh --no-sandboxes`. Existing boxes
never gain sandboxes on a re-run; enable them deliberately with `--sandboxes`.
Full detail: [sandboxes.md](../sandboxes.md).

---

## Media: video ingest and CAD

Video ingest (`video_ingest`: paste a link, get a searchable transcript) and CAD
drawing ingest (DWF, DWG, DXF) need the **media sidecar**: the `media` compose
profile runs the `titanwest/mantle-media` image (yt-dlp, ffmpeg and the DWG
tools) behind a bearer token. **The installer does not enable it and does not
set the token.** Without it those two features are unavailable on a fresh box.

Turn it on in `.env` and bring it up:

```bash
# in .env
COMPOSE_PROFILES=sandboxes,media      # keep whatever profiles are already listed
MEDIA_SIDECAR_TOKEN=<openssl rand -hex 32>

docker compose --profile media up -d --wait
```

The image only exists from server v0.232.34, so update before enabling on an
older box. Full guide: [video-ingest.md](../video-ingest.md).

---

## Voice, vision and images

All ride the one OpenRouter key from the onboarding wizard: transcription,
spoken replies, image understanding and image generation are provider workers.
There is no local speech model and no host binary to install. Wizard step 4
offers an optional **xAI** key as a smoother voice route; skip it and voice
falls back to OpenRouter.

---

## Embeddings

**Online by default.** The wizard's Memory step selects `text-embedding-3-large`
reduced to 768 dimensions, on the same OpenRouter key (or an OpenAI key if you
prefer direct). No embedder is pulled or started.

The **local embedder** (Ollama + EmbeddingGemma, about 3.3 GB of image and
model) is opt-in through the `local-embedder` compose profile:
`MANTLE_LOCAL_EMBEDDER=1` on the one-liner or `scripts/install.sh
--local-embedder` later, then select provider `local` under Settings →
Embedding. It needs a big box: under multi-file ingest the CPU embedder degrades
the whole stack on a 16 GB / 8-core server. It does not fit a core box. See
[embeddings.md](../embeddings.md).

---

## Manual install (no installer script)

Download `mantle-deploy-<version>.tar.gz` from the
[releases page](https://github.com/crossworks-engineering/mantle/releases) and
unpack it. The easy manual path is to run the bundled configurator from there
(`bash scripts/install.sh`, interactive, or `--domain … -y` scripted). Fully by
hand instead, you need all three compose files plus `.env.prod.example` and
`infra/` on the box, then:

```bash
cp .env.prod.example .env
$EDITOR .env
```

Required (compose refuses to start without the first five):

- `POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`: strong random values
- `SESSION_SECRET`: `openssl rand -base64 48`
- `MANTLE_MASTER_KEY`: `openssl rand -base64 32` (**back it up; never change it**)
- `MANTLE_SITE_ADDRESS`: your domain (Caddy fetches the certificate), or `:80`
  for plain HTTP
- `MANTLE_PUBLIC_URL`: your public origin, e.g. `https://mantle.example.com`
- `MANTLE_SERVER_ORIGIN`: the origin the **browser** reaches the API on. The
  owner UI serves this to the page as its API base, so it must be the address
  people open, port included. Same value as the public URL on a domain install;
  `http://<ip>` on a LAN install.
- `MANTLE_CADDY_SHAPE=same-origin`: the front-door routing shape. Without it a
  fresh box routes nothing and nobody can reach sign-up.
- `MANTLE_STACK_DIR`: the host-absolute path of this directory
  (`MANTLE_STACK_DIR=$(pwd -P)`), or the in-app updater parks "unconfigured".
- `MANTLE_DATA_DIR`: where state is bind-mounted (default `./data`).

Optional: `MANTLE_BIND_ADDR=127.0.0.1` for a this-machine-only install,
`MANTLE_WEB_DEBUG_PORT` if something already holds 3000, `COMPOSE_PROFILES`
(`sandboxes`, `media`, `local-embedder`, `helpers`) and `SANDBOXD_TOKEN` /
`MEDIA_SIDECAR_TOKEN` for the profiles that need one.

Then bring up **both** stacks and recreate the front door:

```bash
docker compose pull && docker compose up -d --wait
docker compose -f docker-compose.client.yml --project-directory . pull
docker compose -f docker-compose.client.yml --project-directory . up -d --wait
docker compose up -d --force-recreate caddy      # now that client-web exists
bash scripts/install.sh --check                  # the same sanity check the installer runs
```

The one-shot `migrate` service runs migrations before any app service starts;
Caddy fetches its certificate on the first request.

> **Leave `ALLOWED_USER_ID` blank on a fresh install**: the runtime resolves your
> single account once you sign up. Only set it when importing an existing brain,
> together with the **same** `MANTLE_MASTER_KEY`, or the encrypted data will not
> decrypt. See the [deploy runbook](../deploy.md).

---

## First run: create your account

1. Open the address the installer printed. While no account exists the first
   visit shows **Create your account**. Sign up. Sign-up closes once the first
   account exists; it is a single-owner brain.
2. The **onboarding wizard** takes over: your OpenRouter key, model choices, the
   embedder, then it provisions the assistant, specialists and workers, runs a
   sanity check, captures the brain's purpose, and optionally pairs Telegram.

No `psql`, no `ALLOWED_USER_ID` to fill in.

---

## State, backups, updates

Everything that holds state lives under `MANTLE_DATA_DIR` on the host (default
`./data`): Postgres, MinIO, your files, backups, mini-app databases, Caddy's
certificates, and, when enabled, the local embedder's models and the Tailscale
node state. The only named Docker volume is the Tailscale socket. **A backup is a
database dump plus a copy of that directory plus `.env`.**

Updating is one click in **Settings → Updates**, which rolls both stacks to a
tested pairing, or by hand: `docker compose pull && docker compose up -d --wait`
for the brain, then the same for `docker-compose.client.yml`. Details, pinning
and rollback: [self-hosting.md](../self-hosting.md).

---

## The apps

- **Web**: the owner UI the installer started, at your brain's address.
- **Desktop**: the same UI in an Electron shell, from the jackdaw repo's
  [GitHub Releases](https://github.com/crossworks-engineering/jackdaw/releases).
  Each release ships a Debian package and AppImage for Linux, an arm64 dmg and
  zip for macOS, and a Windows installer. The macOS builds are unsigned:
  right-click → Open on first launch, and self-update is disabled there until
  signing lands. See [desktop.md](../desktop.md).
- **Mobile**: the companion app (jackdaw-mobile, Flutter) has no store listing
  or download yet; it is built from source and pairs by typing the brain's URL.

---

## Local development

This repo is the **brain only**. `pnpm start` runs the API, MCP server and
workers against Postgres, MinIO and Tika in Docker; it serves the API on
http://localhost:3000 and **no owner UI**. The UI is the separate
[jackdaw](https://github.com/crossworks-engineering/jackdaw) repo.

Prerequisites: **Node.js 26+**, **pnpm 11** (`corepack enable`), **Docker**
running, Git.

```bash
git clone https://github.com/crossworks-engineering/mantle && cd mantle
pnpm install
cp .env.example server/web/.env.local     # server/web/.env.local, not the repo root
$EDITOR server/web/.env.local             # MANTLE_MASTER_KEY + SESSION_SECRET
pnpm start                                # NOT `pnpm up`: pnpm aliases that to `update`
```

`DATABASE_URL` and the `S3_*` values are pre-filled to match the dev containers.
Then, in a second terminal, run the UI from the jackdaw checkout against this
brain:

```bash
git clone https://github.com/crossworks-engineering/jackdaw && cd jackdaw
pnpm install
pnpm dev:fe        # the owner UI, pointed at your brain by the env file it documents
```

The jackdaw README covers its env file and the pairing rule between client and
server versions. Sign-up and onboarding happen in that UI, exactly as on a server.
Remember the laptop caveat: for email and Telegram ingest and reminders to keep
working, put the brain on a server.

---

## After it is running

Head to [Getting started](01-getting-started.md) to meet the assistant and add
your first knowledge, then connect [email](03-using/02-email-inbox-and-contacts.md)
and Telegram so the brain starts filling up.
