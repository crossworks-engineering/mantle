# The item tree: one folder navigation for every kind

Every workspace screen's left column is one tree: folders (icon, colour, name,
count) nesting at most three levels, and items shown by title with a small
status slot. Summaries, descriptions and tags live in the item's own view, not
in navigation. The same tree serves every reader; the brain prunes it to what
that reader may see.

Status: the tree serves **Files** (phase 1), the flat kinds **notes, draw,
tables, formulas, tasks, events, contacts and secrets** (phase 2), **Apps**
(phase 3), **Recall** maps and, since phase 7, **Pages** (they stopped
nesting; see "Pages" below). Folders can be shared with the team or
clients (phase 4), and members file drafts in place (phase 5). A client
offers the tree for the kinds the shell's `treeKinds` names and keeps its
older screen for the rest.

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
question about items, not about where they sit. The level filter uses the
level an item is read at (its own level or a folder's share, the more
open).
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

### Apps for members and clients

Apps are not a reader tree kind (`READER_TREE_KINDS`): a member or a client
RUNS an app, and that rule is not the Library's read rule (a green published
build, never through an embed, and for a client the client level exactly).
So their launcher gets its folders from the list that already holds the
rule: `GET /api/member/apps` and `GET /api/client/apps` answer `folders`
next to `apps` (`AppLauncherFolder`: id, name, icon, colour, `parentId`,
`appIds`; `packages/content/src/app-folders.ts`).

- **One rule.** `appLauncher(anchor, reader)` reads the apps the reader may
  run, as the reader, then reads the folder rows on the way to those apps,
  as the brain, and nothing else. It takes no paths from its caller. A
  folder is answered only when it holds, at any depth, an app of the same
  answer. A folder of admin apps, a folder of drafts and an empty folder are
  absent, name and id, whatever their share says. When the folder read
  fails the apps still list, with no folders, and the failure is logged.
- **Names are organisational.** A team app in a folder nobody shared still
  shows in its folder: the folder's name, icon and colour come with it.
- **Read only.** No level, share or system flag on a folder, no path on a
  card, and no write route. Siblings come in the admin's order.
- **Older clients** read `apps` (and `homeAppId`) as before and ignore
  `folders`; an older brain sends none, and the launcher shows one flat
  list.

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
- **Races** (migration 0207). A share change and a write filing into the
  folder wait for each other on the owner's share lock (the inherit trigger
  takes it shared, a refresh takes it exclusive), so neither misses the
  other's work. The order is always the lock first, then rows: a writer that
  changes shares or folder paths takes it exclusive as the first statement
  of its transaction, and one that moves existing rows (an item move,
  Accept) takes it shared first. Both wait at most 10 seconds; a write that
  meets another on the same rows answers "busy, try again" (409), never SQL.
  A nightly `share-drift` sweep repairs anything that slips through.
- **Restores** (migration 0212). A brain restored from a dump taken at
  migration 0204 up to 0210 came back without the refresh trigger; 0212
  repairs the stale levels and puts it back (docs/access-levels.md,
  section 6).
- **Who reads it.** `nodes_viewer_read` reads a brain row at its own level
  OR its inherited share OR its embedded level (below); still a same-row
  check. Chunks, facts, pages and the rest follow their node as before.
- **Embeds follow their embedder** (migration 0208, folder audit S5).
  What a shared item embeds is readable with it, whatever kind it is, for
  as long as the item is shared (Jason, 2026-09-30: a shared folder shares
  everything in it; teams and clients are of the same admin owner). The
  admin-only kinds (secrets, tasks, events, contacts, email, journal) never
  open that way: the type ceiling holds. An embed opens READING only: an
  app named by an embed is not run, its tools and data are not used, by
  anyone it was not shared with (the app gates read own level and folder
  share, `readAtSql(levels, { embeds: false })`). A drawing embeds what its
  published scene places, so a picture pasted into a draft opens nothing
  until "Save version". An unshare closes a loop of embeds (a note that
  embeds a note that embeds it) at once. An
  item that a page, drawing or note embeds is read through that embedder's
  folder share, wherever the item lives, and only while the embedder is:
  unshare the folder, move the embedder out, delete the folder, or take the
  embed out, and that access goes. Nothing's own level changes. The
  database keeps it, like the shares: `node_embeds (from_id, to_id)` holds
  the edges, kept by triggers from `pages.doc`, `draws.file_refs` and a
  note's markdown (a note's image counts wherever the note shows it, even
  in a heading or a table cell; a parity test pins the SQL to the
  TypeScript walkers, `packages/content/src/embed-edges.db.test.ts`), and
  `nodes.embedded_level` is the most open share among the owner's rows that
  reach the item through embeds, transitively (a note embeds a drawing that
  embeds an image). Only the brain's own rows pass a share on, so a
  member's draft never does. A refresh runs only where something can
  change (an edge added from a shared or reached row, an edge removed to a
  reached row, a share or owner change on a row that embeds something): a
  brain with no shared folder pays an index probe per save. Opening only
  raises levels forward (an image embedded by a thousand notes in a folder
  being shared is set once); closing recomputes only the rows read at the
  level that went. Measured on the workstation: sharing a folder of 1,000
  notes that embed one image takes about 0.4 s and unsharing it 0.8 s; a
  note that embeds 1,000 images, 0.6 s and 2 s; a save, about 1 ms. It
  grows with the rows reached from one change: expect tens of seconds past
  about 10,000. The client thread
  is not carried: an item read only through an embed has no client thread
  of its own (the client talks on the item that embeds it). Items lowered
  by a folder share before 0208 keep that level: they cannot be told apart
  from levels set on purpose, so nothing is raised.
