# Mantle

Jason's AI-queryable life tree. Single Postgres-backed system that knows about emails, Telegram messages, files, notes, sermons, secrets, and printer projects — and exposes all of it to Claude over MCP. Replies to Telegram DMs automatically via OpenRouter.

## Layout

```
mantle/
├── infra/
│   └── postgres/init/   # extensions + auth.users baked in at first container boot
├── apps/
│   ├── web/             # Next.js 15 (App Router) + shadcn UI
│   ├── mcp/             # MCP server (stdio) — Claude's tools
│   └── agent/           # OpenRouter-powered Telegram responder
├── packages/
│   ├── db/              # Drizzle schema + migrations
│   ├── email/           # Gmail / Graph / IMAP adapters + sync engine
│   ├── telegram/        # Telegram bot ingest + outbound
│   ├── storage/         # S3-compatible (MinIO) wrapper
│   ├── api-keys/        # Encrypted API key vault (OpenRouter, OpenAI, …)
│   ├── crypto/          # AES-256-GCM helpers for secrets at rest
│   ├── search/          # full-text + vector search helpers
│   └── rules/           # ingest rules engine
├── scripts/             # dev convenience (just `up.sh`)
├── docker-compose.dev.yml   # Postgres + MinIO + Tika for local dev (embedder = your local Ollama)
└── docker-compose.yml       # full production stack (Linux): built app images + bundled embedder (Ollama)
```

## First-time setup

```bash
# 1. Install pnpm
corepack enable && corepack prepare pnpm@10 --activate

# 2. Install deps
pnpm install

# 3. Copy env (single file — Next.js, worker, MCP, agent, and Drizzle all read it)
cp .env.example apps/web/.env.local
$EDITOR apps/web/.env.local
#  - MANTLE_MASTER_KEY  → openssl rand -base64 32
#  - SESSION_SECRET     → openssl rand -base64 48
#  - ALLOWED_USER_ID    → uuid of the user row in auth.users (see below)

# 4. Local embedder (macOS / local dev) — the dev stack does NOT bundle it, so
#    install Ollama and pull the model. Mantle's apps reach it at
#    http://localhost:11434 by default. (Production bundles this — see below.)
brew install ollama
brew services start ollama    # serves on :11434 (or run the menu-bar app)
ollama pull embeddinggemma    # the 768-dim local embedder Mantle defaults to

# 5. Bring up the stack (Docker must be running)
pnpm up
```

> **macOS embedder, why step 4.** The dev stack (`docker-compose.dev.yml`) ships
> only Postgres + MinIO + Tika — **not** the embedder, because on a dev machine
> you run Ollama natively (faster, uses the Mac GPU). Without a running Ollama
> serving `embeddinggemma` on `:11434`, the app still boots and chat works, but
> **embeddings fail** — uploaded content won't index and semantic search returns
> nothing. On Linux you can install Ollama the same way (`curl -fsSL
> https://ollama.com/install.sh | sh`) or just use the production stack below.

> **Dev vs production.** The steps above are the **local dev stack** (`pnpm up`:
> infra in Docker + the apps hot-reloading on the host + your local Ollama).
> **Production is meant to run on Linux** via the full `docker-compose.yml`, which
> builds the app images and **bundles the embedder (Ollama) + a one-shot model
> pull** — so a fresh deploy needs **no native Ollama** (it works on any Docker
> host, Linux or macOS, CPU-only where there's no GPU). See
> [`docs/deploy.md`](./docs/deploy.md).

`pnpm up` runs `scripts/up.sh`, which:

1. Brings up Postgres + MinIO via `docker-compose.dev.yml`
2. Ensures the `mantle` MinIO bucket exists
3. Runs Drizzle migrations against the fresh DB
4. Starts the dev servers (web + mcp + email worker + telegram worker + agent)

That's it — **no SQL, no `ALLOWED_USER_ID` to fill in.** Open
http://localhost:3000 and you'll land on **Create your account** (the first-run
signup, available only while `auth.users` is empty). After signup, the
**onboarding wizard** walks you through everything the brain needs to run: a
model key (OpenRouter), optional voice/image (xAI) and transcription/vision
(OpenAI) keys, then it provisions your assistant + the background AI workers,
runs a sanity check, captures who you are as Life Logs, and lets you shape the
assistant's personality. See [`docs/onboarding.md`](./docs/onboarding.md).

> `ALLOWED_USER_ID` is now **optional** — left blank, the workers and MCP server
> auto-resolve the single `auth.users` row, so a fresh install is zero-config.
> Set it only for scripts or a multi-DB setup.

Other handy scripts:

