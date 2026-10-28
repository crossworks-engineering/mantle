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

| Table                     | What it holds                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messenger_conversations` | A direct chat or a group. `last_seq`, `last_message_at` and `last_preview` (the tail) are written by the send that changes them. A direct chat has a `direct_key` (the two login ids, sorted and joined; unique), so a pair has one chat. A group may have an `icon` and a `color` (0341) and an `info` text (0343), below. |
| `messenger_participants`  | One row per login (or, from Phase 3, the group's one agent). `admin` marks a group admin (the creator first). `last_read_seq`, `mention_seq`, `cleared_before_seq`, `muted`; `from_seq`, the floor of what the login reads; `left_at` and `left_seq` once the login left.                         |
| `messenger_messages`      | One row per message, `(conversation_id, seq)` unique. `author_kind` is login, agent or system. `author_name` is a snapshot. `via` is the credential label shown, `via_ref` the credential itself. `client_msg_id` makes a send idempotent.                                                        |
| `messenger_attachments`   | The attachment rows of Phase 4 (no bytes yet).                                                                                                                                                                                                                                                    |
| `messenger_reactions`     | One emoji of one login on one message.                                                                                                                                                                                                                                                            |
| `messenger_favourites`    | A login's pins: a conversation or an agent thread.                                                                                                                                                                                                                                                |
| `login_presence`          | When a login's messenger stream last beat ("online": the last two minutes).                                                                                                                                                                                                                       |

`push_login_prefs` has two more columns for Phase 5: `messages` (all,
mentions, off) and `message_preview`.

Migrations: `packages/db/migrations/0335_messenger.sql`,
`0336_messenger_fix_round_2.sql` (the read columns, the participants
policy, the trigger order), `0341_messenger_group_look.sql` (a group's
icon and colour) and `0343_messenger_group_info.sql` (a group's info
text). Drizzle schema:
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
  list row shows no newer line, and the room shows the people who were
  there when it left (the participants policy itself: no row of a later
  joiner; judged by seqs, never by clocks);
- a login added to a group later, or added back, reads from the line that
  added it (`from_seq`), never the history before it or the gap while it was
  out, and sees none of the people who left before it joined;
- nobody reads another login's cursors, mute or leave as a column (a read
  receipt is a stream event by design), and nobody reads the conversation's
  tail as a column: the workspace role may SELECT only the other columns
  (ACCESS_MATRIX, 0336). Its own rows, with the tail capped at its leave (no
  newer time or line), come from `mantle_messenger_mine(conversation)`, the
  room's people as it may see them from `mantle_messenger_people`;
- there is no Admin exception: an Admin user or the brain owner reads no chat
  it is not in, and there is no moderation view;
- an agent row widens nobody's read.

`mantle_messenger_seq_cap(conversation)` answers the highest seq the acting
login may read (null: none), `mantle_messenger_seq_floor(conversation)`
the seq it reads above, and `mantle_messenger_sees_participant` whether it
sees one participant row. All are security definers keyed on the scope's
own login, so the participant policy does not read itself. The workspace
role (`mantle_view_user`) has SELECT only. The title, the admin flags and
whether the group is archived, as a leaver sees them, are the room's
current ones (a known choice: the list needs a name). A login added back
reuses its one participant row, so the seq rule judges only its latest
stint: a leaver no longer sees someone who came back after it left, and the
one who came back sees nobody who left during its earlier stint (one row per
stint would keep both; not in V1).

Writes run in `packages/content/src/messenger.ts`, one function per action,
each one transaction on the system pool (ACCESS_MATRIX writer `system`). Each
checks the actor's participant row inside the same transaction. Each read of
the module also names the login in its own WHERE, so a read stays the
login's own even outside a scope. A non-participant hears "not found", never
"forbidden".

**Who may start a chat** (the directory): logins that share a live
workspace with the caller; an Admin user reaches every usable login. This
is one part of the people gate (below): `peopleVisibleTo(caller)` is the
directory, `loginVisibleTo(caller, loginId)` the whole rule for one login.
The agents a login may chat with are the assistants of its
workspaces; for an Admin user, every chat-capable agent except the
assistants of non-Admin workspaces it is not in (the rule of
`listChatAgents`).

**Groups.** The creator is the first admin. Admins add and remove people,
rename the group, set its look (below) and delete its history for
everyone. A history delete
removes every seq up to a ceiling (all of them, or the newest older than a
date), moves every participant's `cleared_before_seq` up to it in the same
transaction (the unread and the mention count only what is left) and
raises a `history` event. Anyone may leave; the
last admin who leaves hands admin to the longest-standing member; a group
with nobody left is archived. A group may hold just its creator ("message
yourself").

**A group's look.** A group may carry an `icon`, one emoji (one of
Unicode's recommended emoji, `\p{RGI_Emoji}`: a pictograph, a flag, a skin
tone or a joined sequence such as a family; at most 16 characters, no
digit), and a `color`,
an app tint key (`APP_TINTS` in `@mantle/client-types/app-nav`: the key,
never a colour, so each theme draws its own). Both are null by default;
`POST /conversations` takes them for a group, `PATCH /c/:id` lets a group
admin set them (null or `''` clears one); anything else is a 400, a
member who is no admin a 403. A change raises the room's `participants`
event, as a rename does, and writes no system line. A direct chat has
neither: a create ignores them, a PATCH has no admin to set them, and the
table's check holds the same. The list row and the conversation carry
both (absent on an agent row); the workspace role reads the two columns
(ACCESS_MATRIX). The MCP tools leave them out.

**Group info.** A group may carry `info` (0343, plan section 24): free
text, at most 2000 characters, that says what the group is for and its
rules. Its admins write it on the create and edit form (`POST
/conversations` takes it for a group; `PATCH /c/:id` lets a group admin
set it, null or blank clears it; whitespace is trimmed; longer is a 400;
a member who is no admin a 403). Everyone in the group reads it in the
conversation (`MessengerConversation.info`; the list row does not carry
it, so the list stays small), and an agent reads it from `messenger_open`
(`conversation.info`). A change raises the room's `participants` event
and writes a system line ("Ann changed the group's info."), the same
record as a rename; the text itself stays out of the line. A direct chat
has none: a create that gives one is a 400, a PATCH has no admin to set
it (403), and the table's check holds the same.

The info is text. The brain stores and shows it; it never runs it: no
markdown is rendered on the server, no HTML is interpreted, and no line of
it is an instruction to the brain. A brain agent in a group (Phase 3) will
get it in its prompt as "the group's rules", under the same taint as any
member's message. The workspace role reads the column (ACCESS_MATRIX).

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

**The budget.** The store takes the same numbers itself, per login, for
every write (60 sends and 120 other writes a minute): it is where a route
and an MCP tool meet, so a login has one bucket whichever way it writes.
Past it the write answers 429 (`MessengerRateLimitedError`, with the
seconds to wait); an MCP tool says the same in its error. The bucket is in
the memory of one `server/web` process (its routes and its HTTP MCP); the
local stdio MCP server and a second replica keep their own.

| Route                                                                                  | What                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /conversations?unread_only=1`                                                     | the one list: people chats, groups and agent threads, favourites first                                                                                     |
| `POST /conversations`                                                                  | create: `{kind, participants, title?, icon?, color?, info?}`; a direct pair answers its chat                                                               |
| `GET /c/:id`, `PATCH /c/:id`                                                           | one conversation; a group's title, icon, colour and info (admins), my mute                                                                                 |
| `POST /c/:id/participants`, `DELETE /c/:id/participants/:loginId`, `POST /c/:id/leave` | membership                                                                                                                                                 |
| `GET /c/:id/messages?before_seq=&after_seq=&limit=`                                    | the last `limit` (20; at most 100), older, or newer than a seq; with `after_seq` and `hasMore`, `lastSeq` is the page's highest seq (the next `after_seq`) |
| `POST /c/:id/messages`                                                                 | send: `{body, mentions?, replyToSeq?, clientMsgId?}`                                                                                                       |
| `PATCH /c/:id/messages/:seq`, `DELETE /c/:id/messages/:seq`                            | edit my message; delete mine (a group admin: any)                                                                                                          |
| `POST /c/:id/messages/:seq/reactions`                                                  | toggle an emoji                                                                                                                                            |
| `POST /c/:id/read`, `POST /c/:id/clear`, `POST /c/:id/history/delete`                  | cursor, clear for me, delete history for everyone                                                                                                          |
| `POST /c/:id/typing`                                                                   | a NOTIFY, stored nowhere                                                                                                                                   |
| `PUT /favourites/:kind/:id`, `DELETE /favourites/:kind/:id`                            | pin and unpin                                                                                                                                              |
| `GET /directory?q=`                                                                    | who I may chat with, with "online"; `q` matches the shown name, never the address                                                                          |
| `GET /photo/:loginId?v=`                                                               | the older path of `GET /api/people/:id/photo` (People, below): the same handler and callers                                                                |
| `GET /stream`                                                                          | the SSE stream (below)                                                                                                                                     |
| `GET /unread`                                                                          | the badge                                                                                                                                                  |
| `GET /capabilities`                                                                    | `{calls, callsAgent, video: false}`: whether this brain shows a Call button (Calls, below)                                                                 |
| `POST /c/:id/call`, `POST /c/:id/call/token`                                           | start or join the chat's call; a fresh hour for the open one (Calls, below)                                                                                |
| `POST /c/:id/call/leave`, `POST /c/:id/call/end`                                       | my leave (a courtesy); a group admin ends the call for everyone                                                                                            |
| `DELETE /c/:id/call/participants/:loginId`                                             | a group admin drops a person from the call                                                                                                                 |
| `POST /c/:id/call/agent`, `DELETE /c/:id/call/agent`                                   | P2: refused with one line, nothing recorded                                                                                                                |
| `GET /c/:id/calls?before=&limit=`                                                      | the chat's calls, newest first                                                                                                                             |

