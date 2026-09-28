# Team Forum: shared topic threads

> **Status: RETIRED (member logins Phase 6, 2026-09-28).** Team contacts
> became member logins through invites ([member-logins.md](./member-logins.md)
> section 9); a member chats with the team agent from their own login. The
> forum was first closed to writes (section 8), then its code was deleted:
> every `/api/team/forum/**` route and `/team/forum` (which now redirects to
> `/login`), the admin forum routes (`forum/pin`, `forum/post`,
> `forum/topics/[id]/read`, `forum/uploads/[id]/{dismiss,download,file}`,
> `/api/team-admin/topics`), the turn runner (`runForumTurn`, the
> `forumTurnWorkflow` workflow, the `mantle_forum` queue) and the forum
> modules of `@mantle/content`. Its content lives on as the admin-level
> **Forum archive** pages (section 8); the forum tables and the export stay
> until the tables are dropped. The rest of this document describes the forum
> as it ran.

The Forum is the team's shared conversation surface at `/team/forum`, the
successor to the per-member 1:1 Team Chat (removed 2026-09-26; the owner
still sees old transcripts as the "Chat archive" in `/team-admin`). A member creates a **topic**; the
team responder answers; the thread continues, and **every team member can
read every `team` topic**. Plan of record: "PLAN: Team Forum" (dev brain page
71601ba2, signed off 2026-07-17). This document covers Phase 1 (forum core).

