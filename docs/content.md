# Notes, Tasks, Events

> Three small content surfaces that share a shape. Notes are markdown,
> tasks have status / priority / due, events have start time + reminders.
> All three ride on the `nodes` table, all three flow through the
> extractor, and all three are addressable from MCP so the assistant can
> create / update / delete them on your behalf.
>
> For richer, structured documents (callouts, columns, tables, embeds) see
> the heavier [`pages.md`](./pages.md) surface, a TipTap editor with a
> draft/commit model. Notes remain the lightweight markdown quick-capture.
> For first-person self-knowledge (who you are, how you feel) that also feeds
> the assistant's always-on identity context, see [`journal.md`](./journal.md)
> , a fourth `nodes.data` sibling that rides this same shape.
>
> Any of the three can be shared read-only via a public link (`/s/[token]`),
> see [`sharing.md`](./sharing.md).

---

## 1. Why one doc

The three are 80% the same. Each is:

- A `nodes` row with a specific `type` (`note`, `task`, `event`).
- A jsonb `data` blob carrying the type-specific fields.
- A lazy-created top-level ltree branch (`notes`, `tasks`, `events`).
- Indexed by the extractor on insert + on every meaningful update.
- Exposed via REST (`/api/{notes,tasks,events}`), a web UI (`/notes`,
  `/tasks`, `/events`), and MCP tools (`{note,task,event}_{list,get,
create,update,delete}`).

All the shared logic lives in `packages/content/`. Web + MCP both import
from there.

---

## 2. Shapes

### Notes (`type='note'`)

```ts
data = {
  content: string,    // markdown body
  // extractor adds:
  summary?: string,
  summary_model?: string,
  summary_at?: string,
  entities?: ExtractedEntity[],
}
```

The editor renders content as Markdown + GFM (tables, strikethrough,
task lists). Search is substring against title / body / summary.

### Tasks (`type='task'`)

```ts
data = {
  body?: string,
  status: 'open' | 'in_progress' | 'blocked' | 'done',
  priority: 'low' | 'normal' | 'high',
  due_at?: string,    // ISO timestamp
  todos?: [{ id, text, done }],  // checklist inside the task (≤100 × ≤500 chars)
  rank?: string,      // fractional board-order key (packages/content/src/rank.ts)
  archived_at?: string,  // ISO timestamp; absent while the task is live
}
```