The DTOs are in `packages/client-types/src/dto/messenger.ts`. A mention is
stored and starts nothing in Phase 1: no agent turn exists yet.

**Faces.** A participant and a directory entry carry `avatar` (`{style,
seed, parts}`, the shape `GET /api/shell` gives for the caller's own): a
login's from its own Appearance seed and builder parts, an agent's from
`agents.avatar` (its slug when the seed is empty); `style` is always the
brain's one style (the anchor's `avatarStyle`), never a stored one. No
seed is `avatar: null`, and the client draws initials. A login also
carries `photoVersion` (the shell's `avatarPhotoVersion`, for that login),
null when it has no photo; the photo outranks the avatar. Both come from
the people module, through its gate (`loginFaces` takes the caller and
leaves out a login it may not see; one query per list after the Admin
check; `agentFaces` for the brain's agents), for the ids the scoped read
returned, as the names do. The photo itself is
`GET /api/people/:id/photo?v=` (People, below); `/api/messenger/photo/:loginId`
is its older path. The MCP tools leave both fields out: a face tells a
model nothing.

## People

Mantle is a team system and every login is approved by hand, so what a
person shares with its team (its name, avatar, photo and presence; later a
status, a time zone or a location shared on purpose) is open to the team:
the UI, the API and the agents. It reaches a caller through one gate,
`packages/content/src/people.ts`, and no other way (plan section 23).

**The gate.** A caller sees a login when it is the caller itself; or it is
in the caller's directory (a usable login, a mailbox and not disabled,
that shares a live workspace with the caller; for an Admin user every
usable login); or it is a person of a chat the caller is in, as the
caller may see that room (never one who left before it joined; for a chat
it left, only those added before it left; a disabled login stays visible
there). Every read of the module runs on the system pool by name, the
caller's own login id in its WHERE: the caller is always the
authenticated login, never an id from a request. Not visible and not
existing read the same (left out of a list, the one 404). Faces too go
through the gate (`loginFaces` takes the caller), and a search matches the
name a caller is shown, never the mailbox behind it. The messenger
re-exports `peopleVisibleTo` and `loginVisibleTo`, and its rooms keep the
same seq rule (`roomPeopleSql`, which `mantle_messenger_people` answers in
a scope). Agents are not logins: an agent's face is the messenger's.

**The card** (`PersonCard`, `packages/client-types/src/dto/people.ts`):

| Field          | What                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | the login id                                                                                                                                                                       |
| `name`         | the display name, else the mailbox part                                                                                                                                            |
| `avatar`       | `{style, seed, parts}` as on a participant, or null (initials)                                                                                                                     |
| `photoVersion` | the `v` of the photo route, or null (no photo)                                                                                                                                     |
| `presence`     | `{state, lastActiveAt}`: `online` when the login's stream beat in the last two minutes (`login_presence`), else `offline`; the type also names `idle` and `busy`, which come later |
| `status`       | `{text, until}` or null; always null until a status is stored                                                                                                                      |

**The routes**, under `/api/people`, each open to every login (`class:
'self'`, `open: 'any'`) with the per-login limit `peopleRead` (600 a
minute):

| Route                                | What                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/people`                    | every card the caller may see, itself included, by name (one query after the Admin check; at most 1000, with no sign of more) |
| `GET /api/people/:id`                | `{ person }`, or the one 404                                                                                                  |
| `GET /api/people/presence?ids=a,b,c` | `{ presence: [{id, state, lastActiveAt}] }` for the ids the caller may see; the first 200 ids are read, the rest ignored      |
| `GET /api/people/:id/photo?v=`       | the photo's bytes, or the one 404                                                                                             |

**The photo** carries the headers of `/api/profile/photo` (`private`;
`immutable` only when `v` is the photo served, revalidated otherwise),
read from storage only after the gate let the login through. A login out
of the caller's gate, one with no photo and an id that is no uuid answer
the one 404, never a 403. As with the caller's own photo, a browser keeps
a photo it fetched at its `v` after the access that opened it ends.

**The photo token.** An `<img>` in the desktop app or the phone carries no
cookie and no bearer, so the photo route (and its messenger path) also
take `?at=<token>`: the short-lived asset token the shell mints for
`/api/profile/photo` (`buildAssetToken`, the same token and lifetime; a
member's lasts 10 minutes and the shell mints it again). The gate admits
the token on these two paths only (`isAssetPath`), on a GET, and the
route reads the caller as `anyLoginAssetCaller()` (caller kind
`loginAsset`): the session if there is one, else the token's login, which
is read again and must be usable, on the session epoch the token carries
and of the brain the token names. The photo is then served only through
the gate, as for a cookie. An expired or forged token is no credential
(the gate's 401, as on every asset path), so is the token of a login that
signed out everywhere or was disabled, or one naming another brain; a
token opens no other route and no HEAD. The token is part of the URL a
browser caches by: a client that rewrites every photo `src` each time the
shell mints a new token fetches each photo again (and spends the
`peopleRead` budget); keeping the URL a photo was first drawn with until
its `v` changes, or fetching the bytes once into a blob, avoids that.

## Live delivery

Two triggers raise NOTIFYs with ids only, never text:

- `messenger_changed` `{c, seq, kind, actor}`: kind `new`, `edit`, `delete`
  (a message), `read` (a cursor moved), `self` (my clear or mute; a clear
  raises `read` too), `participants` (someone joined or left, an admin or
  the title changed), `reaction`; `typing` from its route; `history` (a
  history delete up to `seq`: load the chat again, a deleted row raises no
  message event; the stream event carries no seq, so a leaver does not
  learn how far the chat went).
- `login_notice` `{kind: 'message', loginId, c, seq}` for each live login of
  the conversation that is not the author and not muted. The push handler
  skips the kind until Phase 5 sends it.

`server/web/lib/realtime.ts` LISTENs once per process and hands each change
only to the streams of the conversation's participants (a small map,
conversation to its participants). An entry is dropped on a `participants`
event (with a stream open or not), lives 60 s at most, and the whole map
empties when the last messenger stream closes and when the LISTEN
(re)connects. A left participant hears nothing past its `left_seq`; typing
skips the typist; `history` reaches everyone whose window held a deleted
seq.

`GET /api/messenger/stream` is the SSE stream for any login, on the guards of
the member stream: the login is checked again on every heartbeat (a disabled
login's stream closes), a stream lives at most an hour, and one login holds at
most `MEMBER_STREAMS_PER_LOGIN` messenger streams (429 beyond), slots apart
from its member streams (`/api/member/realtime`). The heartbeat marks the
login online. A client fetches `after_seq` on every event, on reconnect and on
focus: seq makes the gap exact.

## Calls

Calls between people (plan page "PLAN: Calls and agent voice over LiveKit",
sections 5, 8, 9, 11, 12 and 20; P1 M1 and M2). A call is a LiveKit room
named after the conversation (`msgr-<conversationId>`); LiveKit runs on the
box as the `calls` compose profile, switched from Settings > Services and
off by default: no container, no ports, no Call button. Nothing else in the
messenger model changes.

**Start, join, leave.** A live participant taps Call: `POST /c/:id/call`
opens the call row (one open call per conversation, a partial unique
index), writes the system line `{type: 'call_started', callId}` at the
next seq (so the existing `messenger_changed` trigger carries it to every
client, which rings), and answers a one-hour token for the one room. Every
later tap is a join: the same call, a token for that login. A login is in
one call at a time across its devices: a second device swaps the first
(the earlier participant is removed by identity before the new token is
handed out), and a join to another chat's call drops it from the one it
was in. `POST /c/:id/call/token` is a fresh hour with the same checks.
`POST /c/:id/call/leave` is a courtesy mark (the webhook is the truth).
A leaver of the chat is refused, an outsider hears "not found", calls off
is one 404, a LiveKit that does not answer is one 503 with nothing written.

**What the token says** (`packages/content/src/livekit.ts`): identity
`login:<id>`, the shown name, one room, `roomJoin`, `canPublish`,
`canSubscribe`, `canPublishData`, `canPublishSources: [microphone]`, one
hour. Never an admin grant: a group admin's end and remove go through the
room API on the brain. The API key pair lives in `.env` only.

**The answer** (`packages/client-types/src/dto/calls.ts`,
`MessengerCallJoinResponse`): `{callId, room, url, token, expiresAt, ice}`.
`url` is `wss://<site>/livekit` (Caddy proxies `/livekit/*` to the
service). `ice` is the ICE override of plan section 20: LiveKit tells a
browser to reach TURN/TLS on port 443, which Caddy holds, so the brain
hands the client `{urls: ['turns:<MANTLE_CALLS_HOST>:5349?transport=tcp',
'turn:<MANTLE_CALLS_HOST>:3478?transport=udp'], username, credential}`,
the room's own TURN credential pair read from the room API (`username` is
the room's name, `credential` the room's TURN password, exactly as LiveKit
mints them). The client passes it as `rtcConfig.iceServers` when it
connects. `ice` is null when the box has no calls host or TURN is off:
connect with LiveKit's own list then.

