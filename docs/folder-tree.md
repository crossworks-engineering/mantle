# The item tree: one folder navigation for every kind

Every workspace screen's left column is one tree: folders (icon, colour, name,
count) nesting at most three levels, and items shown by title with a small
status slot. Summaries, descriptions and tags live in the item's own view, not
in navigation. The same tree serves every reader; the brain prunes it to what
that reader may see.

Status: the tree serves **Files** (phase 1), the flat kinds **notes, draw,
tables, formulas, tasks, events, contacts and secrets** (phase 2), **Apps**
(phase 3), **Recall** maps and, since phase 7, **Pages** (they stopped
nesting; see "Pages" below). A folder is shared by its grants to
workspaces, like any item (phase 4 shared folders by level until workspaces
W5b2; phase 5 filed members' drafts in place until W6b). A client app
offers the tree for the kinds the shell's `treeKinds` names and keeps its
older screen for the rest.

## The model

- **One tree per kind.** Each kind has a root label (`files`, `notes`, `pages`,
  `draw`, `tables`, `formulas`, `apps`, `tasks`, `events`, `contacts`,
  `secrets`, `recall`). The kinds, their roots, node types, sort orders and
  whether a folder may be shared come from the kind registry, `ITEM_KINDS`
  in `packages/client-types/src/kinds.ts` (each kind's `tree` entry);
  `TREE_KIND_SPECS` in `packages/client-types/src/tree.ts` is derived from
  it.
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
  the chosen sort: the custom order (below, the default), name or last
  updated for most kinds; tasks by due date (open tasks first, soonest due
  first, undated last, done tasks after); events by start.
- **What a row carries.** A title, the workspaces that hold it
  (`workspaces`) and whether it has a public link (`hasLink`; the item's
  level is no longer sent since W5b2), a short `subtype` for the
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

The tree's filter menu narrows the same search: `ws=` (a workspace id) and
`tag=` keep only the items that workspace reads or that carry that tag,
together with any `q`. A filtered search lists items only; it is a
question about items, not about where they sit. (The `level=` filter went
with the levels in W5b2.)

**A search across workspaces** (task f26a516e): with a term and
`across=1`, `ws=` narrows nothing. The search covers every workspace the
caller reads, the items `ws` reads come first (each part by name; the
cursor carries the part), the folders that match come too unless a tag
narrows, and each item names the workspace it opens in (`workspace`, a
`HitWorkspace`). The answer echoes `across: true`; a brain before it
narrows as above, and its items carry no `workspace`. An empty `q` ignores
`across`. What the caller reads is decided by the row rules of its scope,
never by the route: `parseReadCover` in `server/web/lib/list-workspaces.ts`
only says whether `ws` narrows or orders.

**Items in another workspace.** Asked with `ws=`, each folder of a page
also counts `itemsElsewhere`: its items that the caller's other
workspaces read and `ws` does not (not in `itemCount`). The first page of
a folder where `ws` reads no item names them in `elsewhere`
(`[{id, name, count}]`, most first), so a client can say "2 items in
Admin" and offer the switch. Both count only the caller's own workspaces
and only what its scope reads.
`GET /api/tree/:kind/tags` lists the tags on the kind's items, most used
first (at most 40), leaving out the tag every item of the kind carries by
default (every file is tagged `file`).

**Tree reads never require write rights.** A read first makes sure the kind's
root row exists and moves in what older brains kept elsewhere
(`ensureTreeRoot` in `server/web/lib/tree-route.ts`: `ensureKindRoot`,
`ensureFilesRootBranch`, `reconcileNotesAutoFiled`, `reconcileAppNav`,
`reconcileAppMarks`; `GET /api/app-nav` runs the last two as well). Each of
these looks first and writes only what is missing, and when the database
refuses the write (a read-only replica, or a role with SELECT only such as the
public demo's reader) it skips it and the read is served from the rows that
exist: a kind whose root was never made reads as an empty tree, and a move
still to do waits for a database that takes it. Looking first is not enough by
itself, because Postgres checks a table's privilege when a statement starts,
before it looks at a row, so even `INSERT ... ON CONFLICT DO NOTHING` of a row
that exists is refused; the refusal is caught with `isWriteRefused`
(`packages/content/src/tree/refused-write.ts`, over `bestEffortWrite` in
`@mantle/db`), which catches nothing else, so a broken query still fails
loudly. After a refusal the tree tries no write for five minutes, so a
read-only brain does not fill its database log with one refused statement per
read. Any new step a read makes for itself must follow
the same rule; `tree-readonly.db.test.ts` and `tree-readonly-routes.db.test.ts`
run the reads as such a role and check that nothing was written.

## Custom order

People put a folder's items and its subfolders in the order they are worked
in (stages, steps), by dragging. The order is one for everyone, never per
login (owner decision 2026-10-26).

- **Where it lives.** An item's place is its `data.tree_rank`, a
  fractional key (`packages/content/src/rank.ts`); a folder's place among
  its siblings is its `data.rank`, as before. Both are presentation keys
  (0281, `tree_rank` since 0335): the database lets edit of the item or of
  its folder change them, and nothing else of the row. `tree_rank` is the
  tree's own: a task's board order (`rank`) never moves an item in the
  tree, and a place never moves a card on a board. A place never touches
  `updated_at` (`mantle.keep_updated_at`), so "last updated" and the
  extractor ignore it.
- **Who sets it.** Write on the folder orders what it holds, its items and
  its subfolders; the top level is in no folder, so only an Admin scope
  orders it, and there the database asks edit of each row written, so the
  moved item or folder must be the caller's to edit (refused first, 403,
  never silently left in place). `placeTreeItem` and a folder's `after` ask
  it first (`mayOrderFolder`, `TOP_LEVEL_ORDER_REFUSED`); a folder page says
  it (`mayOrder`). A PATCH of a folder that only sets `after` asks no right
  of that folder beyond its read: the order right of the folder that holds
  it decides.
- **Reading.** `custom` is every kind's first sort. A folder where an item
  the reader reads carries a rank lists by rank, then by name, items with
  no rank last (`ordered: true` on the page); one with none lists in the
  kind's next sort, exactly as before (`treeFallbackSort`). So an untouched
  folder looks the same, and an ordered one opens in its order for
  everyone. A to Z and last updated stay a choice per browser. A read-only
  snapshot copy's rank is the one it inherited: it never makes a folder
  ordered.
- **Writing.** `POST /api/tree/:kind/place` `{ id, after }` puts an item
  right after another of its folder (null = first); the agents' tool is
  `tree_item_place`, and `tree_folder_update` takes `after` for a folder.
  Both go through one gateway, `orderChildren` in
  `packages/content/src/tree/write.ts` (the plan is
  `packages/content/src/tree/order-plan.ts`): under an advisory lock on the
  folder, so places in one folder run one at a time, it reads the children
  in its transaction and writes every rank in one statement. Read-only
  snapshot copies are never neighbours: a place goes between the nearest
  children that are not copies, and a copy's inherited rank never ties
  with one. A place writes the moved item only when those neighbours both
  carry a rank with room between. Otherwise the folder is ranked: in a
  folder that already has an order every rank stays, the children with
  none take keys after the last (`planWhole`), so a member's place leaves
  the items it does not see where they were; in a folder with no order yet
  (or a tie, or a key grown past 48 characters) the children are ranked
  whole, evenly (`ranksSpread`), in the order the tree shows them, so the
  first drag moves one item and nothing else. Such a ranking writes only
  rows the caller may write: never a copy (it keeps its place, and cannot
  be placed), and at the top level only what the caller may edit (asked
  then, not on every place). A folder of more than 5,000 children
  (`TREE_ORDER_MAX`) is refused a place that needs a ranking (409: sort it
  another way, or split it); a place between ranked neighbours works at
  any size. The route is limited per login (`treePlace`, 120 a minute). A
  move to another folder keeps the item's rank, so it lands by it there
  until someone places it.

## Pins, Recent and Most used

`item_marks` holds one login's marks per item: a pin and an open counter.
`POST /api/tree/items/:id/opened` counts an open; `PUT /api/tree/items/:id/pin`
pins or unpins (at most 12 per kind); `GET /api/tree/:kind/marks?view=` lists
pinned, recent or most used items with their crumbs. Per login, so two admins
of one brain keep their own.

The app opens every tree on Folders, every time its screen is opened
(Jason, 2026-10-01). Recent, Most used and A to Z are one click away and
hold for that visit only: the chosen view is never stored. The sort and the
open folders are still remembered per browser.

## Writing

- `POST /api/tree/:kind/folders` creates a folder under `parentId` (null = top),
  with its `icon` and `color` when chosen (the same values PATCH takes; null
  or an empty icon is none).
- `PATCH /api/tree/:kind/folders/:id` renames, restyles (`icon`, `color`),
  moves (`parentId`) or reorders (`after`: the sibling to follow, null = first).
- `DELETE /api/tree/:kind/folders/:id` deletes a folder after moving what it
  holds up to its parent; nothing inside is deleted. Everything lands one
  level up (`P.rest` goes to `Q.rest`, `Q` the parent), so a clash is a
  merge: a subfolder whose name is already taken there merges into that
  folder, recursively (its subfolders merge the same way one level down, its
  items move in), and the folder that was there keeps its name, look and
  share. A file whose name is taken where it lands gets the repo's de-dup
  name first (`report.pdf` becomes `report-2.pdf`, `dedupeFilename`, the
  same `-2` style Auto-filed uses; file names are sanitised lower-case with
  dashes, so " (2)" could not survive); other kinds may share titles, so
  nothing else is renamed. A subfolder named like the deleted folder takes
  its place. Rows-only kinds do it in one transaction
  (`deleteNodeFolderMerging`, `packages/content/src/tree/node-ops.ts`).
  Files go through the disk one child at a time, disk first
  (`packages/content/src/tree/files-merge.ts`), after checking everything
  read only: a file on disk the brain does not track, in the folder or in a
  subfolder that merges, or a name already on disk where a subfolder would
  move up, refuses the delete before anything moves. Members' drafts and
  folders follow by the same mapping (`carrySpaceRows`). A folder rename or
  move checks again on the locked rows inside its transaction, so two
  writes racing cannot both pass a stale check.
- `POST /api/tree/:kind/move` moves items into a folder (null = the root). Each
  item moves on its own; the answer lists any that could not.
- `POST /api/tree/:kind/place` puts an item in its folder's custom order
  (`after`: the item to follow, null = first; "Custom order" above).

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
/api/app-nav` (the layout save) answered 410 with a message to update the
app until arch A7 (a 405 since: the path serves GET only); `PUT /api/app-nav/pins` and the open counter keep working through
`item_marks`. Tree writes to apps also notify `app_nav_changed`, so an older
client refetches.

### Apps for members

Apps are a reader tree kind (`READER_TREE_KINDS`): a member's or client's
shell names `apps` in `treeKinds`, and its Apps screen is the tree. The
tree reads the app rows the login's row rule reads (the nodes rule,
0242), the same rows `GET /api/apps` lists for it, and the folders on the
way to them (the login's trail, 0311, as on every kind).

- **Every readable app, not only the runnable ones.** A draft or an app
  whose build failed lists when it is granted to one of the login's
  workspaces, and so does the login's own draft; running it still asks
  the app's own rule. This is the move from the launcher, which listed
  only the apps the login could run, to the list `GET /api/apps` already
  answers.
- **Folders.** A folder the login reads lists, empty or not (one granted
  to its workspace, say). A folder it does not read lists only on the way
  to a row it reads below it, at any depth, as id, path and name: a team
  app in a folder nobody shared still shows in its folder, while a folder
  of admin apps only is absent and does not open by id.
- **Reads write little.** The first Apps read of a login copies its own
  app pins and opens into its marks, once (`backfill:app-marks`). The
  pre-tree layout move (`backfill:app-nav`) is the brain's own
  housekeeping and runs on an Admin user's read only (a scope without the
  Admin workspace skips it, `packages/content/src/tree/apps-nav.ts`);
  until then a member reads the apps where their rows stand.

History: the launcher (`GET /api/member/apps`, and the client launcher
`GET /api/client/apps`) answered `folders` next to `apps` from
`appLauncher` (`packages/content/src/app-folders.ts`). Both routes went in
arch A7, leaving a member's Apps screen a flat card list until apps
joined the reader kinds.

### Present for members

Present canvases are a reader tree kind too, named with apps
(`READER_SCREEN_KINDS` in `packages/content/src/tree/kinds.ts`), not by
flipping the registry's `library` flag, which drives the Library lists.
A member's shell names `present` in `treeKinds`, and its Present screen
is the tree: the canvases its row rule reads (the rows `GET
/api/presents` lists for it) and the folders on the way to them, as for
apps. A canvas of a workspace the member is not in, or one homed in
Admin, is absent, and `GET /api/presents/:id` and its frame ticket
answer 404 for it; a canvas in a folder nobody shared still shows in its
folder. The frame (`GET /api/presents/:id/frame`) reads the canvas again
in the ticket's login scope.

## Sharing a folder (workspaces)

A folder is an item with a home and grants like any other
([workspaces.md](./workspaces.md), "Folders"). The tree offers the
folder's Grant Access panel on folders of files, notes, pages, draw,
tables, formulas and apps (the kinds `TREE_KIND_SPECS` marks `shareable`),
never on a system folder (Auto-filed). Tasks, events and Recall maps are
workspace kinds too (`mantle_kind_class`, migration 0241): the grants
routes take them, but the tree offers no folder panel for them yet. Only
contacts, secrets and the other Admin-class kinds live in the Admin
workspace alone.

- **Placing an item in a folder** (by create or by move) gives the item the
  folder's grants: the one automatic grant. Inside a moved folder a change
  passes down to what is inside, unless a folder on the way stops it (its
  own grant keeps a workspace; its "Removed here" blocks one). A grant set
  on the item, its home and its exclusions stay. Embeds do not follow:
  nothing is granted for you. The database derives it
  (`mantle_rederive_nodes`, migration 0241, replaced by 0251).
- **Confirm first.** A write that places items under another folder (a
  folder or items moved, a folder deleted with its contents lifted, a file
  or page made or copied into a folder, the Files screen's move and copy,
  and the agent tools `file_move`, `file_copy`, `folder_move`,
  `folder_copy`, `file_create`, `file_upload`, `tree_item_move` and
  `tree_folder_update`) is computed first, dry, from the grants
  (`packages/content/src/tree/visibility.ts`). When it changes which
  workspaces read anything and the caller did not confirm, it is refused
  with 409 `{ error: 'visibility', changes, total }` until it is repeated
  with `confirm: true` (and `seen`, the count shown). Every agent tool that
  can change who sees something takes `confirm` and tells the model to ask
  the user first (`packages/tools/src/confirm-schema.test.ts`).
- **The level share is gone.** `PATCH /api/tree/:kind/folders/:id` with
  `share` answers 410 `{ error, code: 'gone' }` ("Use the folder's Grant
  Access panel"). `nodes.share_level` and `inherited_level` were archived
  and frozen by migration 0261 (W5b2), and the nightly `share-drift` sweep
  went with them. `GET /api/access/nodes/:id` and its `sharedVia` are gone
  ([access-levels.md](./access-levels.md)).
- **Who reads the tree.** Every login reads `GET /api/tree/:kind` (with
  `/search` and `/tags`) in its own workspaces
  (each route file's `policy`, `open: 'owner'`): an item or a folder shows
  when a workspace of the reader holds it (the row rules). Folder writes
  and moves are open to a non-Admin login where it may edit (the same
  `open: 'owner'` on the write).
- **Folder counts are the reader's.** A folder's item and subfolder counts
  are what the reader sees when it opens the folder in the same scope:
  only what its workspaces read, and with `?ws=` only the items that
  workspace reads (`selectFolders` in `packages/content/src/tree/read.ts`,
  the one count path; the MCP `tree_folders` tool and the reply of a
  folder write read the same). `?ws=` does not narrow the subfolders (the
  tree keeps every folder the reader reads), so a folder with no item for
  that workspace can still show a subfolder count. A folder the reader
  holds but whose contents it does not read still shows, with 0: an Admin
  user may share an empty folder to give a workspace its structure. The
  tag counts (`/tags?ws=`) and a move's confirm list follow the same
  scope: a confirm never names or counts an item the caller cannot open.

## Members' folders and drafts (history)

Until workspaces W6b a member filed drafts and private folders in the
brain's tree from its personal space (`/api/member/tree/:kind`, its
folders, move and search). Migration 0267 folded every personal space into
the brain: each personal item is a brain item in its login's private
workspace, read and written through the normal routes. The
`/api/member/tree/*` routes answered 410 `{ error, code: 'gone' }` until
arch A7 deleted them. What this
page said about the level share (phase 4) and drafts in place (phase 5) is
in the repository history before workspaces W8f.

## For agents

Files keep their own `folder_*` tools (their folders are directories, and
those tools refuse any other kind's folder). Every other tree kind, Recall
included, shares one set, told apart by `kind`
(`packages/tools/src/builtins-tree.ts`):

- `tree_folders`: every folder of a kind, in tree order, with ids, paths,
  counts and the system flag.
- `tree_folder_create`, `tree_folder_update` (rename, move, or both).
- `tree_item_move`: file items into a folder, or to the top level.
- `tree_folder_delete` (MCP only, like Files' `folder_delete`): what the folder
  held moves up first; a clashing subfolder merges into the one there.

They sit in each kind's tool group (`tree_folders` alone in Draw's read-only
group), so an agent that can work with a kind can organise it. The brain is
the trust boundary, so they are not split per kind. They run on the owner
surface only: since workspaces W7b that is every login's own MCP connection
and its own assistant turn, each call in the caller's workspaces (a move, a
create in a folder and a delete are checked against the scope;
`OWNER_ONLY_IN_SCOPE` in `packages/tools/src/admin-gate.ts`). A turn on a
team surface is refused. A write that would change who can see
items is refused with the list until the call repeats with `confirm: true`,
which the model is told to send only once the user agreed. Every write
notifies the tree like the screens do.

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

Auto-filed is Admin only, so an export (`export_node`, `sheet_build`,
`app_export`) asks `saveExport` (`packages/files/src/export-home.ts`) where
it lands: Exports for the owner and an Admin user who may change that folder;
anyone else's at the top of Files, in the home a new item takes there (its
private workspace, or the chat's workspace it moderates). The reply names
where it landed (`landedIn`). The export holds only what its caller reads.

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

## Pages (phase 7)

Pages live in folders exactly like notes do, and **a page is never the
parent of another page** (Jason, 2026-09-30). A page's place is its
folder's path under `pages`; the folder rows, the three levels, the
folder's grants passing down to what it holds and the confirm diff all
apply unchanged (the level shares of 0204 and 0207 and the embed rule of
0208 went with the levels in W5b2). The old sub-page model (`parent_id` on a page, a
path of `pages.<id>.<id>`) is gone:

- **Migration 0210** (`0210_pages_in_folders.sql`, idempotent) files the old
  hierarchy: every page that had child pages becomes a page NEXT TO a folder
  of its own name, its former children move into that folder, one level of
  the old hierarchy at a time (a child with children of its own makes its
  folder inside its parent's), cut to three levels (past that, children
  land in the deepest folder allowed, next to their parent). Folder slugs
  follow `folderSlugOf` (`mantle_folder_label` in SQL, pinned to the
  TypeScript by `pages-in-folders.db.test.ts`); a taken slug gets `-2`. Every
  page's `parent_id` that named a page is cleared (it was ON DELETE
  CASCADE), and any page at a path with no folder row moves to the deepest
  folder above it. Nothing is lost: ids, documents, tags, levels and links
  stay. A member's nested draft becomes the member's own folder the same
  way.
- **A page may reference another page** without that page becoming its
  child: the `childPage` block is a **page link card** now (`[Title](page:<id>)`
  on its own line), still an embed edge (0208), so a shared page opens the
  page it links to while it is shared. `page_split` and
  `page_extract_section` (and the editor's "Extract to a new page") make
  pages next to the source, in the same folder, and leave link cards behind.
- **No index pages.** A folder is just a folder. A page that wants to list
  its folder's pages uses the **Folder index** block
  (`[Folder index](folder:<folder-id>)`, or `folder:here` for the page's own
  folder): it lists the folder's pages live, title only, as the reader sees
  them (the reader's own tree read), never stored. An open link
  renders it as an inert label.
- **Member drafts and review (history).** The member draft's block, read
  through `/api/member/space/:id` and `/api/member/tree/pages`, and the
  reviewer's view before and after Accept went with review (W5c) and the
  personal spaces (W6b, migration 0267). A member's page is now a brain
  page in a workspace, and `folder:here` means its folder for every reader
  who reads it.
- **Where a page sits.** `PageDetail.folderId` names the folder (null at
  the top level); `PageRow.parentId` is always null and stays on the wire
  for older clients, as do `childCount` and `parentTitle` (absent),
  `AccessNodeView.childCount` (0) and a link's `cascade` (false). `POST
/api/pages` takes `folderId`; `POST /api/pages/:id/move` takes `folderId`
  (null = top level) and the confirm shape, and is the tree's item move for
  one page. The deprecated `parentId` on both means "the same folder as that
  page". `page_create` and the `page_from_*` tools take `folder_id`;
  `page_move` takes `folder_id` or `to_top_level` with `confirm`; the tree
  tools serve `kind: 'pages'` and sit in the `pages` tool group.
- **Retired with the nesting**: the "Share sub-pages" cascade on a page
  link (`setShareCascade`, `POST /api/shares/cascade`, `page_share`'s
  `children`): a set of pages is shared by sharing its folder.

## What comes next

Still open from the plan, each waiting on a decision: the phone's
read-only tree, pins and Recent / Most used for non-Admin logins, and
the task board filtered by folder.
