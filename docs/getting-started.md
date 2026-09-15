# Getting started

The operator's setup guide: the developer checkout of the **brain**, first run,
connecting email and Telegram, API keys, and the agent basics. (Moved here from
the README, which is now the product front door.) Installing on a server is
[`guide/01-installation.md`](./guide/01-installation.md), the one canonical
install page; production sizing is in [`deploy.md`](./deploy.md) §0a; updating
a running box is [`update-prod.md`](./update-prod.md).

> **This repo is the brain only.** Since the 2026-08-13 split the owner UI
> (sign-up, onboarding, every owner screen) lives in the separate
> [jackdaw](https://github.com/crossworks-engineering/jackdaw) repo. `pnpm start`
> here gives you the API, the MCP server and the workers on
> http://localhost:3000, and no screen. Run the UI from a jackdaw checkout with
> `pnpm dev:fe` there, pointed at this brain.

## Layout

```
mantle/
├── infra/
│   ├── postgres/init/   # extensions + auth schema baked in at first container boot
│   ├── caddy/           # the release-owned Caddyfile + routing shapes
│   └── updater/         # the in-app updater sidecar's script
├── server/
│   ├── web/             # Hono HTTP API + MCP-over-HTTP + share/print pages; the workers live in workers/
│   ├── api/             # durable turn runners + the ingest listeners (summarize/extract/reflect)
│   ├── mcp/             # MCP server (stdio) for Claude Desktop / Claude Code
│   └── sandboxd/        # CLI-sandbox daemon (standalone image, holds the Docker socket)
├── packages/            # the shared logic: db, content, search, embeddings, runtime, tools, email, telegram, …
├── scripts/             # dev + operator scripts (up.sh, install.sh, db-dump.sh, …)
├── docker-compose.dev.yml    # Postgres + MinIO + Tika for local dev (the apps run on the host)
├── docker-compose.yml        # the production brain stack (26 services)
├── docker-compose.client.yml # the owner UI stack (image built by jackdaw)
└── docker-compose.core.yml   # override that shrinks the brain to the 4 GB core shape
```

## First-time setup

Prereqs: **Node.js 26+**, **pnpm 11.1.2** (the version pinned in
`package.json`'s `packageManager`, installed in step 1), and **Docker** (Desktop
or engine) running; `pnpm start` boots Postgres, MinIO and Tika in containers.

```bash
# 1. Install pnpm at the pinned version
corepack enable && corepack prepare pnpm@11.1.2 --activate

# 2. Install deps
pnpm install

# 3. Copy env (single file: the API, workers, MCP server and Drizzle all read it)
cp .env.example server/web/.env.local
$EDITOR server/web/.env.local
#  - MANTLE_MASTER_KEY  → openssl rand -base64 32
#  - SESSION_SECRET     → openssl rand -base64 48

# 4. (Optional) Local embedder — the product DEFAULT is an online embedder
#    (text-embedding-3-large @768, chosen in onboarding's Memory step on your
#    OpenRouter/OpenAI key). Install Ollama only if you want the opt-in local
#    path; the apps reach it at http://localhost:11434 by default.
brew install ollama
brew services start ollama    # serves on :11434 (or run the menu-bar app)
ollama pull embeddinggemma    # the 768-dim local embedder (opt-in)

# 5. Bring up the brain (Docker must be running)
pnpm start
```

> **`pnpm start`, not `pnpm up`.** `pnpm up` is a built-in alias for
> `pnpm update` (deps), so it shadows any script of the same name. Use
> `pnpm start` to bring the stack up (or `pnpm run up` if you prefer the old
> name). The collision is documented at <https://pnpm.io/cli/update>.

> **macOS embedder, why step 4 is optional.** The **default** embedder is
> online, onboarding's Memory step selects `text-embedding-3-large` (or the
> budget `text-embedding-3-small`), MRL-reduced to 768 dims, running via
> OpenRouter (reuses the chat key) or OpenAI direct, so most dev setups need
> **no Ollama at all**. The keyless **local** config (EmbeddingGemma) is the
> pre-onboarding fallback, so the app boots and chat works without any key,
> but until the Memory step completes (or you run Ollama natively and select
> the `local` provider), embeddings fail: uploaded content won't index and
> semantic search returns nothing. If you want the local path on a dev machine,
> run Ollama natively (faster, uses the Mac GPU); on Linux `curl -fsSL
> https://ollama.com/install.sh | sh`.

> **Dev vs production.** The steps above are the **local dev stack** (`pnpm start`:
> infra in Docker + the brain hot-reloading on the host). **Production runs on
> Linux** from the published images via `docker-compose.yml` plus
> `docker-compose.client.yml`; see the
> [install page](./guide/01-installation.md). The bundled local embedder is
> opt-in there too, behind the `local-embedder` compose profile.

`pnpm start` runs `scripts/up.sh`, which:

1. Brings up Postgres + MinIO + Tika via `docker-compose.dev.yml`
2. Ensures the `mantle` MinIO bucket exists
3. Runs Drizzle migrations against the fresh DB
4. Ensures the pg-boss schema exists (so the workers don't race to create it)
5. Starts the dev servers: `server/web`, `server/api`, `server/mcp` and every
   worker (email, telegram, files, docs, events, maintenance, runs, calendar,
   microsoft, push)

That's the brain. **Sign-up and the onboarding wizard live in the UI**, so now
run jackdaw against it:

```bash
git clone https://github.com/crossworks-engineering/jackdaw && cd jackdaw
pnpm install
pnpm dev:fe     # the owner UI against your brain; its README documents the env file
```

Open the address `pnpm dev:fe` prints and you'll land on **Create your account**
(the first-run signup, available only while `auth.users` is empty). After
signup, the **onboarding wizard** walks you through everything the brain needs
to run: a model key (OpenRouter), your model picks, an optional voice (xAI)
key, your embedder (the Memory step), then it provisions your assistant + the
background AI workers, runs a sanity check, captures the brain's purpose, and
lets you shape the assistant's personality. See [`onboarding.md`](./onboarding.md).
No SQL, no `ALLOWED_USER_ID` to fill in.

> `ALLOWED_USER_ID` is **optional**: left blank, the workers and MCP server
> auto-resolve the single `auth.users` row, so a fresh install is zero-config.
> Set it only for scripts or a multi-DB setup.

The scripts in the root `package.json`:

| Command               | What it does |
|-----------------------|--------------|
| `pnpm start`          | Full stack (infra + migrations + pg-boss + dev servers). The "from cold" command. |
| `pnpm dev`            | Dev servers only (assumes infra already up). Preflight refuses politely if it's not. |
| `pnpm stop`           | Stop infra (keeps the data) |
| `pnpm reset`          | Wipe the dev brain + rebuild from scratch (asks for confirmation, backs up first) |
| `pnpm infra:up`       | Bring infra up without dev servers |
| `pnpm infra:logs`     | Tail postgres + minio logs |
| `pnpm infra:psql`     | Open psql in the postgres container |
| `pnpm db:migrate`     | Apply Drizzle migrations |
| `pnpm db:studio`      | Drizzle Studio (browse the DB) |
| `pnpm dev:web`        | Just the HTTP API (`server/web`) |
| `pnpm dev:api`        | Just the turn runners + ingest listeners (`server/api`) |
| `pnpm dev:mcp`        | Just the stdio MCP server |
| `pnpm dev:worker`, `dev:telegram`, `dev:files`, `dev:docs`, `dev:events` | One worker at a time |
| `pnpm verify`         | typecheck + lint + format check + docs check + tests (what the pre-push hook runs) |

API: http://localhost:3000 (a bare visit redirects to `/login`, which the UI serves)
MinIO console: http://localhost:9001 (user `minio` / pass `minio12345`)

## Connecting an email account

Mantle uses **IMAP for every provider**: Gmail, Outlook, custom
domains, all of them. No OAuth, no Google Cloud Console setup, no
refresh tokens to babysit. The cost is one app-password per account.

For each account:

1. **Enable 2FA** on the account if it isn't already (provider requires
   this before issuing app passwords).
2. **Generate an app password** in the provider's account-security UI:
   - Gmail / Workspace: https://myaccount.google.com/apppasswords
     (also: Gmail Settings → Forwarding and POP/IMAP → IMAP access: Enable)
   - Outlook / Microsoft personal:
     https://account.live.com → Security → Advanced → App passwords
   - Fastmail / iCloud / Zoho / Proton (via Bridge): same idea,
     account security → app passwords
3. **Open `/settings/accounts` → Add IMAP account**:
   - **Host** depends on provider:
     - Gmail: `imap.gmail.com`
     - Outlook personal: `outlook.office365.com`
     - Your own domain: whatever your registrar set up
   - **Port**: 993, TLS on
   - **Username**: full email address
   - **Password**: the app password from step 2
4. Hit **Test connection** to verify before saving.

**The contacts list is the ingest gate**: a message is only ingested when its
sender matches a contact (exact address or `@domain` wildcard) or one of your
own addresses; everyone else is silently rejected. Discover new senders at
`/settings/discover`. See [`email-ingest.md`](./email-ingest.md).

**Microsoft 365 corporate caveat**: some tenants have basic-auth IMAP
disabled by admin policy. If you can't get IMAP working from a paid
M365 mailbox, the easiest workaround is to ask your admin to enable
it for your mailbox; Mantle does not implement Microsoft OAuth.

## Connecting a Telegram bot

The bot worker (`server/web/workers/telegram-poll.ts`) long-polls
Telegram for DMs and stores them as `nodes` of type `telegram_message`.
The MCP server exposes `telegram_pending` / `telegram_send` /
`telegram_react` / `telegram_edit` / `telegram_pair` tools so Claude
can read and reply.

> **Where to do this.** Telegram is **optional** and set up **after** your
> assistant exists. You can do it in the **last step of the onboarding wizard**
> ("Reach your assistant on Telegram"), or any time later in
> `/settings/agents`; both run the exact same connect → pair flow (the shared
> `<TelegramBotSection>`) against your assistant. The steps below are that flow.

