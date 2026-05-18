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

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser  (you)                                                  │
└─────────────────────────────┬────────────────────────────────────┘
                              │ HTTPS
┌─────────────────────────────▼────────────────────────────────────┐
│  apps/web         Next.js 15 (App Router, RSC + server actions)  │
│  - middleware.ts: signed-cookie gate, Edge runtime               │
│  - lib/auth.ts:   bespoke HMAC session + bcryptjs                │
│  - app/api/...:   REST endpoints (auth, attachments)             │
│  - workers/...:   long-running ingest loops (run in same proc.   │
│                   via `pnpm dev`)                                │
└──┬─────────────────────────────┬─────────────────────────────────┘
   │                             │
   │ Drizzle (pg pool)           │ @mantle/storage (AWS S3 SDK)
   │                             │
┌──▼─────────────────────────────▼────────┐  ┌──────────────────────┐
│  postgres (pgvector/pgvector:pg17)      │  │  minio (S3-compat)   │
│  - public.*  (Mantle data)              │  │  bucket: mantle      │
│  - auth.users  (id + bcrypt hash)       │  │  content-addressed   │
│  - extensions: ltree, pg_trgm, vector,  │  │  files at aa/bb/<sha>│
│      pgcrypto, uuid-ossp                │  │                      │
│  - triggers: pg_notify('telegram_…')    │  │                      │
└──┬──────────────────────────────────────┘  └──▲───────────────────┘
   │                                            │
   │ stdio (JSON-RPC)                           │
   │                                            │
┌──▼──────────────────────────────────────┐     │
│  apps/mcp     (Drizzle direct)          │─────┘ (only when serving
│  9 tools exposed to Claude              │        attachments via web)
└─────────────────────────────────────────┘
```

Everything in the box is in `docker-compose.dev.yml` (the two infra containers)
plus a single `pnpm dev` process tree (the four Node processes orchestrated by
`concurrently`).

---

## 3. The processes

`pnpm dev` (`package.json:11`) runs five concurrent workers, named `web`,
`mcp`, `worker`, `tg`, and `agent`. Plus Postgres and MinIO from
docker-compose. That's it.

| Process            | What it does                                                                  |
|--------------------|-------------------------------------------------------------------------------|
| `postgres` (Docker)| Source of truth. Holds every row. Healthchecked, restart on failure.          |
| `minio` (Docker)   | Object store for attachment bytes. Healthchecked.                             |
| `web`              | Next.js dev server (Turbopack). Serves UI, API routes, server actions. Hosts the `/assistant` chat surface (POST `/api/assistant/turn`). |
| `mcp`              | MCP server (`apps/mcp/src/server.ts`). Speaks stdio JSON-RPC to Claude Code.  |
| `worker` (email)   | `apps/web/workers/email-sync.ts`. pg-boss queue consumer, runs IMAP syncs.    |
| `tg`               | `apps/web/workers/telegram-poll.ts`. Long-polls Telegram for new DMs.         |
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
`email_accounts.password_enc` and `telegram_accounts.bot_token_enc`).

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
│   ├── email/           # IMAP adapter + sync + sender resolver + ingest rules
│   ├── telegram/        # grammy wrapper + gate + outbound helpers
│   ├── storage/         # S3 client + content-addressing
│   ├── crypto/          # AES-GCM seal/open
│   ├── rules/           # Ingest rule engine (tag, route, suppress, …)
│   └── search/          # Hybrid search (FTS + vectors + ltree)
├── infra/postgres/init/ # SQL run at first container boot
├── scripts/             # up.sh — only script that ships now
├── docs/                # this file + telegram.md
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

In rough priority order:

- **Production Dockerfile is in place** (`Dockerfile` at repo root,
  multi-target: `web`, `agent`, `worker-email`, `worker-telegram`).
  `docker-compose.yml` wires all four behind `postgres + minio`.
  Still untested end-to-end on a real VPS; refine env handling +
  ergonomics there as needed. `pnpm up` (which uses
  `docker-compose.dev.yml` + native Node) remains the dev path for
  hot-reload.
- **Rate limiting** on `/api/auth/login`. Acceptable for localhost-only;
  needs to land before any remote exposure. Either at the reverse proxy
  layer (Caddy with `rate_limit` directive) or in the route handler.
- **Attachment proxy** in `apps/web/app/api/attachments/[id]/route.ts`
  streams bytes through Next. Fine functionally; in prod we'd want to
  put a CDN or proxy in front of the Next process.
- **Web UI for Telegram** is missing. Allowlist management, pairing-code
  approval, conversation view — all happen via MCP tools today.
- **Embeddings for Telegram messages** aren't generated. The
  `nodes.embedding` column exists but is unused for type=`telegram_message`.
- **Webhooks instead of long-poll** for Telegram, once Mantle has a
  public URL.
- **Multi-turn agent context.** Today the agent sees only the inbound
  message + persona. Storing outbound replies (new `telegram_replies`
  table or a direction flag on `telegram_messages`) would let it carry
  conversational state.
- **Memory tiers + retrieval for the agent.** The persona prompt is a
  fixed env string; the planned tier-2 (per-chat recent window) and
  tier-3 (semantic retrieval over `nodes.embedding`) aren't wired.
- **Multi-model routing in the agent.** Today every reply uses one
  default model. Cheap-triage + Claude-escalation lives in `docs/architecture.md`
  as a known design, not as code.
- **Group support** for Telegram. `gate.ts` drops non-DM messages in v1.
- **OAuth/MFA** for auth. Bespoke session is fine for single-user; if
  this ever opens to more humans, swap in `better-auth` (~half a day,
  Drizzle adapter built in).

---

## Reading this code

If you only read four files, read these in order:

1. `packages/db/src/schema/nodes.ts` — the central abstraction.
2. `apps/mcp/src/server.ts` — the tools Claude actually uses.
3. `packages/email/src/sync.ts` — the longest end-to-end pipeline.
4. `apps/web/lib/auth.ts` — the security boundary.

Then `git log --oneline` for the rest.