**The chat's gate holds for the room.** A login that leaves the chat or is
removed from it is dropped from the open call in the same transaction (its
stay closes; the room drops its identity after commit), and the reconciler
drops any identity in the room that is not a live participant. A group
admin's `DELETE .../call/participants/:loginId` is a kick, not a ban: the
person may tap Call again while still in the chat.

**Who is in it, and when it ends.** LiveKit posts signed webhooks to
`POST /api/livekit/webhook` (public at the gate, verified on the raw body
with the API secret, 401 and no side effect on any failure, the body never
logged, every event id kept a day so a replay is a no-op): a stay opens on
`participant_joined` and closes on `participant_left`; `room_finished`
closes the call row (`finished`, duration, head count) and writes the line
`{type: 'call_ended', callId, seconds, participants}`. The reconciler in
the events worker (`maybeReconcileCalls`, once a minute) is the truth when
a webhook is lost: a row whose room is gone closes as `reconciled`, a row
past `MANTLE_CALLS_MAX_MINUTES` closes as `cap_reached` with the room
deleted and the line `{type: 'call_cap', ...}`, and a pass with the service
off closes every row as `service_off`. It corrects stays to the room's
list and never closes anything while LiveKit does not answer. It only
closes: no cron, trigger or state change ever starts a call or a voice job
(plan section 12).

