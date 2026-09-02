# Installation

Mantle is **self-hosted**: you run it on your own machine. You have two options:

- **On a Linux server (recommended)**: always-on, reachable from anywhere, HTTPS.
- **Locally** on your Mac/Linux desktop, quickest to try, and how you'd develop it.

> **Why a server is the better home.** Mantle is most useful when it's *always
> running*: that's what lets it sync your email, answer on Telegram, fire event
> reminders, and run proactive [heartbeats](04-configuring/03-heartbeats.md) while
> you're away, and reach you on your phone. A laptop sleeps, changes networks, and
> isn't reachable from outside your house, so background ingest and reminders stall.
> Run it locally to try it out or to develop; run it on a small server for real use.

The authoritative, command-by-command operator runbooks live in the developer docs:
[deploy](../deploy.md) (first-time server deploy) and
[update-prod](../update-prod.md) (updating). This page is the orientation.

---

## What you need

**For a server (the recommended path):**

- A **Linux server** (a small VPS is plenty) with **Docker** (Engine + the Compose
  plugin). That's it, Postgres, object storage, and the document parser all run as
  containers the installer pulls; you don't install them. (An optional **local
  embedding model** is bundled too, behind the `local-embedder` compose profile.)
- A **domain name** with a DNS A record pointing at the server, and ports **80/443**
  open, *if* you want automatic HTTPS. HTTPS is handled by the bundled **Caddy**
  reverse proxy (Let's Encrypt); you don't configure certificates by hand. You can
  also run on plain `http://<ip>` without a domain to try it.
- A **model provider API key**: an **OpenRouter** key covers the whole text + vision
  brain (the assistant, extraction, search). You add it during the in-app onboarding
  wizard, not in a file. Embeddings (meaning-search) default to an **online model**
  chosen in the wizard's Memory step (`text-embedding-3-large`, reduced to 768 dims)
  and run on that same OpenRouter key (or an OpenAI key, if you prefer direct). A
  keyless **local** embedder is available as the advanced opt-in for keeping vectors
  on the box.

**For local development, additionally:** **Git** and **Node.js 24+ and pnpm**.
**[Ollama](https://ollama.com)** is only needed if you opt into the local embedder
(the dev stack doesn't bundle it; see below).

You do **not** need to install Postgres, pgvector, MinIO, Tika, or Ollama on a server,
they're part of the Docker stack the installer brings up.

---

## Installing on a Linux server

### The one-line installer (recommended)

On the server, run:

```bash
# Plain HTTP, served on the server's network (quickest):
curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh | bash

# …or with automatic HTTPS for a domain (point its DNS A record here + open 80/443 first):
MANTLE_DOMAIN=mantle.example.com \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh)"
```

> **Use the `bash -c "$(curl …)"` form for the domain.** In
> `MANTLE_DOMAIN=… curl … | bash`, the variable is set for `curl`, not for the
> `bash` on the right of the pipe, the script never sees it and installs on
> plain HTTP without a word of complaint.

The installer does everything: checks Docker, fetches the deploy bundle
(`docker-compose.yml`, the Caddy + Postgres init files, the updater script),
**generates your secrets** (`SESSION_SECRET`, `MANTLE_MASTER_KEY`,
`POSTGRES_PASSWORD`, `S3_SECRET_KEY`) into a `.env`, writes `MANTLE_STACK_DIR` so the
in-app updater works, pulls the images, and starts the stack. Migrations run
automatically before the app comes up. (The optional local embedding model, the
`local-embedder` compose profile, only downloads its ~300 MB model if you enable it.)

Before the ~2 GB pull it checks the things that break an install late and
expensively: free disk and memory, whether ports 80/443 are already taken, and,
for a domain, whether DNS actually points at this box. It ends on a
per-service health check, and if that check fails it says **"Installation
incomplete"** and exits non-zero rather than printing a URL that won't answer.

> ⚠ **Back up the generated `.env`.** `MANTLE_MASTER_KEY` encrypts your stored API
> keys, mailbox passwords, and secrets at rest, lose it and that vault is
> unrecoverable.

When it finishes it prints your URL. Open it and continue at
[First run](#first-run-create-your-account) below.

### How the brain is reached

The one-line command above is deliberately non-interactive, and without
`MANTLE_DOMAIN` it serves **plain HTTP on port 80 across the server's
network**, open `http://<server-ip>`. (On your own laptop that's
`http://localhost`; on a VPS it is not.)

Run the bundled configurator directly, on a fresh box, or again later to
change your mind, and it asks instead:

```bash
cd mantle && bash scripts/install.sh
```

```
  How should people reach this brain?

    1  A domain, with HTTPS       brain.example.com — the certificate issues itself
    2  This machine only          http://localhost — a laptop, or a box you tunnel into
    3  This machine's network     http://192.168.1.20 — LAN or VPN, no certificate
```

Each choice has a flag, for scripted installs:

| Choice | Flag | What it does |
|---|---|---|
| Domain + HTTPS | `--domain <host>` | Caddy obtains a Let's Encrypt certificate |
| This machine only | `--localhost` | binds the front door to `127.0.0.1` |
| This machine's network | `--lan` (or `--no-domain`) | HTTP on `:80`, every interface |
| Behind an existing proxy | `--behind-proxy` | plain HTTP on `127.0.0.1:8080`; your nginx/apache terminates TLS |

### If port 80 is already taken

Caddy needs its host ports, and a port it can't bind is not a small problem:
Docker abandons the container's whole network setup, so the front door comes up
with no network and serves nothing.

What the installer does depends on whether a certificate is involved:

- **No certificate** (`--localhost`, `--lan`): it moves on, 8080, then 8081,
  and so on, and tells you the address including the port. Nothing is lost;
  you just open `http://…:8080`.
- **A domain with HTTPS**: it stops, because moving is not survivable here.
  Let's Encrypt answers HTTP-01 on port **80** and TLS-ALPN-01 on **443**, both
  fixed by the ACME spec, on any other port no certificate can ever be issued.
  Interactively you're offered a re-check after freeing the port, or
  `--behind-proxy`; unattended it exits rather than building an install that
  will never get a certificate.

`--behind-proxy` is the answer when the box already runs nginx or apache:
Caddy serves plain HTTP on a loopback port and the existing proxy keeps :443.
Point it at `http://127.0.0.1:8080` and forward the `Host` header.

**"This machine only" genuinely means it.** It sets `MANTLE_BIND_ADDR=127.0.0.1`
so Caddy listens on loopback alone. This matters more than it sounds: a
published Docker port bypasses the host firewall, Docker writes its own DNAT
rules ahead of it, so on a laptop or a shared box, binding loopback is the
only thing that actually keeps the brain off the network.

Choosing a domain checks it **before** any certificate is requested: every A
and AAAA record is compared against this machine's public and local addresses.
If it doesn't point here you get a choice, re-check after fixing DNS, start on
plain HTTP for now, try a different domain, or stop, instead of Caddy
retrying a request that cannot succeed and burning that hostname's Let's
Encrypt rate limit. Unattended (`-y`), a record that doesn't point here falls
back to plain HTTP rather than proceeding into a doomed certificate request.

### Manual install (no installer script)

If you'd rather not pipe a script, do what it does by hand: get the deploy bundle
(clone the repo, or copy `docker-compose.yml`, `.env.prod.example`, and the `infra/`
directory onto the box), then:

```bash
cp .env.prod.example .env
$EDITOR .env
```

Fill in:

- `SESSION_SECRET`, `openssl rand -base64 48`
- `MANTLE_MASTER_KEY`, `openssl rand -base64 32` (**back it up; never change it**)
- `POSTGRES_PASSWORD`, `S3_SECRET_KEY`, strong random values
- `MANTLE_PUBLIC_URL`, your public origin, e.g. `https://mantle.example.com`
- `MANTLE_SITE_ADDRESS`, your domain (Caddy fetches the TLS cert for it), or `:80`
  for plain HTTP
- `MANTLE_BIND_ADDR`, which interface the front door listens on. Defaults to
  `0.0.0.0` (every interface); set `127.0.0.1` for a this-machine-only install
- `MANTLE_WEB_DEBUG_PORT`, host port for the loopback debug tunnel to the web
  container (default `3000`). Only for on-host debugging; Caddy never uses it.
  Change it if something already holds 3000, Docker drops a container's whole
  network when it can't publish a requested port, which leaves the app running
  but unreachable and unable to see the database
- `MANTLE_DATA_DIR`, where state is bind-mounted on disk (e.g. `/opt/mantle/data`)
- **`MANTLE_STACK_DIR`**: the **host-absolute path of this directory** (the one
  holding `docker-compose.yml` + `.env`): `MANTLE_STACK_DIR=$(pwd -P)`. The installer
  sets this for you; on a manual install you **must** set it, or the in-app updater
  (Settings → Updates) parks "unconfigured" and hangs.

Then bring it up:

```bash
docker compose pull
docker compose up -d --wait
```

A one-shot gate runs migrations + creates the object-store bucket before the app
starts; Caddy fetches an HTTPS certificate on first run. Continue at First run.

> **Leave `ALLOWED_USER_ID` blank for a fresh install**: the runtime auto-resolves
> your single account once you sign up. Only set it when *importing an existing
> brain*, in which case reuse the **same** `MANTLE_MASTER_KEY` and `ALLOWED_USER_ID`
> as the source, or the encrypted data won't decrypt. (See the
> [deploy runbook](../deploy.md).)

---

## Running locally (for trying it out or developing)

```bash
git clone <your mantle repo> mantle
cd mantle
pnpm install
cp .env.example server/web/.env.local      # NOTE: server/web/.env.local, not the repo root
$EDITOR server/web/.env.local              # set the two secrets below
```

Set in `server/web/.env.local`:

- `MANTLE_MASTER_KEY`, `openssl rand -base64 32`
- `SESSION_SECRET`, `openssl rand -base64 48`

`DATABASE_URL` and the `S3_*` values are pre-filled to match the dev containers, so a
fresh install usually doesn't touch them. Then start (the local embedder is
optional; the default embedder is online, chosen in the onboarding Memory step):

```bash
brew install ollama && brew services start ollama   # optional: local embedder (opt-in)
ollama pull embeddinggemma                           # the keyless local path, not the default
pnpm start                                           # NOT `pnpm up` — see note
```

> `pnpm start` is the one command: it checks Docker, brings up Postgres + object
> storage, **creates the storage bucket**, runs migrations, and starts the app +
> workers. Use `pnpm start`, **not `pnpm up`**: pnpm treats `up` as its built-in
> alias for `update` (it would update dependencies, not start the stack).

Open **http://localhost:3000** and continue at First run. Remember the laptop caveat
above, for email/Telegram ingest and reminders to keep working, put it on a server.

---

## First run: create your account

There is **no manual database step**: Mantle has a real signup flow now.

1. Open your URL. While no account exists yet, the first visit shows **"Create your
   account."** Sign up. (Signup closes automatically once the first account exists,
   it's a single-owner brain.)
2. The **onboarding wizard** takes over: it takes your **OpenRouter API key**, lets
   you pick your models and your embedder (the Memory step), provisions the
   assistant + specialists + workers, runs a sanity check, captures your brain's
   purpose and your assistant's personality, and optionally wires Telegram, all in
   the interface. Completing it leaves a working brain that can answer immediately.

That's it. No `psql`, no `ALLOWED_USER_ID` to fill in.

---

## State & backups

Everything that holds state, the database, object storage, your files, backups,
mini-app databases, TLS certificates, and (if enabled) the local embedder's models,
lives under `MANTLE_DATA_DIR` on the host (default `./data`; no named Docker volumes),
so **a backup is a database dump plus a copy of that directory**. Updating later is `docker compose pull && docker compose up -d
--wait`, or one click in **Settings → Updates**: see the
[update runbook](../update-prod.md). (Self-builders who run their own image build on
the server rebuild instead of pulling; the architectures differ from a Mac build.)

---

## After it's running

Head to [Getting started](01-getting-started.md) to meet the assistant and add your
first knowledge, then connect [email](03-using/02-email-inbox-and-contacts.md) and
Telegram so the brain starts filling up.
