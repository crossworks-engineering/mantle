# Member logins

> Phase 1 of the member logins plan (dev-brain plan v3.1). A member is a user
> of the brain with the member role: users are the team. It is off by
> default: set `MANTLE_MEMBERS=1`.
> What a member may read is decided by Postgres row security at the team level
> ([access-levels.md](./access-levels.md)), never by a check in each route.

## 1. The model

- **Two roles.** `auth.users.role` is `admin` or `member` (migration 0162).
  The anchor (`is_owner`) is always an admin. The role is read from the login
  row on every request, never from a token, so a change takes effect at once.
- **Users are the team** (Jason, 2026-09-26). A login with role member IS
  the team member: it needs no contact, and its display name (else the part
  of its email before the @) is how the agent and the admin see it. Contacts
  are plain contacts; the old team switch and team codes on contacts belong
  to the team portal, which is being retired. `auth.users.contact_id` is an
  optional link, no longer required.
- **Users are contacts in user form.** Every active login's email counts in
  both email gates, inbound (`loadContactGate`) and outbound (the send
  tools), next to the contact list. A disabled login's address does not.
- **Disabled.** `auth.users.disabled_at` set = the login cannot sign in,
  refresh a bearer or use a session it holds. Locking a login out (demote or
  disable) also revokes its mobile bearers and its MCP connector (OAuth)
  grants, and drops its unclaimed pairing codes. Deleting a login deletes all
  of them (FK cascade). Push devices are keyed to the brain, not a login, and
  are not touched.
- **Connector grants belong to a login.** An OAuth grant carries the login
  that consented (`actor_id`, migration 0164). The MCP bearer check, the code
  exchange and every refresh re-read that login: a grant works only while it
  is an admin that is not disabled. Grants made before 0164 are attributed to
  the anchor.
- **Web only.** The mobile companion calls admin routes only, so its login
  (`/api/auth/mobile-login`) refuses a member (403 `member-login`) and mints
  no token. A member signs in from a browser.
- **The flag.** With `MANTLE_MEMBERS` off, a member row resolves to no session
  at all, and no member login can be created.

## 2. Deny by default

- Every admin gate (`getOwnerOr401`, `getOwnerOr401WithSource`,
  `getSessionUser`, `requireOwner`, `getOwnerForAsset`) refuses a member: a
  403 with `reason: 'member-login'`, or no session.
- A member reaches only the routes in `MEMBER_ROUTES`
  (`server/web/lib/auth/member-routes.ts`). Each calls `getMemberOr401` (or
  `getMemberForAsset` for bytes) and reads inside `withViewer('team', …)`.
  `MemberCaller` has no `.id`, so the anchor-scoped call sites cannot take a
  member by mistake.
- `server/web/server/member-sweep.test.ts` drives every manifest route with a
  member session and proves each route not listed refuses it; it also proves
  an admin is refused on every member route.
- A member route is always member-specific. Never put a shared owner route on
  the list.

## 3. What a member can do (Phase 1)