**Tables** (migration 0342, rollback beside it): `messenger_calls` (the
row, with `started_seq`, the seq of its own "call started" line, so row
security answers a call exactly as it answers that line: a live
participant, a leaver up to its leave, a login added later from its add
line) and `messenger_call_participants` (one row per stay; written by the
webhook, corrected by the reconciler); `messenger_call_webhooks` is the
replay guard, the system's alone. `messenger_messages.event` carries what
a system line marks (`MessengerMessage.event` in the DTO; null on every
other row). `messenger_conversations.voice_replies` is stored for P3 and
read by nothing yet. Writes go through
`packages/content/src/messenger-calls.ts` only, one transaction each on
the system pool.

**Limits** (plan section 12): a start or join 5 a minute per login
(`messengerCall`), a refresh 12 (`messengerCallToken`), the other call
writes `messengerWrite`; one open call per conversation; one call at a
time per login; `MANTLE_CALLS_MAX_PARTICIPANTS` (25) people, checked at the
tap and set on the room; `MANTLE_CALLS_MAX_MINUTES` (240) per call; the
webhook 1 MB and 600 a minute per address.

**Your own assistant.** `POST /api/assistant/:agentId/call` and
`.../call/token` mint a token for the room `asst-<agentId>-<loginId>`
(no `messenger_calls` row: assistant threads are not messenger rows), for
an agent the login may chat with, and only where the agent worker is
registered (`MANTLE_CALLS_AGENT=1`; the worker itself is P2, so until then
nobody joins that room). `callId` is null in that answer.

