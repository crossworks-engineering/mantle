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
[deploy](/docs/system/deploy.md) (first-time server deploy) and
[update-prod](/docs/system/update-prod.md) (updating). This page is the orientation.

---

## What you need

**Both local and server:**

- **Docker** (Engine + the Compose plugin). Mantle runs Postgres, object storage,
  the document parser, and (optionally) the local embedding model as containers —
  you don't install those individually.
- **Git** — to get the code.
- **Node.js 24+ and pnpm** — to run the dev stack locally, and to build the image
  on a server.
- **A model provider API key** — an **OpenRouter** key covers the whole text +
  vision brain (the assistant, extraction, search). Add it in-app later under
  Settings → API keys. Embeddings (meaning-search) run **locally and free** via a
  bundled model, so no key is needed for those.

**For a server (production), additionally:**

- A **Linux server** (a small VPS is plenty). Builds run natively on the box.
- A **domain name** with a DNS record pointing at the server, and ports **80/443**
  open. HTTPS is handled automatically by the bundled **Caddy** reverse proxy
  (Let's Encrypt) — you don't configure certificates by hand.

You do **not** need to install Postgres, pgvector, MinIO, Tika, or Ollama yourself —
they're part of the Docker stack.

---

## Configuration (the `.env` file)

Mantle reads its settings from an env file. Copy the template and fill it in:

```bash
cp .env.example .env.local      # then edit .env.local
```

The file is self-documenting; the values that matter most:

- `SESSION_SECRET` — signs your login cookie. Generate: `openssl rand -base64 48`.
- `MANTLE_MASTER_KEY` — the encryption key for everything sealed at rest (API keys,
  secrets, mailbox passwords). Generate: `openssl rand -base64 32`. **Back this up
  and never change it** — losing it means losing the encrypted vault.
- `ALLOWED_USER_ID` — the UUID of your single user (you create it in the next step).
- `DATABASE_URL`, `S3_*` — storage connection (defaults match the bundled containers).
- `MANTLE_FILES_ROOT`, `MANTLE_DOCS_ROOT` — **absolute** paths shared by every
  process (your files tree and the docs folder).
- `NEXT_PUBLIC_APP_URL` — where the app is reached (`http://localhost:3000` locally;
  your `https://…` domain on a server).

> Single-user by design: there is **no signup screen**. You create your one account
> directly in the database (below), then put its UUID in `ALLOWED_USER_ID`.

---

## Running locally

For trying Mantle out or developing it:

```bash
git clone <your mantle repo> mantle
cd mantle
pnpm install
cp .env.example .env.local        # fill in the secrets above
pnpm up
```

`pnpm up` is the one command: it checks Docker, brings up Postgres + object storage,
creates the storage bucket, runs database migrations, and starts the app + workers.
Then:

1. **Create your user** — there's no signup, so insert a row into `auth.users` with
   a bcrypt password hash (via `psql`), and copy its UUID into `ALLOWED_USER_ID`.
2. **(Recommended) local embeddings** — install [Ollama](https://ollama.com) and
   pull the embedding model so semantic search runs free and private:
   `ollama pull embeddinggemma`.
3. Open **http://localhost:3000** and log in.
4. Add an **OpenRouter** key under Settings → API keys so the assistant and indexing
   can run.

That's enough to explore. But remember the laptop caveat above — for email/Telegram
ingest and reminders to actually keep working, put it on a server.

---

## Installing on a Linux server

The production path is the full Docker Compose stack behind Caddy. In outline (the
exact commands are in the [deploy runbook](/docs/system/deploy.md)):

1. **Prepare the box** — install Docker (Engine + Compose plugin) and git; open
   ports 80/443; point your domain's DNS at the server.
2. **Get the code** — clone the repo onto the server. Builds run **natively on the
   server** (don't build on a Mac and ship the image — the architectures differ).
3. **Configure `.env`** — set the same secrets as above, but with production values:
   your `https://your-domain` for `NEXT_PUBLIC_APP_URL`, a strong `POSTGRES_PASSWORD`
   and `S3_SECRET_KEY`, `MANTLE_SITE_ADDRESS` (your domain, which Caddy uses to fetch
   the TLS certificate), and `MANTLE_DATA_DIR` (where Postgres, object storage, and
   your files are bind-mounted on disk so they survive container rebuilds).
   - **If you're migrating from a local install,** reuse the **same**
     `MANTLE_MASTER_KEY` and `ALLOWED_USER_ID`, or the encrypted data you bring over
     won't decrypt.
4. **Bring it up** — `docker compose build` then `docker compose up -d`. A one-shot
   migration step runs automatically before the app starts; Caddy fetches an HTTPS
   certificate for your domain on first run.
5. **Create your user** (same `auth.users` insert as local) and log in at your
   domain.
6. **Embeddings** run on the bundled local model out of the box; add an **OpenRouter**
   key under Settings → API keys for the assistant + extraction.

Everything that holds state — the database, object storage, and your files — lives
under `MANTLE_DATA_DIR` on the host, so **backups are a database dump plus a copy of
that directory**. Updating later is "pull the code, rebuild, restart" — see the
[update runbook](/docs/system/update-prod.md).

---

## After it's running

Head to [Getting started](01-getting-started.md) to meet the assistant and add your
first knowledge — then connect [email](03-using/02-email-inbox-and-contacts.md) and
Telegram so the brain starts filling up.
