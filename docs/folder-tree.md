# The item tree: one folder navigation for every kind

Every workspace screen's left column is one tree: folders (icon, colour, name,
count) nesting at most three levels, and items shown by title with a small
status slot. Summaries, descriptions and tags live in the item's own view, not
in navigation. The same tree serves every reader; the brain prunes it to what
that reader may see.

Status: the tree serves **Files** (phase 1), the flat kinds **notes, draw,
tables, formulas, tasks, events, contacts and secrets** (phase 2), and
**Apps** (phase 3). Pages wait for Recall v2 (pages stop nesting). A client offers the tree for the kinds the shell's `treeKinds`
names and keeps its older screen for the rest.

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
  the chosen sort: name or last updated for most kinds; tasks by due date
  (open tasks first, soonest due first, undated last, done tasks after);
  events by start.
- **What a row carries.** A title, the item's level, a short `subtype` for the
  status slot (a file's extension, a secret's kind) and, for tasks and events,
  `meta` (a task's done box and due date, an event's start). Archived tasks are
  left out of the tree; the task screen's Archived view is where they live.
- **Files stay mirrored on disk.** Every Files write goes through the Files
  package's disk-safe operations (disk first, then the database, rolled back
  together), so agents and the sandbox always see the same tree people do.
- **Every other kind is rows only** (`packages/content/src/tree/node-ops.ts`):
  the same slug, clash and depth rules, and a folder's rename or move rewrites
  the path of everything below it in one statement. Filing an item does not
  change its `updated_at`. No other table keeps a copy of these kinds' paths,
  and every list of these kinds selects by type, not by path, so filed items
  stay visible on the older screens.

## Reading: lazy, 50 at a time

`GET /api/tree/:kind?folder=&cursor=&sort=` answers one folder's page
(`TreeFolderPage`): all its direct subfolders, with what the reader can see in
each counted, and one page of its items (50, at most 100). The cursor is keyset
(sort key and id), so paging never skips or repeats an item while others are
added. No folder is the root; there, on the first page, the caller's own
private items come first (they have no folder yet).

`GET /api/tree/:kind/search?q=` answers matching folders, then matching items,
each with the crumbs of where it lives, so a result can be opened in place.
An empty `q` is the A to Z view: every item of the kind by name, paged the
same way, and no folders.

The tree's filter menu narrows the same search: `level=` (admin, team, client,
public) and `tag=` keep only the items read at that level or carrying that
tag, together with any `q`. A filtered search lists items only; it is a
question about items, not about where they sit. Until folder shares arrive
(phase 4) an item's own level is the level it is read at.
`GET /api/tree/:kind/tags` lists the tags on the kind's items, most used
first (at most 40), leaving out the tag every item of the kind carries by
default (every file is tagged `file`).

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

## Apps (phase 3)

Apps used to keep their folders in one JSON document on the brain's profile
(`preferences.appNav`) and each login's pins and open counts in its own
preferences. They now live like every other kind: folders are rows under
`apps`, an app's place is its `path`, pins and opens are `item_marks`.

The move is lazy and runs once (`packages/content/src/tree/apps-nav.ts`):
`reconcileAppNav` turns the document into folder rows the first time a
brain's apps are read, keeping each folder's id, name, icon, colour and
order; names that clash in one folder get " 2", and a name with no letters or
digits keeps its title with the slug `folder`. `reconcileAppMarks` copies one
login's pins (in order) and open counts the first time that login's apps are
read. Done-markers sit on the `apps` root row. The old document and
preferences are left untouched, a copy to roll back to. Manual order of apps
inside a folder is not kept: items follow the chosen sort, as on every kind.

`GET /api/app-nav` still answers in its old shape, built from the rows, for
clients from before the tree: each folder's subfolders then its apps by name,
top-level apps left unsorted, and `rev` a digest of the layout. `PUT
/api/app-nav` (the layout save) answers 410 with a message to update the
app; `PUT /api/app-nav/pins` and the open counter keep working through
`item_marks`. Tree writes to apps also notify `app_nav_changed`, so an older
client refetches.

## Sharing a folder (phase 4)

A folder of a shareable kind (files, notes, pages, draw, tables, formulas,
apps) can be shared with the team or with clients: `PATCH
/api/tree/:kind/folders/:id { share: 'team' | 'client' | null }`. The share
reaches everything below it, now and later. Public stays a per-item link.
System folders (Auto-filed) and the admin-only kinds (tasks, events,
contacts, secrets) cannot be shared.