**Infra** (M2): the `livekit` service in `docker-compose.yml` behind the
`calls` profile, its release-owned config `infra/livekit/livekit.yaml`
(embedded in the image, refreshed by the updater like the Caddyfile,
filled at container start from the environment), the Caddy route and the
`access_token=` redaction in both shapes, the Settings > Services switch
with its updater cases, the key pair `install.sh` writes. The four media
ports (UDP 7882, TCP 7881, TCP 5349, UDP 3478) must be open at the cloud
edge of a box; `infra/livekit/README.md` has the ops notes.

## MCP tools

On the one login surface, MCP only (`mcpOnly`), none spends, none is risky,
each runs as the caller in its scope:

| Tool                  | What                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `messenger_list`      | my chats with unread and the last line                                                                 |
| `messenger_open`      | messages of a chat, oldest first, with its people and a group's `info`                                 |
| `messenger_send`      | send as me; `client_msg_id` makes a retry safe                                                         |
| `messenger_create`    | a direct chat or a group (with its `title` and `info`)                                                 |
| `messenger_wait`      | wait up to 60 s for messages after a seq; at most 100 at a time (`hasMore`: call again with `lastSeq`) |
| `messenger_mark_read` | move my cursor                                                                                         |
| `messenger_directory` | who I may chat with                                                                                    |

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

