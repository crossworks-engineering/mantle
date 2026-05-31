# Mantle Architecture

A concrete, file-cited tour of how the system fits together. If you want one
document to read before touching the codebase, this is it.

Companion docs:
- [`memory.md`](./memory.md) — the memory layer in depth: tier taxonomy,
  vector vs graph retrieval, the `memories` / `entities` / `entity_edges`
  schema, the build sequence.
- [`knowledge-graph.md`](./knowledge-graph.md) — the graph axis (shipped): how
  entity↔entity relations are extracted, traversed (`graph_path`), kept clean
  (entity-resolution integrity + near-dup consolidation), and why it's all
  Postgres, not a graph DB.
- [`federation.md`](./federation.md) — Mantle-to-Mantle federation: sealed
  per-peer tokens, scoped per-node grants, the traced `/api/federation` surface.
- [`observability.md`](./observability.md) — the tracing layer: how every
  agent run becomes a `traces` row + `trace_steps` tree, the reactflow
  visual, the dashboard widgets, and how to add a new trace kind.
- [`files.md`](./files.md) — the host-mirrored filesystem layer:
  folders + files on disk under `MANTLE_FILES_ROOT`, the editor, the
  ingestion handoff, and the MCP tools.
- [`file-ingestion.md`](./file-ingestion.md) — how files/images/documents
  enter from every source (Files UI, /assistant, Telegram, disk-watcher,
  MCP): the save→notify→extract spine, the shared primitives, a flow table,
  and the production audit.
- [`telegram.md`](./telegram.md) — a frozen handoff covering the Telegram
  bridge build. Project diary; durable details have moved here.
- [`pages.md`](./pages.md) — the Notion-style rich-document content type:
  TipTap editor, draft/commit model, custom blocks, and how pages plug into
  the brain (incl. `content_chunks` chunked retrieval + re-extract semantics).
  Also covers the **"Pages" delegate agent** + Phase 2b block-addressed
  editing (stable per-block ids, `page_blocks_list`, `page_block_*` tools)
  + the Phase 3a editor AI-assist side panel.
- [`recall.md`](./recall.md) — "Remy", the memory-recall agent: time-windowed
  replay of past conversations (`find_window` → `recall_window`) via the
  `invoke_agent` delegation path. Lossless paging vs. lossy digests.
- [`research.md`](./research.md) — "Researcher", the web-search agent: the
  outward twin of Remy. `web_search` (Perplexity Sonar via OpenRouter) wrapped
  by a synthesising agent, reached through `invoke_agent` delegation.
- [`email-send.md`](./email-send.md) — outbound email: the `email_send` tool
  sends from the user's mailbox via provider SMTP submission (reusing the IMAP
  app password); never an own MTA. The send half of the §8 read-only pipeline.
- [`contacts.md`](./contacts.md) — `contact` node type (name + company + email
  + cell + description) and the `/contacts` master-detail UI. The contacts
  list IS the email allowlist: non-empty contacts engages the send gate.
  Per-method send counters bumped on success. Same-surname-different-given
  reconciler refinement lives here too.
- [`chat-failover.md`](./chat-failover.md) — primary + backup chat routes for
  agents and chat workers (migration 0062): a different-model backup the runtime
  fails over to on route-down / 429 / 5xx. Single-shot `chatWithFailover` +
  sticky-within-turn tool-loop failover. The enabler for local-primary +
  cloud-fallback. Operator-facing summary in `ai-workers.md` §7a.

---

## 1. What this is

Mantle is a **single-user, self-hosted "AI-queryable life tree."** A Postgres
database is the source of truth for everything you care about — emails, files,
notes, secrets, Telegram messages, contacts, tasks — modelled as polymorphic
`nodes` arranged in a tree. A Next.js app gives you a UI on top; an MCP server
gives Claude direct tool access to it; workers ingest new data on a loop.

Three deliberate constraints shape every decision:

- **Self-hosted.** No SaaS in the runtime path. Postgres, object storage,
  auth, sync workers — all run on your machine in `docker-compose.dev.yml`.
- **Single-user.** The whole tree belongs to one human (`ALLOWED_USER_ID`).
  No multi-tenancy, no role-based access, no signup flow.
- **Postgres-first.** If something can be a table, it's a table. Auth, job
  queues, search, vectors, real-time events — all in Postgres. The lean
  stack is what's left after removing every other moving part.

---

## 2. The big picture

