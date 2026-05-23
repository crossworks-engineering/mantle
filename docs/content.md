# Notes, Todos, Events

> Three small content surfaces that share a shape. Notes are markdown,
> todos have status / priority / due, events have start time + reminders.
> All three ride on the `nodes` table, all three flow through the
> extractor, and all three are addressable from MCP so the assistant can
> create / update / delete them on your behalf.
>
> For richer, structured documents (callouts, columns, tables, embeds) see
> the heavier [`pages.md`](./pages.md) surface — a TipTap editor with a
> draft/commit model. Notes remain the lightweight markdown quick-capture.

---

## 1. Why one doc

The three are 80% the same. Each is:

- A `nodes` row with a specific `type` (`note`, `task`, `event`).
- A jsonb `data` blob carrying the type-specific fields.
- A lazy-created top-level ltree branch (`notes`, `todos`, `events`).
- Indexed by the extractor on insert + on every meaningful update.
- Exposed via REST (`/api/{notes,todos,events}`), a web UI (`/notes`,
  `/todos`, `/events`), and MCP tools (`{note,todo,event}_{list,get,
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

### Todos (`type='task'`)

```ts
data = {
  body?: string,
  status: 'open' | 'done',
  priority: 'low' | 'normal' | 'high',
  due_at?: string,    // ISO timestamp
}
```

List sort order is `open` first, then `due_at` ascending (nulls last),
then `updated_at` descending. The list page has inline status toggle
(click the checkbox) and a row-expand that lets you change priority +
due-date without leaving the page.

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

---

## 3. Extractor handoff

All three are in `DEFAULT_EXTRACT_TYPES` in
`apps/agent/src/extractor.ts`. The default body resolution is:

- **note**: `data.content` — the markdown verbatim.
- **task**: title + `Status:` + `Priority:` + `Due:` + body. Surfaces
  the structured metadata so a summary can say *"OPEN, due tomorrow:
  ship the events feature"* instead of just the title.
- **event**: title + `Starts:` + `Ends:` + `Location:` + body. Same
  reason — the assistant searching for "meeting with Alex on Tuesday"
  needs to find the row by its date.

Every meaningful edit (title, body, status, priority, due, starts_at,
…) clears `summary` / `summary_model` / `summary_at` / `entities` and
fires `pg_notify('node_ingested', id)` so the extractor re-runs.

---

## 4. The reminder worker

`apps/web/workers/events-reminders.ts`. Runs as the `events` lane in
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
automatically — no schedule to cancel + re-enqueue.

**At-least-once delivery**: we mark sent *after* the Telegram API
call returns. If the worker crashes between send + mark, the next
tick re-sends. Single-user, low-traffic — duplicate reminders are
better than missed ones.

**No target chat?** If no allowed private Telegram chat exists for
the owner (you haven't paired one yet), the worker logs a warning
and leaves the row untouched. Pair a chat via `/settings/senders`
and the next tick will drain the backlog.

---

## 5. The MCP surface

The assistant in Claude Desktop can drive all three end-to-end via
the new tools (apps/mcp/src/server.ts):

| Surface | Tools                                                            |
|---------|------------------------------------------------------------------|
| notes   | `note_list`, `note_get`, `note_create`, `note_update`, `note_delete` |
| todos   | `todo_list`, `todo_get`, `todo_create`, `todo_update`, `todo_delete` |
| events  | `event_list`, `event_get`, `event_create`, `event_update`, `event_delete` |

Typical flows the assistant can now do without any custom plumbing:

- *"Remind me of my meeting at 10am"* →
  `event_create({title: 'meeting', startsAt: '…T10:00:00…', remindMinutesBefore: 0})`.
  The reminder fires at 10am, the worker pings your Telegram DM.
- *"Add a todo to renew my passport, due end of month, high priority"* →
  `todo_create({title: 'renew passport', priority: 'high', dueAt: '…'})`.
- *"What notes do I have about the printer project?"* →
  `searchNodes` (semantic) brings back the relevant note rows; the
  assistant follow-ups with `note_get` for full content.
- *"Mark the secrets feature todo as done"* → `todo_list` (find it),
  then `todo_update({id, status: 'done'})`.

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
  TZ; UI input is `datetime-local` (naive). The DB stores UTC ISO.
- **No calendar import / sync.** No iCal export, no Google Calendar
  bridge. Events live only in Mantle for now.
- **Reminder target is whichever DM you last spoke in.** Multi-bot
  setups would want per-event override; we picked the recommended
  default for simplicity.
