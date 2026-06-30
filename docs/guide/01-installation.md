# Installation

Mantle is **self-hosted** — you run it on your own machine. You have two options:

- **On a Linux server (recommended)** — always-on, reachable from anywhere, HTTPS.
- **Locally** on your Mac/Linux desktop — quickest to try, and how you'd develop it.

> **Why a server is the better home.** Mantle is most useful when it's *always
> running*: that's what lets it sync your email, answer on Telegram, fire event
> reminders, and run proactive [heartbeats](04-configuring/03-heartbeats.md) while
> you're away — and reach you on your phone. A laptop sleeps, changes networks, and
> isn't reachable from outside your house, so background ingest and reminders stall.
> Run it locally to try it out or to develop; run it on a small server for real use.

The authoritative, command-by-command operator runbooks live in the developer docs:
[deploy](../deploy.md) (first-time server deploy) and
[update-prod](../update-prod.md) (updating). This page is the orientation.

---

## What you need

**For a server (the recommended path):**

- A **Linux server** (a small VPS is plenty) with **Docker** (Engine + the Compose
  plugin). That's it — Postgres, object storage, the document parser, and the local
  embedding model all run as containers the installer pulls; you don't install them.
- A **domain name** with a DNS A record pointing at the server, and ports **80/443**
  open — *if* you want automatic HTTPS. HTTPS is handled by the bundled **Caddy**
  reverse proxy (Let's Encrypt); you don't configure certificates by hand. You can
  also run on plain `http://<ip>` without a domain to try it.
- A **model provider API key** — an **OpenRouter** key covers the whole text + vision
  brain (the assistant, extraction, search). You add it during the in-app onboarding
  wizard, not in a file. Embeddings (meaning-search) run **locally and free** via a
  bundled model, so no key is needed for those.

**For local development, additionally:** **Git**, **Node.js 24+ and pnpm**, and
**[Ollama](https://ollama.com)** (the local embedder for dev — the dev stack doesn't
bundle it; see below).

You do **not** need to install Postgres, pgvector, MinIO, Tika, or Ollama on a server —
they're part of the Docker stack the installer brings up.

---

## Installing on a Linux server

### The one-line installer (recommended)

On the server, run:

```bash
# Plain HTTP on the server's IP (quickest):
curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh | bash

# …or with automatic HTTPS for a domain (point its DNS A record here + open 80/443 first):
MANTLE_DOMAIN=mantle.example.com \
  curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh | bash
```

The installer does everything: checks Docker, fetches the deploy bundle
(`docker-compose.yml`, the Caddy + Postgres init files, the updater script),
**generates your secrets** (`SESSION_SECRET`, `MANTLE_MASTER_KEY`,
`POSTGRES_PASSWORD`, `S3_SECRET_KEY`) into a `.env`, writes `MANTLE_STACK_DIR` so the
in-app updater works, pulls the images, and starts the stack. Migrations run
automatically before the app comes up, and the embedding model pulls once (~300 MB).

> ⚠ **Back up the generated `.env`.** `MANTLE_MASTER_KEY` encrypts your stored API
> keys, mailbox passwords, and secrets at rest — lose it and that vault is
> unrecoverable.

When it finishes it prints your URL. Open it and continue at
[First run](#first-run-create-your-account) below.

### Manual install (no installer script)

If you'd rather not pipe a script, do what it does by hand: get the deploy bundle
(clone the repo, or copy `docker-compose.yml`, `.env.prod.example`, and the `infra/`
directory onto the box), then:

```bash
cp .env.prod.example .env
$EDITOR .env
```

Fill in:

- `SESSION_SECRET` — `openssl rand -base64 48`
- `MANTLE_MASTER_KEY` — `openssl rand -base64 32` (**back it up; never change it**)
- `POSTGRES_PASSWORD`, `S3_SECRET_KEY` — strong random values
- `MANTLE_PUBLIC_URL` — your public origin, e.g. `https://mantle.example.com`
- `MANTLE_SITE_ADDRESS` — your domain (Caddy fetches the TLS cert for it), or `:80`
  for plain HTTP
- `MANTLE_DATA_DIR` — where state is bind-mounted on disk (e.g. `/opt/mantle/data`)
- **`MANTLE_STACK_DIR`** — the **host-absolute path of this directory** (the one
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

> **Leave `ALLOWED_USER_ID` blank for a fresh install** — the runtime auto-resolves
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
cp .env.example apps/web/.env.local      # NOTE: apps/web/.env.local, not the repo root
$EDITOR apps/web/.env.local              # set the two secrets below
```

Set in `apps/web/.env.local`:

- `MANTLE_MASTER_KEY` — `openssl rand -base64 32`
- `SESSION_SECRET` — `openssl rand -base64 48`

`DATABASE_URL` and the `S3_*` values are pre-filled to match the dev containers, so a
fresh install usually doesn't touch them. Then install the local embedder and start:

```bash
brew install ollama && brew services start ollama   # dev stack doesn't bundle Ollama
ollama pull embeddinggemma                           # local, free semantic search
pnpm start                                           # NOT `pnpm up` — see note
```

> `pnpm start` is the one command: it checks Docker, brings up Postgres + object
> storage, **creates the storage bucket**, runs migrations, and starts the app +
> workers. Use `pnpm start`, **not `pnpm up`** — pnpm treats `up` as its built-in
> alias for `update` (it would update dependencies, not start the stack).

Open **http://localhost:3000** and continue at First run. Remember the laptop caveat
above — for email/Telegram ingest and reminders to keep working, put it on a server.

---

## First run: create your account

There is **no manual database step** — Mantle has a real signup flow now.

1. Open your URL. While no account exists yet, the first visit shows **"Create your
   account."** Sign up. (Signup closes automatically once the first account exists —
   it's a single-owner brain.)
2. The **onboarding wizard** takes over: it captures your name and your brain's
   purpose, takes your **OpenRouter API key**, provisions the assistant + specialists
   + workers, runs a sanity check, and optionally wires email and Telegram — all in
   the interface. Completing it leaves a working brain that can answer immediately.

That's it. No `psql`, no `ALLOWED_USER_ID` to fill in.

---

## State & backups

Everything that holds state — the database, object storage, and your files — lives
under `MANTLE_DATA_DIR` on the host, so **a backup is a database dump plus a copy of
that directory**. Updating later is `docker compose pull && docker compose up -d
--wait`, or one click in **Settings → Updates** — see the
[update runbook](../update-prod.md). (Self-builders who run their own image build on
the server rebuild instead of pulling; the architectures differ from a Mac build.)

---

## After it's running

Head to [Getting started](01-getting-started.md) to meet the assistant and add your
first knowledge — then connect [email](03-using/02-email-inbox-and-contacts.md) and
Telegram so the brain starts filling up.