1. **Create a bot.** DM [@BotFather](https://t.me/BotFather), `/newbot`,
   write down the token.
2. **Link it to your assistant.** In `/settings/agents` (or the onboarding
   Telegram step), select your assistant, **any agent can carry a Telegram
   channel**, and paste the token into its **Telegram bot** section. Mantle
   validates it (`getMe`), seals it AES-256-GCM at rest on the agent's
   `channels` row (`credentials_enc`, the generic comms-channels binding,
   [`comms-channels.md`](./comms-channels.md)), and binds the bot to that
   agent, so DMs to that bot are answered by it. The poll worker picks it
   up within ~60s.
3. **Pair.** DM your bot from your phone. Within ~25s the worker
   gates the message, generates a 6-char pairing code, and DMs it back.
   Approve it with one click in the agent's Telegram section (or via the
   `telegram_pair` MCP tool).
4. **You're paired.** Subsequent DMs land in `telegram_messages` and
   trigger `pg_notify('telegram_message_inserted')`, which the agent
   listens for.

## Connecting Claude (Desktop / Code)

Claude Desktop and Claude Code can drive your Mantle directly, search,
mail, tasks, the knowledge graph, Telegram, through the bundled stdio MCP
server (`server/mcp`). It's a one-time config per client machine: Claude
spawns the server on demand (locally, or inside the `mantle_web` container
over SSH for a remote install) and your SSH key is the entire auth layer.
Full instructions, config snippets for all three deployment shapes, and the
security model: [`connecting-claude.md`](./connecting-claude.md).

## Saving API keys

`/settings/keys` is the UI for storing keys for external services
(OpenRouter, OpenAI, Anthropic, …). Keys are AES-256-GCM encrypted at
rest using `MANTLE_MASTER_KEY`, your backups contain ciphertext only.

- **Service** is the slug your code looks up by (e.g. `openrouter`).
- **Label** disambiguates multiple keys for the same service
  (e.g. `personal`, `agent`).
- The plaintext is shown **exactly once** at creation time (and again
  at rotation). After that the list only shows a masked view.

The agent reads its OpenRouter key as `getApiKey(userId, 'openrouter')`.
Storage is per-user, and the unique constraint is `(user_id, service,
label)` so you can swap a key without affecting another label.

## Agents & auto-responding

`server/api` listens on `pg_notify('telegram_message_inserted')` and replies
through the shared agent runtime, the same code path the web `/assistant`
uses (one conversation store across channels; see
[`conversation.md`](./conversation.md)):

```
inbound DM → telegram-poll worker → INSERT inbound telegram_messages row
          → pg_notify('telegram_message_inserted', new.id::text)   (inbound only)
          → server/api picks up
          → resolve responder  (per-chat override → the bot's owning agent → global priority)
          → loadConversationContext  (persona + facts + digests + content hits + history)
          → chat adapter call  (provider-routed, failover-capable; cache_control for Anthropic)
          → telegram_send via @mantle/telegram  (on the inbound message's own bot)
          → recordTurn(outbound) → mark inbound processed
```

**Configuration** lives in the `agents` table, manage it at
`/settings/agents`. Each row carries:

- `slug`, `name`, `description`
- `role`, `responder` (Telegram-facing), `assistant` (web chat), or `custom`
  (delegation targets like Remy / Researcher / Pages). One-shot jobs
  (extractor, summarizer, reflector, TTS/STT/vision/image-gen/embedding) are
  **AI workers**, a separate table, see [`ai-workers.md`](./ai-workers.md).
- `model` + `provider`, any wired provider/model (OpenRouter slug, direct
  Anthropic/Google/xAI, local) with an optional backup route
  ([`chat-failover.md`](./chat-failover.md))
- `api_key_id`, which entry in `api_keys` to use
- `system_prompt`, persona (plus evolving `persona_notes` the reflector appends)
- `memory_config`, history/digest/fact/chunk limits, `delegate_to` allowlist
- `params`, `temperature`, `max_tokens`, `top_p`
- `tts_worker_id`, which `kind='tts'` AI worker voices this agent
- `priority`; higher wins when multiple agents share a role
- `enabled`, kill switch

First-time setup is handled by onboarding; manual path: add an OpenRouter key
at `/settings/keys`, then create a responder at `/settings/agents`.

**Memory at a glance.** Six layers, all live: `persona` + `recent_turns` +
`conversation_digest` (topic-grouped roll-ups by the summarizer, embedded for
recall) + `profile` (dedup'd facts with an ADD/UPDATE/DELETE classifier) +
`content_index` (per-item summary + embedding + chunks) + `content_store`.
Prompt assembly keeps the cacheable prefix byte-stable (persona ← breakpoint 1,
digests ← breakpoint 2, everything per-turn rides below them), see
[`memory.md`](./memory.md) §7 for the as-built order and the cache-hygiene
rule.

To bootstrap memory on existing content:

```bash
pnpm -C server/web extract:backfill                  # all eligible nodes
pnpm -C server/web extract:backfill --types=note     # restrict
pnpm -C server/web extract:backfill --since=2025-01-01
```

The agent must be running, the script just feeds `pg_notify('node_ingested')`;
the durable extract queue does the work.
