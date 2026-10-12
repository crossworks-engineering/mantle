# Team Forum (retired)

The team forum is gone (member logins Phase 6, 2026-09-28). Its routes,
its turn runner and its modules were deleted, and migration 0177 dropped
its tables. Users now chat with each workspace's assistant in their own
thread: [workspaces.md](./workspaces.md), "Assistants and chats".

## The Forum archive

Before the tables were dropped, the forum was frozen into pages:

- One **"Forum archive"** page in the Admin workspace, and under it one
  page per topic, private topics included. A topic page lists every post
  in order: the author's name and kind, the time (UTC), the body, and for
  an agent reply the agent's name, its model and a `/traces/<id>` link.
- Uploads nobody reviewed were filed into `files/review/forum-archive`,
  indexed by name only, and linked from their post. One whose bytes were
  already gone is named without a link.
- One JSON dump of the whole forum (metadata only) at
  `files/archive/forum-<date>.json`.
- Archive pages carry `data.source = 'forum-archive'`. They are exempt from
  the extractor for good: nothing is indexed and nothing spends.

**The `forum-uploads/` folder** exists only on boxes that ran the forum: its
old upload quarantine, a sibling of the files root. Nothing reads it since
0177 ([backups.md](./backups.md)).

The record of how the forum worked is in the repository history before
workspaces W8f.