**Archive is orthogonal to status.** An archived task keeps the status it
had — it is "filed away", not a fifth lifecycle state. `taskConds` excludes
archived rows from **every** list and count unless the caller passes
`archived: 'only' | 'all'`, which is the single door that keeps a Done
column from growing without bound (`GET /api/tasks?archived=only|all`,
`task_list`'s `archived`). `PATCH` and `task_update` take a boolean
`archived` and the SERVER stamps the timestamp, so a client cannot backdate
it. Archiving is metadata: like rank and tags it is deliberately absent from
`updateTask`'s `contentChanged` check, so filing a thousand finished tasks
away costs zero embeddings and zero LLM calls.

List sort order is not-done first, then `rank` ascending (nulls last —
board order carries into the list), then `due_at` ascending (nulls
last), then `updated_at` descending. The `/tasks` screen is
**master-detail** (see `jackdaw/docs/ui-style-guide.md` §8)
plus a **Kanban board** view (one column per status; a drag PATCHes
`{status, rank}` — rank/tags-only edits deliberately do NOT re-index,
so a drag can never trigger an LLM pass). Search, filters, and
pagination are URL-driven (SSR), same for `/events` and `/secrets`, via
`listTasks`/`countTasks` (and the `events`/`secrets` equivalents) with
`limit`/`offset`. `GET /api/tasks` takes `pageSize` (≤500) so the board
loads every column in one call; `status=active` = every not-done state
(the list default in the client); unknown `status`/`priority` filter
values are a 400, not a silent widen.

**Comments** are removed on 2026-10-09: the brain has no comment threads any more; user-to-user talk moves to the forum (dev-brain plan Forum v2). The `node_comments` table and its rows stay (no destructive migration), unread and unwritten. Every comment route, the agent tools
`task_comments_list` / `task_comment_add` (their tool rows are disabled by
the boot reconcile, `RETIRED_BUILTIN_TOOL_SLUGS`) and the realtime `comment`
event are gone. Progress on a task goes in its body (`task_update`).
`TaskRow.commentCount` stays on every row, always 0, so an older UI still
renders.

### Events (`type='event'`)

```ts
data = {
  body?: string,
  starts_at: string,         // ISO
  ends_at?: string,
  location?: string,
  remind_minutes_before: number,
  remind_at: string,         // computed = starts_at - n minutes
  reminder_sent_at?: string, // set by the worker on delivery
}
```

`remind_at` is denormalised so the worker's hot query is a simple
indexed range scan. Editing `starts_at` or `remind_minutes_before`
recomputes it and clears `reminder_sent_at` if the new fire time is
still in the future, so moving a meeting an hour later automatically
re-arms the reminder.

The `/events` screen is **master-detail** with a **live countdown hero**
(a theme-token progress ring that fills as the event nears, ticking
d/h/m/s; a pulsing "Happening now" + through-the-event bar while it runs;
a muted "ended" after) and a day-grouped list (Today / Tomorrow / This
week / Later / Past) with live relative-time badges. Each event has an
**Add to calendar (.ics)** button, and date entry uses the shadcn
`DateTimePicker` (calendar popover + time), not the native control. The
live-time helpers are pure + tested in [`packages/client-types/src/lib/event-time.ts`].

---

## 3. Extractor handoff

All three are in `DEFAULT_EXTRACT_TYPES` in
`server/api/src/agent/extractor.ts`. The default body resolution is:

- **note**: `data.content`, the markdown verbatim.
- **task**: title + `Status:` + `Priority:` + `Due:` + body. Surfaces
  the structured metadata so a summary can say _"OPEN, due tomorrow:
  ship the events feature"_ instead of just the title.
- **event**: title + `Starts:` + `Ends:` + `Location:` + body. Same
  reason, the assistant searching for "meeting with Alex on Tuesday"
  needs to find the row by its date.

Every meaningful edit (title, body, status, priority, due, starts_at,
…) re-indexes the item through `markContentChanged`, which clears
`summary` / `summary_model` / `summary_at` / `entities` with the vector and
announces it on `node_ingested` so the extractor re-runs. A note's title
only re-embeds. What every kind's fields re-index is the table in the next
section.

---

## 3a. Re-index after a write (every kind)

One call re-indexes an item after a write (workspaces arch A10 #7):
`markContentChanged(tx, node, changedFields)` in
`packages/db/src/content-changed.ts`. The service calls it inside the
write's own transaction, after the write, naming the fields it changed
(`changedFields` compares old and new by value, so a save that sends a
field back unchanged changes nothing). The kind registry's `indexed` field
(`packages/client-types/src/kinds.ts`) says what each field feeds, and the
most work any changed field asks for is done once:

| Work      | What the reset leaves                                                                       | What the extractor does                                                                                                                                                                                                                                           | Cost                                                    |
| --------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `embed`   | the vector cleared, the summary and the completion marker kept, `data.index_work = 'embed'` | `embed_only` step (`server/api/src/agent/extract/gates.ts`): the vector from the title and the kept summary; with no summary, from the title and the text read locally; a table keeping its summary reuses it in the model step and rebuilds its profile passages | one embedding on the local embedder, never a model call |
| `extract` | the vector and the four summary keys cleared, `data.index_work = 'extract'`                 | the whole pass: summary, vector, passages, facts, entities                                                                                                                                                                                                        | one model call                                          |
| none      | nothing                                                                                     | nothing (not announced)                                                                                                                                                                                                                                           | nothing                                                 |

There is no summary-only pass: the summary and the facts come from one
model call.

**The work stamp.** The reset stamps the work it asks for on the row,
`data.index_work` (`INDEX_WORK_KEY`), and the extractor's gate reads the
stamp, not the shape of the row (`embedWork` in `gates.ts`). One module sets,
reads and drops it, `packages/db/src/index-work.ts`, and it holds the one
meaning of "a summary" every reader and writer uses (`hasSummary`, and
`hasSummarySql` for the same test in SQL): a string with something other than
whitespace in it. An empty summary (`summary: ''`, written when a model reply
was not JSON) is no summary. markContentChanged is the only code that sets the
stamp (`packages/db/src/edit-check.test.ts` holds every other product file to
not spelling the key). An `embed` stamp is never a model call, whatever else
the row holds:

- with a summary (with the completion marker, or an item extracted before
  the marker existed): the vector from the title and that summary;
- a table keeping its summary: admitted before the key pre-flight, and the
  model step reuses the summary and rebuilds its profile passages (no model
  call, so no key or chat adapter is needed: a rename on a box whose cloud
  extractor key is missing still gets its vector); one that no workspace with
  an assistant reads gets the cost guard's local index instead, as before;
- with no summary, on an item indexed before (a terminal skip, such as a page
  too short to summarise, a completed pass, or a vector the reset cleared,
  which the stamp records as `index_work_had_vector`): the vector from the
  title and the text read locally (a file: its name spine; its bytes are not
  parsed again);
- with no summary on an item never indexed (renamed before its first pass
  ran): its first pass runs, as it would have without the rename.

An `extract` stamp is never downgraded: a rename that lands while a content
change still waits for its pass keeps `extract`, so the new content is still
summarised. The extractor drops the stamp when it has done the work (the
summary write, the re-embed, a terminal skip, the local index), and only the
stamp the job read: a content change that lands while a job ends in a
terminal skip keeps its `extract` stamp for its own job. (A second `extract`
stamp over the one the job read cannot be told apart and is dropped; that
change's own job still runs its whole pass.) The summary write reads the
stamp in the same select as the row version (xmin) its write is guarded on,
not when the job was admitted: a content change that commits while the body
is read lands before that select, the write then answers it, and the
change's own job skips as already extracted, as before the stamp. The gate
never skips an `extract` stamp as already extracted, whatever else the row
holds; the pass it runs drops the stamp, so the next notify skips. The re-embed lands
only while the row still has the title and the summary it was made from, so a
job for an older title never writes over a newer rename. A table's cell
commit is `cells` (`embed`) only when the table has a summary to keep; a
table with no summary, or an empty one, runs the whole pass on a commit, as
before.

A conversation digest and a chat archive note are authored summaries the
extractor never reads: their vector comes from their topic and summary
(`digestEmbedText`), so a rename of one names no field and keeps the vector.
If one has no vector (a hand edit cleared it), the gate rebuilds it from the
topic and summary on the embedder before its terminal skip.

**What a title costs while it is typed.** The editors save a title on a
pause (a page's meta after 1 s, a table's after 800 ms, a drawing's on its
own pause), so each pause is one rename: one `embed_only` trace row and one
embedding. On the bundled local embedder that embedding is free; on a box
configured with a cloud embedder it is one embedding call per pause (a
fraction of a cent each, never a model call).

The announcement is a `pg_notify` on the write's transaction, so it is
delivered when the write commits and dropped when it rolls back. A
personal-space write and a quiet create are never announced. A re-signal of
an item nothing changed (the `extract_reindex` tool, the OCR re-scan, the
docs re-index) is `resignalNode`. Nothing else announces an item, clears its
vector or drops its summary by hand: `eslint-rules/no-hand-reindex.mjs`
refuses it, and the scoreboard pins `reindexNotifyCalls`,
`reindexEmbeddingResets` and `reindexSummaryClears` at 0 outside the files
it names with their reason (the gateway, the Recall prompt vectors, three
hand-run operator backfills).

**The indexed fields.** A field not listed for a kind feeds no index.

| Kind          | `extract`                                                   | `embed`                                     | No re-index                                            |
| ------------- | ----------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| note          | content                                                     | title                                       | tags                                                   |
| page          | doc (a commit, or a doc written through PATCH)              | title                                       | look (icon, visibility, width), tags                   |
| table         | schema (a commit that changed the shape, or the first)      | title, cells (a commit that kept the shape) | look, tags                                             |
| draw          | scene (a commit)                                            | title                                       | look (icon, visibility, description), tags             |
| journal       | body                                                        | title                                       | kind, entry_date, tags                                 |
| formula       | spec                                                        | title                                       | tags                                                   |
| location      | body, address                                               | title                                       | coordinates, source, tags                              |
| file          | content (new bytes), indexing (the mode flips)              | title (a rename)                            | tags                                                   |
| task          | title, body, status, priority, due_at, todos, reviewed      |                                             | archived_at, rank, tags                                |
| event         | title, body, starts_at, ends_at, location                   |                                             | recur, remind, timezone, tags                          |
| contact       | first_name, last_name, company, emails, description         |                                             | country_code, cell, tags                               |
| secret        | title, description, kind, tags                              |                                             | sealed (the note and fields never reach the extractor) |
| documentation | content (a docs sync)                                       |                                             |                                                        |
| app           | source (a publish, a restore, an install with a live build) |                                             |                                                        |

A task's or an event's title stays `extract`: the title is part of the body
their summary reads. A secret's tags stay `extract`: its index is its
metadata alone. Turning a field to `extract` makes every save of it a model
call: a cost decision, never a tidy-up.

**What A10 #7 changed** (each cell named in
`server/web/server/a10-content-changed.changes.json`, the matrix recorded on
main in `a10-content-changed.main.json`):

- A rename re-embeds a note, a journal entry, a formula, a location, a
  drawing, a page, a table and a file (before: nothing, so search and recall
  kept the old title). Cost per rename: one local embedding, no model call.
- A save that sends an event's, a location's, a secret's or a formula's
  fields back unchanged re-indexes nothing (before: a model pass per save).
- The page PATCH `reindex: false` flag is accepted and ignored: a doc
  written through PATCH is indexed like a commit. It once left the index on
  the old doc and pointed at a `POST .../reindex` route that never existed;
  no client sends it.
- A file whose indexing mode flips drops its summary and vector at once, so
  a file turned name-only stops answering from its content now. Same work
  as before: one extractor pass.
- A reused summary (a table's cell commit or new title) keeps the relation
  edges its own pass made; the extractor used to rebuild them from an empty
  list and drop them.
- A table that reuses its summary needs no extractor key or chat adapter:
  on main the reuse ran after the key pre-flight, so a missing cloud key
  left a cell commit unindexed.

**Follow-up in jackdaw.** The dev-tools catalog text that describes what a
write re-indexes lives in the frontend repo (crossworks-engineering/jackdaw)
and still describes main before A10 #7; it should be brought in line with
this section (a rename re-embeds, never a model call).

**The boot drain stays.** The extractor's boot drain and periodic sweep
(`server/api/src/agent/runtime.ts`) re-queue recently written items with no
vector. Before A10 #7 every one of the 23 hand notify calls ran after its
write had committed, on its own connection, best effort (a failed notify was
only logged): a crash or a failed notify between the two left an item reset
and unannounced, and only the drain found it. That window is closed (the
announcement commits with the write). The drain is still the net for
announcements sent while the agent was down (a docs sync at web boot during
a roll, a calendar sync) and for migrations that clear vectors in bulk.

---

## 4. The reminder worker

`server/web/workers/events-reminders.ts`. Runs as the `events` lane in
`pnpm dev`. Loop:

```
every 30s:
  for ownerId in (distinct owner_id from nodes where type='event'):
    due = events where remind_at <= now() AND reminder_sent_at is null
    target = first allowed private telegram_chats for this owner,
             ordered by last_message_at desc, joined to enabled account
    if no target: log + skip (will retry next tick)
    for evt in due:
      try sendMessage(account, chatId, "⏰ Reminder: {title} …")
          markReminderSent(evt.id)
      catch: log; leave reminder_sent_at null; retry next tick
```

**Why a poll loop, not pg-boss schedule**: state lives in the DB
already (`remind_at` + `reminder_sent_at`); a restart loses nothing.
30s granularity is good enough for human-scale meetings. If you move
a meeting earlier, the next tick picks up the new `remind_at`
automatically, no schedule to cancel + re-enqueue.

**At-least-once delivery**: we mark sent _after_ the Telegram API
call returns. If the worker crashes between send + mark, the next
tick re-sends. Single-user, low-traffic; duplicate reminders are
better than missed ones.

**No target chat?** If no allowed private Telegram chat exists for
the owner (you haven't paired one yet), the worker logs a warning
and leaves the row untouched. Pair a chat via the responder's Telegram
section under `/settings/agents` and the next tick will drain the backlog.

---

## 5. The MCP surface

The assistant in Claude Desktop can drive all three end-to-end via
the new tools (server/mcp/src/server.ts):

| Surface | Tools                                                                     |
| ------- | ------------------------------------------------------------------------- |
| notes   | `note_list`, `note_get`, `note_create`, `note_update`, `note_delete`      |
| tasks   | `task_list`, `task_get`, `task_create`, `task_update`, `task_delete`      |
| events  | `event_list`, `event_get`, `event_create`, `event_update`, `event_delete` |

Typical flows the assistant can now do without any custom plumbing:

- _"Remind me of my meeting at 10am"_ →
  `event_create({title: 'meeting', startsAt: '…T10:00:00…', remindMinutesBefore: 0})`.
  The reminder fires at 10am, the worker pings your Telegram DM.
- _"Add a task to renew my passport, due end of month, high priority"_ →
  `task_create({title: 'renew passport', priority: 'high', dueAt: '…'})`.
- _"What notes do I have about the printer project?"_ →
  `searchNodes` (semantic) brings back the relevant note rows; the
  assistant follow-ups with `note_get` for full content.
- _"Mark the secrets feature task as done"_ → `task_list` (find it),
  then `task_update({id, status: 'done'})`.

Same owner-scoping as the rest of the MCP surface
(`OWNER_ID = process.env.ALLOWED_USER_ID`).

---

## 6. Known sharp edges

- **No recurring events.** Every event is a single instance. If you
  have a weekly meeting, create seven events, or add recurrence in a
  later cycle.
- **One reminder per event.** Single configurable lead time. No
  "remind me 1 day before AND 1 hour before".
- **No timezone display.** All times render in the browser's local
  TZ; date entry is the shadcn `DateTimePicker` (calendar + time, naive
  local). The DB stores UTC ISO.
- **No two-way calendar sync.** Events offer a one-shot **.ics**
  "Add to calendar" (per-event in the detail, and on shared events), but
  there's no Google/CalDAV bridge, events live in Mantle.
- **Reminder target is whichever DM you last spoke in.** Multi-bot
  setups would want per-event override; we picked the recommended
  default for simplicity.