- **In the database** (migration 0204). `nodes.share_level` on the folder;
  `nodes.inherited_level` on every row, kept true by triggers: a row takes
  the share of the nearest shared folder holding it (same owner; an item
  holds its folder's own share, a folder only what is above it), on insert
  and on a path change, and a folder whose path or share changes refreshes
  its subtree. Every writer that files an item (the UI, agents, uploads, the
  disk watcher) gets it for free. Only workspace kinds ever inherit (the type
  ceiling); a member's draft (another owner) never does.
- **Who reads it.** `nodes_viewer_read` reads a brain row at its own level
  OR its inherited share; still a same-row check. Chunks, facts, pages and
  the rest follow their node as before.
- **The level shown** is the effective level (`effectiveLevel`,
  `@mantle/content-core/tree`): the more open of the item's own level and
  its inherited share. Tree rows carry it in `level`, with `inherited` naming
  the share. Embeds follow it and a page's indexed text is folded for it
  (`itemLevel`, `packages/content/src/item-level.ts`): text folded for the
  more open reader is safe for every reader of the row.
- **Confirm first.** A share change, an item or folder move, and a folder
  delete that lifts its contents are computed dry first
  (`packages/content/src/tree/visibility.ts`). If who can see anything would
  change, the write is refused with 409 `{ error: 'visibility', changes,
total }` and nothing is written; the same call with `confirm: true` goes
  ahead (`?confirm=true` on DELETE). The agent folder tools take `confirm`
  too and tell the model to ask first. A rename never asks.
- **Shared via.** `GET /api/access/nodes/:id` names the shared folder an
  item takes its share from (`sharedVia { folderId, trail, level }`,
  `sharedViaFolder` in `packages/content/src/shared-via.ts`). Its level is
  the Access control's floor: the item is read there whatever its own level
  says, so the control offers nothing above it ("Move it out of the shared
  folder to hide it"). The brain does not refuse such a raise (an unshared
  link sets an item back to admin); `access_get` returns `sharedVia` and
  `access_set` warns that the item is still read at the folder's share.
- **After a confirmed change**, embeds of the pages, drawings and notes
  concerned follow them to the level they are now read at (never raising
  anything) and the pages' text is re-folded.
- **Members and clients** read a folder-shared item wherever they read
  items, by the row policy's union rule: its own level OR its inherited
  share is one of the reader's levels (`isReadAt` / `readAtSql`,
  `packages/content/src/item-level.ts`). The member Library and the
  client's "Shared with you" (list, open, the `client_shared_*` tools), a
  client's redaction (which references keep their names), drawing and chat
  images, and apps (an app runs at its effective level, so an admin app in
  a team-shared folder is a team app). The client thread too: an item read
  at client level through a folder carries it (migration 0205 widens the
  0194 read policy to the union rule; `client-thread.ts`, `addNodeComment`
  and the admin usage report check the same rule). Unsharing the folder, or
  moving the item out, hides the thread below admin again.
- **The member and client trees.** `GET /api/member/tree/:kind` and
  `/api/client/tree/:kind` (with `/search`) serve the kinds a Library holds
  (`READER_TREE_KINDS`: files, notes, drawings, tables; the shells list them
  in `treeKinds`), read only (`packages/content/src/tree/reader.ts`). Items
  are read AS the reader, at the Library's levels by the union rule, without
  extracted image fragments. Folders are read as the brain (a shared folder's
  own row is not the reader's: it inherits only from above itself) and show
  when their share, or the share they inherit, covers the reader, or when
  they lead to something the reader reads or to such a folder. Nothing is
  stored; the visible set is computed per call. Counts are the reader's. A
  folder the reader cannot see is a 404 like a missing one, by id and in
  search. A member gets the owner's shapes (levels are staff information);
  a client gets `ClientTreeFolderPage` / `ClientTreeSearchResult`, with no
  level, share or system flag. No pins, Recent or Most used for these
  readers yet (item marks are the owner's), and no tag or level filter.
- **The owner's gates count it too.** "What clients see" lists what a
  client-shared folder holds, and sharing a folder with clients asks for a
  fresh acknowledgement before another client login can be added. A
  client-sourced turn's write waits at Pending when it lands in a folder
  shared with clients: a tree move into one (`tree_item_move`,
  `tree_folder_update` with `parent_id`), a Files create, copy or move by
  path into or below one, or any write into an item read by clients
  through a folder.

## Members' folders and drafts in place (phase 5)

A member files its drafts in the brain's tree and keeps private folders there.

- **Where a draft sits.** A draft (and a member's own folder) is a row the
  member's space owns at a BRAIN folder path (`notes.clients.acme`), maybe
  below the member's own folders (`notes.clients.acme.mine`). No new column:
  the owner says whose it is. A member's files and file folders mirror the
  brain's under `space_files` (`files.docs` is the member's
  `space_files.docs`, `spaceFilesPath` in `@mantle/db`), so no brain file
  helper, the disk watcher or the extractor ever resolves them; their bytes
  stay keyed by id under `MANTLE_SPACES_ROOT`.
- **The member's tree** (`packages/content/src/tree/member-tree.ts`,
  `GET /api/member/tree/:kind`) merges per path: the brain's items the member
  reads, its own folders (`own: true`) and drafts, and teammates' drafts
  shared with the team (`source`, `state`, `author` on the item). A
  teammate's draft shows at the deepest folder of its path the member sees,
  never at the teammate's own folders. The brain folders on the way to the
  member's own rows show too (names are organisational). Drafts come first on
  a folder's first page; brain items page after them.
- **The member's writes** (`member-tree-write.ts`, `POST /api/member/tree/:kind/folders`,
  `PATCH|DELETE .../folders/:id`, `POST .../move`): create, rename, restyle,
  move and delete its own folders, file its own drafts. A place must be a
  folder its tree shows, or the top level. Only its own rows change; a draft
  with an admin does not move on its own. New drafts (`POST /api/member/space`)
  and uploads (`POST /api/member/space-files`) take a `folderId`.
