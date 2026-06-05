# Telegram bridge — session handoff (2026-05-16)

This doc captures what was built, what's running, and what's still open so
the next Claude Code session can pick up without re-deriving context.

> **Update (2026-06: comms-channels.** Transport is decoupled from `agents.role`.
> A bot is attached to **any** agent through the generic `channels` table — the
> binding (`channels.agent_id`) + the sealed token (`channels.credentials_enc`)
> live there; `telegram_accounts` is now just the poll-state extension, linked
> 1:1 via `channel_id`. The old `telegram_accounts.responder_agent_id` +
> `bot_token_enc` columns are gone. The poller polls per enabled channel; inbound
> dispatch resolves the channel's agent (per-chat override still wins). Tokens are
> still entered/rotated from `/settings/agents` (same connect+pair UI, now writing
> a channel). See [`comms-channels.md`](./comms-channels.md) for the full design.
>
> **Update (2026-05-28): per-responder bots + in-app pairing.** *(superseded by
> comms-channels above)* Bot tokens were entered from the responder's
> `/settings/agents` **Telegram bot** section, bound via
> `telegram_accounts.responder_agent_id` (migration 0050). Pairing requests are
> approved with one click there (`telegram_pair` MCP tool remains the fallback).

## TL;DR

Telegram is now a first-class data source in Mantle. A long-poll worker
ingests DMs into Postgres; the Mantle MCP server exposes them to Claude
via tool calls (`telegram_pending`, `telegram_send`, etc.). End-to-end
inbound + outbound is verified against the **remote prod DB**.

MCP server wiring is now fixed and `✓ Connected` (verified via
`claude mcp get mantle`). MCP servers attach at Claude Code process
startup — so after registering you must fully `/exit` and relaunch
`claude`. `/reload-plugins` does **not** load MCP servers; it only
touches the plugin subsystem.

### Update 2026-05-16 (later that day)

The original `claude mcp add` invocation captured in the first handoff
saved an entry with an **empty command and args** (and at *local*
scope, not user — likely because we ran it inside Claude Code without
the `--` separator). Symptom: `claude mcp list` showed
`mantle: ✗ Failed to connect`, and no `mcp__mantle__*` tools appeared
in the deferred-tools list of a fresh session.

Corrected registration:

```bash
claude mcp remove mantle -s local
claude mcp add mantle -s local -- \
  pnpm -C /Users/jasonschoeman/Projects/mantle/apps/mcp start
```

The `--` is critical — without it `claude mcp add` swallows the args
as its own flags and stores an empty command. After this, `claude mcp
get mantle` shows `✓ Connected` and the next launched session sees the
mantle tools.

## Why this exists (background)

Earlier in the same session we attempted a standalone `telegram-robust`
plugin (a launchd-managed daemon + per-session MCP client). Outbound
worked; inbound never reached Claude because **Claude Code 2.1.143 does
not render `notifications/claude/channel` MCP notifications** in this
environment, regardless of plugin. The same symptom reproduced with the
upstream `telegram@claude-plugins-official` plugin.

The pivot: stop relying on channel notifications. Land Telegram messages
in the Mantle DB instead, and let Claude pull them via standard MCP tool
calls. That sidesteps the broken rendering path entirely and makes
Telegram a peer to email/notes/files in the existing tree.

Abandoned artifact (left in place but not used):

- `~/.claude/plugins/local/telegram-robust/` — the local plugin source
- `https://github.com/TitanKing/telegram-robust-claude` — public repo,
  full daemon + MCP client. Useful as a reference for the wire protocol
  but obsolete for daily use.
- `~/.claude/channels/telegram/{.env,access.json}` — the legacy state.
  The bot token in `.env` was migrated into the DB but the file is still
  the canonical source for the seed script.

## Architecture

```
Telegram Bot API
       │  (getUpdates long-poll, ~25s timeout)
       ▼
apps/web/workers/telegram-poll.ts
       │  loads enabled telegram_accounts, spawns one loop per account
       │  per inbound: gate() → upsert telegram_chats → insert telegram_messages + nodes row
       ▼
Postgres (remote prod via SSH tunnel localhost:54322)
       │
       ▼
apps/mcp/src/server.ts  (stdio MCP server)
       │  telegram_pending  → unprocessed messages, FIFO
       │  telegram_send     → bot.sendMessage
       │  telegram_react    → bot.setMessageReaction
       │  telegram_edit     → bot.editMessageText
       │  telegram_mark_processed
       │  telegram_pair     → approve a pairing code
       ▼
Claude Code session   (per-session MCP client)
```

## What's in the repo

### Database

- `packages/db/src/schema/telegram.ts` — new Drizzle schema:
  - `telegram_accounts` — one row per bot. Stores AES-GCM-encrypted bot
    token (`bot_token_enc` bytea, AAD bound to row id), branch_path,
    last_update_offset for resumable polling, enabled flag.
  - `telegram_chats` — per-chat metadata + allowlist state:
    - `allowlist_status enum('allowed','pending','denied')`
    - `pairing_code` / `pairing_expires_at` / `pairing_replies` for the
      pairing flow.
    - `last_message_at` for recency.
  - `telegram_messages` — one row per inbound DM. Has `node_id` ref so
    every message is also a `nodes` row of type `'telegram_message'`
    (search, tags, embeddings all work). `processed boolean` flips when
    Claude responds. Dedupe via `unique(account_id, telegram_update_id)`.
- `packages/db/src/schema/nodes.ts` — added `telegram_message` to the
  `node_type` enum.
- `packages/db/src/schema/index.ts` — re-exports the telegram schema.
- `packages/db/migrations/0008_node_type_telegram.sql` — enum add only.
  In its own file because `ALTER TYPE ... ADD VALUE` can't sit in the
  same transaction as DDL that uses the new value. `breakpoints: true`
  in the journal forces Drizzle to commit between 0008 and 0009.
- `packages/db/migrations/0009_telegram.sql` — tables, indexes, and a
  `pg_notify('telegram_message_inserted', new.id::text)` trigger so a
  future `telegram_wait` tool can `LISTEN` instead of poll.
- `packages/db/migrations/meta/_journal.json` — appended idx 8 + 9.

### packages/telegram (new workspace package)

Mirrors `packages/email` conventions.

- `package.json` — depends on `@mantle/crypto`, `@mantle/db`, grammy.
- `src/types.ts` — `GateResult`, `InboundMessage`.
- `src/client.ts` — cached `Bot` (grammy) per account; decrypts token
  via `@mantle/crypto.open()` AAD-bound to account id.
- `src/gate.ts` — DB-backed `gate()`. DMs only (groups silently dropped
  in v1). Upserts chat row, handles `allowed`/`denied`/`pending`,
  issues new pairing codes capped at 3 pending per account, replies
  max twice before silent-drop.
- `src/sync.ts` — `pollOnce(account, timeoutSec=25)`. Calls
  `bot.api.getUpdates`, normalises each Telegram Update into our
  `InboundMessage`, runs through `gate()`, and on `deliver` persists
  inside a single DB transaction (nodes + telegram_messages +
  last_message_at bump). Advances `last_update_offset` after the batch.
  Handles 409 Conflict gracefully via `last_poll_error`.
- `src/outbound.ts` — `sendMessage` (with 4096-char chunking + optional
  MarkdownV2 + optional reply threading), `reactToMessage`,
  `editMessage`, `accountForChat` lookup helper.
- `src/index.ts` — public exports.

### Worker

- `apps/web/workers/telegram-poll.ts` — supervisor process. On boot
  loads all `telegram_accounts WHERE enabled=true`, spawns one
  long-poll loop per account. Refreshes the account set every 60s so
  newly-added bots come online without a restart. Exponential backoff
  on errors (1s → 60s). No pg-boss — Telegram's long-poll is already
  single-flight per token.

### MCP server

- `apps/mcp/src/server.ts` — extended with 7 new tools (full list below).
  Existing tools (`tree_list`, `search`, `email_get`, `email_list`)
  unchanged except that `search` accepts `type='telegram_message'`.

### Seed / migration

- `apps/web/scripts/seed-telegram.ts` — idempotent. Reads
  `~/.claude/channels/telegram/.env` (TELEGRAM_BOT_TOKEN) and
  `access.json` (allowFrom list), upserts one `telegram_accounts` row
  + one `telegram_chats` per allowlisted user. Re-running just refreshes
  the encrypted token (with AAD bound to the row id) and re-applies
  `allowlist_status='allowed'`.

### Wiring

- `apps/web/package.json` — added `worker:telegram:dev` script + the
  `@mantle/telegram` workspace dep + `seed:telegram` script.
- `apps/mcp/package.json` — added `@mantle/telegram` dep.
- Root `package.json` — the `pnpm dev` concurrent group now includes
  the telegram worker as `tg` (yellow).

## MCP tools (Claude-facing API)

| Tool | Purpose |
| --- | --- |
| `telegram_pending` | Unprocessed DMs, oldest first. Returns row id, telegram_message_id (for reply-threading), chat_id, sender info, text, sent_at, attachments. Optional `chat_id` filter. This is the inbound polling tool. |
| `telegram_send` | Sends a chat message. Outbound-gated: refuses chats not in `allowlist_status='allowed'`. Splits text at 4096 chars. Optional `reply_to` (telegram_message_id) and `markdown`. |
| `telegram_react` | Adds an emoji reaction (Telegram's whitelist only). |
| `telegram_edit` | Edits a bot message in place. Edits don't push-notify. |
| `telegram_mark_processed` | Flips `processed=true` on a `telegram_messages` row. Pass the **row id** from `telegram_pending` (not the telegram_message_id). |
| `telegram_pair` | Approves a pending pairing code. Allowlists the chat and sends a confirmation DM. |
| `search` (extended) | Now accepts `type='telegram_message'` to scope full-text search to DMs. |

Usage pattern for real-time-ish polling:

```
/loop /tg-tick
```

…where `/tg-tick` is a custom slash command (TODO — not built yet) that
calls `telegram_pending`, responds via `telegram_send`, then
`telegram_mark_processed`. The looping is what we'd put in tmux for
always-on. For now you just call `telegram_pending` manually.

## Current running state (as of handoff)

- **SSH tunnel to remote prod Postgres** — pid 92561, started via
  `~/Projects/mantle/scripts/dev-tunnel.sh --background`. Forwards
  `127.0.0.1:54322 → cwe@mcp.crossworks.network:5432`.
  PID file: `$TMPDIR/mantle-tunnel.pid`. Stop with `./scripts/dev-tunnel.sh --stop`.
- **Local Supabase is stopped** — `supabase stop` was run to free port
  54322 for the tunnel. To switch back to local dev, `./scripts/dev-tunnel.sh --stop && supabase start`.
- **Telegram worker** — was running as a background task inside the
  previous Claude Code session. **Will be killed when that session
  exits.** Restart it any time with:
  ```bash
  cd ~/Projects/mantle/apps/web && \
    pnpm worker:telegram:dev
  ```
  Or just `pnpm dev` from the root for the full stack.
- **Mantle MCP server** — registered at **local** scope (per-project)
  in `~/.claude.json` under the project entry for
  `/Users/jasonschoeman/Projects/mantle`. Command:
  `pnpm -C /Users/jasonschoeman/Projects/mantle/apps/mcp start`.
  Verified `✓ Connected` via `claude mcp get mantle`. **Requires
  Claude Code restart** to be loaded into a session — `/reload-plugins`
  is plugin-only. (Earlier in the day the entry was broken — see the
  "Update 2026-05-16" note in the TL;DR for the recovery commands.)

## Verified state in the DB

```text
telegram_accounts
  id                = 52ef0b87-9308-4319-8c96-c8be6118e4f1
  bot_username      = miaschoemanbot
  branch_path       = inbox.telegram_miaschoemanbot
  enabled           = true
  last_update_offset = (advanced past the test message)

telegram_chats
  id                = e766dc17-3cd8-4839-8361-1d88f418609a
  telegram_chat_id  = 431132685    (Jason's Telegram user id)
  chat_type         = private
  allowlist_status  = allowed

telegram_messages   (one unprocessed test)
  id                = e077c9a9-8da0-42bc-9438-205a69d93c02
  from_name         = Jason Schoeman
  text              = "Are you working yet?"
  sent_at           = 2026-05-16T10:43:00Z
  processed         = false   ← waiting for the next session to reply
```

## How to pick up where we left off

1. **Make sure the tunnel and worker are up:**
   ```bash
   pgrep -fl "ssh -N.*54322"          # tunnel
   pgrep -fl "telegram-poll"          # worker
   ```
   If either is missing:
   ```bash
   cd ~/Projects/mantle
   ./scripts/dev-tunnel.sh --background
   pnpm -C apps/web worker:telegram:dev &
   ```

2. **Verify mantle MCP is loaded.** Run `claude mcp list` from a
   shell — `mantle` should show `✓ Connected`. Then inside Claude
   Code, the deferred-tools list in the session's system reminder
   should include `mcp__mantle__telegram_pending`,
   `mcp__mantle__telegram_send`, etc. If `claude mcp list` shows
   `✗ Failed to connect`, run `claude mcp get mantle` — if Command/Args
   are empty, re-register with the commands in the TL;DR's
   "Update 2026-05-16" note. If the connection is healthy but the
   tools are missing from the session, fully `/exit` and relaunch
   `claude` (MCP servers attach at process startup only).

3. **Drain the queued message.** Ask Claude to:
   - call `telegram_pending` — should return the "Are you working yet?"
     row (or whatever has arrived since)
   - call `telegram_send` with `chat_id='431132685'` and a reply
   - call `telegram_mark_processed` with the row id

4. **Confirm with a fresh DM** — message the bot from your phone.
   Within ~25s it should appear in `telegram_pending`.

## Open items / next steps

In rough priority order:

- **Web UI** for telegram under `apps/web/(app)/telegram/` — list chats,
  view messages, manage allowlist, view pairing codes. Mirror the
  `/settings/accounts` shape used for email.
- **Always-on worker** — currently the worker dies when its parent
  shell exits. Either run under launchd (mirroring the abandoned
  `telegram-robust` plist) or include it in a `pnpm dev` always-on
  setup with `pm2 / launchctl`.
- **A slash command** like `/tg-tick` (a Claude Code skill) so
  `/loop /tg-tick` reliably drains the inbox without re-explaining the
  pattern each time.
- **Attachment download tool** — `telegram_download_attachment(file_id)`
  that pulls the bytes via `getFile` + `https://api.telegram.org/file/...`
  and stores via `@mantle/storage`. The schema already supports
  `attachments` jsonb on `telegram_messages`; this is the only missing
  end of the round-trip.
- **Embeddings** for telegram messages so they show up in the OpenAI
  semantic search (the embedding column on `nodes` is unused today
  for telegram).
- **Permission-request inline keyboard** flow — Claude asks for a
  tool's permission, the user clicks Allow/Deny on Telegram. Was
  implemented in the abandoned `telegram-robust` plugin (see
  `~/.claude/plugins/local/telegram-robust/daemon.ts` and the
  `bot.on('callback_query:data', ...)` handler) — port if needed.
- **Group support** — `gate()` drops non-DM messages in v1. Restore the
  group-policy logic from the abandoned plugin if you actually use
  groups.
- **Webhooks** instead of long-poll — once Mantle has a public URL.
  Telegram `setWebhook` + an HTTPS endpoint on `apps/web` would drop
  the polling worker entirely.
- **`/start`, `/help`, `/status`** bot commands — the upstream plugin
  had these for the pairing UX. We didn't port them; pairing currently
  works by DM-ing anything and getting a code back.

## Key design decisions and the reasons

- **DB-backed allowlist** (instead of a JSON file) because Mantle is
  Postgres-first and the email package already follows this pattern.
  Bonus: pairing state has a TTL via `pairing_expires_at`.
- **Tool-polling, not channel notifications.** Channel notifications
  don't render in Claude Code 2.1.143 (regression or env-specific bug).
  Polling via MCP tools is universal and always works.
- **Long-poll over webhooks** for v1 because Mantle is localhost-only.
  Webhooks require a public URL; polling needs nothing.
- **Single MCP server (mantle) for everything** because the user
  explicitly chose this: one MCP server connected to Claude that
  surfaces all of their data. No more separate "telegram plugin" — it's
  just another package inside Mantle.
- **Branch path `inbox.telegram_<botname>`** — ltree under `inbox`,
  mirroring `inbox.<email_account>`. Per-bot subtree so messages from
  multiple bots don't collide.

## Files touched in this session

```
packages/db/migrations/0008_node_type_telegram.sql     (new)
packages/db/migrations/0009_telegram.sql               (new)
packages/db/migrations/meta/_journal.json              (appended idx 8, 9)
packages/db/src/schema/nodes.ts                        (enum add)
packages/db/src/schema/index.ts                        (export telegram)
packages/db/src/schema/telegram.ts                     (new)
packages/telegram/package.json                         (new)
packages/telegram/tsconfig.json                        (new)
packages/telegram/src/index.ts                         (new)
packages/telegram/src/types.ts                         (new)
packages/telegram/src/client.ts                        (new)
packages/telegram/src/gate.ts                          (new)
packages/telegram/src/sync.ts                          (new)
packages/telegram/src/outbound.ts                      (new)
apps/web/workers/telegram-poll.ts                      (new)
apps/web/scripts/seed-telegram.ts                      (new)
apps/web/package.json                                  (added scripts + dep)
apps/mcp/src/server.ts                                 (added 7 tools)
apps/mcp/package.json                                  (added dep)
package.json                                           (added tg to pnpm dev)
docs/telegram.md                                       (this file)
```

`pnpm typecheck` is green across the workspace as of writing.

## Things deliberately left alone

- The seed script never deletes the legacy `~/.claude/channels/telegram/`
  files. They stay as the canonical source for the bot token until a
  proper Mantle web UI for managing bot accounts exists.
- `installed_plugins.json` still lists `telegram-robust@telegram-robust-claude`
  even after `/plugin uninstall`. It's `enabled: false` in
  `settings.local.json`. Leaving the registry entry is harmless and
  reversible.
- The abandoned plugin's launchd plist `dev.telegram-robust.plist` was
  removed when we tore down that experiment.

---

## Voice in/out (added 2026-05-19)

Telegram voice notes now flow through Mantle end-to-end:

**Inbound voice → text:** when a voice note arrives, the agent
detects the `voice` attachment, calls the default `kind='stt'`
ai_worker (OpenAI Whisper by default), updates `telegram_messages.
text` with the transcript, and continues the normal responder flow.
The responder never sees the placeholder "(voice message)" string.

**Outbound text → voice:** when the user voice-messaged us OR the
responder emits a `[VOICE]` marker at the start of its reply, the
agent calls the default `kind='tts'` ai_worker (OpenAI
gpt-4o-mini-tts → voice `nova` by default), then sends the resulting
OGG/Opus bytes via `sendVoice` instead of `sendMessage`. The reply
appears as a voice-note bubble in Telegram.

Providers wired today: OpenAI (TTS + STT) and ElevenLabs (TTS,
including cloned voices via live `/v1/voices` discovery). Configure
at `/settings/ai-workers`. Failure modes degrade to text reply with
a polite apology — see [ai-workers.md §5](./ai-workers.md#5-voice-inout--end-to-end)
for the full pipeline.

`packages/telegram/src/outbound.ts` gained two new helpers:

- `sendVoice(account, chatId, audioBuffer, options)` — uploads the
  audio as an `InputFile` and calls `bot.api.sendVoice`. Audio must
  be OGG/Opus for Telegram to render it as a voice-note bubble.
- `downloadTelegramFile(account, fileId)` — two-step
  `getFile` → CDN fetch. Returns the raw bytes plus a sniffed MIME
  type. Used by the STT path; available to any code that needs the
  raw bytes of an attachment.