| Command           | What it does |
|-------------------|--------------|
| `pnpm up`         | Full stack (infra + dev servers) |
| `pnpm dev`        | Dev servers only (assumes infra already up) |
| `pnpm down`       | Stop infra |
| `pnpm infra:up`   | Bring infra up without dev servers |
| `pnpm infra:logs` | Tail postgres + minio logs |
| `pnpm infra:psql` | Open psql in the postgres container |
| `pnpm db:migrate` | Apply Drizzle migrations |
| `pnpm db:studio`  | Drizzle Studio (browse the DB) |
| `pnpm dev:web`    | Just the web (helpful when iterating on UI) |
| `pnpm dev:agent`  | Just the OpenRouter agent |

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

The first sync starts within ~2 min and scans 12 months of headers
without ingesting any bodies — those wait until you approve a sender
at `/settings/senders`.

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

1. **Create a bot.** DM [@BotFather](https://t.me/BotFather), `/newbot`,
   write down the token.
2. **Link it to a responder.** Open [`/settings/agents`](http://localhost:3000/settings/agents),
   select (or create) a `responder` agent, and paste the token into its
   **Telegram bot** section. Mantle validates it (`getMe`), seals it
   AES-256-GCM at rest, and binds the bot to that responder — so DMs to that
   bot are answered by that agent. The poll worker picks it up within ~60s.
   (The token lives in `telegram_accounts`, now with a `responder_agent_id`
   link; CLI bootstrap via `pnpm -C apps/web seed:telegram` from
   `~/.claude/channels/telegram/.env` still works for migrating a legacy setup.)
3. **Pair.** DM your bot from your phone. Within ~25s the worker
   gates the message, generates a 6-char pairing code, and DMs it back.
   In Claude (with the MCP server connected), call
   `mcp__mantle__telegram_pair` with the code to allowlist the chat.
4. **You're paired.** Subsequent DMs land in `telegram_messages` and
   trigger `pg_notify('telegram_message_inserted')`, which the agent
   listens for.

See [`docs/telegram.md`](./docs/telegram.md) for the original handoff
detail.

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

## Agents & auto-responding to Telegram

`apps/agent` is a tiny Node process that listens on
`pg_notify('telegram_message_inserted')` and replies via OpenRouter. As of
2026-05 it's **DB-driven and has memory**:

```
inbound DM → telegram-poll worker → INSERT inbound telegram_messages row
          → pg_notify('telegram_message_inserted', new.id::text)   (inbound only)
          → apps/agent picks up
          → resolve responder  (per-chat override → the bot's owning responder → global priority)
          → load conversation history  (last N inbound+outbound turns)
          → @openrouter/sdk call  (cache_control on system prompt for anthropic/*)
          → telegram_send via @mantle/telegram  (on the inbound message's own bot)
          → INSERT outbound telegram_messages row
          → mark inbound processed
```

Each `responder` can own its own bot: paste the token into the agent's
**Telegram bot** section at `/settings/agents` (it binds
`telegram_accounts.responder_agent_id`), approve pairing requests there with one
click, and DMs to that bot are answered by that agent. See
["Connecting a Telegram bot"](#connecting-a-telegram-bot) above.

**Configuration** lives in the `agents` table — manage it at
[`/settings/agents`](http://localhost:3000/settings/agents). Each row carries:

- `slug`, `name`, `description`
- `role` — `responder` for Telegram replies (`assistant`, `extractor`, `summarizer`, `custom` are also defined)
- `model` — any OpenRouter slug (e.g. `anthropic/claude-sonnet-4.6`)
- `api_key_id` — which entry in `api_keys` to use
- `system_prompt` — persona
- `memory_config.history_limit` — turns to replay (default 20)
- `params` — `temperature`, `max_tokens`, `top_p`
- `tts_worker_id` — which `kind='tts'` AI worker voices this agent's spoken
  replies (set in the **Voice (TTS)** picker). Unset → the owner's default TTS
  worker. See [`docs/ai-workers.md`](./docs/ai-workers.md).
- `priority` — higher wins when multiple `responder` agents are enabled
- `enabled` — kill switch

First-time setup: add an OpenRouter key at `/settings/keys`, then create a
responder at `/settings/agents`. The default seed values in the form
(`anthropic/claude-sonnet-4.6`, history limit 20) are a good starting point.

**Tier-2 memory: conversation digests.** When the unsummarized turn count in
a chat crosses a threshold (default 30), a `summarizer` agent rolls the
oldest 20 turns into a single digest node (`type='note'`,
`tags: ['conversation-digest','telegram']`) and points those rows at it via
`telegram_messages.digest_node_id`. The responder loads the most recent N
digests (default 3) and prepends them to the prompt as a second system
block. End-to-end:

```
       raw turns ──┐
                   ├─ summarizer (Haiku) ──→  digest node (~3 sentences)
       (oldest 20) ┘                       └→ telegram_messages.digest_node_id set

       responder reply prompt:
         [system, persona]                ← cache_control (stable forever)
         [system, recent digests]         ← cache_control (stable for ~20 turns)
         [last 20 raw turns]              ← drifts
         [new user message]
```

Two cache breakpoints (Anthropic allows up to 4), so the digests stay in
cache turn-to-turn until the next summarization fires. Configure the
threshold and batch size in the agent row at `/settings/agents`.

**Prompt caching.** For `anthropic/*` models the runner emits
`cache_control: { type: 'ephemeral' }` on the system block (and on the
digest block when present). OpenRouter forwards this to Anthropic, which
caches the prefix for 5 minutes and reuses it on the next turn at ~10% the
cost. The agent logs cache-read tokens at INFO level so you can confirm
it's working.

**Memory layer (six tiers).** All shipped: `persona` + `recent_turns` +
`conversation_digest` + `profile` (dedup'd facts with ADD/UPDATE/DELETE
classifier) + `content_index` (per-item summary + embedding) +
`content_store`. Plus the embedding subsystem (`@mantle/embeddings`,
OpenRouter-routed, hash-cached) and reflector for `persona_notes`
evolution. Read [`docs/memory.md`](./docs/memory.md) for the full design
and the layer-to-schema-to-agent map.

To bootstrap memory on existing content:

```bash
pnpm -C apps/web extract:backfill                  # all eligible nodes
pnpm -C apps/web extract:backfill --types=note     # restrict
pnpm -C apps/web extract:backfill --since=2025-01-01
```

The agent must be running — the script just feeds `pg_notify('node_ingested')`;
the listener does the work.

Entity-anchored retrieval and the **graph traversal API are now shipped** —
relations between entities, `graph_path` multi-hop queries, and a clean entity
layer (see [`docs/knowledge-graph.md`](./docs/knowledge-graph.md)). What's
deliberately parked: the industrial/RBI fork
([`docs/future/`](./docs/future/industrial-fork-and-graph.md)), OCR for
scanned-AND-encrypted PDFs, and federation pairing/rate-limiting. See
[`docs/architecture.md`](./docs/architecture.md#16-known-sharp-edges--future-work).

## Docs

- [`docs/architecture.md`](./docs/architecture.md) — full architecture tour: the five processes, the data plane, the `nodes` abstraction, the ingest pipelines, the MCP tools, the workspace layout. Read this before touching the codebase.
- [`docs/hardening-audit-2026-05.md`](./docs/hardening-audit-2026-05.md) — **the May 2026 hardening audit:** an independent four-subsystem sweep + the fixes (chat retry/backoff, cache breakpoints, stale-fact retirement, HNSW index, migrate-on-boot, …), what was deliberately *not* done (the cost-unbounded re-extract trigger), and what's still open. Read before re-pitching a "known issue."
- [`docs/agent-overhaul-2026-05.md`](./docs/agent-overhaul-2026-05.md) — **overview of the May 2026 agent & tool-result overhaul:** the through-line principles + a tour of what changed — wrapping speech tags, delegation made real (`delegate_to` UI + merge), the live model catalog (context + vision), the **tool-result spill store** (`read_result`: page/grep/semantic query — the fix for assistants quitting mid-job on truncated tool output), and the duplicate-edge guard. Start here, then dive into the `architecture.md` §9b'/§9l/§9m sections it links.
- [`docs/memory.md`](./docs/memory.md) — the memory layer: tier taxonomy (conversation / session / user), vector vs graph retrieval, the `memories` / `entities` / `entity_edges` schema, and the build sequence. **§7 has the as-built June-2026 retrieval assembly.**
- [`docs/recall-eval.md`](./docs/recall-eval.md) — **the recall eval harness + the June-2026 retrieval overhaul.** `pnpm -C apps/web eval:recall` scores real retrieval as `recall@k`/`MRR`; the doc chronicles each enhancement (hybrid search, bulk-email salience, kind-aware recency, auto-chunks, entity-graph expansion, query enrichment) with measured before/after. The regression gate for any retrieval change.
- [`docs/knowledge-graph.md`](./docs/knowledge-graph.md) — **the knowledge graph** (shipped 2026-05): relationships *between* the things in your life (`employed_by`, `banks_with`, …) extracted into `entity_edges` in the same LLM pass as facts, the `graph_path` multi-hop traversal (recursive CTE, no graph DB), entity-resolution integrity (unique constraint + race-proof upsert), verb canonicalization, and conservative near-dup consolidation with the `/settings/entities` review UI. Includes why Postgres, not Neo4j.
- [`docs/federation.md`](./docs/federation.md) — **Mantle-to-Mantle federation:** two sovereign single-user instances exchanging *scoped* data — sealed per-peer tokens, explicit per-node grants, an authenticated `/api/federation` surface (every cross-Mantle read traced), and the `peer_*` tools so Saskia can query a peer in natural language. Federation of separate brains, not multi-tenancy.
- [`docs/recall.md`](./docs/recall.md) — **Remy**, the memory-recall agent: time-windowed replay of past conversations (`find_window` → `recall_window`) via `invoke_agent` delegation — lossless paging back to what was *actually said*, vs. the lossy conversation digests.
- [`docs/research.md`](./docs/research.md) — **Researcher**, the web-search agent: the outward twin of Remy. `web_search` (Perplexity Sonar via OpenRouter) + a synthesising agent; Saskia delegates and decides whether to save the cited result as a note.
- [`docs/contacts.md`](./docs/contacts.md) — the index of people/orgs Saskia may reach: `contact` node type with fields (name + company + email + cell + description), the master-detail `/contacts` UI, the `contact_*` builtins, and the per-method counters bumped on send. **Contacts ARE the email allowlist** — non-empty contacts engages the gate.
- [`docs/email-send.md`](./docs/email-send.md) — outbound email: the `email_send` tool sends from your own mailbox via provider **SMTP submission** (587/465, reusing the IMAP app password) — never an own MTA/port 25. Pairs with the researcher for "research X and email it to me."
- [`docs/observability.md`](./docs/observability.md) — the tracing layer: how every agent run becomes a queryable `traces` row + `trace_steps` tree, the reactflow visual at `/traces`, and the dashboard widgets on `/debug`.
- [`docs/data-flow-tracing.md`](./docs/data-flow-tracing.md) — operational guide for verifying ingest by hand: how to connect to the dev Postgres and trace one node through every layer (content_store → index → facts → graph → traces), the success/skip/silent-miss signatures, and how to safely re-run extraction on a single node. Backed by [`scripts/trace-node.sh`](./scripts/trace-node.sh).
- [`docs/journey.md`](./docs/journey.md) — the **Activity → Reaction** map: every way content enters the brain (chat, attachment, email, note, event, Telegram, agent tool) and which memory layers react, plus the trace kinds and the source-of-truth files to update when the pipeline changes. Rendered live as the **Journey** tab at `/debug/journey`.
- [`docs/realtime.md`](./docs/realtime.md) — the **live-UI** layer: how `LISTEN/NOTIFY` on the `node_ingested` trigger is bridged to the browser over SSE so server-rendered screens repaint without a refresh, and the one-line `useRealtime()` recipe to opt any screen in. Events screen is the reference consumer.
- [`docs/handoff-vision-files.md`](./docs/handoff-vision-files.md) — **active handoff (2026-05-20):** the open `/assistant` image-Q&A bug (Bedrock "Could not process image" on large photos), the pending stack restart, other open vision/Telegram-photo threads, and what shipped this session. Read this to resume that work.
- [`docs/telegram.md`](./docs/telegram.md) — frozen handoff covering the Telegram bridge build (May 2026). Historical project diary; the durable reference is `architecture.md`.
- [`docs/pages.md`](./docs/pages.md) — **Pages**, the Notion-style rich-document type: the TipTap editor + shared schema (callouts, columns, tables, task lists, code highlighting, KaTeX math, image/file embeds), the draft/commit model, and how a page reaches the brain.
- [`docs/tables.md`](./docs/tables.md) — **Tables**, the typed database-grid type (Airtable/Notion-database): the `TableDoc` model (typed columns, stable row/column ids, totals, formulas, sort/filter views), xlsx/csv import, the `table_*` tools + the **Tables** delegate agent, and the TanStack `/tables` grid editor. Built as a deliberate mirror of Pages (node + sidecar, draft/commit, brain-indexed).
- [`docs/lifelog.md`](./docs/lifelog.md) — **Life Logs**, the `lifelog` node type: short first-person entries (mood + life-area category) about who you are, what you do, and how you feel. Indexed like notes **and** distilled into an always-on "who you are" identity block (`buildIdentityContext`) injected into every agent turn (deterministic, no LLM; opt-out via `memory_config.inject_lifelog`). The `/lifelog` master-detail UI + `lifelog_*` tools.
- [`docs/rich-writing.md`](./docs/rich-writing.md) — **Saskia's rich writing:** the document-canvas `/assistant`, the `rich_writing` skill that teaches a Notion-style markdown dialect, and the `page_*` tools that let her author real Pages (`markdownToDoc`).
- [`docs/sharing.md`](./docs/sharing.md) — **public sharing:** read-only links (`/s/[token]`) to any page, note, todo, event, or file — revocable tokens, server-rendered page HTML, media-appropriate file viewers, and scoped public asset serving.