- **Brain folders carry them.** A brain folder rename, move or delete moves
  every member's rows under it in the same transaction
  (`carrySpaceRows`, `packages/db/src/space-carry.ts`): a member's folder
  whose new path the member already has merges into it, a delete lifts the
  drafts to the parent, and anything past three levels is cut to fit, so a
  member's private folders never block the admin.
- **Accept claims in place** (`packages/content/src/accept-place.ts`). An
  accepted draft lands in the brain folder it was filed in; the author's own
  folders below it become brain folders (merging by name, keeping name and
  look, cut to three levels), and the author's emptied folders go. The admin
  may pick another folder (`folderId`; null = the top level): the author's
  folders still go below the pick. The rest of the bundle lands in place. The
  preview names the default (`AcceptPreview.place`). Pages keep their own
  placement until phase 7.

## For agents

Files keep their own `folder_*` tools (their folders are directories). Every
other tree kind shares one set, told apart by `kind`
(`packages/tools/src/builtins-tree.ts`):

- `tree_folders`: every folder of a kind, in tree order, with ids, paths,
  counts and the system flag.
- `tree_folder_create`, `tree_folder_update` (rename, move, or both).
- `tree_item_move`: file items into a folder, or to the top level.
- `tree_folder_delete` (MCP only, like Files' `folder_delete`): what the folder
  held moves up first.

They sit in each kind's tool group (`tree_folders` alone in Draw's read-only
group), so an agent that can work with a kind can organise it. The brain is
the trust boundary, so they are not split per kind. They are owner only: a
member's or client's turn is refused until folder sharing (phase 4) gives
those readers a tree of their own. Every write notifies the tree like the
screens do.

## Auto-filed

Everything Mantle files by itself lives in one admin folder, `files/auto-filed/`
(`packages/files/src/auto-filed.ts`), never at the top of Files:

| Folder            | Holds                                      | Split                 |
| ----------------- | ------------------------------------------ | --------------------- |
| Assistant uploads | files sent to the assistant in chat        | a folder per month    |
| Telegram uploads  | files sent over Telegram                   | a folder per month    |
| Exports           | documents and sheets from the export tools | a folder per month    |
| Generated images  | `generate_image` output                    | a folder per month    |
| Video             | `video_ingest` audio and video             | a folder per month    |
| Extracted images  | pictures pulled out of documents           | a folder per document |
| Sandbox exports   | `sandbox_export` snapshots                 | none                  |
| API docs          | stored integration docs (`api_docs_set`)   | none                  |

Writers ask `ensureAutoFiledFolder(owner, source)` for their folder. Every
folder there is a system folder (`data.system`): its name is locked and it
cannot be moved, because writers find it by its path. Its contents can be
moved, renamed and deleted freely.

Brains made before Auto-filed kept these folders at the top of Files, dated by
day. `reconcileAutoFiled` moves them in once (merging when both exist) and
merges day folders into months; a file name taken in the month gets `-2`
(then `-3`) rather than overwriting. The file watcher
(`server/web/workers/files-watch.ts`) runs it before it starts watching, so it
never mistakes the moves for deletes and adds. A second run finds nothing to do.

Notes have an Auto-filed too: **Notes / Auto-filed / Assistant** holds the
conversation digests the summarizer writes (`server/api/src/agent/summarizer.ts`
creates it with `ensureNotesAssistantFolder`). Both folders are system folders.
Digests used to be written at the path `assistant`, outside the notes root, so
no tree showed them; `reconcileNotesAutoFiled`
(`packages/content/src/tree/notes-auto-filed.ts`) moves a brain's older digests
in once, the first time its notes tree is read. It is a path change only:
digests are found by their `conversation-digest` tag, agent id and embedding,
never by path.

## What comes next

The other kinds move onto the tree one by one; Apps' folder document becomes
folder rows; a folder can then be shared with the team or clients (everything
under it, now and later) and members and clients browse the same tree; members
file their drafts in the same folders; pages stop nesting once Recall has its
own content type.
