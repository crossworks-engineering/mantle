# Messenger

The messenger is a chat between the logins of one brain: direct chats (two
logins) and groups (any number of logins). It is Messenger V1; the plan of
record is the dev-brain page "PLAN: Messenger V1" (2026-10-27). This page
describes what is built: **Phase 1, the core store, the API and the MCP
tools.** The chat window (Phase 2), agents in groups (Phase 3), attachment
bytes and voice notes (Phase 4), the phone (Phase 5), the agent tool group
(Phase 6) and web push (Phase 7) come later.

The chat with an assistant is not a messenger conversation. It stays in
`assistant_messages` (one thread per agent and login). The messenger list
shows each such thread as a row of kind `agent` beside the people chats, with
its unread count, so one list holds everything.

## The model

| Table | What it holds |
| --- | --- |
| `messenger_conversations` | A direct chat or a group. `last_seq`, `last_message_at` and `last_preview` are written by the send that changes them. A direct chat has a `direct_key` (the two login ids, sorted and joined; unique), so a pair has one chat. |
| `messenger_participants` | One row per login (or, from Phase 3, the group's one agent). `admin` marks a group admin (the creator first). `last_read_seq`, `mention_seq`, `cleared_before_seq`, `muted`; `from_seq`, the floor of what the login reads; `left_at` and `left_seq` once the login left. |
| `messenger_messages` | One row per message, `(conversation_id, seq)` unique. `author_kind` is login, agent or system. `author_name` is a snapshot. `via` is the credential label shown, `via_ref` the credential itself. `client_msg_id` makes a send idempotent. |
| `messenger_attachments` | The attachment rows of Phase 4 (no bytes yet). |
| `messenger_reactions` | One emoji of one login on one message. |
| `messenger_favourites` | A login's pins: a conversation or an agent thread. |
| `login_presence` | When a login's messenger stream last beat ("online": the last two minutes). |

`push_login_prefs` has two more columns for Phase 5: `messages` (all,
mentions, off) and `message_preview`.

Migration: `packages/db/migrations/0335_messenger.sql`. Drizzle schema:
`packages/db/src/schema/messenger.ts`.

## Seq: the one order

Every message takes a seq from its conversation: 1, 2, 3. The send locks the
conversation row (`SELECT FOR UPDATE`), takes `last_seq + 1`, inserts the
message and moves `last_seq`, `last_message_at` and `last_preview`, in one
transaction. Writers to one conversation wait for each other; different
conversations do not. Seq is the order, the unread arithmetic and the
catch-up after a dropped connection. Clocks never order messages.

A deleted history leaves the max seq below `last_seq`, which is fine. A max
seq above `last_seq` is a bug: `MESSENGER_SEQ_DRIFT_SQL` in the content module
finds it.

## Who reads what

Row security keys every read on the participant row:

- a login reads a conversation, its participants and its messages while it
  holds a participant row;
- a participant who left reads up to its `left_seq` and nothing after; its
  list row shows no newer line, and the room shows the people as they were
  when it left;
- a login added to a group later, or added back, reads from the line that
  added it (`from_seq`), never the history before it or the gap while it was
  out;
- there is no Admin exception: an Admin user or the brain owner reads no chat
  it is not in, and there is no moderation view;
- an agent row widens nobody's read.

`mantle_messenger_seq_cap(conversation)` answers the highest seq the acting
login may read (null: none) and `mantle_messenger_seq_floor(conversation)`
the seq it reads above. Both are security definers, so the participant
policy does not read itself. The workspace role (`mantle_view_user`) has
SELECT only.

Writes run in `packages/content/src/messenger.ts`, one function per action,
each one transaction on the system pool (ACCESS_MATRIX writer `system`). Each
checks the actor's participant row inside the same transaction. Each read of
the module also names the login in its own WHERE, so a read stays the
login's own even outside a scope. A non-participant hears "not found", never
"forbidden".

**Who may start a chat** (the directory): logins that share a live workspace
with the caller; an Admin user reaches every usable login. The agents a login
may chat with are the assistants of its workspaces; for an Admin user, every
chat-capable agent except the assistants of non-Admin workspaces it is not
in (the rule of `listChatAgents`).

**Groups.** The creator is the first admin. Admins add and remove people,
rename the group and delete its history for everyone. Anyone may leave; the
last admin who leaves hands admin to the longest-standing member; a group
with nobody left is archived. A group may hold just its creator ("message
yourself").

**Direct chats.** Two logins, fixed. No admin, no leaving; a direct chat can
be cleared.

## Unread

`unread = last seq I may read - max(last_read_seq, cleared_before_seq)`,
never below zero. A mention sets `mention_seq`. Reading moves the cursor
forward only. Clear for me moves `cleared_before_seq` to the last seq: I see
nothing older, nobody else is affected. Muted chats still count.

`GET /api/messenger/unread` is the badge: people chats and groups, plus the
assistant replies after the login's `assistant_read_cursors` cursor.

## The API

Every route is under `/api/messenger`, open to every login (`class: 'self'`,
`open: 'any'`), reads the caller with `anyLoginCaller()`, and takes a per-login
limit (`server/web/lib/route-limits.ts`): `messengerRead` 600, `messengerWrite`
120, `messengerSend` 60 and `messengerTyping` 20 a minute.

| Route | What |
| --- | --- |
| `GET /conversations?unread_only=1` | the one list: people chats, groups and agent threads, favourites first |
| `POST /conversations` | create: `{kind, participants, title?}`; a direct pair answers its chat |
| `GET /c/:id`, `PATCH /c/:id` | one conversation; a group's title (admins), my mute |
| `POST /c/:id/participants`, `DELETE /c/:id/participants/:loginId`, `POST /c/:id/leave` | membership |
| `GET /c/:id/messages?before_seq=&after_seq=&limit=` | the last 20, older, or everything after a seq |
| `POST /c/:id/messages` | send: `{body, mentions?, replyToSeq?, clientMsgId?}` |
| `PATCH /c/:id/messages/:seq`, `DELETE /c/:id/messages/:seq` | edit my message; delete mine (a group admin: any) |
| `POST /c/:id/messages/:seq/reactions` | toggle an emoji |
| `POST /c/:id/read`, `POST /c/:id/clear`, `POST /c/:id/history/delete` | cursor, clear for me, delete history for everyone |
| `POST /c/:id/typing` | a NOTIFY, stored nowhere |
| `PUT /favourites/:kind/:id`, `DELETE /favourites/:kind/:id` | pin and unpin |
| `GET /directory?q=` | who I may chat with, with "online" |
| `GET /stream` | the SSE stream (below) |
| `GET /unread` | the badge |

The DTOs are in `packages/client-types/src/dto/messenger.ts`. A mention is
stored and starts nothing in Phase 1: no agent turn exists yet.

## Live delivery

Two triggers raise NOTIFYs with ids only, never text:

- `messenger_changed` `{c, seq, kind, actor}`: kind `new`, `edit`, `delete`
  (a message), `read` (a cursor moved), `self` (my clear or mute),
  `participants` (someone joined or left, an admin or the title changed),
  `reaction`; and `typing` from its route.
- `login_notice` `{kind: 'message', loginId, c, seq}` for each live login of
  the conversation that is not the author and not muted. The push handler
  skips the kind until Phase 5 sends it.

`server/web/lib/realtime.ts` LISTENs once per process and hands each change
only to the streams of the conversation's participants (a small map,
conversation to its participants, dropped on a `participants` event). A left
participant hears nothing past its `left_seq`; typing skips the typist.

`GET /api/messenger/stream` is the SSE stream for any login, on the guards of
the member stream: the login is checked again on every heartbeat (a disabled
login's stream closes), a stream lives at most an hour, and one login holds at
most `MEMBER_STREAMS_PER_LOGIN` streams (429 beyond). The heartbeat marks the
login online. A client fetches `after_seq` on every event, on reconnect and on
focus: seq makes the gap exact.

## MCP tools

On the one login surface, MCP only (`mcpOnly`), none spends, none is risky,
each runs as the caller in its scope:

| Tool | What |
| --- | --- |
| `messenger_list` | my chats with unread and the last line |
| `messenger_open` | messages of a chat, oldest first, with its people |
| `messenger_send` | send as me; `client_msg_id` makes a retry safe |
| `messenger_create` | a direct chat or a group |
| `messenger_wait` | wait up to 60 s for messages after a seq |
| `messenger_mark_read` | move my cursor |
| `messenger_directory` | who I may chat with |

A connection that names no login (a peer bound to an Admin user the owner
did not register) is refused: the tools never fall back to the brain owner.
Only the local stdio server, which has no credential, acts as the owner.

Every message records how it was sent: `via` (the OAuth client name, the API
key name, the peer name) and `via_ref` (the credential itself:
`oauth:<client id>`, `key:<key id>`, `peer:<peer id>`). `messenger_wait` skips
the caller's own messages sent through the same credential, so two clients
on one login wait for each other. The filter keys on `via_ref`, not the
label: two Claude Code installs both name their client "Claude Code". One
open wait per credential: a new wait ends the older one with nothing.

The wait LISTENs once per process on `messenger_changed`; the LISTEN only
wakes the wait, which reads in its own caller's scope. Without a LISTEN it
polls every 5 seconds.

**Two Claude accounts on one brain** (plan decision 19.3, both supported):

- two member logins, each with its own MCP connection: a direct chat;
- one login with two credentials (two API keys, or two OAuth clients): a
  group with just that login; each side calls `messenger_wait` and sees only
  the other side's messages.

## Cost safety

Nothing in Phase 1 can start LLM work: no cron, no queue row, no trigger that
spends. A mention is stored only. Phase 3 adds the group turn, started only by
a login's message that tags the group's agent, never by an agent's message.

## Tests

- `packages/content/src/messenger.db.test.ts`: the row security matrix, seq
  under 50 concurrent sends, the idempotent send, the unread arithmetic,
  direct dedup, the directory, favourites, the trigger payloads.
- `packages/tools/src/builtins-messenger.db.test.ts`: the MCP tools,
  `messenger_wait` on a NOTIFY and at the timeout, via, a one-human group,
  two member logins.
- `server/web/lib/realtime-messenger.db.test.ts`: the fan-out reaches only
  participants.
- `server/web/app/api/messenger/stream/messenger-stream-route.test.ts`: the
  stream guards.
