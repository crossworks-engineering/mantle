# Getting started

The operator's setup guide — local dev stack, first run, connecting email and
Telegram, API keys, and the agent basics. (Moved here from the README, which
is now the product front door.) Production deployment is
[`deploy.md`](./deploy.md) — its §0a has measured **VPS sizing** (minimum
2 vCPU / 4 GB; recommended 4 vCPU / 8 GB for build-on-VPS); updating a
running box is [`update-prod.md`](./update-prod.md).

## Layout

```
mantle/
├── infra/
│   └── postgres/init/   # extensions + auth.users baked in at first container boot
├── apps/
│   ├── web/             # Next.js 15 (App Router) + shadcn UI
│   ├── mcp/             # MCP server (stdio) — Claude's tools
│   └── agent/           # the responder + extractor/summarizer/reflector loops
├── packages/
│   ├── db/              # Drizzle schema + migrations
│   ├── email/           # IMAP adapters + sync engine
│   ├── telegram/        # Telegram bot ingest + outbound
│   ├── storage/         # S3-compatible (MinIO) wrapper
│   ├── api-keys/        # Encrypted API key vault (OpenRouter, OpenAI, …)
│   ├── crypto/          # AES-256-GCM helpers for secrets at rest
│   ├── search/          # full-text + vector search helpers
│   ├── embeddings/      # embedding dispatch + cache + re-embed
│   ├── agent-runtime/   # tool loop + prompt assembly (shared by all surfaces)
│   ├── content/         # notes, todos, events, lifelogs, backups, …
│   └── rules/           # ingest rules engine
├── scripts/             # dev convenience (up.sh, db-dump.sh, …)
├── docker-compose.dev.yml   # Postgres + MinIO + Tika for local dev (embedder = your local Ollama)
└── docker-compose.yml       # full production stack (Linux): built app images + bundled embedder (Ollama)
```

## First-time setup

```bash
# 1. Install pnpm
corepack enable && corepack prepare pnpm@10 --activate

# 2. Install deps
pnpm install

# 3. Copy env (single file — Next.js, workers, MCP, agent, and Drizzle all read it)
cp .env.example apps/web/.env.local
$EDITOR apps/web/.env.local
#  - MANTLE_MASTER_KEY  → openssl rand -base64 32
#  - SESSION_SECRET     → openssl rand -base64 48

# 4. Local embedder (macOS / local dev) — the dev stack does NOT bundle it, so
#    install Ollama and pull the model. Mantle's apps reach it at
#    http://localhost:11434 by default. (Production bundles this — see below.)
brew install ollama
brew services start ollama    # serves on :11434 (or run the menu-bar app)
ollama pull embeddinggemma    # the 768-dim local embedder Mantle defaults to

# 5. Bring up the stack (Docker must be running)
pnpm start
```

> **`pnpm start`, not `pnpm up`.** `pnpm up` is a built-in alias for
> `pnpm update` (deps), so it shadows any script of the same name. Use
> `pnpm start` to bring the stack up (or `pnpm run up` if you prefer the old
> name). The collision is documented at <https://pnpm.io/cli/update>.

> **macOS embedder, why step 4.** The dev stack (`docker-compose.dev.yml`) ships
> only Postgres + MinIO + Tika — **not** the embedder, because on a dev machine
> you run Ollama natively (faster, uses the Mac GPU). Without a running Ollama
> serving `embeddinggemma` on `:11434`, the app still boots and chat works, but
> **embeddings fail** — uploaded content won't index and semantic search returns
> nothing. On Linux you can install Ollama the same way (`curl -fsSL
> https://ollama.com/install.sh | sh`) or just use the production stack below.