- **The level shown** is the effective level (`effectiveLevel`,
  `@mantle/content-core/tree`): the most open of the item's own level, its
  inherited share and its embedded level. Tree rows carry it in `level`,
  with `inherited` naming the folder share and `embedded` the share it is
  read at through an embedder. A page's indexed text is folded for it
  (`itemLevel`, `packages/content/src/item-level.ts`): text folded for the
  more open reader is safe for every reader of the row.
- **Confirm first.** A share change, an item or folder move, and a folder
  delete that lifts its contents are computed dry first
  (`packages/content/src/tree/visibility.ts`). If who can see anything would
  change, the write is refused with 409 `{ error: 'visibility', changes,
total }` and nothing is written; the same call with `confirm: true` goes
  ahead (`?confirm=true` on DELETE). A delete compares every row at its
  real landing place: what merges into a folder takes that folder's share,
  a subfolder that moves up keeps its own and takes the shares above its
  new place. A caller that sends `seen` (the
  `total` it showed, plus `embedsTotal` when embeds are listed; `&seen=` on
  DELETE) is refused again with the new list
  when the change differs by then, so a confirm never covers items filed or
  shared while the dialog was open. A rename never asks. The same check
  guards every Files write outside the tree routes
  (`packages/content/src/tree/files-guard.ts`): the Files screen's move and
  copy (`PATCH /api/files/files/:id { move, confirm }`, `POST ... { copy_to,
confirm }`, and the same on `/api/files/folders/:id`), a new file or an
  upload into a shared folder (`POST /api/files/files`, `confirm` in the JSON
  body or as a form field before the file), and the agent tools `file_move`,
  `file_copy`, `folder_move`, `folder_copy`, `file_create` and
  `file_upload`. A copy is judged by where its NEW rows land: copies take
  the destination's share, never the shares inside the source. Every agent
  tool that can change who sees something takes
  `confirm` and tells the model to ask the user first; a test pins that each
  such tool declares it (`packages/tools/src/confirm-schema.test.ts`).
- **Shared via.** `GET /api/access/nodes/:id` names the shared folder an
  item takes its share from (`sharedVia { folderId, trail, level }`,
  `sharedViaFolder` in `packages/content/src/shared-via.ts`). Its level is
  the Access control's floor: the item is read there whatever its own level
  says, so the control offers nothing above it ("Move it out of the shared
  folder to hide it"). The brain does not refuse such a raise (an unshared
  link sets an item back to admin); `access_get` returns `sharedVia` and
  `access_set` warns that the item is still read at the folder's share.
  The same for an item read through what embeds it: `readThrough { level,
via }` (`readThroughEmbeds`) names the nearest items that embed it and
  carry a share, with title and kind, and is a floor too; the note, file,
  folder, drawing, app, formula and table rows carry `embedded` next to
  `inherited`, and badges count it.
- **After a confirmed change**, what the pages, drawings and notes
  concerned embed is read through them at their new level (the database
  did it, above), and the text of the pages concerned, of the pages they
  reach, and of the client and public pages that name what changed is
  re-folded. Those embeds may live anywhere, so the refusal lists them too
  (`alsoEmbeds`, from, to and the item's `type` each: "also readable through
  them", or no longer), every kind, not only images, from EVERY row whose
  share changes (not only the hundred listed), with `embedsTotal`. A write
  that only opens embeds (a note already read at the folder's share moving
  in) asks too. An Accept that lands in
  a shared folder lists the same for what its bundle embeds, whoever wrote
  it, in its 409 `visibility` (`alsoEmbeds`), before anything moves, also
  when the item itself is read at the level chosen. A member's note save
  checks every `media:` and `draw:` id in its text (`noteGateRefs`), a
  superset of the edges the database records, so an image in a heading or
  a table cannot carry an item the member could not share. The
  agent tools that write a note's or a page's content say so
  (`EMBEDS_SHARED`, `packages/tools/src/visibility-refusal.ts`). A page,
  note or drawing save that meets another write on the same rows (a
  deadlock the embed triggers can meet against an unshare) runs once more,
  then answers 409 "try again", never SQL (`withBusyRetry`, `@mantle/db`).
- **Members and clients** read a folder-shared item wherever they read
  items, by the row policy's union rule: its own level, its inherited share
  or its embedded level is one of the reader's levels (`isReadAt` /
  `readAtSql`, `packages/content/src/item-level.ts`). The member Library and the
  client's "Shared with you" (list, open, the `client_shared_*` tools), a
  client's redaction (which references keep their names), drawing and chat
  images, and apps (an app runs at its effective level, so an admin app in
  a team-shared folder is a team app). The client thread too: an item read
  at client level through a folder carries it (migration 0205 widens the
  0194 read policy to the union rule; `client-thread.ts`, `addNodeComment`
  and the admin usage report check the same rule, without the embedded
  level: `readAtSql(levels, { embeds: false })`). Unsharing the folder, or
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
  never at the teammate's own folders. A brain folder shows only by the
  reader rules (its share covers the member, or it leads to something the
  member reads). Where the member's own folder sits at the path of a brain
  folder it does not see, its own row shows (its name and id), never the
  brain's; its rows below a folder it no longer sees show at the deepest
  folder above them it does. A folder's pages run through its drafts first,
  then the brain's items, at most `limit` per page. By name (a search and
  the A to Z view, `GET /api/member/tree/:kind/search`) drafts and brain
  items are one list in one order, paged together by one cursor, so every
  draft is reached however many there are.
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
  drafts one level up with everything else (into the folder a subfolder
  merged into, when it merged), and anything past three levels is cut to
  fit, so a member's private folders never block the admin.
