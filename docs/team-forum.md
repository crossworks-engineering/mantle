# Team Forum — shared topic threads

The Forum is the team's shared conversation surface at `/team/forum` — the
successor to the per-member 1:1 Team Chat (which lives on read-only at
`/team/assistant` as the "Chat archive"). A member creates a **topic**; the
team responder answers; the thread continues, and **every team member can
read every `team` topic**. Plan of record: "PLAN: Team Forum" (dev brain page
71601ba2, signed off 2026-07-17). This document covers Phase 1 (forum core).

> **Topology (v0.200 member carve):** the `/team` UI (forum included) is served
> by the **client app** (`client/web`); the data plane stays `/api/team/*` on
> the server origin. Cross-origin, the member credential is the **signed team
> bearer** (localStorage `mantle_team_token`, minted by
> `POST /api/team/auth {mode:'bearer'}`) sent via `teamFetch`/`teamEventStream`
> from `@mantle/web-ui/team-fetch`; same-origin it's the classic
> `mantle_team_chat` cookie. The server origin keeps a redirect stub for old
> `/team` bookmarks. See the member-carve section of
> [`frontend-backend-split.md`](./frontend-backend-split.md).

## 1. The model in one paragraph

Topics are titled, multi-author threads (`forum_topics` + `forum_posts`,
migration 0123) carrying a **kind** (`question` default · `discussion` ·
`review` / `feature` / `bug` — the request flags, wired to the review queue in
Phase 2), a **visibility** (`team` = whole team; `private` = author + owner
only), an owner-only **pinned** flag (the announcement mechanism — pinned
topics float to the top of everyone's list), and a **status**
(`open`/`answered`/`closed`). Every member post normally triggers a durable
agent turn answered into the thread; a per-post "no answer needed" toggle
(defaulted ON in `discussion` topics) waves the agent off. The same
`team-responder` agent serves both surfaces under the same trust posture:
read-anything / write-nothing except `team_request_create`.

## 2. Surfaces

| Surface                   | Who     | What                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/team/forum`             | members | Topic list (pinned first, unread dots, kind badges) + "New topic" dialog.                                                                                                                                                                                                                                                                                                                                                              |
| `/team/forum/[id]`        | members | Linear multi-author transcript + composer; live turn streaming.                                                                                                                                                                                                                                                                                                                                                                        |
| `/team/assistant`         | members | The old 1:1 thread, READ-ONLY (archive banner, no composer).                                                                                                                                                                                                                                                                                                                                                                           |
| `/team-admin?view=topics` | owner   | All topics (incl. private), master-detail transcript with trace links, pin/unpin, owner reply (optionally marking the topic answered).                                                                                                                                                                                                                                                                                                 |
| `/team-admin` (Members)   | owner   | The same content read PERSON-first: one member's posts each paired with the answer it drew, the topics they started, the requests they filed. Backed by `listForumMemberActivity` / `listForumPostsByContact` / `listForumTopicsByAuthor` (`packages/content/src/forum.ts`) — owner-scoped queries with **no visibility filter**, since the owner sees private topics too. Do not reuse them member-facing without `visibleTopicCond`. |

## 3. Turn pipeline

`runForumTurn` (`packages/assistant-runtime/src/run-forum-turn.ts`) is a
sibling of `runTeamTurn` sharing the unified `assemble-turn`/`responder-loop`
core, with three deliberate differences:

1. **The member's post is persisted by the route** (it must appear to every
   member instantly); the workflow (`forumTurnWorkflow`, DBOS, shared `mantle`
   queue) receives `topicId` + `inboundPostId` and owns only the answer.
2. **History is the topic transcript, multi-author**: member/owner posts
   become name-prefixed user turns (consecutive ones coalesced — strict-
   alternation providers reject back-to-back user messages); agent posts are
   assistant turns. The volatile block carries a "Forum topic" line telling
   the model it speaks to a room. Isolation invariants are identical to team
   chat: no persona notes, no digests, no owner identity/journal; private
   reads stripped unless the owner's pref allows.
3. **Serial-per-topic**, enforced by the DB: a partial unique index allows at
   most one `pending` agent post per topic; a concurrent turn's insert
   conflicts and retries with backoff, and a stale-pending sweep (15 min)
   guarantees an abandoned turn can never wedge a topic.

Turn ids ride the same `team-<contactId>.<nonce>` namespace as chat, so
`/api/team/turn/[turnId]/stream` (SSE, full status labels) serves forum turns
unchanged, with the same cross-member isolation.

## 4. Surface provenance

The tool loop runs under `surface: { kind: 'forum', contactId, topicId,
inboundPostId }`. `team_request_create` accepts `team` and `forum` surfaces
and additionally stamps `data.teamRequest.{topicId, postId}` on forum
requests — the hook Phase 2's round-trip (owner reply → posted back into the
topic) hangs off. Owner-side tools (`team_chat_*`, `team_access_list`) refuse
both team surfaces.

## 5. Data model (migration 0123)

- **`forum_topics`** — kind / visibility / pinned / status, author snapshot,
  denormalized `post_count` + `last_post_at`, and `node_id` reserved for the
  Phase 3 shadow ingestion node.
- **`forum_posts`** — flat chronological, `author_kind` `member|owner|agent`;
  agent rows mirror `team_messages` (agent/model/trace + durable `pending`
  bubble). **Deliberately unlike `team_messages`: `contact_id` is SET NULL**
  with `author_name` as the durable snapshot — forum content is team
  knowledge and outlives its author; revoking a member kills access, not
  history. `kind` + `source_request_task_id` are the Phase 2 request-flag
  columns, present from day one.
- **`forum_read_cursors`** — per-READER unread cursors (`reader_id` =
  contact id, or the owner's id); unread counts exclude the reader's own
  posts.
- **`forum_uploads`** (migration 0126) — the file-upload review queue.
  Lifecycle `staged` → `pending` (bound to a post in the post's own tx) →
  `filed` (owner moved it into `files/review/<topic>/`, `node_id` set,
  ingestion fired) | `dismissed`. Bytes live in the QUARANTINE
  (`${MANTLE_DATA_DIR}/forum-uploads/<owner>/<blobId>`, a sibling of the
  files root — outside the ltree, so nothing ingests until filed). The
  post's `attachments` jsonb references blobs by `fileId`; this row is the
  mutable review state. `contact_id` SET NULL, `topic_id`/`post_id` CASCADE.
  A reconcile pass (`apps/web/lib/forum-quarantine.ts`, fired opportunistically
  from the upload route and the owner review load) sweeps stale staged rows
  and reclaims orphaned bytes.

## 6. Cost & access controls

One shared daily budget covers the whole team surface: team-chat turns +
forum posts count against `TEAM_CHAT_DAILY_TURNS` (default 100/contact/day)
— moving the conversation from chat to forum must not double the budget.
Posts are burst-limited per contact (6/min). **Uploads** have their own burst
limit (10/min), a hard body-size ceiling checked before the multipart body is
buffered, and a per-member daily BYTE budget (`TEAM_UPLOAD_DAILY_BYTES`,
default 100 MB) enforced atomically under an advisory lock. Every action lands
in `team_access_log` (`detail.surface` = `forum` / `forum-uploads` /
`forum-attachment`), and denials log as `denied`. Auth is the standard team
gate: cookie or bearer token, liveness re-checked every request. Byte serving
(member + owner) always goes through `safeDownloadHeaders` (stored-XSS
defense) and supports Range.

## 7. Phases (plan §5)

Phase 1 (this doc) ships the forum core. **P4 attachments SHIPPED**
(v0.143.0, migration 0126 — see §5 `forum_uploads`): member uploads stored in
quarantine, NOT auto-ingested, owner promotes to the brain via the Requests
tab's Uploads queue (Move to files → `files/review/<topic>/`) or dismisses.
The agent sees filenames only. Still to come: **P2** review bridge (composer
kind flags file the owner task; `notifyTeamRequester` delivers the owner's
reply into the originating topic), **P3** brain ingestion (shadow
`forum_topic` nodes, debounced reindex, facts from human posts only, private
topics never ingested — see the scope note in
[team-chat.md](team-chat.md) §7), **P5** forum hierarchy inline in the
Requests tab.