> **Dev vs production.** The steps above are the **local dev stack** (`pnpm start`:
> infra in Docker + the apps hot-reloading on the host + your local Ollama).
> **Production is meant to run on Linux** via the full `docker-compose.yml`, which
> builds the app images and **bundles the embedder (Ollama) + a one-shot model
> pull** — so a fresh deploy needs **no native Ollama** (it works on any Docker
> host, Linux or macOS, CPU-only where there's no GPU). See
> [`deploy.md`](./deploy.md).

`pnpm start` runs `scripts/up.sh`, which:

1. Brings up Postgres + MinIO + Tika via `docker-compose.dev.yml`
2. Ensures the `mantle` MinIO bucket exists
3. Runs Drizzle migrations against the fresh DB
4. Ensures the pg-boss schema exists (so the workers don't race to create it)
5. Starts the dev servers (web + mcp + email worker + telegram worker + agent)

That's it — **no SQL, no `ALLOWED_USER_ID` to fill in.** Open
http://localhost:3000 and you'll land on **Create your account** (the first-run
signup, available only while `auth.users` is empty). After signup, the
**onboarding wizard** walks you through everything the brain needs to run: a
model key (OpenRouter), optional voice/image (xAI) and transcription/vision
(OpenAI) keys, then it provisions your assistant + the background AI workers,
runs a sanity check, captures who you are as Life Logs, and lets you shape the
assistant's personality. See [`onboarding.md`](./onboarding.md).

> `ALLOWED_USER_ID` is **optional** — left blank, the workers and MCP server
> auto-resolve the single `auth.users` row, so a fresh install is zero-config.
> Set it only for scripts or a multi-DB setup.

Other handy scripts:

| Command           | What it does |
|-------------------|--------------|
| `pnpm start`      | Full stack (infra + migrations + pg-boss + dev servers). The "from cold" command. |
| `pnpm dev`        | Dev servers only (assumes infra already up). Preflight refuses politely if it's not. |
| `pnpm stop`       | Stop infra (keeps volumes) |
| `pnpm reset`      | Wipe the dev brain + rebuild from scratch (asks for confirmation, backs up first) |
| `pnpm infra:up`   | Bring infra up without dev servers |
| `pnpm infra:logs` | Tail postgres + minio logs |
| `pnpm infra:psql` | Open psql in the postgres container |
| `pnpm db:migrate` | Apply Drizzle migrations |
| `pnpm db:studio`  | Drizzle Studio (browse the DB) |
| `pnpm dev:web`    | Just the web (helpful when iterating on UI) |
| `pnpm dev:agent`  | Just the agent |

App: http://localhost:3000
MinIO console: http://localhost:9001 (user `minio` / pass `minio12345`)

## Connecting an email account

Mantle uses **IMAP for every provider** — Gmail, Outlook, custom
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
   - Fastmail / iCloud / Zoho / Proton (via Bridge): same idea —
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
own addresses — everyone else is silently rejected. Discover new senders at
`/settings/discover`. See [`email-ingest.md`](./email-ingest.md).

**Microsoft 365 corporate caveat**: some tenants have basic-auth IMAP
disabled by admin policy. If you can't get IMAP working from a paid
M365 mailbox, the easiest workaround is to ask your admin to enable
it for your mailbox — Mantle does not implement Microsoft OAuth.

## Connecting a Telegram bot

The bot worker (`apps/web/workers/telegram-poll.ts`) long-polls
Telegram for DMs and stores them as `nodes` of type `telegram_message`.
The MCP server exposes `telegram_pending` / `telegram_send` /
`telegram_react` / `telegram_edit` / `telegram_pair` tools so Claude
can read and reply.

> **Where to do this.** Telegram is **optional** and set up **after** your
> assistant exists. You can do it in the **last step of the onboarding wizard**
> ("Reach your assistant on Telegram"), or any time later in
> `/settings/agents` — both run the exact same connect → pair flow (the shared
> `<TelegramBotSection>`) against your assistant. The steps below are that flow.

1. **Create a bot.** DM [@BotFather](https://t.me/BotFather), `/newbot`,
   write down the token.
2. **Link it to your assistant.** In `/settings/agents` (or the onboarding
   Telegram step), select your assistant — **any agent can carry a Telegram
   channel** — and paste the token into its **Telegram bot** section. Mantle
   validates it (`getMe`), seals it AES-256-GCM at rest on the agent's
   `channels` row (`credentials_enc` — the generic comms-channels binding,
   [`comms-channels.md`](./comms-channels.md)), and binds the bot to that
   agent — so DMs to that bot are answered by it. The poll worker picks it
   up within ~60s.
3. **Pair.** DM your bot from your phone. Within ~25s the worker
   gates the message, generates a 6-char pairing code, and DMs it back.
   Approve it with one click in the agent's Telegram section (or via the
   `telegram_pair` MCP tool).
4. **You're paired.** Subsequent DMs land in `telegram_messages` and
   trigger `pg_notify('telegram_message_inserted')`, which the agent
   listens for.

## Saving API keys

`/settings/keys` is the UI for storing keys for external services
(OpenRouter, OpenAI, Anthropic, …). Keys are AES-256-GCM encrypted at
rest using `MANTLE_MASTER_KEY` — your backups contain ciphertext only.

- **Service** is the slug your code looks up by (e.g. `openrouter`).
- **Label** disambiguates multiple keys for the same service
  (e.g. `personal`, `agent`).
- The plaintext is shown **exactly once** at creation time (and again
  at rotation). After that the list only shows a masked view.

The agent reads its OpenRouter key as `getApiKey(userId, 'openrouter')`.
Storage is per-user, and the unique constraint is `(user_id, service,
label)` so you can swap a key without affecting another label.

## Agents & auto-responding

`apps/agent` listens on `pg_notify('telegram_message_inserted')` and replies
through the shared agent runtime — the same code path the web `/assistant`
uses (one conversation store across channels; see
[`conversation.md`](./conversation.md)):

```
inbound DM → telegram-poll worker → INSERT inbound telegram_messages row
          → pg_notify('telegram_message_inserted', new.id::text)   (inbound only)
          → apps/agent picks up
          → resolve responder  (per-chat override → the bot's owning agent → global priority)
          → loadConversationContext  (persona + facts + digests + content hits + history)
          → chat adapter call  (provider-routed, failover-capable; cache_control for Anthropic)
          → telegram_send via @mantle/telegram  (on the inbound message's own bot)
          → recordTurn(outbound) → mark inbound processed
```

**Configuration** lives in the `agents` table — manage it at
`/settings/agents`. Each row carries:

- `slug`, `name`, `description`
- `role` — `responder` (Telegram-facing), `assistant` (web chat), or `custom`
  (delegation targets like Remy / Researcher / Pages). One-shot jobs
  (extractor, summarizer, reflector, TTS/STT/vision/image-gen/embedding) are
  **AI workers**, a separate table — see [`ai-workers.md`](./ai-workers.md).
- `model` + `provider` — any wired provider/model (OpenRouter slug, direct
  Anthropic/Google/xAI, local) with an optional backup route
  ([`chat-failover.md`](./chat-failover.md))
- `api_key_id` — which entry in `api_keys` to use
- `system_prompt` — persona (plus evolving `persona_notes` the reflector appends)
- `memory_config` — history/digest/fact/chunk limits, `delegate_to` allowlist
- `params` — `temperature`, `max_tokens`, `top_p`
- `tts_worker_id` — which `kind='tts'` AI worker voices this agent
- `priority` — higher wins when multiple agents share a role
- `enabled` — kill switch

First-time setup is handled by onboarding; manual path: add an OpenRouter key
at `/settings/keys`, then create a responder at `/settings/agents`.

**Memory at a glance.** Six layers, all live: `persona` + `recent_turns` +
`conversation_digest` (topic-grouped roll-ups by the summarizer, embedded for
recall) + `profile` (dedup'd facts with an ADD/UPDATE/DELETE classifier) +
`content_index` (per-item summary + embedding + chunks) + `content_store`.
Prompt assembly keeps the cacheable prefix byte-stable (persona ← breakpoint 1,
digests ← breakpoint 2, everything per-turn rides below them) — see
[`memory.md`](./memory.md) §7 for the as-built order and the cache-hygiene
rule.

To bootstrap memory on existing content:

```bash
pnpm -C apps/web extract:backfill                  # all eligible nodes
pnpm -C apps/web extract:backfill --types=note     # restrict
pnpm -C apps/web extract:backfill --since=2025-01-01
```

The agent must be running — the script just feeds `pg_notify('node_ingested')`;
the durable extract queue does the work.