There is no `messenger_update` tool: an agent reads a group's info (its
rules), it does not write it. Admins write it in the chat window.

## The via chip

A line sent through a credential (an MCP client, an API key, a peer) is
marked by the server: `via` is the label (`messengerViaFor`: the OAuth
client's name, the key's name, the peer's name, with the fallbacks "MCP",
"API key" and "Peer"), `via_ref` the credential. A browser session sends
with `via` null. Nothing a client sends can set or drop it. The client
(mantle-client, the Chats screen) shows it as a chip, with these exact
words:

- In the transcript: the author's name, then "via <label>" in the muted
  style with a small bot icon; the chip's title (its tooltip) says "Sent
  through <label>, an external agent or key on <name>'s account".
- In the list row's preview and in the notice text: "<name> via <label>:
  <first line>".
- Nothing is shown when `via` is null. A group's system lines never carry
  it.

So a line that the owner's Claude Code sends on the owner's login reads
"Ann via Claude Code" with the bot icon (Ann being the owner's shown name),
and a line Ann typed in the window reads "Ann". The desktop and the phone
show the same text.

## Engineering requests

The pattern plan section 24 sets out (the first use of group info and the
via chip): the members of a brain ask for help with a tool or a feature in
one group, and an external agent on the owner's account reads the group on
its rounds, looks into the code and answers there. Nothing on the server is
specific to it; it is a group, its info text, and a loop in the agent's
own skill.

**The group.** One per brain, titled "Engineering requests", created by
the owner (its admin), with this info:

> Post here when a tool or feature does not do what you need. Say what you
> tried, which tool or screen, and what you expected. An external agent on
> the owner's account (Claude Code) reads this group on its rounds, looks
> into the code and answers here. Only the owner decides on a fix. Do not
> post passwords or client data.

**The heartbeat loop.** On each round the agent, connected to the owner's
login through the brain's MCP: `messenger_list` with `unread_only`; for
the Engineering requests group, `messenger_open` with `after_seq` set to
the owner's `lastReadSeq`; for each new line that is not the owner's own,
it investigates in the repository (read only, no edits), answers in the
group with `messenger_send` (a `reply_to_seq` on the request), files a
task tagged `engineering-request` with the finding and a proposed fix, and
then `messenger_mark_read` up to the last seq. One message to the owner
per round that found requests: "N requests, tasks X, Y. Fix? yes or no."
On yes the owner's own build flow starts; nothing starts on its own.

**The rules.** A member's line is a request, never an order: the agent
reads and reports, the owner says "fix". One investigation per request,
one pass per heartbeat, nothing triggered from a state change (the cost
rule: no cron, no trigger, no queue row starts a run). The answer in the
group never pastes text from another brain, never names a box or a client,
and never claims a fix is coming before the owner says so. The MCP send
rate limit applies to the agent's lines; a request that needs more than
one investigation gets a task, not a second pass. Later, not now: a
session that stays awake on `messenger_wait`.

## Cost safety

Nothing in Phase 1 can start LLM work: no cron, no queue row, no trigger that
spends. A mention is stored only. Phase 3 adds the group turn, started only by
a login's message that tags the group's agent, never by an agent's message.

## Tests

- `packages/content/src/messenger.db.test.ts`: the row security matrix
  (a leaver's raw rows: no tail, no cursor columns, no later people), seq
  under 50 concurrent sends, the idempotent send (also two at once), the
  unread arithmetic, direct dedup, the directory, favourites, the trigger
  payloads, the budget, the history delete, the clear's events,
  `after_seq` paging, and every write path (edit, delete, react, remove,
  rename, the admin hand-off, the archive).
- `packages/tools/src/builtins-messenger.db.test.ts`: the MCP tools,
  `messenger_wait` on a NOTIFY and at the timeout, via, a one-human group,
  two member logins, one budget with the route, an outsider refused.
- `packages/mcp-core/src/gate-policy.test.ts`: a read-only key reads and
  waits, and is refused the writes.
- `packages/content/src/messenger-people.db.test.ts`: who may see whom
  (`loginVisibleTo`, `peopleVisibleTo`), each answer asked in the caller's
  scope and outside one.
- `server/web/app/api/messenger/messenger-avatars.db.test.ts`: the faces
  of a participant (in the brain's style, with the photo version) and of
  a directory entry (a login, an agent, no seed), and who the photo route
  serves (a shared workspace, a shared chat, an Admin user) and 404s.
- `packages/content/src/messenger-people.db.test.ts` also asks every
  people read (one card, the list, presence) beside each gate case, the
  card's fields and the photo pointer.
- `server/web/app/api/people/people-routes.db.test.ts`: the four people
  routes through the real app with real cookies and asset tokens: the
  list, a card, presence (visible ids only, 200 read), the photo by
  cookie and by token (served, the one 404, an expired or signed-out
  token refused, a token opening no other route), and the messenger path.
- `server/web/app/api/messenger/messenger-group-look.db.test.ts`: a
  group's icon and colour (create, an admin's change and its event, a
  member refused, a bad tint, a direct chat), and a group's info (0343:
  create, an admin's change, its event and its line, null clears, a
  member refused, a direct chat refused, the cap).
- `packages/content/src/messenger.db.test.ts` and
  `packages/tools/src/builtins-messenger.db.test.ts` also hold the info's
  store cases and `messenger_create` with info and `messenger_open`
  answering it.
- `server/web/lib/realtime-messenger.db.test.ts`: the fan-out reaches only
  participants, is right after an add or a remove with no stream open, and
  carries the history event.
- `server/web/app/api/messenger/stream/messenger-stream-route.test.ts` and
  `server/web/lib/sse.test.ts`: the stream guards, its own slots.
- Calls: `packages/content/src/livekit.test.ts` (the token's claims exactly,
  the ICE override, the switch, the webhook signature);
  `packages/content/src/messenger-calls.db.test.ts` (the token route's rules,
  one open call, the started line and its NOTIFY, the device swap, the cap,
  the webhook's stays and the ended line, the replay, the reconciler's four
  cases, admin end and remove, the agent stub, row security, the assistant
  twin); `server/web/app/api/livekit/webhook/webhook-route.test.ts` (401 on
  any bad signature with nothing applied, the 1 MB ceiling);
  `server/web/lib/caddy-layout.test.ts` (the route in both shapes, the
  redaction, the release-owned config).
