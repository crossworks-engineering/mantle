# Mantle Architecture

A concrete, file-cited tour of how the system fits together. If you want one
document to read before touching the codebase, this is it.

Companion docs:
- [`memory.md`](./memory.md) — the memory layer in depth: tier taxonomy,
  vector vs graph retrieval, planned `memories` / `entities` / `entity_edges`
  schema, the build sequence.
- [`observability.md`](./observability.md) — the tracing layer: how every
  agent run becomes a `traces` row + `trace_steps` tree, the reactflow
  visual, the dashboard widgets, and how to add a new trace kind.
- [`files.md`](./files.md) — the host-mirrored filesystem layer:
  folders + files on disk under `MANTLE_FILES_ROOT`, the editor, the
  ingestion handoff, and the MCP tools.
- [`telegram.md`](./telegram.md) — a frozen handoff covering the Telegram
  bridge build. Project diary; durable details have moved here.

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
| `events`           | `apps/web/workers/events-reminders.ts`. Polls every 30s for events whose `remind_at` has passed and `reminder_sent_at` is null; sends a Telegram DM via `@mantle/telegram`. |
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

A row is one of 12 types: `branch`, `email`, `email_thread`, `file`, `note`,
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

`packages/email/` is ~1.5K LOC. The big idea: **never ingest mail you didn't
ask for.**

Flow:

1. **Account.** You add an IMAP account via `/settings/accounts` (Gmail,
   Outlook, Fastmail, anything that speaks IMAP + app-passwords). The
   credentials are encrypted at rest via `@mantle/crypto`.
2. **Initial scan.** `syncAccount()` in `packages/email/src/sync.ts:36`
   pulls only headers for the first 12 months — no bodies, no attachments.
3. **Sender curation.** Every `From` address is upserted into
   `email_senders` with a status: `pending`, `allowed`, or `denied`. The UI
   at `/settings/senders` is where you approve who counts as a real
   correspondent.
4. **Two-phase sync.** For each subsequent batch, the worker:
   - Upserts senders (so the UI always sees recent activity even from
     denied addresses).
   - Resolves each message to a sender decision (address > domain > policy
     default — `packages/email/src/decisions.ts`).
   - For `allowed` only: fetches the full body, runs ingest rules
     (`@mantle/rules`), persists a `nodes` row + an `emails` row + any
     `email_attachments`, uploads attachment bytes via `@mantle/storage`.
   - Bumps the account's sync cursor.

Pending/denied senders never touch your tree — they're a single row in
`email_senders` with `message_count`, and that's it. This is the security
property: a stranger emailing you can't get into your `nodes` table by
default.

The worker process (`apps/web/workers/email-sync.ts`) is a pg-boss queue
consumer. Three queues: `mantle.email.sync` (per-account work),
`mantle.email.backfill` (deeper history rescans), `mantle.email.scheduler`
(periodic enqueueing of `sync` jobs). pg-boss owns the `pgboss` schema in
Postgres; jobs survive process restarts.

**Extractor handoff.** Once an `allowed` message lands as a `nodes` row
with `type='email'`, the `node_ingested` pg_notify trigger
(migration 0018) fires and the extractor agent picks it up — same path
as notes and files. `DEFAULT_EXTRACT_TYPES` in
`apps/agent/src/extractor.ts:63` includes `email` and `email_thread` so
no per-agent config is needed; `readNodeBody` joins the `emails` table
for subject + plaintext body. Bodies longer than `BODY_MAX_CHARS`
(24K) get head+tail-truncated to bound the prompt cost.

---

## 9. Telegram pipeline

`packages/telegram/` is ~500 LOC. The full handoff doc is
[`telegram.md`](./telegram.md); this is the abridged version.

Flow:

1. **Long-poll worker.** `apps/web/workers/telegram-poll.ts` spawns one
   `bot.api.getUpdates` loop per enabled `telegram_accounts` row. ~25s
   long-poll timeout, exponential backoff on errors, advances
   `last_update_offset` after each batch.