- **Accept claims in place** (`packages/content/src/accept-place.ts`). An
  accepted draft lands in the brain folder it was filed in; the author's own
  folders below it become brain folders (merging by name, keeping name and
  look, cut to three levels), and the author's emptied folders go. The admin
  may pick another folder (`folderId`; null = the top level): the author's
  folders still go below the pick. The rest of the bundle lands in place. The
  preview names the default (`AcceptPreview.place`, with `share`: what a
  shared folder there makes it read at; `?folderId=` previews a pick). A
  page lands like a note (phase 7); the request's old `parentPageId` is
  ignored.
- **Accept asks before a folder share applies.** In a shared folder an item
  is read at the more open of its level and the folder's share. When the
  item, or anything of its bundle, would be read above the level the admin
  chose, Accept answers 409 `visibility` with the list (`changes`, `total`)
  and moves nothing; the same call with `visibilityConfirmed: true` goes
  ahead. A client's item read at client that way needs the usual level
  confirmation too, and what it embeds goes down to the level it is read at.
- **A submitted draft stays put.** It never moves on its own, and a member's
  folder holding one is not renamed, moved or deleted until the review is
  done: Accept lands it where the admin reviewed it.

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
the trust boundary, so they are not split per kind. They are owner only: a
member's or client's turn is refused (members and clients organise through
their own trees, not these tools). A write that would change who can see
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
folder's path under `pages`; the folder rows, the three levels, the shares
and their inheritance (0204, 0207), the embed rule (0208) and the confirm
diff all apply unchanged. The old sub-page model (`parent_id` on a page, a
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
  them (the owner, member or client tree read), never stored. An open link
  renders it as an inert label.
- **A member's draft has the block too.** The member's own draft read
  (`GET /api/member/space/:id`) carries `folderId` on the page body, as
  every page detail does (`MemberSpaceItemBody`, pinned by
  `member-space.viewer.db.test.ts`): the member's own folder, the brain
  folder the draft was filed in, or null at the member's top level. The
  member draft editor hands it to the block, so `folder:here` lists the
  draft's own folder through `GET /api/member/tree/pages` (the member's
  drafts first, then what it reads of the brain's); a draft at the top level
  lists the member's top level, and a draft moved while its editor is open
  lists the folder it is in now. The slash menu offers the block to a member
  only when the member shell names `pages` in `treeKinds` and the folder is
  known; a body with no `folderId` (an older brain) shows the block's label
  alone, never the root; so does a brain that sends it while its member
  tree does not serve pages. In the block a member's drafts come first
  (newest first), then what it reads of the brain's, by name. A folder the
  member cannot open says "This folder is not shared with you"; that
  includes the member's own draft under a brain folder an admin has since
  unshared (the body still names that folder).
- **Before and after Accept.** A reviewer reads the submitted draft through
  the owner tree: a draft in a brain folder lists that folder's brain pages
  (not the draft itself, which is not in the brain yet), a draft at the
  member's top level lists the brain's top level, and a draft in the
  member's OWN folder shows the block's label alone, because the owner tree
  does not hold that folder. A teammate reading a shared draft gets the same
  label-alone face for the author's own folder. After Accept the page sits
  in a brain folder (accept claims in place: the author's own folder becomes
  a brain folder; a top-level draft lands at the top level), and
  `folder:here` means that place for every reader. An admin's private item,
  a client's own page and a client's submitted page are in no folder a tree
  lists: the slash menu offers no block there, and a block that arrives
  another way (a paste) shows its label alone.
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
read-only tree, pins and Recent / Most used for members and clients, and
the task board filtered by folder.