| Route                           | What                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/member/shell`         | Who is signed in, the brain's brand, a member asset token              |
| `GET /api/member/library`       | Team-level pages, notes, drawings, tables, files (see below)           |
| `GET /api/member/library/:id`   | One item with its published body                                       |
| `GET /api/member/files/:id`     | File bytes (`?thumb=1` for a thumbnail); `?at=` works for `<img>` srcs |
| `GET /api/member/draws/:id/svg` | A drawing's committed SVG                                              |
| `GET /api/member/chat`          | The member's own thread with the team-level agent                      |
| `POST /api/member/chat`         | Send a message; the reply lands in the thread                          |

The Library LISTS only items set to exactly Team. Row security lets the team
role read client- and public-level items too, and those stay readable by id
(a link inside a team page opens them) and by the team agent. But an open
link makes an item client or public, often as a side effect (the agent
emailing a page with a link), so listing every such item to every member is
not something an owner chose. To list an item to members, set it to Team.

- **Chat** happens in the owner app's assistant dock (jackdaw v0.6.146+),
  with its three shapes (side column, movable window, full display): for a
  member the dock renders the member's own thread over these two routes. It
  uses `team-responder`, and only once an admin has set it below
  admin (access-levels.md §5): members chat only with team-level agents, and
  the turn engine refuses an admin agent for a member (`assertMemberAgent`).
  One thread per login (`team_messages.login_id`, migration 0163), never in
  the owner's assistant stream. A member's rows carry the login and no
  contact (migration 0167). Limits per login: 6 messages a minute and the
  team daily cap. The admin reads member chats in `/team-admin` > Member
  chats (`GET /api/team-admin/member-chats`) and with the `team_chat_list` /
  `team_chat_read` tools (`loginId`).
- **Not yet:** attachments in chat. Own items: section 5; review by an
  admin: section 6; running apps: section 7.

## 4. Turning it on for a brain

1. Set `MANTLE_MEMBERS=1` in the box's `.env` and roll.
2. Set item levels and lower `team-responder` to team (access-levels.md §5).
3. Settings > Users: create a user with role member, and hand the person
   their email and password.

## 5. Personal spaces (Phase 2)

Every login has a personal space: a row in `spaces` (migration 0165), made
with the login by a trigger. `nodes.owner_id` points at a space: the brain
(one row whose id is the anchor login's id, so no brain row changed) or a
personal space. Every brain path filters on the brain id, so a personal item
is invisible to the brain from its first row: never indexed, embedded,
extracted or compiled into Recall. The ingest trigger skips it,
`notifyNodeIngested` and `isBrainOwnerId` refuse inside a space scope, and the
extractor gate checks the owner.

**Three sources** a member reads:

| Source      | What                                                  | Scope                                  |
| ----------- | ----------------------------------------------------- | -------------------------------------- |
| Mine        | the member's own items, drafts included               | `withSpace` (personal-space role)      |
| Team drafts | other members' items shared with the team, saved only | `withTeamDrafts` (team role, human on) |
| Library     | brain items set to team                               | `withViewer('team')`                   |

**The personal-space role.** `mantle_view_space` is a fourth limited LOGIN
role. `withSpace({ spaceId, loginId }, fn)` runs `fn` in one short
transaction on it that sets `mantle.space_id` and `mantle.login_id`; `db`
returns that transaction. Its row rules (0165) show and accept only that
space's rows, workspace kinds only, level always admin (a personal item
carries no level). Drafts are readable there: they are the member's own
working copy. Column grants cannot differ per row, which is why this is its
own role and not the team role: the team role never reads a draft column.

**Team drafts** are visible only to the team role with `mantle.human` on
(`withTeamDrafts`): a member's own request. No agent path sets the flag, so a
team-level agent never reads anyone's drafts. Published columns only.

**Sharing and review** live in `space_items` (one row per personal item):
`sharing` private or team, `review_state` draft, submitted, returned,
accepted. Submit sends the SAVED version (unsaved edits refuse); a submitted
item is FROZEN: the row rules refuse every write until Accept, Return or
Recall. Recall (the author, before Accept) puts it back to draft. The member
can never set accepted.

**Routes** (all in `MEMBER_ROUTES`, all through `inMySpace` or
`withTeamDrafts`):

| Route                                           | What                                                |
| ----------------------------------------------- | --------------------------------------------------- |
| `GET/POST /api/member/space`                    | List Mine; create a page, note, drawing, table      |
| `GET/PATCH/DELETE /api/member/space/:id`        | One item with its body; rename; delete              |
| `PUT /api/member/space/:id/draft`               | Autosave `{ doc \| scene \| table \| ops, if_rev }` |
| `POST /api/member/space/:id/save`               | Save version `{ doc \| scene, if_rev, svg? }`       |
| `POST /api/member/space/:id/share`              | `{ sharing: 'private' \| 'team' }`                  |
| `POST /api/member/space/:id/submit`             | Submit the saved version for review                 |
| `POST /api/member/space/:id/recall`             | Take a submitted item back                          |
| `POST /api/member/space-files`                  | Upload a file (multipart, one `file` part)          |
| `GET /api/member/space/:id/bytes`               | An own file's bytes (`?thumb=1`: thumbnail)         |
| `GET /api/member/team-drafts[/:id]`             | Teammates' shared items, saved version only         |
| `GET /api/member/team-drafts/:id/bytes`         | A teammate's team-shared file                       |
| `GET/POST /api/member/space/:id/comments`       | The thread on an own item (shared or submitted)     |
| `DELETE …/space/:id/comments/:commentId`        | Remove an own comment                               |
| `GET/POST /api/member/team-drafts/:id/comments` | The thread on a teammate's shared item              |
| `DELETE …/team-drafts/:id/comments/:commentId`  | Remove an own comment                               |
| `GET /api/member/realtime`                      | SSE: own and team-shared item changes               |

The draft and save routes keep the owner routes' etag contract (`if_rev` in,
`draft_rev` out, 409 with `current_rev`). State refusals answer 409 with a
`reason` (`frozen`, `not-draft`, `not-submitted`, `unsaved-draft`, `quota`,
`embed`, `not-shared`); an empty comment is a 400 (`invalid`); another
member's item is a plain 404.

A table's draft takes a whole `table` document or an `ops` batch (the owner
op schema); Save version publishes the draft workbook. `GET …/:id?tab=` picks
a table's tab (unknown = the first).

**Where the bytes live.** A personal table's workbook sits under
`TABLE_DB_DIR/<spaceId>/` (tables were already keyed by owner). A personal
file's bytes sit under `MANTLE_SPACES_ROOT/<spaceId>/files/<nodeId>`: its own
bind mount (`/data/spaces` in docker-compose.yml, mounted into web and api),
deliberately outside the brain's files tree, so the files watcher never sees
it. The file node's path is `space_files`, not under `files`, so every brain
file helper resolves no disk path for it. The filename is metadata (a rename
touches no disk). `scripts/db-dump.sh` and the scheduled backup tar the root
to `backups/mantle-spaces-<ts>.tgz`; `scripts/db-restore.sh` puts it back with
the dump. Only web, api and the events worker (which runs the scheduled
backup, read-only mount) carry `MANTLE_SPACES_ROOT`; a production process
without it answers member uploads 503 instead of writing into the container.
A delete unlinks the bytes only after the space transaction commits, and a
create that rolls back removes the bytes it wrote.

**The embed rule.** Save version refuses an item that embeds or links
anything other than the member's own items and Library items (409 `embed`
with the refused `ids`): never another member's item, shared or not, and
never an admin-only brain item. Accept (Phase 4) moves an item's embed
closure into the brain, so a foreign id would drag someone else's work
along. It reads every reference (`packages/content/src/embed-refs.ts`): on a
page every node's `nodeId`, `drawId` and `pageId`, mention chips, and every
`src` and `href` on a node or a mark (the app's schemes `page:`, `media:`,
`draw:`, `mention:node:`, and every id in a relative path such as `/n/<id>`
or a member bytes URL); a note's markdown the same way, on every change (a
note has no draft); a drawing's element links; a table's text cells that are
a path or an app scheme. Refused outright: an id that is not a uuid, an
entity mention (no member can read entities), an external image or embedded
frame (a tracking pixel on teammates and the reviewer), and any other scheme.
A plain external link is fine. Autosave is not checked; the draft is the
author's alone.

**Drafts stay the author's.** Below admin nothing reads a table's draft
workbook: not a teammate, not a Library reader, not a team-level agent's
table tools (`loadDocsFromFile` and the tools' `windowFile` read the
published file unless the scope may read drafts).

**Limits.** 2000 items per space; a page document at most 2 MB; a table
document at most 5 MB per request (bigger grids go by op batches); drawings
use the owner's scene and SVG limits. Files: 100 MB per upload, 2 GB per
space (file bytes plus table workbooks, unsaved drafts included), 500 MB of
uploads a day. The daily cap reads an upload ledger (`space_uploads`,
migration 0169), so deleting a file does not give its bytes back to today's
budget. The upload route compares Content-Length with the space's headroom
before it spools a byte, and a table draft is refused once the space is
full. Every quota check takes a per-space advisory lock, so two parallel
writes cannot both pass the same headroom.

**Deleting a login** leaves its space and items behind (`login_id` goes
null); deleting a space deletes its rows, never its bytes on its own. A
DEACTIVATED login's private items are purged after 30 days, rows and bytes
(section 6).

**Rollback.** 0165 is safe under older code: the brain row keeps every
existing owner id valid. Once personal items exist, never roll back below
v0.232.255 (the extractor's owner check).

**Comments** (migration 0168). The author comments while an item is shared
with the team or submitted (409 `not-shared` otherwise); a teammate while it
is shared. Threads are stored with the brain's id as owner, so they survive
Accept. Row security holds the reads: the space role sees the threads on its
own items, the team role with the human flag the threads on teammates'
shared items, and nothing below admin ever sees a brain item's thread. A
teammate's comment is written on the admin pool (`asSystem`) in one
statement whose own condition is the proof (the item's sharing row, locked):
an unshare or delete cannot slip in between, and the change event commits
with it. The team role never writes.

A thread is split by audience (migration 0171, `thread_scope`): what anyone
writes while the item is shared is the team's; what the author writes while
it is private and submitted is review talk, and teammates never read it,
even after the item is shared later. A teammate can always delete their own
comment, also after an unshare. An image's thumbnail is cached inside its
own space (`<space>/thumbs`, by node id) and removed with the file.

**Live changes.** Every personal-space action (create, Save version, share,
submit, recall, delete, a comment) raises `space_item_changed` inside its
own transaction, so only committed changes are announced. The payload is
ids and flags only. `GET /api/member/realtime` passes an event to a member
when the item is in their own space or is (or just was) shared with the
team: `{ type: 'space_item', id, kind, own }`. The client reloads.

**Agents, on behalf of** (plan 2e). `my_items_list` and `my_item_open` (in
`team-read`) read the personal items of the member a team turn serves. The
member is the turn's own login, stamped on the team surface by the server,
never named by the model; any other surface (an owner turn, a heartbeat, a
run, MCP) finds nothing. Each call opens its own short space transaction
(`mantle_personal_space(login)` maps the login to its space). Read, never
learn: no search by meaning over personal items.

Admins never see a member's private items, and that holds for the chat too
(migration 0170). A team reply whose turn used a my-space tool, or that
follows such a reply in the history the model saw, is marked `used_private`;
the admin readers (the Member chats tab, `team_chat_read`, the
`team_chat_list` preview) show a placeholder instead of its text, while the
member reads their own thread in full. The my-space tool results are not
journaled by the durable engine and never spill to the tool-result store.
The durable engine's own step log still holds each model round's output
(the reply as written), which no admin screen shows; it is database-level
state only.

**In the client** (jackdaw v0.6.146+) a member edits own pages, notes,
drawings and tables in Mine over these routes. A personal drawing keeps no
images (the routes store no scene files); a table edits one tab at a time
with no import, tab editing or cross-tab references. The page editor keeps
`@` as plain text for a member: there is no member mention source yet.

## 6. Review and accept (Phase 4)

**What an admin sees of a space.** Exactly two things, named in every query
of `packages/content/src/member-review.ts` (the admin pool bypasses row
security, so the rule lives in the query): an item SUBMITTED for review, and
an item a deactivated (or deleted) login left SHARED with the team. Never a
private item: every review route answers an id of a private item, of a
recalled item and of one another admin already handled with the same 404,
so nothing tells them apart. Chat replies marked `used_private` stay
redacted for admins (section 5).

**Routes** (owner only, `/team-admin` > Review in the client):

| Route                                               | What                                             |
| --------------------------------------------------- | ------------------------------------------------ |
| `GET /api/team-admin/submissions`                   | The queue: submitted (oldest first), left behind |
| `GET /api/team-admin/submissions/:id[?tab=]`        | The saved body (never a draft) and the thread    |
| `GET /api/team-admin/submissions/:id/bundle`        | What Accept would move, links that stay behind   |
| `GET /api/team-admin/submissions/:id/bytes[?node=]` | The file, or a file in its bundle (`?thumb=1`)   |
| `GET /api/team-admin/submissions/:id/svg[?node=]`   | A drawing's saved SVG, or one in its bundle      |
| `GET/POST /api/team-admin/submissions/:id/comments` | The thread; the reviewer's review talk           |
| `DELETE …/submissions/:id/comments/:commentId`      | Take back an own review comment                  |
| `POST /api/team-admin/submissions/:id/accept`       | `{ audience?, parentPageId?, folderPath? }`      |
| `POST /api/team-admin/submissions/:id/return`       | `{ note }`: back to the author                   |
| `POST /api/team-admin/submissions/:id/discard`      | Delete a left-behind item (inactive author only) |

**The thread.** The reviewer writes review talk (`thread_scope` 'review',
author kind `owner`): the author reads it in their own thread, teammates
never do. The admin reads the review talk, plus the team's comments while
the item is shared with the team. Comments are open while the item is
submitted.

**Return** puts a submitted item back to `returned` with the note (the
member sees it as a banner, edits, and submits again).

**Accept** (plan 6.2) is one transaction per bundle. The bundle is the item
plus everything that renders inside it, repeated until nothing new joins:
`embed-refs.ts` splits every reference into EMBEDS (an id, `src` or `href`
on a node: an image, a file embed, an embedded drawing or child page; a
drawing's file refs) and LINKS (a link mark, a mention chip, a drawing's
element link, a table cell). Embeds of the author's own items move; links
stay where they are, and the dialog says how many point at items that stay
in a personal space. Every moved item keeps its node id (links stay valid),
goes to the brain at the level the admin picks (admin by default), loses any
leftover draft, and its `space_items` row goes to `accepted` with the
reviewer (the row stays: it records the author). A page lands at the top of
Pages or under a chosen brain page; files land in a chosen Files folder
(`files` by default) under a safe, unique name. Bytes move beside the rows:
a file is copied into the folder under a dot name the files watcher ignores,
renamed into place after the commit, and its space copy removed; a table's
workbook is snapshotted into `TABLE_DB_DIR/<brain>/` and the old one removed
after the commit. A rollback removes what was staged. Accept is the ONE
place a personal item is announced to the extractor: once per moved item,
inside the transaction, so it is heard only on commit. A Recall that lands
first wins (Accept then answers 404). A DB test walks every table with an
`owner_id` column and asserts no row keeps the space as owner of a moved
item (the owner-copy registry).

**Deactivation** (plan 6.4). Deactivate a login in Settings > Users (never
delete it). Its sessions stop at once. What it shared with the team, and
what it submitted, shows up in the Review queue as "left behind": accept or
discard. Its private items are purged 30 days after the deactivation by the
nightly `space-purge` maintenance task (`pnpm -C server/web space:purge`
for a dry run, `--apply` to run it by hand): rows and bytes, counts only,
never titles. A space the purge leaves empty loses its
`MANTLE_SPACES_ROOT/<space>` and `TABLE_DB_DIR/<space>` directories (audit
D6). The purge refuses to run where the spaces root is missing or
read-only, so it never deletes rows and keeps their bytes. A login enabled
again before the 30 days keeps everything.

**Not yet:** the author's own list of what was accepted (the item leaves
Mine on Accept; accepted at team or above, the author finds it in the
Library), read access for the author to an item accepted at admin (plan
6.2: another of their items that shows an accepted image then shows it
broken), a "member-authored" badge on accepted items.

## 7. Apps for members (Phase 4b)

A member RUNS apps. A member never creates, edits, builds, publishes, shares
or deletes one: every `/api/apps/*` route stays admin only, and none is on
`MEMBER_ROUTES`. What a member may run: an app at **team level or lower**
with a green **published** build, never a draft
(`packages/content/src/member-apps.ts`). The rule is written in each query
and the routes read on the team role as well, so both locks hold. Set an
app's level in its Access control; nothing else lists it to members.

| Route                                    | What                                               |
| ---------------------------------------- | -------------------------------------------------- |
| `GET /api/member/apps`                   | The apps the member may run, and the home app id   |
| `POST /api/member/apps/:id/frame-ticket` | A seconds-lived frame ticket that names the login  |
| `GET /api/member/apps/:id/frame?t=`      | The frame document: the PUBLISHED build            |
| `POST /api/member/apps/:id/tool-broker`  | `host.tools.call()` (rules below)                  |
| `POST /api/member/apps/:id/db-broker`    | `host.db.query` / `host.db.exec` on the app SQLite |
| `GET /api/member/home`                   | The home app and what its `host.hub.get()` answers |

- **The frame.** A sandboxed iframe sends no cookie, so the member mints a
  ticket (`mem` = the login) and the frame URL carries it. Only the member
  frame route accepts a member ticket, and it re-checks that the login is
  still an active member and the app still one they may run. The owner
  frame route, which serves the draft, refuses a member ticket.
- **Tools** (`packages/tools/src/member-app-tools.ts`, checked per call,
  since `dispatchTool` checks none of this): the app declares the tool
  (`manifest.toolSlugs`); it is a built-in (no http, shell, recipe or MCP
  tool); it needs no confirmation; an ENABLED tool group at team level or
  lower holds it; and it is not one of `my_items_list` / `my_item_open` (an
  app could copy the member's private items into shared app data),
  `summarize_text` (LLM work), `team_request_create` (a chat turn's write) or
  `read_result`. The call runs on the team role, on a team surface that
  names the login, with the private corpus off: row security decides what
  it reads, and team refusals apply. `app_tools_set` returns `warnings` for
  every declared tool a team-level app's members would be refused.
- **Data.** Row security does not reach SQLite, so the db broker checks the
  app itself (team level or lower, published) before it opens the database.
  Team apps may write, as team-mode shares do. App data is shared per app,
  not per member (v1): every member reads and writes the same database. The
  SQLite work runs on the admin pool (it writes the app's registry rows).
- **Cost.** A member write into an app table that is exported to the brain
  schedules the export sync (debounced, hash-gated): bounded, not zero
  (decided 2026-09-26). Exported tables stay admin level. Nothing else a
  member app does starts LLM work.
- **Audit.** Every ticket, tool call and database call lands in the app's
  access log with the login (`app_access_log.actor_id`, migration 0172); the
  app's Activity tab shows the member's name.
- **Team chat** (`app_db_list` / `app_db_query` in `team-read`) reads the
  data of team-level apps only, the same level rule.
- **Home app.** The brain's pinned hub app (Team admin > Settings, the
  `teamHubAppId` pref) is the members' home app while they may run it: no
  share is needed, the level is the access. Otherwise the member home shows
  its built-in view. Its `host.hub.get()` answers from `/api/member/home`: the
  site name, the member's name, the newest team pages as sections (a
  section's `token` is the page id) and Library counts. The `/team` portal
  hub keeps its own rules (a team-mode share) until it is retired.