2. **Inbound gate.** `packages/telegram/src/gate.ts` decides what happens
   to each message. DMs only (groups silently dropped in v1). Allowlist
   logic: known chat → deliver. New chat → issue a 6-char pairing code, DM
   it back, wait for the operator to approve via `telegram_pair`. Replies
   are capped at 2 per pending chat so an unknown sender can't farm
   responses.
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
  → resolve responder agent  (highest-priority enabled row in `agents`)
  → load conversation history  (last N inbound+outbound turns, chronological)
  → buildChatMessages(...)  (cache_control on system block for anthropic/*)
  → @openrouter/sdk call
  → @mantle/telegram sendMessage
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
   footgun we have.
4. **Cost attribution.** The child gets its own `traces` row
   (`kind='manual'`, `subjectKind='child_agent'`, `data.parent_trace_id`
   set for navigation). The child trace owns the child's full cost;
   the parent's `invoke_agent` step records `meta.child_trace_id` +
   `meta.child_cost_micro_usd` for visibility but doesn't roll up,
   so `/debug` "spend by agent" totals stay correct.

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
stt | vision | image_gen`. The first three migrate cleanly from the
old `agents.role` enum (preserved by the migration's backfill); the
last four are brand new and unlock features that don't fit the agent
abstraction.

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

One worker per `(owner, kind)` is marked `is_default=true`. The runtime
calls `getDefaultWorker(ownerId, kind)` from `@mantle/db`; the default
flag wins, otherwise highest-priority enabled row.

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

The agent + assistant both speak the multimedia adapter surface for
images:

- **Vision in (Telegram photo):** photo attachment → saved as a `file`
  node under `/files/telegram-uploads/<date>/` → default vision worker
  transcribes it into the node's `data.text` (`photo_ingest` trace) →
  the responder then answers about it (`responder_turn` trace),
  transcript-default with the file node id surfaced so Saskia can
  re-read via `extract_from_image`. Full parity with the /assistant
  upload path; no longer a short-circuit.
- **Attachment in (/assistant upload):** an image OR a document
  (pdf/docx/xlsx/csv/txt/md/json/yaml) attached to a web turn → saved
  under `/files/assistant-uploads/<date>/` → text extracted (vision
  worker for images, `@mantle/files` parsers for documents) → folded
  into the turn (transcript-default) with the file node id surfaced.
  User's bubble shows the image (documents show a file chip).
- **Vision in (separate image upload):** an image dropped into `/files`
  outside the chat (Files UI, disk-sync watcher, MCP `file_upload`) has
  no inline vision pass — the **extractor** runs the vision worker when
  it sees an image `file` node with no `data.text`, persists the text,
  and re-fires `node_ingested` to index it. One indexing path however
  the image lands.
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
from this list; what's here is genuinely still open.

**Deployment & operations**
- **Production deploy untested on a real VPS.** `Dockerfile` (multi-
  target) and `docker-compose.yml` exist; the dev path
  (`docker-compose.dev.yml` + `pnpm dev`) is the only one exercised
  end-to-end. First-deploy runbook + HTTPS-only cookie verification +
  Caddy reverse proxy config still need to land.
- **No backup/restore drill.** `pg_dump` + MinIO `mc mirror` would
  work; nothing's scripted or rehearsed.
- **No HSTS, no Content-Security-Policy** on web responses. Acceptable
  on localhost; must land before public exposure.
- **Attachment proxy** in `apps/web/app/api/attachments/[id]/route.ts`
  streams bytes through Next. Fine functionally; in prod a CDN or
  direct presigned-MinIO would scale better.

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

**Agent ergonomics**
- **No UI for `delegate_to`.** The `invoke_agent` allowlist lives on
  `memory_config.delegate_to` and is editable via the jsonb-config
  editor at `/settings/agents` but there's no dedicated field. Build
  this once delegation has been exercised enough to know the right
  shape.
- **Production chat still routes through OpenRouter SDK directly**
  (responder, /assistant, reflector, extractor, summarizer). The
  chat adapter registry (xAI, HF, Anthropic, Google) is exercised
  for new workers that opt into those providers and for the "Test
  chat" UI affordance. Migrating the production chat path to use
  the adapter registry is non-breaking work — deferred until a real
  reason emerges (multi-provider failover, cost arbitrage, etc.).

---

## Reading this code

If you only read four files, read these in order:

1. `packages/db/src/schema/nodes.ts` — the central abstraction.
2. `apps/mcp/src/server.ts` — the tools Claude actually uses.
3. `packages/email/src/sync.ts` — the longest end-to-end pipeline.
4. `apps/web/lib/auth.ts` — the security boundary.

Then `git log --oneline` for the rest.