> **Topology (v0.200 member carve):** the `/team` UI (forum included) is served
> by the **client app** (`jackdaw`); the data plane stays `/api/team/*` on
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
`review` / `feature` / `bug`, the request flags, wired to the review queue in
Phase 2), a **visibility** (`team` = whole team; `private` = author + owner
only), an owner-only **pinned** flag (the announcement mechanism, pinned
topics float to the top of everyone's list), and a **status**
(`open`/`answered`/`closed`). Every member post normally triggers a durable
agent turn answered into the thread; a per-post "no answer needed" toggle
(defaulted ON in `discussion` topics) waves the agent off. The same
`team-responder` agent serves both surfaces under the same trust posture:
read-anything / write-nothing except `team_request_create`.

## 2. Surfaces

| Surface                   | Who     | What                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/team/forum`             | members | Topic list (pinned first, unread dots, kind badges) + "New topic" dialog.                                                                                                                                                                                                                                                                                                                                                                     |
| `/team/forum/[id]`        | members | Linear multi-author transcript + composer; live turn streaming.                                                                                                                                                                                                                                                                                                                                                                               |
| `/team-admin?view=topics` | owner   | All topics (incl. private), master-detail transcript with trace links, pin/unpin, owner reply (optionally marking the topic answered).                                                                                                                                                                                                                                                                                                        |
| `/team-admin` (Members)   | owner   | The same content read PERSON-first: one member's posts each paired with the answer it drew, the topics they started, the requests they filed. Backed by `listForumMemberActivity` / `listForumPostsByContact` / `listForumTopicsByAuthor` (`packages/content/src/forum/members.ts`), owner-scoped queries with **no visibility filter**, since the owner sees private topics too. Do not reuse them member-facing without `visibleTopicCond`. |

## 3. Turn pipeline

`runForumTurn` (`packages/runtime/src/assistant/run-forum-turn.ts`) is a
sibling of `runTeamTurn` sharing the unified `assemble-turn`/`responder-loop`
core, with three deliberate differences:

1. **The member's post is persisted by the route** (it must appear to every
   member instantly); the workflow (`forumTurnWorkflow`, DBOS, shared `mantle`
   queue) receives `topicId` + `inboundPostId` and owns only the answer.
2. **History is the topic transcript, multi-author**: member/owner posts
   become name-prefixed user turns (consecutive ones coalesced, strict-
   alternation providers reject back-to-back user messages); agent posts are
   assistant turns. The volatile block carries a "Forum topic" line telling
   the model it speaks to a room. Isolation invariants are identical to team
   chat: no persona notes, no digests, no owner identity/journal; private
   reads stripped unless the owner's pref allows.
3. **Serial-per-topic**, enforced by the DB: a partial unique index allows at
   most one `pending` agent post per topic; a concurrent turn's insert
   conflicts and retries with backoff, and a stale-pending sweep (15 min)
   guarantees an abandoned turn can never wedge a topic.

Turn ids ride the `team-<contactId>.<nonce>` namespace of the retired chat, so
`/api/team/turn/[turnId]/stream` (SSE, full status labels) serves forum turns,
with the same cross-member isolation. The path keeps its old name until the
forum retires.

## 4. Surface provenance

The tool loop runs under `surface: { kind: 'forum', contactId, topicId,
inboundPostId }`. `team_request_create` accepts `team` and `forum` surfaces
and additionally stamps `data.teamRequest.{topicId, postId}` on forum
requests, the hook Phase 2's round-trip (owner reply → posted back into the
topic) hangs off. Owner-side tools (`team_chat_*`, `team_access_list`) refuse
both team surfaces.

## 5. Data model (migration 0123)

- **`forum_topics`**: kind / visibility / pinned / status, author snapshot,
  denormalized `post_count` + `last_post_at`, and `node_id` reserved for the
  Phase 3 shadow ingestion node.
- **`forum_posts`**: flat chronological, `author_kind` `member|owner|agent`;
  agent rows mirror `team_messages` (agent/model/trace + durable `pending`
  bubble). **Deliberately unlike `team_messages`: `contact_id` is SET NULL**
  with `author_name` as the durable snapshot; forum content is team
  knowledge and outlives its author; revoking a member kills access, not
  history. `kind` + `source_request_task_id` are the Phase 2 request-flag
  columns, present from day one.
- **`forum_read_cursors`**: per-READER unread cursors (`reader_id` =
  contact id, or the owner's id); unread counts exclude the reader's own
  posts.
- **`forum_uploads`** (migration 0126): the file-upload review queue.
  Lifecycle `staged` → `pending` (bound to a post in the post's own tx) →
  `filed` (owner moved it into `files/review/<topic>/`, `node_id` set,
  ingestion fired) | `dismissed`. Bytes live in the QUARANTINE
  (`${MANTLE_DATA_DIR}/forum-uploads/<owner>/<blobId>`, a sibling of the
  files root, outside the ltree, so nothing ingests until filed). The
  post's `attachments` jsonb references blobs by `fileId`; this row is the
  mutable review state. `contact_id` SET NULL, `topic_id`/`post_id` CASCADE.
  A reconcile pass (`server/web/lib/forum-quarantine.ts`, fired opportunistically
  from the upload route and the owner review load) sweeps stale staged rows
  and reclaims orphaned bytes.

## 6. Cost & access controls

One shared daily budget covers the whole team surface: team-chat turns +
forum posts count against `TEAM_CHAT_DAILY_TURNS` (default 100/contact/day)
, moving the conversation from chat to forum must not double the budget.
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
(v0.143.0, migration 0126, see §5 `forum_uploads`): member uploads stored in
quarantine, NOT auto-ingested, owner promotes to the brain via the Requests
tab's Uploads queue (Move to files → `files/review/<topic>/`) or dismisses.
The agent sees filenames only. Still to come: **P2** review bridge (composer
kind flags file the owner task; `notifyTeamRequester` delivers the owner's
reply into the originating topic), **P3** brain ingestion (shadow
`forum_topic` nodes, debounced reindex, facts from human posts only, private
topics never ingested, see the scope note in
[team-chat.md](team-chat.md) §7), **P5** forum hierarchy inline in the
Requests tab.

## 8. Closed, and the Forum archive (Phase 6)

**Writes were closed** (stage 4; since stage 5 the routes are gone and
answer 404, or 401 without a session). A new topic (`POST /api/team/forum/topics`), a reply
(`POST /api/team/forum/topics/[id]/posts`), a staged upload
(`POST /api/team/forum/uploads`) and the admin's post
(`POST /api/team-admin/forum/post`) answer, once the caller's credential
resolves (an anonymous caller still gets its 401):

```json
{
  "error": "The team forum is closed. …",
  "reason": "forum-closed",
  "inviteHint": "Ask the brain admin for an invite link: …"
}
```

with status 410 (`server/web/lib/forum-closed.ts`, deleted in stage 5).
`enqueueForumTurn` threw `ForumClosedError`, so no path started a new forum
turn; a turn already
queued before the freeze ran to completion.

**The archive.** `exportForumArchive`
(`packages/content/src/forum/export.ts`) freezes the forum into pages:

- One **"Forum archive"** page, and under it one page per topic, private
  topics included. The page is admin level (the default for a new item), so
  only admins see it. A topic page lists every post in order: the author's
  name and kind (member, owner, agent), the time (UTC), the body as it was
  written (markdown), and for an agent reply the agent's name, its model and a
  `/traces/<id>` link. Attachments are links (mention chips) to their file
  nodes; an upload the admin dismissed, or whose bytes were gone, is named
  without a link.
- **Uploads nobody reviewed** (`staged` or `pending`) are filed into
  `files/review/forum-archive` (flagged metadata-only: indexed by name, type
  and folder, the content is never read) and linked from their post; the
  `forum_uploads` row flips to `filed`. One whose quarantine bytes are gone
  stays as it was and is named in the page and the dump. The quarantine
  (`forum-uploads/`, a sibling of the files root) is not a bind mount in
  `docker-compose.yml`, so on a box the bytes of an unreviewed upload do not
  survive a container recreate; expect most of them to be gone there.
- **One JSON dump** of the whole forum (topics, posts, uploads, request
  tasks) at `files/archive/forum-<date>.json`, metadata-only.
- A **request task** filed from a topic (`data.teamRequest.topicId`) gets
  `data.teamRequest.archivePageId`.

**Nothing is indexed, nothing spends.** Archive pages carry
`data.source = 'forum-archive'`. The node insert trigger still announces each
page on `node_ingested`, but the extractor's admission gate refuses it before
any pass (disposition `extract_exempt`: no summary, embedding, chunks or
facts), and the boot drain and the missed-event sweep leave it out
(`isExtractExempt` / `unextractedNodeConds` in
`packages/db/src/extract-exempt.ts`). The filed uploads and the dump are
metadata-only: no LLM, one local spine embedding each. The export itself calls
no model and no embedder. So search and the agents never read the archive
pages; an admin reads them in Pages.

**Idempotent.** `forum_topics.node_id` (reserved since migration 0123, unused
until now) is the per-topic done-marker. A run adopts what an interrupted run
left (a topic page by its topic id, a filed upload by its upload id), so
running it again creates nothing. A topic with an agent reply still pending is
deferred to a later run. A transaction-scoped advisory lock keeps two runs
apart; the second one answers `busy`.

**Who runs it.** Both call the same function:

| Trigger                             | What                                                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api server boot                     | `server/api/src/forum-archive-boot.ts`: at every start, one count query; the export runs only while a topic has no page. Never blocks boot, never throws                                                         |
| `GET /api/team-admin/forum/export`  | Admin only. `{ unexported }`: topics with no page yet                                                                                                                                                            |
| `POST /api/team-admin/forum/export` | Admin only. 200 with `{ status: 'done', exported, deferred, alreadyExported, archivePageId, dumpFileId, uploadsFiled, uploadsMissing, tasksLinked }`; 409 `{ error, reason: 'busy' }` while a run holds the lock |

**Showing a page to the team, by hand.** The archive stays admin level on
purpose: private topics sit next to team ones. To share one topic page, an
admin opens it in Pages and sets its level in the Access control (or
`PATCH /api/access/nodes/<page id>` with `{ "audience": "team" }`, or
`access_set` from the assistant; see [access-levels.md](./access-levels.md)
section 4). Check the page first: a private topic's page carries "Private
topic" in its first line. Lowering a page does not lower the files it links
(no inheritance, and a mention chip is not part of the page's closure): set
each file's level the same way if the team should open it. The page stays out
of the brain either way: its level decides who may open it, not whether it
is indexed.

**Tests.** `packages/content/src/forum/export.db.test.ts` (Postgres: two runs,
no duplicates, the cost checks, the lock, deferral, adoption and the
stale-reply sweep),
`server/web/app/api/team-admin/forum/export/export-route.test.ts`,
`server/api/src/forum-archive-boot.test.ts`,
`server/api/src/workflows/forum-turn-retired.test.ts` and
`forum-turn-retired.db.test.ts` (the stub), and the `extract_exempt` case in
`server/api/src/agent/extract/gates.test.ts`.

**Deleted (stage 5).** The routes, the turn pipeline and the content code
went; the export (`export.ts`), its boot task and `GET/POST
/api/team-admin/forum/export` stay while the tables do. Two things keep an
upgrade clean:

- **A forum turn still queued or in flight** when a box upgrades has no
  runner. `server/api/src/workflows/forum-turn-retired.ts` registers a no-op
  under the old name (`forumTurnWorkflow`): it fails that topic's pending
  agent reply, runs the archive boot task, and ends in SUCCESS. Without it
  DBOS finds no function for the name and the turn stays PENDING, retried on
  every boot. The `mantle_forum` queue is no longer registered; its row in the
  DBOS system database persists on a box that had it, so the queue runner
  still dispatches a leftover turn into the stub
  (`forum-turn-retired.db.test.ts` proves it on a real DBOS).
- **A pending reply nothing will finish.** The export fails an agent reply
  pending for more than 15 minutes (`STALE_REPLY_MS`, the old runner's
  stale-pending sweep) before it looks for topics to defer, so such a topic is
  archived with "This reply failed" instead of being deferred for good.

The archive pages, filed files, dump and task links stay.
