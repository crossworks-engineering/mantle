# Run from source

Run the brain from a git checkout and the owner UI from the jackdaw repo, for working on Mantle itself.

This repo is the brain only: it serves the API on `http://localhost:3000` and has no screens. For everyday use, install on a [server](03-server.md) instead. A laptop sleeps, so email sync and reminders stop with it.

## Before you start

- Node.js 26 or newer
- Docker, running (the database, object store and Tika run in containers)
- Git

## Start the brain

1. Get the code and the pinned pnpm:

   ```bash
   git clone https://github.com/crossworks-engineering/mantle && cd mantle
   corepack enable && corepack prepare pnpm@11.28.5 --activate
   pnpm install
   ```

2. Create the env file. It goes in `server/web`, not the repo root:

   ```bash
   cp .env.example server/web/.env.local
   ```

3. In `server/web/.env.local`, set three values:

   | Variable | Value |
   |---|---|
   | `MANTLE_MASTER_KEY` | the output of `openssl rand -base64 32` |
   | `SESSION_SECRET` | the output of `openssl rand -base64 48` |
   | `MANTLE_API_CORS_ORIGINS` | `http://localhost:3001`, so the UI below can call the brain |

4. Start everything:

   ```bash
   pnpm start
   ```

   It starts the containers, runs the database migrations, and starts the API, MCP server and workers. Use `pnpm start`, not `pnpm up`: pnpm treats `up` as `update`.

## Start the UI

1. In another terminal, next to the mantle checkout:

   ```bash
   git clone https://github.com/crossworks-engineering/jackdaw && cd jackdaw
   pnpm install
   echo "MANTLE_REMOTE=http://localhost:3000" > client/web/.env.detached.local
   pnpm dev:fe --port 3001
   ```

2. Open `http://localhost:3001` and [create your account](../02-first-steps/01-create-account.md). A dev brain asks for no setup code.

## Daily commands

Run these in the mantle checkout:

| Command | What it does |
|---|---|
| `pnpm start` | Start from cold: containers, migrations, servers |
| `pnpm dev` | Servers only, when the containers already run |
| `pnpm stop` | Stop the containers and keep the data |
| `pnpm reset` | Wipe the dev brain and rebuild it (asks first, backs up first) |

## Next

- [Create your account](../02-first-steps/01-create-account.md)
- [Architecture](../04-concepts/07-architecture.md)
