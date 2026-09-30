# The item tree: one folder navigation for every kind

Every workspace screen's left column is one tree: folders (icon, colour, name,
count) nesting at most three levels, and items shown by title with a small
status slot. Summaries, descriptions and tags live in the item's own view, not
in navigation. The same tree serves every reader; the brain prunes it to what
that reader may see.

Status: phase 1 serves **Files**. The other kinds keep their older lists until
they move over (the shell's `treeKinds` names the kinds a brain serves).

## The model

- **One tree per kind.** Each kind has a root label (`files`, `notes`, `pages`,
  `draw`, `tables`, `formulas`, `apps`, `tasks`, `events`, `contacts`,
  `secrets`). The kinds, their roots, node types, sort orders and whether a
  folder may be shared are one table: `TREE_KIND_SPECS` in
  `packages/client-types/src/tree.ts`.
- **Folders are rows.** A folder is a `branch` node under its kind's root, and
  an item's location is its folder's path (`files.clients.acme` holds the files
  whose `path` is exactly that). An item at the root is unsorted. Items are
  never parents.
- **Three levels.** A folder sits at depth 1 to 3 below the root
  (`files.a.b.c` at most). The writers refuse or clamp, and migration
  `packages/db/migrations/0201_item_tree.sql` adds a database check as the
  backstop (`nodes_tree_folder_depth_ck`, NOT VALID, so older rows are left
  alone). An agent's `mkdir -p` (`ensureFolderPath`) cuts a deeper chain back
  to its third folder and writes there; a directory made on disk deeper than
  that stays out of the brain (the watcher logs the refusal).
- **Name and slug.** What people see (`title`, "Acme Corp") is kept apart from
  the slug (`acme-corp`), which is both the path label (`acme_corp`) and, for
  Files, the directory name on disk. A rename re-derives the slug and moves the
  directory; a rename that only changes case or spacing keeps the path.
- **Order.** Folders keep a manual order (`data.rank`, then name). Items follow
  the chosen sort (name or last updated for Files).
- **Files stay mirrored on disk.** Every Files write goes through the Files
  package's disk-safe operations (disk first, then the database, rolled back
  together), so agents and the sandbox always see the same tree people do.

## Reading: lazy, 50 at a time

`GET /api/tree/:kind?folder=&cursor=&sort=` answers one folder's page
(`TreeFolderPage`): all its direct subfolders, with what the reader can see in
each counted, and one page of its items (50, at most 100). The cursor is keyset
(sort key and id), so paging never skips or repeats an item while others are
added. No folder is the root; there, on the first page, the caller's own
private items come first (they have no folder yet).

`GET /api/tree/:kind/search?q=` answers matching folders, then matching items,
each with the crumbs of where it lives, so a result can be opened in place.

## Pins, Recent and Most used

`item_marks` holds one login's marks per item: a pin and an open counter.
`POST /api/tree/items/:id/opened` counts an open; `PUT /api/tree/items/:id/pin`
pins or unpins (at most 12 per kind); `GET /api/tree/:kind/marks?view=` lists
pinned, recent or most used items with their crumbs. Per login, so two admins
of one brain keep their own.

## Writing

- `POST /api/tree/:kind/folders` creates a folder under `parentId` (null = top).
- `PATCH /api/tree/:kind/folders/:id` renames, restyles (`icon`, `color`),
  moves (`parentId`) or reorders (`after`: the sibling to follow, null = first).
- `DELETE /api/tree/:kind/folders/:id` deletes a folder after moving what it
  holds up to its parent. It is refused, before anything moves, when a name
  would clash there.
- `POST /api/tree/:kind/move` moves items into a folder (null = the root). Each
  item moves on its own; the answer lists any that could not.

Every write NOTIFYs `tree_changed`; open clients get a realtime `tree` event
with the kind and refetch the folders they show. Uploads and deletes of items
raise their own node events as before.

The server side is `packages/content/src/tree/` (reads, marks, writes, and the
per-kind ops table); path math shared with clients is
`packages/content-core/src/tree.ts`; the routes are thin wrappers in
`server/web/app/api/tree/` with their plumbing in `server/web/lib/tree-route.ts`.

## What comes next

The other kinds move onto the tree one by one; Apps' folder document becomes
folder rows; a folder can then be shared with the team or clients (everything
under it, now and later) and members and clients browse the same tree; members
file their drafts in the same folders; pages stop nesting once Recall has its
own content type. Machine-made folders gather under one admin-only "Auto-filed"
folder, dated by month.