A `pnpm dev` process tree of seven Node lanes, two Docker containers,
one shared Postgres + MinIO behind them. Memory is the spine — every
ingest path lands a `nodes` row, which fires `pg_notify('node_ingested')`,
which the extractor turns into searchable index + facts + entities.
See [memory.md §0](./memory.md#0-the-flow-at-a-glance) for the
end-to-end flow.

```mermaid
flowchart LR
    classDef proc fill:#dbeafe,stroke:#3b82f6,color:#0c4a6e
    classDef infra fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef ext fill:#fce7f3,stroke:#db2777,color:#831843

    %% External interfaces
    Browser[/"Browser<br/>(you)"/]:::ext
    Phone[/"Phone<br/>Telegram"/]:::ext
    IMAP[/"IMAP provider<br/>(Gmail, Fastmail, ...)"/]:::ext
    OR[/"OpenRouter<br/>(LLM + embeddings)"/]:::ext
    Providers[/"Direct providers<br/>OpenAI · Anthropic · Google<br/>xAI · Hugging Face · ElevenLabs"/]:::ext
    Disk[/"$MANTLE_FILES_ROOT<br/>(host filesystem)"/]:::ext
    CC[/"Claude Desktop<br/>/ Claude Code"/]:::ext

    %% Web
    Web["apps/web<br/>Next.js 15 (Turbopack)<br/>middleware (HMAC cookie gate)<br/>/inbox /assistant /files<br/>/notes /todos /events<br/>/secrets /traces /debug /pending"]:::proc
    Browser -- HTTPS --> Web

    %% MCP
    MCPp["apps/mcp<br/>stdio JSON-RPC<br/>~30 tools"]:::proc
    CC -- stdio --> MCPp

    %% Background workers
    EmailW["apps/web/workers/email-sync.ts<br/>(pg-boss)"]:::proc
    TgW["apps/web/workers/telegram-poll.ts"]:::proc
    FilesW["apps/web/workers/files-watch.ts<br/>(chokidar)"]:::proc
    EvW["apps/web/workers/events-reminders.ts<br/>(30s poll)"]:::proc
    Agent["apps/agent/src/main.ts<br/>responder + extractor +<br/>summarizer + reflector<br/>(LISTEN-driven)"]:::proc

    IMAP --> EmailW
    Phone -- "Bot API" --> TgW
    EvW -- "reminder" --> Phone
    Disk --> FilesW
    Disk <-- FilesW

    %% Shared infra
    PG[("postgres<br/>pgvector/pg_trgm/ltree<br/>public.* + auth.*<br/>pg_notify channels:<br/>node_ingested,<br/>telegram_message_inserted,<br/>summarize_due")]:::infra
    MIN[("minio<br/>S3-compat<br/>bucket: mantle")]:::infra

    Web -- "Drizzle pool" --> PG
    Web -- "S3 SDK" --> MIN
    EmailW --> PG
    TgW --> PG
    FilesW --> PG
    EvW --> PG
    Agent --> PG
    Agent -- "@mantle/storage" --> MIN
    MCPp --> PG

    %% LLM
    Agent -- "@openrouter/sdk<br/>(responder + workers)" --> OR
    Web -- "@openrouter/sdk<br/>(via /assistant)" --> OR
    %% Provider adapters (TTS/STT/chat alternates) — see §9d
    Agent -- "@mantle/voice adapters" --> Providers

    %% pg_notify fan-out
    PG -. "node_ingested" .-> Agent
    PG -. "telegram_message_inserted" .-> Agent
    PG -. "summarize_due" .-> Agent
```

Everything in the box is in `docker-compose.dev.yml` (the two infra
containers) plus a single `pnpm dev` process tree (seven Node
processes orchestrated by `concurrently`).

---

## 3. The processes

`pnpm dev` (`package.json:11`) runs seven concurrent workers, named `web`,
`mcp`, `worker`, `tg`, `files`, `events`, and `agent`. Plus Postgres and
MinIO from docker-compose. That's it.

| Process            | What it does                                                                  |
|--------------------|-------------------------------------------------------------------------------|
| `postgres` (Docker)| Source of truth. Holds every row. Healthchecked, restart on failure.          |
| `minio` (Docker)   | Object store for attachment bytes. Healthchecked.                             |
| `web`              | Next.js dev server (Turbopack). Serves UI, API routes, server actions. Hosts the `/assistant` chat surface (POST `/api/assistant/turn`). |
| `mcp`              | MCP server (`apps/mcp/src/server.ts`). Speaks stdio JSON-RPC to Claude Code.  |
| `worker` (email)   | `apps/web/workers/email-sync.ts`. pg-boss queue consumer, runs IMAP syncs.    |
| `tg`               | `apps/web/workers/telegram-poll.ts`. Long-polls Telegram for new DMs.         |
| `files`            | `apps/web/workers/files-watch.ts`. chokidar on `MANTLE_FILES_ROOT`; mirrors external edits (vim, Syncthing, host `cp`) back into the DB. Loop-safe via `syncFileFromDisk`, which never re-writes bytes. |
| `events`           | `apps/web/workers/events-reminders.ts`. Polls every 30s for events whose `remind_at` has passed and `reminder_sent_at` is null; sends a Telegram DM via `@mantle/telegram`. A **recurring** event (`data.recur` = daily/weekly/monthly/yearly, optional `data.recur_until`) rolls its single row forward to the next occurrence and re-arms instead of marking sent — `rollForwardRecurrence` in `@mantle/content/events`. |
| `agent`            | `apps/agent/src/main.ts`. LISTENs on `telegram_message_inserted`, replies via OpenRouter. Shares prompt-build + LLM helpers with the web `/assistant` via `@mantle/agent-runtime`. |

The workers live under `apps/web/workers/` (not in their own app) because they
share `.env.local` and `@mantle/*` imports with the web. In production they'd
be split into their own container; for dev, one process tree keeps things
simple.

---

## 4. Data plane: Postgres

One Postgres 17 cluster, one database (`postgres`), three schemas:

- **`public`** — every Mantle table. Owned by Drizzle migrations
  (`packages/db/migrations/*.sql`).
- **`auth`** — identity. One table: `auth.users(id, email, password_hash,
  created_at)`. Owned by `infra/postgres/init/02-auth-schema.sql`. Drizzle
  sees it via `packages/db/src/schema/auth-users.ts` but `drizzle.config.ts`
  is filtered to `schemaFilter: ['public']` so Drizzle never tries to manage
  it.
- **`pgboss`** — auto-created by [pg-boss](https://github.com/timgit/pg-boss),
  the email worker's job queue. Mantle never touches it directly.

**Extensions** (`infra/postgres/init/01-extensions.sql`):

| Extension      | What it enables                                                 |
|----------------|-----------------------------------------------------------------|
| `ltree`        | `nodes.path` — hierarchical paths with operators like `<@`, `@>` |
| `pg_trgm`      | Trigram indexes for fuzzy/full-text fallbacks                   |
| `pgcrypto`     | `gen_random_uuid()` for default PKs                             |
| `"uuid-ossp"`  | Legacy uuid helpers (a few migrations still reference them)     |
| `vector`       | pgvector — `nodes.embedding` (1536-dim, OpenAI ada/3-small)     |

**Bootstrap order** matters and is enforced by the filesystem:

1. Postgres image initialises an empty cluster.
2. `/docker-entrypoint-initdb.d/01-extensions.sql` runs → extensions loaded.
3. `/docker-entrypoint-initdb.d/02-auth-schema.sql` runs → `auth.users` exists.
4. `scripts/up.sh` then runs `pnpm db:migrate` → Drizzle creates `public.*`,
   which FK into `auth.users`. The order matters because every Drizzle
   migration after 0000 references `auth.users(id)`.

A fresh setup needs one extra step the bootstrap can't do: inserting your own
row into `auth.users`. There's no signup UI — you `psql` it in directly with a
bcrypt hash. (Single-user system; this was a deliberate trade.)

**Connection** is a single `postgres-js` pool (`packages/db/src/client.ts`),
exported as `db` (Drizzle). All app code, workers, and the MCP server import
the same `db`. No raw `pg` clients, no service-role split — single connection
shape across the codebase.

---

## 5. Data plane: object storage

Attachment bytes (and eventually files) live in MinIO, an S3-compatible store
that runs as a Docker container next to Postgres. The interface is the AWS S3
SDK pointed at `http://127.0.0.1:9000`.

`packages/storage/src/index.ts` is the only file that knows about S3. It
exposes five functions:

- `putContent(buf, contentType)` — uploads, deduplicating by sha256.
- `getSignedUrl(key, ttl)` — mints a presigned GET URL.
- `getContent(key)` — streams bytes back through Node (for proxied downloads
  when the browser can't reach the MinIO endpoint).
- `deleteContent(key)` — single object delete.
- `contentKey(sha256)` / `hashBuffer(buf)` — pure helpers.

Keys are **content-addressed**: `attachments/aa/bb/<full-sha256>`. Identical
bytes always land at the same key, so dedup is automatic. The PutObject path
calls HeadObject first — if the key exists, the upload is short-circuited and
`deduped: true` is returned.

Attachment downloads go through `apps/web/app/api/attachments/[id]/route.ts`,
which **streams** the bytes through Next rather than 302-redirecting to a
presigned MinIO URL. This is deliberate: the MinIO endpoint
(`127.0.0.1:9000` in dev, an internal docker hostname in prod) is generally
not reachable by the user's browser. Proxying eats a tiny bit of bandwidth in
exchange for never leaking the internal endpoint.

---

## 6. The `nodes` table — Mantle's central abstraction

Everything Mantle stores is either a `node` or hangs off a node.
(`packages/db/src/schema/nodes.ts:34`)

```sql
nodes (
  id          uuid PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES auth.users(id),
  parent_id   uuid REFERENCES nodes(id),
  type        node_type NOT NULL,   -- enum: branch, email, file, telegram_message, ...
  title       text NOT NULL,
  slug        text,
  data        jsonb NOT NULL,       -- type-specific bag
  path        ltree NOT NULL,       -- materialised: 'inbox.email_jason.2026.may'
  tags        text[] NOT NULL,
  embedding   vector(1536),         -- pgvector, OpenAI dim
  search_tsv  tsvector,             -- GENERATED ALWAYS column over title/data
  created_at  timestamptz,
  updated_at  timestamptz
)
```

A row is one of 13 types: `branch`, `email`, `email_thread`, `file`, `note`,
`page` (see [`pages.md`](./pages.md)),
`sermon`, `contact`, `secret`, `task`, `event`, `printer_project`,
`telegram_message`. The polymorphic specialisations live in dedicated
tables (`emails`, `email_attachments`, `telegram_messages`, …) with a
`node_id` FK back to `nodes`.

Why one table:

- **Unified search.** `searchNodes()` (`packages/search/`) hits a single
  table; the tsvector + GIN(tags) + IVFFlat(embedding) indexes mean
  "find anything about X" is one query.
- **Tree operations are O(depth).** ltree's `<@` operator lets you
  ask "everything under `inbox.email_jason`" without recursion.
- **One ownership column.** `owner_id` on every node is the single thing
  the MCP server filters on. Multi-tenancy is one column change away,
  but unused today.

Indexes that Drizzle can't express (GiST on ltree, GIN on tsvector/tags,
IVFFlat on embedding) live in the raw SQL migrations under
`packages/db/migrations/`. The comment in `nodes.ts:64-66` flags this.

---

## 7. Identity

One user, one row in `auth.users`. Auth is a **bespoke signed-cookie session**:

- `apps/web/lib/auth.ts` — the Node-runtime side. `loginWithPassword()`
  compares a bcryptjs hash. `buildSessionCookie()` produces
  `<payload>.<sig>` where `payload = base64url(JSON({uid, exp}))` and
  `sig = base64url(HMAC-SHA256(SESSION_SECRET, payload))`. Signed cookies
  are stateless — to invalidate everything in one shot, rotate
  `SESSION_SECRET`.
- `apps/web/middleware.ts` — the Edge-runtime gate. Same verify logic
  rewritten in Web Crypto (Edge can't use `node:crypto`). Redirects any
  non-public path without a valid cookie to `/login`.
- `apps/web/lib/auth-constants.ts` — `SESSION_COOKIE_NAME` and
  `PUBLIC_PATHS`, the only constants both files share without drift.
- `apps/web/app/api/auth/{login,logout,change-password}/route.ts` —
  Zod-validated, single-purpose endpoints. Login sets HttpOnly + Secure
  (in prod) + SameSite=Lax cookies with 1-year `maxAge`.

`requireOwner()` is the page-level gate (`apps/web/lib/auth.ts:84`):
redirects to `/login` if there's no session, returns `{id, email}` otherwise.
Every protected page calls it at the top of its server component.

`ALLOWED_USER_ID` (an env var, not a DB-derived constant) is what the MCP
server and the workers use to scope queries. It's the same UUID as the one
row in `auth.users`; the duplication is deliberate so workers don't need to
hit the DB at startup.

There is **no signup, no password reset, no OAuth, no email verification**.
You set up the user once via SQL on the lean stack, and the bcrypt hash is
the entire auth surface. Adding a real auth library (better-auth was
considered) is a half-day swap when the time comes.

---

## 8. Email pipeline

Full reference: [`email-ingest.md`](./email-ingest.md) (inbound) and
[`email-send.md`](./email-send.md) (outbound).

The big idea: **never ingest mail you didn't ask for.** Sender curation
(`email_senders` with `pending`/`allowed`/`denied`) is the security gate;
once a sender is `allowed`, the message lands as a `nodes` row of type
`email` and the `node_ingested` pg_notify trigger fires the extractor —
same path as notes and files. `packages/email/` is ~1.5K LOC; the worker
(`apps/web/workers/email-sync.ts`) runs three pg-boss queues (scheduler
every 2 min, per-account sync, per-sender backfill).

**Cross-folder dedup** is two-tier: `emails_account_msg_uq` on
`(account_id, provider_msg_id)` catches same-UID-same-folder races
(restart replay, retry-overlap); the partial `emails_account_rfc_msg_id_uq`
on `(account_id, rfc_message_id)` catches the same logical message
landing in INBOX *and* INBOX.Archive *and* `[Gmail]/All Mail` — Gmail's
All Mail re-UIDs an old message on every label change, so a
folder-scoped key alone leaked duplicates. The INSERT uses an untargeted
`onConflictDoNothing()` + `DuplicateRaceError` sentinel so either
constraint races into a clean transaction rollback, no logged stack, no
failed pg-boss job.

**Gmail labels** (`\Inbox`, `\Sent`, `\Important`, custom user labels)
are fetched via the GIMAP `X-GM-EXT-1` extension and merged with the
IMAP system flags into `emails.labels`; safe on non-Gmail servers
(ImapFlow ignores the request).

**Delivery-kind classification.** Every message is tagged
`direct | list | automated | marketing | unknown` at sync time from
headers + envelope + Gmail labels — no body required, so it works on
mail from pending senders too. Per-sender rollup counters on
`email_senders` drive a soft-hint pill on `/settings/senders`
("📣 marketing" / "📋 list" / "🤖 automated") when ≥3 messages and ≥70%
agree on one kind, plus a `?kind=` filter chip and a conditional
"Deny N marketing senders" bulk action on the pending tab. Rules are
RFC-based (`List-Unsubscribe-Post: One-Click`, `Precedence: bulk`,
`Feedback-ID`, ESP fingerprints) with `Auto-Submitted` as the
marketing→automated downgrader, so transactional sends via ESPs (Stripe
via SendGrid, GitHub via SES) classify correctly. Full detail in
[`email-ingest.md` §9](./email-ingest.md#9-delivery-kind-classification-direct--list--automated--marketing).

---

## 9. Telegram pipeline

`packages/telegram/` is ~500 LOC. The full handoff doc is
[`telegram.md`](./telegram.md); this is the abridged version.

Flow:

1. **Long-poll worker.** `apps/web/workers/telegram-poll.ts` spawns one
   `bot.api.getUpdates` loop per enabled `telegram_accounts` row. ~25s
   long-poll timeout, exponential backoff on errors, advances
   `last_update_offset` after each batch. It reconciles the enabled-account
   set every 60s, so a newly connected bot starts polling without a restart.
   Each `telegram_accounts` row holds the bot's AES-sealed token and (since
   migration 0050) an optional `responder_agent_id` binding the bot to the
   responder that owns it — see §9b. Tokens are entered + rotated from the
   responder's `/settings/agents` **Telegram bot** section
   (`lib/agent-telegram.ts` + `POST /api/agents/[id]/telegram`); the CLI
   `seed:telegram` remains for bootstrap.
2. **Inbound gate.** `packages/telegram/src/gate.ts` decides what happens
   to each message. DMs only (groups silently dropped in v1). Allowlist
   logic: known chat → deliver. New chat → issue a 6-char pairing code, DM
   it back, wait for the owner to approve. Approval is **one click in the
   responder's Telegram section** (pending requests list with Approve/Block,
   polled every 10s) — the `telegram_pair` MCP tool is the equivalent
   fallback. Approving flips the chat to `allowed` and sends a confirmation
   DM that greets with the responder's name. Replies are capped at 2 per
   pending chat so an unknown sender can't farm responses.
3. **Persist.** A single transaction inserts a `nodes` row of type
   `telegram_message` + a `telegram_messages` row + bumps
   `telegram_chats.last_message_at`. A trigger
   (`packages/db/migrations/0009_telegram.sql`) fires
   `pg_notify('telegram_message_inserted', new.id::text)` for any future
   reactive consumer.
4. **Outbound.** Claude calls `telegram_send` (or `telegram_react`,
   `telegram_edit`) via the MCP server. The MCP server checks the chat is
   `allowlist_status='allowed'`, then sends via the cached `Bot` instance.

Inbound persists messages immediately whether or not Claude is watching;
outbound is gated to allowlisted chats only.

---

## 9b. The agent — auto-replies to Telegram

`apps/agent/src/main.ts` is the event-driven reply loop. As of migration
0011/0012 (May 2026) the agent is **DB-driven, multi-turn, and emits
prompt-caching markers.**

```
inbound DM
  → telegram-poll worker INSERTs into telegram_messages (direction='inbound')
  → trigger pg_notify('telegram_message_inserted', new.id::text)   (inbound only)
  → apps/agent's LISTEN connection wakes up
  → resolve responder agent  (per-chat override → bot's owning responder → global priority)
  → load conversation history  (last N inbound+outbound turns, chronological)
  → buildChatMessages(...)  (cache_control on system block for anthropic/*)
  → @openrouter/sdk call
  → @mantle/telegram sendMessage  (on the inbound message's own bot)
  → INSERT outbound row + matching node
  → mark inbound processed
```

Key properties:

- **DB-driven config.** No more `AGENT_MODEL` / `AGENT_PERSONA` env vars.
  Each agent is a row in the `agents` table: model, system prompt,
  `api_key_id` (FK into the encrypted vault), `memory_config`, `params`,
  `priority`, `enabled`. Managed at `/settings/agents`.
- **Priority ranking.** When multiple agents share a role (e.g. several
  `responder` rows), the highest-priority enabled one wins. Priority is a
  plain int, higher = higher priority. Switching the active responder is a
  toggle in the UI.
- **Per-chat overrides.** A `telegram_chats` row can pin a specific agent
  via `responder_agent_id` (migration 0020); when set + the agent is
  enabled, that agent handles inbound for the chat. NULL falls back to
  global priority resolution. Managed inline on the `/debug` chats table.
- **Per-bot binding (migration 0050).** A `telegram_accounts.responder_agent_id`
  links a bot to the responder that owns it — set when you paste the token
  into that responder's `/settings/agents` Telegram section. So one responder
  = one bot, and a message resolves to the bot's owner. Full precedence:
  **per-chat override → the bot's owning responder → global priority**
  (`resolveResponderAgent(ownerId, perChatOverride, accountResponderId)`).
  Replies + attachment downloads go out on the **inbound message's own bot**
  (`accountById(row.accountId)`), not the "first enabled" account — this is
  what makes several responder bots run side-by-side correctly. Unlinked bots
  (`responder_agent_id` NULL, e.g. CLI-seeded) keep the old global-priority
  behaviour.
- **Recent turns (`recent_turns`).** Both inbound and outbound messages
  live in `telegram_messages` now, distinguished by the `direction` column.
  The runner loads the last `memory_config.history_limit ?? 20` turns for
  context. The pg_notify trigger fires only on inbound rows so the agent
  doesn't react to its own replies.
- **Conversation digests (`conversation_digest`).** Migration 0013 adds
  `digest_node_id` on `telegram_messages` plus a separate `summarize_due`
  pg_notify channel that fires on every insert. A summarizer agent (role
  `summarizer`, default model `anthropic/claude-haiku-4.5`) listens on
  that channel inside `apps/agent`, debounces 2s, and rolls the oldest
  `memory_config.summarize_batch ?? 20` undigested turns into one `note`
  node tagged `conversation-digest` whenever the undigested count for a
  chat crosses `memory_config.summarize_threshold ?? 30`. The responder
  loads the latest `memory_config.digest_limit ?? 3` digests for the chat
  and prepends them as a second system message. Conversations stay
  coherent past the raw-history window without an exploding token bill.
- **Prompt caching.** For `anthropic/*` models the runner emits
  `cache_control: { type: 'ephemeral' }` on the system block AND on the
  digest block when present — two of Anthropic's four allowed breakpoints.
  Both prefixes are stable for many turns; only the last-20-turns tail
  drifts. Caching for non-Anthropic models is implicit (OpenAI, DeepSeek
  auto-cache) or unsupported (most open-source routes) — no marker needed.
- **Event-driven, not polled.** The pg_notify trigger is fired inside the
  worker's INSERT transaction, so the agent gets the message id within
  milliseconds of it landing in the DB.
- **Per-chat serialized.** An in-memory `Map<chatId, Promise>` ensures two
  inbound messages from the same chat don't fire two outbound replies
  racing each other.
- **Drains on boot.** On startup the agent processes the backlog of
  `direction='inbound' AND processed=false` rows in `sent_at` order.
- **Owner-scoped.** Reads `ALLOWED_USER_ID` at startup; only handles
  messages whose chat belongs to that user.

Sharp edges still open:

- **No third cache breakpoint.** Two of four are used (system + digest).
  Marking the raw-history block too would cut cost further but needs the
  prefix to be byte-stable turn-to-turn — easy to break accidentally
  when a new turn lands.
- **No cost ceiling.** Each inbound triggers exactly one OpenRouter
  responder call + (every ~20 turns) one summarizer call. Cheap on
  Haiku/DeepSeek; spendier on Sonnet/Opus.
- **No semantic retrieval.** `nodes.embedding` exists but isn't used in
  the agent's context assembly. The natural follow-up is "for this
  inbound, fetch the top-K most-relevant older digests via vector
  similarity, not just the most recent."
- **No idle-summarization.** A chat that goes quiet just below threshold
  sits there until N more turns arrive. Easy to add a startup pass; not
  worth the code until it actually bites.
- **No Tier-3 / fact consolidation.** The Mem0-style ADD/UPDATE/DELETE
  pipeline for observation memory ("Sarah's passport expires June
  2030", dedup'd across sources) is the next layer up — separate from
  conversation summarization.

## 9b'. Agent delegation (`invoke_agent`)

An agent can hand a one-shot prompt to another agent via the
`invoke_agent` builtin tool. The intended shape: cheap triage agent
(claude-haiku, no retrieval) handles every Telegram turn; when it
detects a question that needs deep work, it calls `invoke_agent` with
`agent_slug: 'researcher'` and a focused prompt, and the researcher
(claude-opus + search tools + longer context) returns its final text
as the triage agent's tool result.

The bridge between `@mantle/tools` (where the builtin lives) and
`@mantle/agent-runtime` (where `runToolLoop` lives) is a registered
callback — `apps/agent/src/main.ts` and `apps/web/lib/assistant.ts`
each call `registerAgentInvoker(invokeAgent)` at module load, so the
builtin can call back into the runtime without an import cycle.

Four guardrails ([`packages/tools/src/invoke-agent-guards.ts`](../packages/tools/src/invoke-agent-guards.ts)):

1. **Bounded depth.** `MAX_AGENT_DEPTH = 2`. Entry-point agent runs
   at depth 1, child at depth 2, grandchildren refused. The dispatcher
   AND the runtime both check, so a caller routing around the bridge
   still fails closed.
2. **Synchronous, one-shot.** Parent awaits the child's final text.
   The child's conversation history is NOT shared with the parent;
   delegation passes a single prompt and receives a single reply.
3. **Per-target allowlist.** The parent agent's
   `memory_config.delegate_to: string[]` lists which slugs it may
   invoke. Empty/missing = no delegation. Self-references are refused
   even when present in the list — the closest thing to a recursion
   footgun we have. Editable via the **"Delegates to"** picker at
   `/settings/agents`; `updateAgent` jsonb-**merges** `memory_config`
   (`||`) so a form save never silently drops the allowlist. (An earlier
   wholesale overwrite *did* drop it — the form doesn't render
   `delegate_to`, so saving any agent wiped the grant. That's why
   delegation looked broken until re-seeded.)
4. **Cost attribution.** The child gets its own `traces` row
   (`kind='manual'`, `subjectKind='child_agent'`, `data.parent_trace_id`
   set for navigation). The child trace owns the child's full cost;
   the parent's `invoke_agent` step records `meta.child_trace_id` +
   `meta.child_cost_micro_usd` for visibility but doesn't roll up,
   so `/debug` "spend by agent" totals stay correct.

**Shipped delegation target — "Remy" (recall).** The first concrete
use of this path is the memory-recall agent: Saskia delegates an
explicit "recall what we discussed last week" request to `remy`
(slug), which uses two recall builtins (`find_window` over digests →
`recall_window` over the raw message archive) to replay the actual
turns and hand back a synthesis. Remy is an `agents` row precisely
because recall needs a tool loop (`invoke_agent` only targets
`agents`); it runs at depth 2 so it iterates sub-ranges itself rather
than sub-delegating.

**Shipped delegation target — "Researcher" (web search).** The *outward*
twin of Remy: Saskia delegates an open-web question to `researcher`
(slug), which calls the `web_search` builtin (Perplexity Sonar via the
owner's OpenRouter key) and returns a cited synthesis. Saskia decides
whether to keep it via `note_create` (then the extractor indexes it).
Both targets are wired into the responder's `delegate_to` by their seed
scripts (`pnpm -C apps/web seed:remy` / `seed:researcher`). Full detail
in [`recall.md`](./recall.md).

**Shipped delegation target — "Pages" (document authoring + editing).**
The third delegate, scoped to the `/pages` surface. Saskia hands off
any existing-page transform (restyle, reformat, add callouts,
restructure) and any file → page import to `pages` (slug); Pages
operates on stable per-block ids (Phase 2b) via `page_blocks_list` →
`page_block_get` → `page_block_update` (and `_insert_after`,
`_delete`), so the output bytes scale with the **change**, not the
document size — the lever that whole-doc round-trips through chat
models lacks. All writes land in `pages.draft_doc` (never `doc`); the
operator commits via the editor or via the new AI-assist side panel
([`pages.md` §4 / §8](./pages.md)). Three structural protections worth
naming: Pages does NOT hold `page_update` (the live-overwrite path)
in its tool list, only `page_update_draft` + the block tools; its
persona carries a HARD RULE preserving every word verbatim with a
pre-flight word-count check; the editor's existing draft/commit
machinery is the off-ramp if the model misbehaves. Seed:
`pnpm -C apps/web seed:pages`. Model: `anthropic/claude-sonnet-4.6`,
`max_tokens: 32000`.

## 9c. Encrypted API key vault

`packages/api-keys/` is the storage layer for external service keys
(OpenRouter, OpenAI, Anthropic, …). One table:

```sql
api_keys (
  id          uuid PK,
  user_id     uuid REFERENCES auth.users(id),
  service     text,             -- 'openrouter' | 'openai' | …
  label       text,             -- 'default' | 'personal' | 'agent'
  key_enc     bytea,            -- AES-256-GCM via @mantle/crypto, AAD = id
  key_version int,
  scopes      text[],
  last_used   timestamptz,
  …
  UNIQUE (user_id, service, label)
)
```

Exposed as:

- `getApiKey(userId, service, label?)` — decrypts and returns plaintext.
- `setApiKey`, `rotateApiKey`, `deleteApiKey`, `listApiKeys` (returns
  masked view).

UI at `/settings/keys`. Plaintext is shown to the user exactly once
(at create / rotate); the list endpoint returns only `sk-1…abcd`
masked views.

The agent reads `getApiKey(USER_ID, 'openrouter')` at the start of
every reply. If the key is rotated in the UI, the next reply picks up
the new value with no restart.

The **provider catalogue** in `@mantle/voice` (see §9d) drives the
dropdown of recognised services. Adding a new provider there
auto-populates the create form; the `service` column stays free-text
for forward-compat with services we haven't catalogued yet.

## 9d. AI workers + provider adapter framework

The `agents` table was originally a grab-bag: it held both
conversational agents (responder, assistant) and one-shot jobs
(reflector, extractor, summarizer). After the responder grew tool
loops, persona notes, memory configuration, and a multi-turn shape,
the workers became the awkward minority — they have no persona, no
memory, no turn structure, and only need a model + key + system prompt.
At the same time we wanted to add new transformation jobs (voice
in/out, vision OCR, image generation) that share *worker* DNA but
emphatically not *agent* DNA.

So we split:

- **`agents` table** — conversational reasoners only. Today: responder
  (Telegram) and assistant (web `/assistant`). They have `persona_notes`,
  `memory_config`, `tool_slugs`, `skill_slugs`. UI at `/settings/agents`.
- **`ai_workers` table** (migration `0027_ai_workers.sql`) — one-shot
  jobs of any flavour. Each row has `kind`, `provider`, `model`,
  `api_key_id`, optional `system_prompt`, and `params` (kind-specific
  jsonb). UI at `/settings/ai-workers`.

The `ai_worker_kind` enum: `reflector | extractor | summarizer | tts |
stt | vision | image_gen | embedding`. The first three migrate cleanly
from the old `agents.role` enum (preserved by the migration's backfill);
`tts`/`stt`/`vision`/`image_gen` unlock features that don't fit the
agent abstraction; `embedding` (added in migration 0047) is the canonical
pick point for the text→vector model used across the whole stack.

Per-kind params (declared in `packages/db/src/schema/ai-workers.ts`):

| Kind | Notable params | Triggered by |
|---|---|---|
| `reflector` | `temperature`, `max_tokens`, `window_size`, `max_notes_per_run` | timer (every 10 min) |
| `extractor` | `temperature`, `target_types`, `extract_facts`, `embedding_model`, `extract_cost_cap_micro_usd` | `pg_notify('node_ingested')` |
| `summarizer` | `temperature`, `summarize_threshold`, `summarize_batch` | `pg_notify('summarize_due')` |
| `tts` | `voice`, `speed`, `format`, `instructions` (gpt-4o-mini-tts only) | inbound voice msg OR `[VOICE]` marker |
| `stt` | `language`, `max_duration_seconds` | inbound voice msg |
| `vision` | `extraction_prompt`, `max_tokens` | (not wired yet) |
| `image_gen` | `size`, `style`, `quality` | (not wired yet) |
| `embedding` | `output_dimensions` (only models that honour it — Gemini) | every embedding call (extractor writes, agent memory reads, recall, MCP search, spill query) |

One worker per `(owner, kind)` is marked `is_default=true`. The runtime
calls `getDefaultWorker(ownerId, kind)` from `@mantle/db`; the default
flag wins, otherwise highest-priority enabled row.

**Embedding resolution** is the one kind that's resolved on a *hot path*
rather than at trigger time, so it has its own per-owner 60s in-process
cache in `@mantle/embeddings#resolveEmbeddingModel`. The fall-through
chain: `ai_workers` (kind=embedding) → `MANTLE_EMBEDDING_MODEL` env var
→ hardcoded `openai/text-embedding-3-small`. Workers form mutations
(`createAiWorkerAction` / `updateAiWorkerAction` / `setDefaultWorkerAction`
/ `deleteAiWorkerAction`) call `clearEmbeddingModelCache(ownerId)` so a
model swap takes effect on the next ingest / recall instead of waiting
the TTL. Discovery for the embedding kind uses OpenRouter's keyless
`/api/v1/embeddings/models` catalog — 25 models with pricing — because
OR's main `/v1/models` deliberately excludes embedding routes (separate
endpoint).

The form's `EmbeddingFields` block handles the two cliffs a model swap
can hit. A **Test dimensions** button embeds a probe string and reports
the actual output dim — replaces the hand-maintained allow-list as the
authoritative dim source. When the dim is known and ≠ 1536, the Save
button is **hard-blocked** — switching to a non-1536 model needs a
schema migration on every `vector(1536)` column (nodes, entities, facts,
content_chunks), not just a re-embed. When the dim matches but the
*model* changed, a **Rebuild Index** button re-embeds every stored
vector against the saved model — same code path as the `pnpm re-embed`
CLI via `@mantle/embeddings#runReembed`, cache-aware so re-running
against the same model is free. Full detail in
[`ai-workers.md` §5e](./ai-workers.md#5e-embedding--the-cross-cutting-kind).

**The provider adapter framework** lives in `@mantle/voice` and is the
layer that lets us swap providers without changing call sites. Three
concepts:

- **Provider catalogue** (`providers.ts`) — closed-set list of known
  AI providers with their capabilities, signup URLs, docs URLs. Drives
  the UI dropdowns; persisted as `api_keys.service` and
  `ai_workers.provider`.
- **Per-capability dispatcher interfaces** (`adapters/types.ts`) —
  `ChatDispatcher`, `TtsDispatcher`, `SttDispatcher`,
  `VisionDispatcher`, `ImageGenDispatcher`. Each defines a uniform
  call shape (`chat(opts)`, `synthesize(opts)`, etc.) plus optional
  hooks for live model discovery and voice listing.
- **Adapter registry** (`adapters/registry.ts`) — `Map<ProviderId,
  Dispatcher>` per capability. Built-in adapters self-register on
  import. The runtime resolves
  `getChatAdapter(worker.provider).chat({...})` and the per-provider
  quirks live behind that boundary.

Currently shipped adapters:

| Provider | Chat | TTS | STT | Vision | Image-gen |
|---|---|---|---|---|---|
| OpenAI | (via OpenRouter) | ✅ `openai-tts` | ✅ `openai-stt` | — | — |
| OpenRouter | ✅ (direct SDK) | — | — | — | — |
| xAI (Grok) | ✅ `xai-chat` | — | — | — | — |
| Hugging Face | ✅ `huggingface-chat` (router) | — | — | — | — |
| Anthropic (direct) | ✅ `anthropic-chat` | — | — | — | — |
| Google (Gemini) | ✅ `google-chat` | — | — | — | — |
| ElevenLabs | — | ✅ `elevenlabs-tts` | — | — | — |

Adding a new provider is `~150 LOC`:

1. `catalogs/<provider>.ts` — known models with capabilities + pricing
2. `adapters/<provider>-<capability>.ts` — implements the dispatcher
   interface, translates the unified call shape to the provider's
   native HTTP shape
3. One line in `adapters/index.ts` to `registerXAdapter(...)`

The UI dropdowns light up automatically (the `isProviderWired(id, cap)`
helper derives wired-ness from the registry, not a static flag).

**Why not LiteLLM as a proxy?** Earlier debate; see commits. Short
version: type safety end-to-end, no extra container on Contabo, the
adapter pattern is roughly the same maintenance cost as LiteLLM's own
adapter code (which we can lift from when shapes are weird). LiteLLM
adoption later would mean writing a single `LiteLLMTtsAdapter` /
`LiteLLMChatAdapter` and routing through that — the interface is the
swap point.

See [ai-workers.md](./ai-workers.md) for the deep dive.

## 9e. Voice in/out (Telegram)

A Telegram voice message arrives → the agent transcribes it before the
responder sees anything; the responder's text reply gets synthesised
to a voice note before send. Both directions route through the
adapter framework, so swapping OpenAI Whisper for Deepgram (or
OpenAI TTS for ElevenLabs) is a worker-row edit, not a code change.

```
inbound voice msg
    │
    ├─→ apps/agent handleMessage
    │     │
    │     ├─ detect voice attachment (kind='voice' file_id)
    │     ├─ resolve default STT worker (kind='stt')
    │     ├─ downloadTelegramFile(account, fileId)
    │     ├─ adapter.transcribe(bytes, opts)         ← OpenAI Whisper today
    │     ├─ UPDATE telegram_messages SET text=transcript
    │     └─ continue normal responder flow with the transcribed text
    │
    └─→ responder produces reply text
          │
          ├─ if wasVoice OR reply starts with [VOICE] marker:
          │     ├─ resolve default TTS worker (kind='tts')
          │     ├─ adapter.synthesize({text, voice, speed, instructions})  ← OpenAI / ElevenLabs
          │     └─ sendVoice(account, chatId, audioBytes)
          └─ else sendMessage(...) as text
```

Configuration is per-worker — the user can set Saskia's voice to Nova
(OpenAI default), nova with style instructions ("speak warmly")
on gpt-4o-mini-tts, or pick a cloned voice from their ElevenLabs
library. The `voice in → voice out` mirror is automatic; `[VOICE]`
prefix lets the LLM opt into TTS reply even when the user typed.

Failure modes degrade gracefully:

- STT down → polite text apology ("Sorry — couldn't pick up that voice
  clip"), inbound row stays unprocessed for retry.
- TTS down → falls through to text reply with a `ttsFallback: true`
  meta on the trace step.
- Voice clip > 3 min cap → polite text refusal, no transcription bill.

## 9f. Vision + image generation

Attachment ingestion has two cleanly-separated layers (deep dive:
[`ai-workers.md §5b`](./ai-workers.md)): the **extractor** is the single
durable-metadata producer for every file however it arrived, and the
conversational surfaces add an ephemeral, question-aware read for the
live reply via the shared `extractAttachmentForTurn` helper.

- **Attachment in (/assistant or Telegram):** an image OR document
  (pdf/docx/xlsx/csv/txt/md/json/yaml) → saved as a `file` node under
  `/files/{assistant,telegram}-uploads/<date>/` → `extractAttachmentForTurn`
  (question-aware vision for images, `parseDocumentBytes` for docs) folded
  into the turn (transcript-default) with the file node id surfaced so Saskia
  can re-read it (`extract_from_image` / `file_read`). The responder then
  answers (`responder_turn` trace). Telegram has full parity with web,
  including documents.
- **Indexing (universal):** the save fires `node_ingested` → the extractor
  produces durable `data.text` + summary + embedding + facts — images via the
  shared `runVisionWorker` (neutral describe+OCR, `photo_ingest` trace), docs
  via `parseDocumentBytes`. So a file dropped into `/files` (Files UI,
  disk-watcher, MCP) — with no inline pass — still gets fully indexed. One
  indexing path however the file lands.
- **Vision on demand (Saskia tool):** `extract_from_image(node_id |
  telegram_file_id, prompt?)` — Saskia can re-read a previously-sent
  photo or any image-typed file node.
- **Image gen (Saskia tool):** `generate_image(prompt, size?, style?,
  quality?, negative_prompt?)` — runs the default image_gen worker,
  saves to `/files/generated-images/<date>/`, delivers inline
  (`sendPhoto` on Telegram, base64 artifact on web).

All routed through the same adapter framework as TTS/STT. 4 vision
providers wired (OpenAI, Anthropic, Google, xAI); 4 image-gen
providers (OpenAI, xAI, Google, Hugging Face). See
[`ai-workers.md`](./ai-workers.md) for the full matrix.

## 9g. Web /assistant — full multimedia parity with Telegram

The `/assistant` chat (web) reaches Telegram-equivalent capability:

- **Mic input** — `MediaRecorder` → `POST /api/assistant/transcribe`
  → STT worker → fills the input box. User reviews + sends; no
  auto-send (Whisper mishearings would cost an LLM round-trip).
- **Voice output** — Saskia's `synthesize_speech` tool emits an
  audio artifact via the tool-loop sidecar mechanism; the chat
  renders `<audio controls>` inline in the reply bubble.
- **Image upload** — paperclip in the input row attaches an image;
  multipart submit; vision worker runs synchronously; image renders
  in the user's bubble.
- **Image gen** — `generate_image` artifact renders as a
  click-to-zoom preview in the reply bubble.

Artifacts ride the `runToolLoop` result via a sidecar array — see
[`ai-workers.md §5d`](./ai-workers.md) for the artifact convention.

**Per-agent transcript model.** Each agent on `/assistant` owns its own
forever-conversation. The shared brain (`nodes` / `facts` / `entities`,
none of which are agent-partitioned) is what agents have in common; the
transcripts are not. `assistant_messages.agent_id` is `NOT NULL` since
migration 0049 — the bug class where N assistant-role agents all saw the
same legacy NULL-agent_id rows ("different agents show the same chat
with content swapped") is structurally extinct. The runtime gates are
correspondingly thinner: `recentAssistantMessages(ownerId, agentId,
limit)` and `assistantMessagesBefore(ownerId, agentId, before, limit)`
both require `agentId` so any new caller that forgets to scope fails at
typecheck instead of silently returning everything.

**Last-selected agent persistence.** The dropdown's pick-handler writes
`mantle_assistant_agent` (path=/, 1y, samesite=lax) before navigating to
`?agent=<slug>`. Server reads it as the SSR default when the URL has no
param. Pattern mirrors `mantle_spend_range`. Resolution order: URL param
→ cookie → priority default. Switching agents force-remounts
`AssistantClient` via `key={agent.slug}` so every piece of local state
(draft, attached image, recording flag, optimistic messages) resets
cleanly — without the key, Next.js soft-navigation preserves the prior
agent's component state across the swap.

## 9h. Profile preferences + time-aware agent

Two per-user preferences live in `profiles.preferences` jsonb:

- `timezone` (IANA, e.g. `Africa/Johannesburg`)
- `locale` (BCP-47, e.g. `en-GB`)

Set at `/settings/profile`. The responder turn prefixes Saskia's
system prompt with a one-line **time context**: `Current time:
<full local date + time> (<tz>). UTC instant: <ISO>. User locale:
<bcp47>.` So Saskia resolves "tomorrow at 3pm" → UTC ISO before
calling `event_create`. Costs ~30 prompt tokens per turn; broadly
useful so it's unconditional (not gated on the event tools being
attached).

Saskia gets 5 event tools (`event_list`, `event_get`, `event_create`,
`event_update`, `event_delete`) mirroring the MCP shapes. None
require_confirm — operator can flip per-row in `/settings/tools` if
approval gates are wanted. `event_create` defaults the event's
timezone to the owner's profile when the caller doesn't specify.

## 9i. End-to-end traceability

Companion doc: [`observability.md`](./observability.md). Every data
entry point opens a `content_ingest` trace; every pipeline decision
(including "I considered this but chose not to run") opens a trace
with a disposition string. The node-biography page at
`/nodes/<id>/history` joins all traces tied to a node into a single
operator-facing timeline. The hard rule: **nothing happens to your
data without a trace row showing it.** See observability.md for the
full disposition catalog and the two real-world tracing bugs that
informed this design (FK enum-mismatch + Drizzle journal-skipped
migration).

## 9j. Heartbeats — proactive agent loop

Full doc: [`heartbeats.md`](./heartbeats.md). Heartbeats turn Saskia
from passive to proactive: a `heartbeats` row schedules a
**skill→agent→surface** invocation on a recurring/once/manual
schedule, carries persistent `state jsonb` across fires, and
self-terminates via the `heartbeat_complete` tool.

The fire loop lives in `apps/agent/src/main.ts` as a per-minute
`setInterval` (same backoff pattern as the reflector). Each tick:

1. SELECT active heartbeats where `next_fire_at <= now()`
2. Filter out rows currently in-flight (per-process `Map<id, Promise>`
   lock in `inflight.ts` — without it a fire taking >60s would be
   re-selected by the next tick and double-fire)
3. For each remaining: gate-check (idle / quiet / cooldown / earliest)
4. On pass: open `trace_kind='heartbeat_fire'`, build synthetic
   "you have a heartbeat to do" prompt, run the agent's tool loop
   under `withHeartbeatContext`, deliver reply via a dedicated
   `deliver_surface` step, reload + update `state` + `next_fire_at`
   (preserving any snooze pushed further out than the schedule)
5. On gate fail: append to `heartbeat_fires` audit log + record a
   skipped trace, bump `next_fire_at` to retry soon

Key separation: **heartbeat skills are NOT loaded into the agent's
persistent prompt**. They're injected ONLY into the synthetic
user-role prompt at fire time. The responder's normal turn queries
`open_heartbeats_for_surface` and appends an awareness block with
a **3-branch decision tree** (related answer → call update_state;
unrelated → leave alone, do NOT call heartbeat tools; stop request
→ snooze/complete) — keeping continuity across outbound/inbound
without making every regular turn pestering.

Gates are nullable (per-heartbeat-only policy, no system-wide
defaults). Form offers a "sensible defaults" preset
(15min idle / 22:00–07:00 quiet / 30min cooldown); blank columns
mean "no gate of that kind".

5 builtin control tools live in `@mantle/heartbeats/src/tools.ts`
(not `@mantle/tools` — would create a dep cycle): `heartbeat_complete`,
`heartbeat_snooze`, `heartbeat_update_state` (all use **dual-mode
addressing**: explicit `slug` arg → ALS context → error),
`heartbeat_list`, `heartbeat_fire` (always slug-keyed).

**Permission model**: `agents.tool_slugs` is the single source of
truth. The heartbeat continuity tools must be in the responder
agent's allowlist (visible at `/settings/agents`) for the
responder→state update path to work. The seed script
`seed-get-to-know-user.ts` ensures this; custom heartbeats need
the operator to grant the three mutation tools manually. The tools
self-protect via `resolveTargetHeartbeat`, so granting them is
safe — they're inert in unrelated turns.

**Runtime affordance hygiene**: both responders (apps/agent +
apps/web) drop the `HEARTBEAT_RESPONDER_TOOLS` set
(`heartbeat_update_state` / `_complete` / `_snooze`) from the
per-turn tool list when `hasActiveHeartbeatsOnSurface()` returns
false. The grant in `tool_slugs` is unchanged; the model never
sees the tools on turns with no relevant heartbeat. Equivalent to
greying out a UI button when its action would no-op — pure
context scoping, not a permission change. A completed/paused
install becomes byte-indistinguishable from one that never had
heartbeats.

**State conventions**: `expecting_reply` (boolean — drives the
awareness-block injection), `last_asked_at` (ISO — drives "asked
Nh ago" display + stale-pending nudge), `last_question_topic`,
`answered` (string[]). These are read by engine code but written
only by skill instructions via `heartbeat_update_state`. See
`heartbeats.md` §10 for the canonical list.

## 9k. Re-extract is idempotent (no duplicate brain rows)

Editing content re-fires `node_ingested`, so a node is extracted many times
over its life. Every derived brain artifact is therefore written as a
**rebuild keyed by the node, not an append** — a re-extract *replaces* prior
output instead of piling up:

- **Summary + embedding** — overwritten in place on the `nodes` row.
- **Entities** — reconciled by name (existing rows reused, never re-created).
- **Facts** — run through the ADD/UPDATE/DELETE/NOOP dedup classifier.
- **`content_chunks`** — deleted for the node, then re-inserted.
- **`mentioned_in` edges** — cleared for the node, then re-inserted.

The last two follow the same **delete-then-rebuild per node** rule. The edge
clear was a fix (Phase 4): the extractor previously *appended* a `mentioned_in`
edge on every run, so re-edited content accumulated duplicate
`entity --mentioned_in--> node` rows. Because the rule lives in the **shared
extractor**, it covers every content type automatically — notes, pages,
emails, files — with no per-type code. Edit a note → it re-extracts → its
edges are cleared and rebuilt → no new duplicates. Same for everything.

Two corollaries:

- **Re-extract is not free** — it re-runs the summary LLM and the fact
  classifier (bounded by `extract_cost_cap_micro_usd`). That's why pages
  re-extract only on a deliberate **commit**, not on every keystroke (see
  [`pages.md`](./pages.md) §3, §6).
- **Pre-fix duplicates** that accumulated before the edge fix are cleaned in
  one pass by `pnpm dedupe:edges` (dry-run by default; collapses duplicate
  `mentioned_in` rows, keeping the earliest). `extract:backfill` does *not*
  clean them — it only re-fires nodes still missing their index.
- **Duplicate-edge guard (dashboard).** Because the single writer
  delete-then-rebuilds, duplicates can't accrue — so instead of a recurring
  `dedupe:edges` job (which would *mask* a regression), the dashboard's
  **Memory-index** card shows a live duplicate count (`graphIntegrity()` in
  `apps/web/lib/dashboard.ts`): green when clean, amber with the one-shot
  `pnpm dedupe:edges --apply` remedy if a regression ever surfaces. A monitor,
  not a fixer — see [`agent-overhaul-2026-05.md` §2e](./agent-overhaul-2026-05.md).

## 9l. Model catalog — live context, capabilities, pricing

How the system knows what a model can do —
[`packages/tracing/src/model-context.ts`](../packages/tracing/src/model-context.ts).

**The problem it solves.** A model's context window, vision support, and
pricing are all *provider* facts that change without notice — e.g. Claude
Sonnet/Opus 4.x defaulting to a **1M** window. A hand-maintained table
silently goes stale: the dashboard's "context %" once read a model as 200K
when it was really 1M, over-reporting fill by 5×. So capability is sourced
live and cached.

**Authoritative source.** OpenRouter's public `GET /api/v1/models` (no API
key required). Per slug we read:

| Field | Used for |
|---|---|
| `top_provider.context_length` (fallback `context_length`) | the context window (`contextLimitFor`) |
| `architecture.input_modalities` (`image` ⇒ multimodal) | vision routing (`modelSupportsVision`) |
| `pricing.prompt` / `pricing.completion` (USD per token, string-typed) | per-1M pricing badges (`pricingFor`) |

`supported_parameters` (`tools`, `structured_outputs`, `reasoning`, …) is
available on the same response for future use.

**Pricing as a universal oracle for direct providers.** OpenRouter
aggregates upstream, so its catalog covers what each direct provider
sells. A worker stored as `provider='anthropic', model='claude-sonnet-4-5'`
looks up `anthropic/claude-sonnet-4-5` in this cache and gets the same
pricing Anthropic's own `/v1/models` would have returned if it bothered
to. One source serves both modes — OpenRouter-as-provider in `/settings/agents`,
direct providers in `/settings/ai-workers`. The two prefix-remappings
worth knowing (the only places SUPPORTED_PROVIDERS ids don't match OR
prefixes verbatim): `xai → x-ai`, `mistral → mistralai`.

**Pricing parser nuance.** OpenRouter encodes pricing as USD per single
token, string-typed (`"0.0000025"` for $2.50 per 1M). The parser multiplies
by 1e6 for the per-million view and is tight on the empty-string case —
`Number('')` is 0 in JS, which would silently promote malformed data into
"free". Empty / non-numeric input stays `undefined` so callers can
distinguish *free* (0) from *unknown* (absent).

**The fetch — built to fail safe.** `refreshModelCatalog()` is the single
entry point. It is **TTL-gated** (6h), **dedupes** concurrent callers
(in-flight promise), has an **8s timeout**, and **never throws** — on any
failure it keeps the last-good cache, degrading to a **static fallback
table** that is kept roughly current (so even a cold start with OpenRouter
down returns accurate numbers). The cache is per-process and in-memory; no
DB, no migration.

**The readers are sync** so callers don't have to await:
`contextLimitFor(slug)` / `modelSupportsVision(slug)` return live data if
cached, else the fallback (context) or the family heuristic (vision), else
null/false. `contextSourceFor(slug)` reports provenance (`live` |
`fallback` | `unknown`).

**Warming.** Each consuming process fire-and-forgets `refreshModelCatalog()`
where it reads capability — `recentAgentContext` (dashboard), the agent's
attachment path, the web `/assistant` turn. Fire-and-forget is safe because
the fallback is accurate: the first read after a cold start uses it, live
data takes over once the fetch lands, and the TTL-gated calls keep it fresh.

**Where the user sees it.**
- **Usage card** (sidebar): per-agent context-fill bars, now correct, with
  `live`/`fallback` provenance in the tooltip.
- **`/settings/agents` → Model field**: a searchable combobox over the full
  live OpenRouter catalog (see §9l′) plus a context-window readout for the
  typed slug. Both served by [`/api/model-context`](../apps/web/app/api/model-context/route.ts)
  (the same cached map) — "unknown for this slug" flags a typo'd id.
- **`/settings/ai-workers` → Model field**: the same combobox, fed by the
  adapter's `discoverModels()` for the chosen provider, with this catalog's
  pricing folded in as a fallback for direct providers that don't return
  pricing in their own `/v1/models`.

**How to check by hand:** `curl -s https://openrouter.ai/api/v1/models` and
read `context_length` / `top_provider.context_length` /
`architecture.input_modalities` / `pricing.{prompt,completion}` for the
slug — that's the same source the code reads.

> **Note — Mantle never sets a context "flag".** The window is a property of
> the model slug + its OpenRouter route, not a request parameter. Mantle
> sends only `model` + sampling params (no `provider` routing pref, no
> `anthropic-beta` header). For providers where the big window is a beta,
> OpenRouter handles the opt-in upstream and advertises the resulting ceiling
> as `context_length`. So "1M vs 200K" is decided by the slug, and the
> ceiling is read off the catalog — there's nothing to toggle.

## 9l′. Model picker UI — searchable combobox over the live catalog

Source: [`apps/web/components/ui/model-select.tsx`](../apps/web/components/ui/model-select.tsx)
+ [`model-select-utils.ts`](../apps/web/components/ui/model-select-utils.ts).

**The shape.** A cmdk-backed Popover + Command composition (no new
dependency — shadcn's existing primitives) used identically on
`/settings/agents` and `/settings/ai-workers`. The trigger button shows
the selected model's name + context + pricing inline; the popover lists
every row with the same three badges plus a sort dropdown and a fuzzy
search input. Search matches across `id + name + modality` so a query like
"vision" hits multimodal rows without a tag index.

**Sort keys**: `newest` (default — ISO-dated rows from OpenRouter sort
lexicographically), `name`, `cheapest` (sum of input + output per-1M,
unpriced rows sink to the bottom), `context` (descending, unknowns last).

**Free-text fallback.** When the search doesn't match any catalog row, a
"Use ‹typed›" affordance commits the literal string. Useful for brand-new
models OpenRouter hasn't indexed yet, or for edit-mode opening on a slug
the catalog has since dropped. An out-of-catalog value still renders in
the trigger (the "phantom" path) so edit forms with a stale slug don't go
blank.

**Per-provider pricing reconciliation** (workers form only). The discovery
result is a union (`TtsModelInfo | SttModelInfo | ChatModelInfo |
VisionModelInfo | ImageGenModelInfo`); `toExplorerModels()` normalises it
to the shared `ExplorerModel` shape. Adapter fields are
`inputPricePer1M` / `outputPricePer1M`; the combobox reads
`inputPricePerM` / `outputPricePerM`. The reconciler:

1. Prefers the adapter's own pricing when present.
2. Otherwise looks up `${prefix}/${model.id}` in the OpenRouter pricing
   cache (§9l) — that's how Anthropic / OpenAI / xAI direct
   configurations show pricing badges anyway, even though their own
   `/v1/models` doesn't return pricing.
3. Surfaces `ChatModelInfo.capabilities` (`vision` / `reasoning` /
   `function_calling` / `json_mode`) as a `modality` string so cmdk's
   fuzzy search picks them up.

**Form integration.** Agents form uses controlled React state
(`setForm((f) => ({ ...f, model: next }))`). Workers form uses
`new FormData(e.currentTarget)` for submission, so ModelSelect renders a
hidden `<input name="model" value={value}>` when given a `name` prop —
the server action keeps reading `formData.get('model')` unchanged. Empty
slugs are rejected server-side in the worker action; hidden inputs don't
trigger native validation, so the server is the gate.

**Loading + error states** live inside the popover, never block the form:
"Loading models…" while the fetch is in flight, an amber banner above the
list if the catalog refresh fails, and an empty-state message when the
search produces no matches.

**Test surface** ([`model-select.test.ts`](../apps/web/components/ui/model-select.test.ts)).
The JSX is exercised live; the pure helpers (sort, formatContext,
formatPriceCompact) are pulled into a sibling `model-select-utils.ts` so
vitest can cover the formatting + sort invariants without dragging the
React import chain through `@/`-aliased modules vitest's root config
doesn't resolve. 18 cases — newest with undated rows, case-insensitive
name sort, cheapest sinking unpriced rows, half-priced cheapest, context
desc with unknowns last, plus all formatContext / formatPriceCompact
anchors.

## 9m. Tool-result spill store (`read_result`)

The fourth member of Mantle's store-full / index-compact / dereference family
(brain · recall · heartbeats… and now tool output). Implemented in
[`packages/tools/src/tool-results.ts`](../packages/tools/src/tool-results.ts)
+ the `read_result` builtin.

**The problem.** A tool result has to travel back to the model inside the
conversation, where it (a) bloats context, (b) is **re-sent on every tool-loop
iteration**, and (c) used to be hard-truncated to ~8 KB — which silently
*dropped the very answer* the model went to fetch (a delegated agent's full
synthesis, a big `file_read`, a wide search). That truncation is the single
most common reason integrated assistants "can't finish the job."

**The fix — results become addressable artifacts.** Oversized output is stored
once and the model gets a compact handle + preview; it dereferences on demand.
Only the small envelope re-circulates in history, so the re-send amplification
is gone and nothing is lost. Same principle as the brain (`content_store` ↔
`content_index`) and recall (archive ↔ digest) — see the table in §9b' / §9l.

**Tiers** (per-agent thresholds in `memory_config.result_handling`, KB — set in
the agents form; env defaults `TOOL_RESULT_INLINE_MAX` / `_EMBED_MIN` /
`_SPILL_MAX`):

| Result size | Behaviour |
|---|---|
| ≤ `inline_max` (default 32 KB) | inline, untouched — the common path, zero overhead |
| > `inline_max` | spill to `tool_results`; model gets `{_spilled, handle:"tr_…", preview, pages, note}` |
| ≥ `embed_min` (default 100 KB) | same, but the envelope steers the model to semantic `query` |
| > `spill_max` (default 1 MB) | **head-truncated with a marker before storing** — a runaway tool can't write a giant row or fan out into unbounded chunks |

**`read_result(handle, …)`** — three modes on any spilled handle:
- `page` — linear slice, **byte-accurate and snapped to newline boundaries**
  (no mid-word / mid-JSON cuts; contiguous, so page _p_ ends where _p+1_
  begins). Global `pageBytes`, so the envelope's page count and reads agree.
- `grep` — exact substring with surrounding context.
- `query` — semantic search **within** the result. **Lazy**: the first `query`
  chunks + embeds the content into `tool_result_chunks` (reusing
  `@mantle/embeddings`); `page`/`grep` never pay that cost. Cosine is scoped to
  one `result_id` (a handful of chunks), so no ivfflat index is needed — unlike
  the brain's global `content_chunks`. Chunk size **adapts** so the count never
  exceeds `TOOL_RESULT_MAX_CHUNKS` (env, default 200) while still covering the
  whole stored content — bounding embedding cost + latency regardless of size.

**Preview integrity.** A spilled result's preview is always a strict prefix, so
the envelope appends an **in-band cut marker** (`⚠ PREVIEW ENDS HERE — … call
read_result before answering`) right at the truncation point and sets
`preview_truncated: true`. That's the main guard against the model answering
from a cut-off head — a strong nudge, not hard enforcement (which isn't
possible without false positives).

**Why 32 KB inline, not 8 KB.** The old cap was set for a 200 K-context,
no-cache world. Main agents now run on 1 M context with prompt caching, so
re-sending tens of KB costs fractions of a cent — the generous inline cap means
~95% of results (incl. essentially every delegated synthesis) never spill, and
the store is the backstop for the genuine outliers.

**Wiring.** The tool-loop ([`tool-loop.ts`](../packages/agent-runtime/src/tool-loop.ts))
runs the middleware on every OK result and **always offers `read_result`** (auto-
injected when the agent has tools) so a handle is never a dead end. Spills open
a `spill_result` trace step (`{handle, bytes}`); each `read_result` records
`{mode, hits|count|page}` — so you watch it work in `/traces` exactly like
tracing a node through the brain.

**Lifecycle.** `tool_results` / `tool_result_chunks` are **ephemeral working
state** — never `nodes` rows, never seen by the extractor or brain search.
`cleanupToolResults()` (retention `TOOL_RESULT_TTL_DAYS`, default 7; chunks
cascade) is swept by `maybeSweep()` — an hourly-throttled, never-throwing sweep
called both from the periodic `events-reminders` tick (so it runs even when
idle) and opportunistically from the spill path (so the store self-prunes while
it's being written). So the TTL is real, not aspirational.

**Bounded by construction.** Three ceilings keep the store from running away:
`spill_max` head-truncates oversized output before storage, `TOOL_RESULT_MAX_CHUNKS`
caps embed-tier fan-out (adaptive chunking), and the TTL sweep bounds retention.
The per-agent knobs (`inline_max` / `embed_min` / `spill_max`) live in the agents
form; `MAX_CHUNKS` and `TTL_DAYS` are global store policy (env).

## 9n. In-response duplicate tool-call guard

A defensive guard against misbehaving models that emit parallel
byte-identical `tool_use` blocks for the same write operation. Lives in
[`tool-loop.ts`](../packages/agent-runtime/src/tool-loop.ts), inside the
per-iteration dispatch loop.

**The problem.** Some models (notably Grok-4.x) hedge by emitting
multiple identical tool-call blocks in a single response. Pre-guard, the
loop dispatched every one — a single "move this sermon to /pages" turn
produced 3 duplicate pages because Grok emitted 3× `page_create` with
byte-identical args. Same pattern on a second turn (2×). Confirmed in
traces: same `(name, arguments)` triple, three sequential `compute
success` steps, three rows in `nodes`.

**The fix.** For each LLM response, hash every `tool_use` block by
`(slug, raw args string)`. First occurrence dispatches normally. Each
duplicate within the *same response*:

- Does NOT call the handler.
- Records a `tool: <slug>` step with status `skipped` and disposition
  `duplicate_in_response` (visible in `/traces`).
- Pushes a synthetic tool message paired with the duplicate's `call.id`
  (provider-shape requirement — every `tool_use` must have a matching
  `tool_result`, else the next request 400s):

  ```json
  {
    "ok": false,
    "error": "duplicate_in_response",
    "note": "This exact tool call ... was suppressed ...",
    "first_call_id": "call_1"
  }
  ```

So the model sees its second attempt was a no-op + the id of the call
that did land, and it can correctly tell the user "I created the page"
rather than "I created 3 pages."

**Scope: per LLM response, not lifetime of loop.** The `seenSignatures`
Map is declared inside the iter loop. A model re-issuing the same call
in a *later* iteration (e.g. `file_read` after processing a prior
result) is legitimate and dispatches both times. Only same-response
duplicates are suppressed.

**Catches every mutating tool.** `page_create`, `note_create`,
`todo_create`, `event_create`, `file_create`, `contact_create`,
`telegram_send`, future ones. The guard is tool-agnostic — it doesn't
look at the slug, just at byte-equal args. Non-mutating tools (`file_list`,
`search`) gain the same protection from wasted dispatch but the
correctness stakes are lower.

**What the guard is NOT.** Not a UNIQUE constraint on `nodes (owner_id,
title)` for pages — sermons re-preach, identical titles are legitimate
across years. Not a per-handler "look up existing by title" — same
reason. Not `requires_confirm: true` on every write — adds friction to
every legitimate single call. The right scope is the tool-loop
generically.

**Visibility.** The suppression step's meta carries `model` (denormalised
at write time, no join needed) so the `/debug` "Duplicates suppressed
(7d)" widget can group by model. Empty list = the guard never had to
fire in the window; a populated list answers "which model is
misbehaving?" at a glance — operator-actionable, not just absence-of-
symptom. See `duplicateSuppressionStats` in
[`apps/web/lib/metrics.ts`](../apps/web/lib/metrics.ts) and the
`duplicate_in_response` disposition in
[`observability.md §6`](./observability.md#6-disposition-catalog--why-something-skipped).

## 10. The MCP server

`apps/mcp/src/server.ts`, ~340 LOC. Exposes Claude's tools over stdio
(JSON-RPC) so Claude Code can attach at session startup. Tools:

| Tool                          | Purpose                                                                |
|-------------------------------|------------------------------------------------------------------------|
| `tree_list`                   | List children of a branch in the tree                                  |
| `search`                      | Hybrid full-text + tree search across all node types                   |
| `email_get`                   | Fetch one email by id                                                  |
| `email_list`                  | Recent emails, optional `accountId`/`since` filters                    |
| `folder_list`                 | List folders (children of one, or the whole `files.*` tree)            |
| `folder_create`               | Create a folder under a parent path                                     |
| `folder_describe`             | Set/clear a folder's description                                       |
| `folder_delete`               | Delete an empty folder                                                  |
| `file_list`                   | Files in a folder                                                       |
| `file_upload`                 | Create/overwrite a file (`content_text` or `content_base64`)            |
| `file_read`                   | File metadata + bytes                                                   |
| `file_get`                    | File metadata only                                                      |
| `file_delete`                 | Delete a file                                                           |
| `entity_search`               | Resolve a name/alias to entities (exact + trigram fuzzy)               |
| `entity_neighbors`            | First-hop entity↔entity edges, both directions                         |
| `entity_facts`                | Currently-valid facts on an entity (+ optional retired history)        |
| `entity_mentions`             | Content nodes that mention an entity (via `mentioned_in` edges)        |
| `pending_list`                | List operator-approval-required tool calls queued by agents            |
| `pending_get`                 | Inspect one pending call's args before deciding                        |
| `pending_approve`             | Approve + execute a pending call; result lands under a `manual` trace  |
| `pending_reject`              | Reject a pending call without executing                                |
| `telegram_pending`            | Unprocessed DMs, oldest first                                          |
| `telegram_send`               | Send a DM (allowlist-gated, reply-threading, MarkdownV2 optional)      |
| `telegram_react`              | Set an emoji reaction                                                  |
| `telegram_edit`               | Edit a previously-sent message                                         |
| `telegram_mark_processed`     | Flip `processed=true` so it stops appearing in `telegram_pending`      |
| `telegram_pair`               | Approve a pending pairing code                                         |

Every query is scoped by `OWNER_ID = process.env.ALLOWED_USER_ID` — single-
user isolation. The server uses the same `@mantle/db` client as the web app
and workers; no separate connection or auth layer.

Stdio is the only transport in use today. The HTTP+SSE transport
(`MCP_HTTP_PORT`) is supported by the code path but not wired into a
container; it's there for future remote MCP clients.

---

## 11. Encryption at rest

`packages/crypto/src/index.ts`, ~70 LOC. **AES-256-GCM** behind `seal()` /
`open()`. Used for any column ending in `_enc` (currently
`email_accounts.password_enc` and `telegram_accounts.bot_token_enc`),
plus the `secrets.ciphertext` bytea that backs the user-facing
[secrets surface](./secrets.md).

Layout: `version(1) | iv(12) | tag(16) | ciphertext(n)`, all in one `bytea`
column. Callers never see the parts separately.

The key derivation is **intentionally simple**: `MANTLE_MASTER_KEY` is the
AES key directly (32 random bytes base64). Two implications:

- Rotating the master key means re-encrypting every `_enc` column. There
  is no automated rotation; you'd write a one-off script when needed.
- The `aad` parameter binds ciphertext to a row id (`AAD = account.id`).
  Copy-pasting an encrypted blob from one row to another fails to
  decrypt — a defence against tampering with bytes in the DB.

If we ever need per-record keys or HKDF, `masterKey()` is the single
chokepoint.

---

## 12. Workspace layout

```
mantle/
├── apps/
│   ├── web/             # Next.js 15 (App Router + RSC + server actions)
│   │   ├── app/         # Routes (login, settings, attachment proxy, /api/auth)
│   │   ├── lib/         # auth.ts, auth-constants.ts
│   │   ├── workers/     # email-sync.ts, telegram-poll.ts
│   │   └── components/  # shadcn-style UI primitives
│   └── mcp/             # MCP server (stdio transport)
├── packages/
│   ├── db/              # Drizzle schema + raw SQL migrations + client
│   │                    # + ai-workers resolution (getDefaultWorker)
│   ├── email/           # IMAP adapter + sync + sender resolver + ingest rules
│   ├── telegram/        # grammy wrapper + gate + outbound (sendMessage,
│   │                    # sendVoice, downloadTelegramFile)
│   ├── storage/         # S3 client + content-addressing
│   ├── crypto/          # AES-GCM seal/open
│   ├── api-keys/        # Encrypted credential vault
│   ├── rules/           # Ingest rule engine (tag, route, suppress, …)
│   ├── search/          # Hybrid search (FTS + vectors + ltree)
│   ├── content/         # Notes, todos, events, secrets surfaces
│   ├── files/           # Filesystem + DB hybrid file store
│   ├── tools/           # Builtin tool defs + dispatch + invoke_agent
│   ├── agent-runtime/   # Tool-loop + chat helpers + delegation bridge
│   ├── tracing/         # AsyncLocalStorage tracing
│   ├── embeddings/      # OpenRouter embedding wrapper + cache
│   └── voice/           # AI provider adapters (TTS / STT / chat)
│                        # + per-provider catalogs + registry. NOTE:
│                        # name is "voice" for historical reasons;
│                        # scope is "all non-chat AI capabilities" +
│                        # chat adapters for non-OpenRouter providers.
├── infra/postgres/init/ # SQL run at first container boot
├── scripts/             # up.sh — only script that ships now
├── docs/                # this file + memory.md + ai-workers.md + others
├── docker-compose.dev.yml   # postgres + minio (dev — used by `pnpm up`)
└── docker-compose.yml       # full stack (prod-shaped — web/workers WIP)
```

Why this split:

- **`apps/*` are entrypoints**, with side effects. They have main.tsx /
  server.ts / dev servers.
- **`packages/*` are pure libraries.** No process boundaries, no network,
  no side effects beyond IO they're asked to perform. Anything imported
  from multiple apps lives here.
- **Workers live in `apps/web/workers/`** not their own package because
  they share `.env.local` discovery and `@mantle/*` imports with the web
  process. Moving them to `apps/worker/` is a 5-line change when the
  Dockerfile story lands.

Workspace package boundaries are real — `apps/web` imports `@mantle/db`
the same way `apps/mcp` does. Anything labeled `@mantle/*` is a workspace
package; `pnpm-workspace.yaml` declares them.

---

## 13. Dev workflow

`pnpm up` (`scripts/up.sh`) is the one command:

1. Verifies Docker is running. Bails with a clear message if not.
2. Verifies `apps/web/.env.local` exists. Bails with the env vars you need
   to fill in.
3. `docker compose -f docker-compose.dev.yml up -d --wait` — postgres +
   minio, health-checked.
4. Reads `S3_ACCESS_KEY` / `S3_SECRET_KEY` from `.env.local`, runs `mc mb`
   to ensure the `mantle` bucket exists. Idempotent.
5. `pnpm -C packages/db migrate` — applies any new Drizzle migrations.
6. `exec pnpm dev` — `concurrently` starts web + mcp + email + telegram
   workers.

Granular escape hatches in `package.json`:

| Script             | What                                                       |
|--------------------|------------------------------------------------------------|
| `pnpm up`          | Full thing (infra + dev servers)                           |
| `pnpm dev`         | Dev servers only (assumes infra up)                        |
| `pnpm down`        | Stop infra                                                 |
| `pnpm infra:up`    | Infra only                                                 |
| `pnpm infra:logs`  | Tail postgres + minio                                      |
| `pnpm infra:psql`  | `docker exec -it mantle_pg psql`                           |
| `pnpm db:migrate`  | Drizzle migrate                                            |
| `pnpm db:studio`   | Drizzle Studio (DB browser at localhost:4983)              |
| `pnpm typecheck`   | Recursive tsc across all packages/apps                     |
| `pnpm test`        | Vitest (currently only `packages/email`)                   |

**Hot reload:** `next dev --turbo` for the web; `tsx --watch` for the MCP +
workers. Edit a source file, the relevant process respawns. `.env.local`
changes are **not** picked up by `tsx --watch` — you have to touch a source
file or kill the process to re-read env.

---

## 14. Migrations and bootstrap

Two migration systems coexist:

- **Drizzle** owns `public.*`. Run via `pnpm db:migrate`. Migration files
  in `packages/db/migrations/*.sql`. Journal at `migrations/meta/_journal.json`
  tracks which have been applied — Drizzle records this in a private
  `drizzle.__drizzle_migrations` table on first run.
- **Postgres init scripts** own everything before `public.*` —
  extensions and the `auth` schema. They live in `infra/postgres/init/`
  and the Postgres image runs them exactly once, at first cluster init.
  Re-running compose against the same volume is a no-op.

The boundary is enforced by `drizzle.config.ts:12` (`schemaFilter:
['public']`) — Drizzle will never try to create or modify the `auth`
schema, so the init script is the only place that owns it.

Migration `0008_node_type_telegram.sql` is in its own file because
`ALTER TYPE ... ADD VALUE` can't sit in the same transaction as DDL that
uses the new enum value. The journal's `breakpoints: true` makes Drizzle
commit between 0008 and 0009.

**Adding a new column?**
1. Edit the Drizzle schema in `packages/db/src/schema/`.
2. `pnpm -C packages/db exec drizzle-kit generate` — emits a migration.
3. Inspect the generated SQL, hand-edit if needed (Drizzle can't emit
   GiST/GIN/IVFFlat operator classes — drop those in by hand).
4. `pnpm db:migrate` to apply.

**Adding a new node type?**
- Add to the enum in `packages/db/src/schema/nodes.ts`.
- Emit a `0010_node_type_x.sql` migration with `ALTER TYPE ... ADD VALUE`.
- Add to the MCP server's `search` tool enum (`apps/mcp/src/server.ts:62`).

---

## 15. Operations

**State lives in three places:**

- `mantle_pg_data` Docker volume — Postgres cluster files.
- `mantle_minio_data` Docker volume — object bytes.
- `apps/web/.env.local` — secrets (DATABASE_URL, SESSION_SECRET,
  MANTLE_MASTER_KEY, S3 creds, ALLOWED_USER_ID, OPENAI_API_KEY).

Everything else is rebuildable from source + those three.

**Backups:** there's no automated backup. `pg_dump` is the manual path:

```bash
# Full safety-net dump (every schema, custom format)
pg_dump -h 127.0.0.1 -p 54323 -U postgres -d postgres -Fc \
  -f ~/Backups/mantle/mantle-full-$(date +%Y%m%d-%H%M%S).dump

# Public-schema dump (restore-ready on any vanilla Postgres)
pg_dump -h 127.0.0.1 -p 54323 -U postgres -d postgres -Fc \
  -n public --no-owner --no-privileges \
  -f ~/Backups/mantle/mantle-public-$(date +%Y%m%d-%H%M%S).dump
```

The supabase-era backups (`backups/` at the repo root) are gitignored
historical snapshots; safe to delete.

**Rolling a secret:**
- `SESSION_SECRET`: edit `.env.local`, restart web. Every existing session
  cookie fails verification, everyone signs in again. (You — single user.)
- `MANTLE_MASTER_KEY`: re-encrypt every `_enc` column with the new key.
  No tooling exists for this yet; write a one-off script via `seal/open`.

**Disaster recovery:** `docker volume rm mantle_mantle_pg_data
mantle_mantle_minio_data` nukes everything. `pnpm up` brings up a virgin
stack. `pg_restore --data-only` loads the latest backup. Insert your
`auth.users` row by hand. Done.

---

## 16. Known sharp edges / future work

In rough priority order. Items the audit completed have been removed
from this list; what's here is genuinely still open. The May 2026
hardening pass closed a batch of these — see
[`hardening-audit-2026-05.md`](./hardening-audit-2026-05.md) for what
was fixed, accepted, or deliberately left (and why).

**Deployment & operations**
- **Production deploy untested on a real VPS.** All six daemons are now
  containerized (`Dockerfile` targets web/agent/worker-email/-telegram/
  -files/-events) and a one-shot `migrate` service runs schema
  migrations before any app service starts, so the compose stack is no
  longer a degraded stub. Still unexercised end-to-end on real hardware:
  first-deploy runbook + HTTPS-only cookie verification + Caddy reverse
  proxy config. (`apps/mcp` stays out of compose — stdio-only, would
  crash-loop as a daemon until the HTTP transport lands.)
- **No backup/restore drill.** `pg_dump` + MinIO `mc mirror` would
  work; nothing's scripted or rehearsed.
- **No HSTS, no Content-Security-Policy** on web responses. Acceptable
  on localhost; must land before public exposure.
- **Attachment proxy** in `apps/web/app/api/attachments/[id]/route.ts`
  streams bytes through Next. Fine functionally; in prod a CDN or
  direct presigned-MinIO would scale better.
- **Next-externalized packages must be declared in `apps/web`.** A
  dep that Next keeps external (its `serverExternalPackages` default
  list — e.g. `@aws-sdk/client-s3`, pulled in transitively via
  `@mantle/storage`) must be resolvable *from the app dir*. Under
  pnpm's isolated layout a transitive dep isn't, so Next errors
  "Package … can't be external". Fix: list it directly in
  `apps/web/package.json` (it dedupes to the workspace version). Watch
  for this whenever a workspace package adds such a dep.

**Telegram surface**
- **Web UI for Telegram is missing.** Allowlist management, pairing-
  code approval, conversation view — all happen via MCP tools today.
- **Embeddings for Telegram messages** aren't generated. The
  `nodes.embedding` column exists but is unused for
  `type='telegram_message'`. Means search_nodes can't find a turn
  semantically; only digests are indexed.
- **Long-poll, not webhook.** Once Mantle has a public URL with TLS,
  switching the bot to webhook mode cuts the constant `getUpdates`
  background traffic. Worth doing before the VPS deploy.
- **Group chats** are still dropped in `gate.ts`. v1 is DM-only.

**Voice modality** ✅ shipped
- Inbound voice → OpenAI Whisper (STT worker, default `whisper-1`) →
  transcript replaces `(voice message)` text → normal responder flow.
- Outbound voice → OpenAI TTS (TTS worker, default `gpt-4o-mini-tts`,
  voice `nova`) → `sendVoice` as OGG/Opus voice note.
- ElevenLabs adapter shipped; switching providers is a worker-row
  edit. Cloned voices appear live via `/v1/voices` discovery.
- Still open: Telegram-message embeddings (mentioned above) so
  `search_nodes` can find voice-transcribed turns semantically.

**Vision / image generation**
- Adapter interfaces (`VisionDispatcher`, `ImageGenDispatcher`)
  defined in `@mantle/voice/adapters/types.ts` but no built-in
  adapters yet. Per-provider catalogs are stubbed.
- Whiteboard-photo ingestion (image → markdown via vision-LLM) is the
  next natural feature; would land as a vision adapter (OpenAI /
  Anthropic / Google all do this) plus an ingest hook that fires on
  image attachments.

**Auth**
- **OAuth/MFA** isn't here. Bespoke HMAC session is fine for single-
  user; swap in `better-auth` if this ever opens to more humans
  (~half a day with the Drizzle adapter).

**Testing**
- **DB-dependent integration tests** are not yet written. The pure-
  function layer has 285 vitest tests covering crypto, rate-limit,
  events tz/remind helpers, file paths, tool-args, extractor parse,
  provider catalog, adapter registry, voice + chat dispatcher
  contracts. Integration coverage (full extractor pipeline, secrets
  reveal end to end, tool-loop with a real DB) needs a test
  Postgres — probably a `docker-compose.test.yml`.

**Agent delegation (`invoke_agent`) — audit follow-ups, none blocking**
- ~~**Child reply truncated at ~8 KB.**~~ **RESOLVED** — tool results no
  longer truncate. Oversized output (incl. a delegated agent's full
  synthesis) spills to the tool-result store and the model pages/greps/
  queries it via `read_result`. See §9m.
- **No timeout on the child invocation.** `client.chat.send` has no
  deadline anywhere in the loop, so a hung upstream hangs the child →
  the parent's synchronous `invoke_agent` step → the whole turn. Add a
  per-call timeout + a clean timeout error.
- **No spend cap on delegated children.** Workers have
  `extract_cost_cap_micro_usd`; agents/children have none, and a parent
  can fan out several `invoke_agent` calls per turn (each spawning a
  multi-iteration child). Depth is bounded; per-turn breadth and
  per-child spend are not.
- **`data.parent_trace_id` is effectively always null.** Entry points
  don't pass `parentTraceId`, so the child→parent backlink never
  populates (parent→child via step `meta.child_trace_id` works). Read
  `currentTrace()?.id` in the handler to fix the reverse link.
- **No integration test of the wired path.** The pure guards have unit
  coverage; the handler→bridge→runtime→child-loop chain (e.g. with a
  fake invoker) does not.

**Agent ergonomics**
- **`delegate_to` is now UI-editable** via the "Delegates to" picker at
  `/settings/agents`, and `updateAgent` merges `memory_config` so saves
  no longer wipe it. (Resolved — was previously DB/seed-only.)
- **All chat dispatch is now adapter-routed** (Phase 3, shipped May 2026).
  The responder, web `/assistant`, heartbeat fire, invoke_agent, and
  all three chat-shaped workers (reflector / extractor / summarizer)
  resolve their adapter via `getChatAdapter(provider).chat({...})`.
  The `agents.provider` column landed in migration 0048. Workers and
  agents forms expose the full provider dropdown; KeyValidityHint
  warns on cross-provider key mismatches. See [`ai-workers.md` §8.1](./ai-workers.md#81-provider-routing-today--what-goes-through-what)
  for the per-kind routing table and §7 for the shipped-stage list
  with commit shas. The architecture deep-dive + engineering
  retrospective (call-site inventory, message-grammar walkthrough,
  audit findings, cost math, known sharp edges) lives in
  [`docs/phase-3-retrospective.md`](./phase-3-retrospective.md).
- **Embedding is fully adapter-routed** as of the Stage 1 push
  (5dc3984). `@mantle/embeddings` dispatches through
  `getEmbeddingAdapter(provider)` — five adapters (openrouter, openai,
  google, mistral, cohere) covering both OR-routed and direct-
  provider modes. See [`ai-workers.md` §5e.2](./ai-workers.md#5e2-adapter-dispatch-stage-1-of-the-runtime-honesty-push).

---

## Reading this code

If you only read four files, read these in order:

1. `packages/db/src/schema/nodes.ts` — the central abstraction.
2. `apps/mcp/src/server.ts` — the tools Claude actually uses.
3. `packages/email/src/sync.ts` — the longest end-to-end pipeline.
4. `apps/web/lib/auth.ts` — the security boundary.

Then `git log --oneline` for the rest.
