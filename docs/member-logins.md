# Member logins

> Phase 1 of the member logins plan (dev-brain plan v3.1). A member is a user
> of the brain with the member role: users are the team. Member logins are
> always on (Phase 6 removed the `MANTLE_MEMBERS` flag).
> What a member may read is decided by Postgres row security at the team level
> ([access-levels.md](./access-levels.md)), never by a check in each route.
> Client logins (a person at the brain's one client company) have their own
> operator guide: [client-logins.md](./client-logins.md); what members and
> admins meet of them is section 14 here.

## 1. The model

- **Three roles.** `auth.users.role` is `admin`, `member` (migration 0162)
  or `client` (client logins, migration 0187; section 2). The anchor
  (`is_owner`) is always an admin. The role is read from the login row on
  every request, never from a token, so a change takes effect at once.
  The column has no default (migration 0190): every insert names the role
  (first-run signup, Settings > Logins, member invites, client logins), and
  an insert without one fails on NOT NULL. Until 0190 a forgotten role made
  an admin.
- **Users are the team** (Jason, 2026-09-26). A login with role member IS
  the team member: it needs no contact, and its display name (else the part
  of its email before the @) is how the agent and the admin see it. Contacts
  are plain contacts; the old team switch and team codes on contacts belonged
  to the team portal, retired in Phase 6 (section 9). Team codes are gone
  (migration 0178): an old code opens nothing and redeems nothing, and an
  invite link is the only way in. `auth.users.contact_id` is an
  optional link, no longer required. When set it must be a contact of this
  brain, and a contact links to one login at most: a second login on it is
  a 409. Since migration 0181 a partial unique index on
  `auth.users.contact_id` makes that a rule (two links at once: the loser
  gets the same 409). 0181 stops, naming the contact ids, on a box that
  already holds two logins on one contact: unlink the extra login
  (`PATCH /api/users/:id` `{ "contactId": null }`) and upgrade again.
- **Users are contacts in user form.** Every active login's email counts in
  both email gates, inbound (`loadContactGate`) and outbound (the send
  tools), next to the contact list. A disabled login's address does not.
- **Sessions end (migration 0181, final audit F06).** The session cookie
  and the `?at=` asset token carry the login's `auth.users.session_epoch`,
  signed, and every request compares it with the row; bearers
  (`mobile_tokens`) are rows and are revoked by row. `endLoginSessions`
  (lib/auth/session.ts) bumps the epoch and revokes the login's bearers, so
  every session the login holds ends on its next request. It runs on:
  - a password change (`POST /api/auth/change-password`): the device that
    asked stays signed in (a cookie caller gets a fresh cookie, a bearer
    caller keeps its own bearer; every other bearer is revoked);
  - an admin password reset (`POST /api/users/:id/password`);
  - disable, and enable again (so a copied cookie cannot come back), and a
    role change (`PATCH /api/users/:id`; the same role again changes
    nothing);
  - sign out everywhere: `POST /api/auth/logout` `{ "everywhere": true }`
    for the login's own sessions, and `PATCH /api/users/:id`
    `{ "signOut": true }` for an admin ending another login's.

  A cookie minted before 0181 carries no epoch and counts as 0, so existing
  sessions keep working until the login's first bump. MCP connector (OAuth)
  grants are not sessions: only a lockout (below) revokes them.

- **Disabled.** `auth.users.disabled_at` set = the login cannot sign in,
  refresh a bearer or use a session it holds. Locking a login out (demote or
  disable) also:
  - revokes its mobile bearers and its MCP connector (OAuth) grants;
  - drops its unclaimed pairing codes, and a code claimed anyway mints
    nothing: the claim re-reads the login and pairs only a live admin;
  - removes the push devices it enrolled and tells the push relay
    (`push_subscriptions.login_id`, migration 0173; devices enrolled before
    0173 are attributed to the anchor);
  - releases its personal assistant (the agent is kept as a shared agent,
    never deleted).

  Deleting a login removes its push devices the same way (the relay is
  told), and its bearers, codes, grants and devices go by FK cascade.

- **Connector grants belong to a login.** An OAuth grant carries the login
  that consented (`actor_id`, migration 0164). The MCP bearer check, the code
  exchange and every refresh re-read that login: a grant works only while it
  is an admin that is not disabled. Grants made before 0164 are attributed to
  the anchor.
- **Web only.** The mobile companion calls admin routes only, so its login
  (`/api/auth/mobile-login`) refuses a member (403 `member-login`) and mints
  no token, and QR pairing is admin-only. A member signs in from a browser.
- **No personal assistant.** A member chats only with team-level agents, so
  `PUT /api/users/:id/agent` refuses a member login (400), and demoting a
  login releases the assistant it had.
- **No MCP connectors.** The OAuth consent step answers a member with a
  plain refusal page (403); only an admin can connect a client.
- **No flag.** Member logins are always on (Phase 6). Until then a box had to
  opt in with `MANTLE_MEMBERS=1`; the flag is gone, and a login row that is
  not disabled and has an email holds a session whatever its role.
  `GET /api/users` answers `{ users, currentActorId }`; the
  `membersEnabled: true` it kept one contract cycle after the flag went is
  gone (no paired client reads it since jackdaw v0.6.162).

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
- **Three roles, fail closed** (client logins, Phase C0). A login is an
  admin, a member or a client (a person at the brain's one client company;
  client logins are built in phases: the CHECK admits client from Phase
  C1's migration, and an admin makes one with a sign-in link from Phase
  C2; the operator guide is [client-logins.md](./client-logins.md)). The
  session code names each role (`resolvedFor` in lib/auth/session.ts is a
  switch with `default: null`): a role it does not know is no login
  at all, never an admin. Every admin gate takes an
  admin and nothing else, and every member gate a member: a client gets 403
  `client-login` from both. Password sign-in (`/api/auth/login`, the
  mobile and bearer logins), `POST /api/auth/change-password`, a
  personal assistant (`PUT /api/users/:id/agent`, admins only) and MCP
  consent are refused to a client; `PATCH /api/users/:id` refuses a role
  change to or from any role but admin and member, and counts any role but
  admin as a lockout. An admin password reset
  (`POST /api/users/:id/password`) on a client, or on a role the code does
  not know, answers 400 with `reason: 'not-a-password-login'`; a member's
  reset still works (it is a member's only way back in), and jackdaw hides
  Reset password on client rows. Token refresh
  (`POST /api/auth/token/refresh`) rotates admin and member bearers only: a
  client never holds a bearer. `server/web/server/role-sweep.test.ts` drives every
  manifest route, member routes included, with a client login (each
  refuses it) and with an unknown role (each answers as to a stranger).
  Public routes that read a session themselves (password change, sign
  out, pairing, SSO, MCP consent, the client link, token refresh, the print
  pages) have no gate in front of them: each is
  listed with an answer per role in
  `server/web/server/public-session-routes.ts`, and the sweeps drive it. A
  completeness test reads every other public route's source, so a new one
  that reads a session must be added there.
- The sweep also proves the positive half: a member session gets past the
  gate on member routes, and a member `?at=` asset token
  (`getMemberForAsset`) is refused when it was minted under another anchor,
  for a disabled member, or for an admin login.

## 3. What a member can do (Phase 1)

| Route                           | What                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `GET /api/member/shell`         | Who is signed in, the brain's brand, a member asset token            |
| `GET /api/member/library`       | Team-level pages, notes, drawings, tables, files (see below)         |
| `GET /api/member/library/:id`   | One item with its published body                                     |
| `GET /api/member/files/:id`     | File bytes, streamed, rate limited per login; `?thumb=1`, `?at=` too |
| `GET /api/member/draws/:id/svg` | A drawing's committed SVG, with only the images the member may read  |
| `GET /api/member/chat`          | The member's own thread with the team-level agent                    |
| `POST /api/member/chat`         | Send a message; the reply lands in the thread                        |

The Library LISTS team and client items only, each row with its level
(client logins decision 6, C2: members see what clients see; the app marks a
client item with a Client badge). Row security lets the team role read
public-level items too, and the team agent reads them. But an open link
makes an item public, often as a side effect (the agent emailing a page with
a link), so listing every such item to every member is not something an
owner chose: public items stay out of the Library list. A member still
OPENS a public item by id (`GET /api/member/library/:id`): anyone with its
link can read it, so hiding it from staff helped nobody. It opens without a
Client badge (a client does not read it). To list an item to members, set
it to Team (or Client, when clients should read it too).

- **Chat** happens in the owner app's assistant dock (jackdaw v0.6.146+),
  with its three shapes (side column, movable window, full display): for a
  member the dock renders the member's own thread over these two routes. It
  uses `team-responder`, and only while an admin has set it to team
  (access-levels.md §5): members chat only with a team-level agent, and the
  turn engine refuses any other level for a member (`assertAgentForRole`;
  client and public agents serve other logins, client-logins.md §8).
  One thread per login (`team_messages.login_id`, migration 0163), never in
  the owner's assistant stream. A member's rows carry the login and no
  contact (migration 0167). Limits per login: 6 messages a minute, the
  daily turn cap (`TEAM_CHAT_DAILY_TURNS`, default 100) and a daily token
  budget (`MANTLE_MEMBER_DAILY_TOKENS`, model tokens in plus out, default
  2,000,000, 0 = off). Both daily limits are checked when the turn is QUEUED:
  the route writes a row to the turn ledger (`member_turn_ledger`, migration 0182) before the enqueue and counts those rows, so turns waiting on a busy
  queue count; the token budget sums the login's `responder_turn` traces
  since midnight UTC (a turn's tokens land when it finishes, so turns
  already queued can pass it by a few). A refusal is a 429 with `reason`
  `daily_cap` or `token_budget`, logged as `denied`. Member turns run on
  their own queue (`MEMBER_TURN_QUEUE`, `MANTLE_MEMBER_TURN_CONCURRENCY`,
  default 2), never ahead of the owner's turns. A NUL in the text is
  stripped. A retry with the same `Idempotency-Key` is the same turn, counted
  once; the same key with different text is a 409. The admin reads member chats in `/team-admin` > Member
  chats (`GET /api/team-admin/member-chats`) and with the `team_chat_list` /
  `team_chat_read` tools (`loginId`). The roster names each login's role:
  every member login, and a client login that has a chat thread, listed
  with role client, never as a team member (it is never shown active
  there). A login invited from a team contact
  also shows that contact's old portal chat there, apart (section 9,
  "History"); it never enters the member's own thread.
- **Drawing images.** A saved SVG carries its images' bytes inline, so the
  member copy keeps an image only when its file passes the files route's
  rule (team level or lower, or the member's own accepted file); any other
  image, an admin screenshot in a team drawing say, is taken out and its
  frame shows empty (`packages/content/src/member-draw-images.ts`).
- **Not yet:** attachments in chat. Own items: section 5; review by an
  admin: section 6; running apps: section 7.

## 4. Setting a brain up for members

Member logins are always on; there is nothing to switch on (Phase 6 removed
the `MANTLE_MEMBERS` flag).

1. Set item levels and lower `team-responder` to team (access-levels.md §5).
   Its shipped prompt speaks to a member login in their own chat; a brain
   whose team-responder prompt was never edited gets it on upgrade (section
   9, "The team portal is retired").
2. Invite the person (section 9): pick their contact, or type an email, and
   hand them the invite link. They set their own password and are signed in.
   An old team code no longer works (migration 0178): send an invite link,
   also to a person who used to hold a code.
3. Or, as before: Settings > Users, create a user with role member, and hand
   the person their email and password.

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
Before it opens the transaction, `withSpace` reads the login row
(`spaceLevelForLogin` in `packages/db/src/client.ts`) and refuses a space
that is not the login's own (`spaces.login_id`), a disabled login and a role
the code does not know.

**Team drafts** are visible only to the team role with `mantle.human` on
(`withTeamDrafts`): a member's own request. No agent path sets the flag, so a
team-level agent never reads anyone's drafts. Published columns only.

**Sharing and review** live in `space_items` (one row per personal item):
`sharing` private or team, `review_state` draft, submitted, returned,
accepted. A client's items are never shared with the team: the database
trigger `space_items_client_private` (migration 0189) refuses `sharing`
team on a client's item, so a client's work stays private until it is
submitted. Submit sends the SAVED version (unsaved edits refuse); a submitted
item is FROZEN: the row rules refuse every write until Accept, Return or
Recall. Recall (the author, before Accept) puts it back to draft. The member
can never set accepted.

**The submitted bundle** (migration 0180, audit F04). What renders inside a
submitted item (an embedded drawing or file, a child page: section 6) is
frozen with it. Submit works out the bundle from the saved versions and
refuses with 409 `unsaved-draft` and the `ids` when any item in it has
unsaved edits (save a version of each first). It then records the bundle in
`space_item_bundles` (root first, in bundle order), and the frozen rule
follows it: `mantle_space_item_frozen` in the row rules, and
`assertEditable` in the app, which names the submitted item in its 409
`frozen` (`ids` holds its id). An item frozen this way cannot be submitted
on its own either. Recall, Return and Accept remove the record; the space
role can write it only while the root is not submitted, so the author
cannot unfreeze anything by dropping it. Submit locks the state row and the
bundle's rows first (the same row locks every draft write takes), so an
autosave from a second tab cannot land between the check and the change; a
Submit or Recall that loses a race to another request answers 409 (or 404
when an Accept moved the item), never a stale 200. An item submitted before
0180 has no record: only the item itself is frozen, and Accept works its
bundle out at accept time, as before.

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
| `GET /api/member/space/:id/bytes`               | An own file's bytes (`?thumb=1`: thumbnail; `?at=`) |
| `GET /api/member/team-drafts[/:id]`             | Teammates' shared items, saved version only         |
| `GET /api/member/team-drafts/:id/bytes`         | A teammate's team-shared file (`?at=` too)          |
| `GET/POST /api/member/space/:id/comments`       | The thread on an own item (shared or submitted)     |
| `DELETE …/space/:id/comments/:commentId`        | Remove an own comment                               |
| `GET/POST /api/member/team-drafts/:id/comments` | The thread on a teammate's shared item              |
| `DELETE …/team-drafts/:id/comments/:commentId`  | Remove an own comment                               |
| `GET /api/member/realtime`                      | SSE: own and team-shared item changes               |

The draft and save routes keep the owner routes' etag contract (`if_rev` in,
`draft_rev` out, 409 with `current_rev`). State refusals answer 409 with a
`reason` (`frozen`, `not-draft`, `not-submitted`, `unsaved-draft`, `quota`,
`embed`, `not-shared`, `too-large`: a bundle of more than 200 items); an
empty comment is a 400 (`invalid`); another member's item is a plain 404.
An own item an admin has TAKEN OVER (section 11) is no longer in the space:
`GET /api/member/space` lists it on page 1 as a `with-admin` row (title and
kind only), and every `/api/member/space/:id…` route answers it 409
`with-admin`, with no content and no bytes.

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
the dump. Four services carry `MANTLE_SPACES_ROOT`: web, api, the events
worker (which runs the scheduled backup, read-only mount) and the maintenance
worker (the nightly space purge deletes a deactivated login's bytes); a
production process without it answers member uploads 503 instead of writing
into the container.
A delete unlinks the bytes only after the space transaction commits, and a
create that rolls back removes the bytes it wrote.

**The embed rule.** Save version refuses an item that embeds or links
anything other than the author's own items and the brain items the
author's level reads (409 `embed` with the refused `ids`): never another
login's item, shared or not, and never a brain item above the author's
level. The brain is read at the AUTHOR's level through row security: a
member's space runs at team (team, client and public items), a client's
space at client (client items only, never a team item: client logins C1). Accept (Phase 4) moves an item's embed
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
writes cannot both pass the same headroom. Every write route (the table
above: create, rename, delete, autosave, Save version, share, submit, recall,
comments, uploads) is rate limited per login, 120 a minute (429 `rate-limit`
with Retry-After; `memberWriteGate`). A NUL character anywhere in a JSON
body (a pasted `\u0000` in a note or page) is stripped before the body is
read, on the member and the admin private-space routes alike; Postgres
cannot store it, and it used to answer 500.

**Deleting a login** leaves its space and items behind (`login_id` goes
null, and a trigger stamps `spaces.orphaned_at`, migration 0180); deleting
a space deletes its rows, never its bytes on its own. A DEACTIVATED login's
private items are purged after 30 days, rows and bytes, and so are a
DELETED login's, 30 days after `orphaned_at` (section 6). A space with no
login is nobody's member space: a deleted member's shared items leave Team
drafts at once (an admin still finds them in the Review queue as left
behind, to accept or discard).

**Rollback.** 0165 is safe under older code: the brain row keeps every
existing owner id valid. Once personal items exist, never roll back below
v0.232.255 (the extractor's owner check). Once migration 0178 ran (it drops
`contact_team_tokens`), never roll back below v0.232.301: v0.232.300 still
reads that table for invite redeem and the Team admin Members tab, and both
fail. The pre-roll backup (`backups/pre-roll/`, taken by the updater before
every server roll) is the only way back past 0178.

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
never named by the model; a client's turn works the same way for the client
(client-logins.md §8); any other surface (an owner turn, a heartbeat, a
run, MCP) finds nothing. Each call opens its own short space transaction
(`mantle_personal_space(login)` maps the login to its space). Read, never
learn: no search by meaning over personal items.

Admins never see a member's private items, and that holds for the chat too
(migration 0170). A team reply whose turn used a my-space tool, or that
follows such a reply in the history the model saw, is marked `used_private`;
the admin readers (the Member chats tab, `team_chat_read`, the
`team_chat_list` preview) show a placeholder instead of its text, while the
member reads their own thread in full. Replies written before 0170 were
marked by a backfill in migration 0182 (the same rule, from the turns'
`tool: my_*` trace steps and each agent's history window). The history a
turn loads leaves out its own inbound message, so a turn the durable engine
recovers does not send the member's message twice. The my-space tool results are not
journaled by the durable engine and never spill to the tool-result store.
The durable engine's own step log still holds each model round's output
(the reply as written), which no admin screen shows; it is database-level
state only.

**In the client** (jackdaw v0.6.146+) a member edits own pages, notes,
drawings and tables in Mine over these routes. A personal drawing keeps no
images (the routes store no scene files); a table edits one tab at a time
with no import, tab editing or cross-tab references. The page editor keeps
`@` as plain text for a member: there is no member mention source yet.

- A member's item links open from any source: `/n/<id>` (the team agent's
  citations), `/pages/<id>`, `/draw/<id>`, `/notes/<id>` and `/tables/<id>`
  find the item in Mine, then Team drafts, the Library, then Accepted, read
  its kind from that answer and open it on the kind's screen. A member never
  calls `/api/nodes`.
- Autosave: a brain 5xx (not a proxy 502, 503 or 504) retries once, then
  says "The server could not save this" (not the network). The typing
  stays; the next edit tries again. While an editor holds typing it could
  not save, closing or reloading the tab asks first. Member writes drop NUL
  characters (the brain strips them too).
- A save refused as `frozen` (submitted from another tab) keeps the editor
  on screen, read-only, with the typing, until the member picks "Show it as
  it is now". Submit and Accept wait for a pending title rename first.
- The over-60 KB rescue copy in localStorage is keyed by the login, only
  that login's copies are replayed, sign-out clears them all, and boot
  sweeps expired ones.
- A table conflict after a lost ops response rebases: the brain's copy
  becomes the base, and the grid keeps typing done during the retry backoff.

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

| Route                                               | What                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/team-admin/submissions`                   | The queue: submitted (oldest first), left behind                                    |
| `GET /api/team-admin/submissions/:id[?tab=]`        | The saved body (never a draft) and the thread                                       |
| `GET /api/team-admin/submissions/:id/bundle`        | What Accept would move, what stays behind, and `closure`                            |
| `GET /api/team-admin/submissions/:id/bytes[?node=]` | The file, or a file in its bundle (`?thumb=1`)                                      |
| `GET /api/team-admin/submissions/:id/svg[?node=]`   | A drawing's saved SVG, or one in its bundle                                         |
| `GET/POST /api/team-admin/submissions/:id/comments` | The thread; the reviewer's review talk                                              |
| `DELETE …/submissions/:id/comments/:commentId`      | Take back an own review comment                                                     |
| `POST /api/team-admin/submissions/:id/accept`       | `{ audience?, parentPageId?, folderPath?, lowerConfirmed?, confirmedIds? }` (below) |
| `POST /api/team-admin/submissions/:id/return`       | `{ note }`: back to the author                                                      |
| `POST /api/team-admin/submissions/:id/take-over`    | Into the acting admin's own space (section 11)                                      |
| `POST /api/team-admin/submissions/:id/discard`      | Delete a left-behind item (inactive author only)                                    |

**The thread.** The reviewer writes review talk (`thread_scope` 'review',
author kind `owner`): the author reads it in their own thread, teammates
never do. The admin reads the review talk, plus the team's comments while
the item is shared with the team. Comments are open while the item is
submitted.

Each queue row names its author's role (`author.role`: member or client;
null when the login is gone), so the dialog knows which Accept rule applies.

**Return** puts a submitted item back to `returned` with the note (the
member sees it as a banner, edits, and submits again).

**Take over** (audit F07, section 11) moves a submitted item and its
bundle into the acting admin's own private space to work on it; it leaves
the queue. A taken item whose admin is deactivated or deleted comes back to
the queue (reviewState `taken`, reason `submitted`, or `left-behind` when
its author is gone too): Accept, Return, Take over and Discard then work on
it and on what was taken with it.

**Accept** (plan 6.2) is one transaction per bundle. The bundle
(`member-bundle.ts`) is the item plus everything that renders inside it,
repeated until nothing new joins:
`embed-refs.ts` splits every reference into EMBEDS (an id, `src` or `href`
on a node: an image, a file embed, an embedded drawing or child page; a
drawing's file refs) and LINKS (a link mark, a mention chip, a drawing's
element link, a table cell). Embeds of the author's own items move; links
stay where they are, and the dialog says how many point at items that stay
in a personal space. A submitted item moves the bundle recorded at Submit
(section 5: frozen since, so what the admin reviewed is what moves). A
left-behind item (never submitted) takes only items that are themselves
shared with the team or submitted (audit F18): its author's private embeds
stay behind, count as staying behind, and the review file and SVG routes
never serve them. The bundle's rows are locked still in the space: an item
another Accept moved first (a shared embed) is dropped, never moved twice.
Every moved item keeps its node id (links stay valid),
goes to the brain at the level the admin picks (admin by default; team by
default for an item a CLIENT wrote, client logins C1: the author reads the
accepted item from the snapshot whatever its level, so publishing one
client's request to every client login is an explicit choice). Accepting a
client-authored item at client or public needs `lowerConfirmed: true` (the
admin confirmed that it, and what it embeds, goes down to where every client
login reads it) AND the id of every brain item that goes down with it in
`confirmedIds`. The bundle preview lists those brain items in `closure`
(what the bundle embeds, transitively, at their current levels; the ones
above the chosen level go down). A missing confirmation or a missing tick
answers 409 `confirm-level` with the list in `goingDown`, checked on the
locked rows, and nothing moves. A member-authored item needs no
confirmation. The admin's own Accept after Take over
(`POST /api/admin/space/:id/accept`, section 11) follows the same rule for
an item a client wrote: team by default, and client or public only with
`lowerConfirmed` and every going-down item in `confirmedIds`. The moved item loses any
leftover draft, and its `space_items` row goes to `accepted` with the
reviewer (the row stays: it records the author), and its author's
accepted snapshot is recorded (section 11). Below admin, the brain items
the accepted item embeds (a Library image a member placed, say) go down to
its level in the same transaction: embedding means sharing
(docs/access-levels.md section 1), and the answer lists them in
`alsoLowered`. A page lands at the top of
Pages or under a chosen brain page; files land in a chosen Files folder
(`files` by default) under a safe, unique name. Bytes move beside the rows:
a file is copied into the folder under a dot name the files watcher ignores,
renamed into place after the commit, and its space copy removed; a table's
workbook is snapshotted into `TABLE_DB_DIR/<brain>/` and the old one removed
after the commit. A rollback removes what was staged. Accept is the ONE
place a personal item is announced to the extractor: once per moved item,
after the commit and after the bytes are renamed into place, so the
extractor never opens a file that is not there yet (never for a rollback).
The recorded bundle is removed. A Recall that lands first wins (Accept then
answers 404). A DB test walks every table with an
`owner_id` column and asserts no row keeps the space as owner of a moved
item (the owner-copy registry).

**Deactivation** (plan 6.4). Deactivate a login in Settings > Users (never
delete it). Its sessions stop at once, and stay stopped if it is enabled
again (the session epoch, section 1). What it shared with the team, and
what it submitted, shows up in the Review queue as "left behind": accept or
discard. Its private items are purged 30 days after the deactivation by the
nightly `space-purge` maintenance task (`pnpm -C server/web space:purge`
for a dry run, `--apply` to run it by hand): rows and bytes, counts only,
never titles. A deleted login's space is purged the same way, 30 days after
it lost its login (`spaces.orphaned_at`). The purge keeps every private
item that a shared or submitted item shows (its bundle), so nothing an
admin may still accept loses a piece; once that item is accepted or
discarded, the rest goes the next night. The purge and Discard delete only
rows still in the space: an Accept that re-owns a row to the brain at the
same moment wins, and the delete matches nothing (audit F03). Discard locks
the item's state row as Accept does. The purge never deletes a TAKEN item
(section 11): it is a member's work in an admin's space, and when that
admin's space is purged the taken items stay and are offered in the queue.

Tests: `packages/content/src/member-bundle.viewer.db.test.ts` (Postgres: the
bundle refused with unsaved edits, recorded, frozen, forgotten on Recall,
Return and Accept, and Accept moving exactly the record; left-behind
bundles; the purge keeping bundles and taking a deleted login's space; the
purge and Discard racing an Accept on a second connection; Submit and
Recall losing races) and `packages/db/src/spaces.db.test.ts` (the frozen
rule and the bundle rules in SQL, a deleted member in team drafts, EXECUTE
on the space functions). A space the purge leaves empty loses its
`MANTLE_SPACES_ROOT/<space>` and `TABLE_DB_DIR/<space>` directories (audit
D6). The purge refuses to run where the spaces root is missing or
read-only, so it never deletes rows and keeps their bytes. A login enabled
again before the 30 days keeps everything.

**What the author keeps** (plan 6.2 and 6.3, 0.232.285). Accept takes the
item out of Mine, but its `space_items` row stays and names the author, so:

| Route                          | What                                             |
| ------------------------------ | ------------------------------------------------ |
| `GET /api/member/accepted`     | The author's accepted items, newest accept first |
| `GET /api/member/accepted/:id` | One of them, as ACCEPTED, at any level           |

- **Read access, at any level, to the version accepted.** The author reads
  what they wrote even when the admin accepted it at admin, and reads it as
  it was ACCEPTED: the accepted snapshot (section 11), never the brain's
  current version, so an admin's later edits (saved or draft) stay the
  brain's. `/api/member/files/:id` and `/api/member/draws/:id/svg` fall back
  to the same rule after the team-level lookup misses, so an accepted image
  still renders in the author's other drafts, but only while the brain file
  holds exactly the bytes accepted; after an admin changed it, the file
  route is a 404 and the item says `changedByAdmin: true`. Nobody else gets
  anything new: another member, a returned or recalled item and an item of
  another brain are all a plain 404.
- **The rule lives in the query.** An item above the member's level is not
  visible to the team role and the limited roles hold no grant on
  `space_items`, so `packages/content/src/member-accepted.ts` runs on the
  admin pool and writes the rule into every query: the row names this login
  as the author, its state is `accepted`, and the item belongs to this brain.
  It refuses to run inside a viewer scope.
- **The member-authored badge.** The Library (list and item) and the admin's
  Access panel (`GET /api/access/nodes/:id`) carry `author: { name,
acceptedAt, role }` on an accepted item: the login's display name, "A
  member" without one (never the email), "Removed member" once the login is
  deleted. `role` names the author's role, and an item a client wrote shows
  "A client" without a display name, never "A member".
  An admin's own item has no author (section 10).

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
  tool); the built-in is marked read-only (an app loop has no model in
  between, so a writing or spending built-in an admin put in a team-level
  group for chat stays out); it needs no confirmation; an ENABLED tool group
  at team level or lower holds it; and neither its slug nor its built-in is
  one of `my_items_list` / `my_item_open` (an app could copy the member's
  private items into shared app data), `summarize_text`,
  `extract_from_image` and `search_chunks` (LLM work: a chat model, the
  vision model, and passage scoring calls the decider), `team_request_create`
  (a chat turn's write) or `read_result`. Beyond that list, a built-in
  flagged `spends` (it starts paid model work on a call; a read can spend)
  is refused whatever its slug; `spends-drift.test.ts` fails until every
  built-in that calls a chat, vision, speech, image, decider or web-search
  model, or delegates to an agent, carries the flag. The call runs on the team role, on a
  team surface that names the login, with the private corpus off: row
  security decides what it reads (team, client and public items), and team
  refusals apply. `app_tools_set`, `app_publish` and `access_set` on an app
  return `warnings` for every declared tool its members would be refused.
- **Data.** Row security does not reach SQLite, so the db broker checks the
  app itself (team level or lower, published) before it opens the database.
  Members read every app they may run, and write to an app at TEAM or
  CLIENT level (Jason, 2026-09-30: an app an admin sets to team or client is
  a shared workspace, for example a job log, that everyone who runs it
  writes; clients write client-level apps too) unless an admin marked it
  informational (`dataReadOnly`, then members and clients only read). A
  public app stays read-only for members, so nothing a member writes shows
  to anonymous visitors (decided 2026-09-27). Only admins create, edit,
  build, publish, share or delete apps. App data is shared per app, not per
  member (v1): every member reads and writes the same database. The SQLite work runs on the admin pool
  (it writes the app's registry rows).
- **SQL limits** (every app SQL caller: members, share links, the owner,
  `app_db_query`; `packages/content/src/app-sql-runner.ts`). Each statement
  runs in a child process, so a slow one never blocks the server: 5 seconds
  at most, 50,000 rows at most, 16 MiB per string or blob. The engine's
  authorizer refuses ATTACH, DETACH, VACUUM (any form) and every PRAGMA but
  `table_info` / `table_xinfo`, whatever comments or spacing the text hides
  them behind (audit 2026-09-27). An app's declared schema DDL runs there
  too: one script in one transaction, same authorizer, 30
  seconds at most (a new version may index data already in the app).
  Before, it ran on the main thread with only the text guard and no time
  limit. The children are a small pool (at most 4 per server process, each
  about 40 MB, one statement at a time, exiting after a minute idle; a
  statement past the pool waits for a free child up to its own time limit).
  A statement past its limit gets its child SIGKILLed, so the OS drops the
  child's locks and SQLite rolls the unfinished write back on the next open:
  the next write to that app goes straight through. Before 2026-09-28 the
  statements ran in worker threads, and a write stopped at the limit kept the
  app's write lock ("database is locked") until the web process restarted.
- **Cost.** A member write into an app table that is exported to the brain
  schedules the export sync (debounced, hash-gated, and at most two minutes
  after a burst of writes starts): bounded, not zero (decided 2026-09-26).
  Exported tables stay admin level. Nothing else a member app does starts
  LLM work.
- **Audit.** Every ticket, tool call and database call lands in the app's
  access log with the login (`app_access_log.actor_id`, migration 0172),
  refused ones included, each marked `via: member`; the app's Activity tab
  shows the member's name, or "Removed member" once the login is deleted. A
  request with a malformed body is not logged.
- **Team chat** (`app_db_list` / `app_db_query` in `team-read`) reads the
  data of apps at team level or lower (published or not), the same level
  rule. Before 0.232.281 it read apps with an active team-mode share; levels
  follow links, so on every box checked on 2026-09-27 the two sets were the
  same.
- **Home app.** The brain's pinned hub app (Team admin > Settings, the
  `teamHubAppId` pref) is the members' home app while they may run it: no
  share is needed, the level is the access. Pinning an admin-level app sets
  it to team level (`PUT /api/team-admin/hub-app` answers exactly
  `{ appId, levelChanged }`; the retired `modeChanged` alias is gone); it
  makes no share link. Otherwise the member home shows its
  built-in view, and `/api/member/home` answers `{ homeApp: null, hub: null }`.
  With a home app, `host.hub.get()` answers from that route: the site name,
  the member's name, the newest team pages as sections (a section's `token`
  is the page id), Library counts and the other apps members may run.
- **Contract.** The response shapes are published in
  `@crossworks/client-types` (`packages/client-types/src/dto/member-apps.ts`):
  `MemberAppCard`, `MemberAppList`, `MemberHomeApp`, `MemberHomeData<THub>`
  (write `MemberHomeData<HubData>`; `HubData` stays in
  `share-ui/app-bridge-protocol`) and the admin's `MemberChatsResponse`. A
  card's `audience` is `MemberAppLevel` (team, client or public). The routes
  check their bodies with `satisfies`.

## 8. The member's own chrome (Phase 5)

What the client shows a member around the workspace (jackdaw v0.6.154+). No
new brain route: each piece uses one that already served members.

- **Password.** The account menu has Change password, over
  `POST /api/auth/change-password`, which changes the signed-in LOGIN's own
  password for an admin or a member (it sits under `/api/auth`, a public
  path, and checks the session itself). Every other session of the login
  ends (the session epoch, section 1); the browser that asked gets a fresh
  cookie and stays signed in. A
  wrong current password answers 401 `Current password is incorrect.`, so
  the client reads that answer itself rather than treating the 401 as a
  dead session. Five attempts an hour per login. A member's name and photo
  stay set by an admin (Settings > Users); the Profile screen and its
  `/api/profile*` routes stay admin only.
- **Appearance.** Light or dark and the random theme, in the browser only.
  The brain-wide theme and fonts are written only from Settings >
  Appearance, which a member never reaches.
- **Tour.** A member gets the member tour once per browser on the member
  home (`?tour=member`, or Take the tour in the account menu, opens it
  again). A member never gets a deployment's `MANTLE_TOUR`: its stops are
  admin screens.
- **Contract banner.** When the brain and the client speak different wire
  contracts, a member reads "Needs an update: tell an admin", with no link
  (the updates screen is admin only).

## 9. Invites (Phase 6)

An admin invites a person; the person opens the link, sets a password, and
is a member login. Nobody hands a password around. The table is
`member_invites` (migration 0174, modelled on `pairing_codes`); the logic is
`packages/content/src/member-invites.ts`.

- **The code.** 16 characters from a 54-character alphabet with no
  look-alikes (the one team codes used), about 92 bits. Only its SHA-256 is
  stored (`hashInviteCode`, the hash team codes used, so an invite made
  before 0178 still redeems); the plaintext is in the create answer once. It
  lives 72 hours and redeems once. Only a 16-character code is looked up.
- **One open invite per contact** (a partial unique index). A new invite for
  the same contact, or the same email, revokes the old one: re-inviting
  replaces the link.
- **Admin routes** (admin only; a member gets 403 `member-login`):

  | Route                                | What                                                                                                                                                                                                                     |
  | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `POST /api/team-admin/invites`       | `{ contactId?, email?, displayName? }`: the contact must be a contact of this brain with no login; the email and name default to the contact's. 409 when a login has the email or the contact. 201 `MemberInviteCreated` |
  | `GET /api/team-admin/invites`        | `MemberInviteList`: open, expired and redeemed invites, newest first, never a code. Revoked ones are left out                                                                                                            |
  | `DELETE /api/team-admin/invites/:id` | Revoke an invite not yet redeemed; 404 otherwise                                                                                                                                                                         |

  `MemberInviteCreated` is `{ invite, code, linkPath }`; `linkPath` is the
  client-app path `/invite#code=…`, which the client prefixes with its own
  origin. The code rides in the fragment, which a browser never sends to a
  server, so it lands in no access log and no Referer header (client logins
  audit B12). Links issued before carry `/invite?code=…` and still work: the
  app reads the fragment first, then the query. The brain does not email
  it: copying the link is the way (an invite email would need the client's
  origin and a connected mail account, and the brain has neither for
  certain).

- **Public routes** (under `/api/auth`, a public path; no session):

  | Route                          | What                                                                                                                              |
  | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
  | `GET /api/auth/invite/:code`   | `MemberInvitePreview` `{ email, displayName, siteName }` for a code that would redeem; one 404 for any other                      |
  | `POST /api/auth/invite/accept` | `{ code, password, email? }`: redeem. `MemberInviteAccepted` `{ ok, email }` and the session cookie, as `/api/auth/login` sets it |

  Accept: a password under 8 characters is a 400 before any code is looked
  at. Every other failure (unknown, used, revoked or expired code; an old
  team code; an `email` that is not the invite's; a login that took the
  email meanwhile) is the same 401 with the same message, so
  the route is no oracle. `email` is a check, never a choice: the login is
  always made with the invite's email (login emails pass the email gates,
  section 1). Both routes are rate limited per IP (preview 30, accept 10 a
  minute: every request counts) and for the whole brain on FAILED codes
  only (600 previews, 120 accepts a minute), and accept limits before
  bcrypt. Counting only failures means honest invitees never spend the
  brain-wide budget: at the old caps (300 and 60 of all requests) six
  addresses could lock real invitees out (final audit F31). The brain-wide
  cap guards against a distributed flood, not against guessing (a code
  carries about 92 bits); it trips only when at least 12 addresses (accept)
  or 20 (preview) keep failing at their full per-IP rate within one minute,
  and then for the rest of that minute (`INVITE_LIMITS`,
  lib/member-invites.ts). Audit: `auth.invite_accepted` or
  `auth.invite_failed`.

- **One transaction.** The redeem locks the invite, creates the login (role
  member, the invite's contact and name), links the contact's history to
  the login (below), marks the invite
  redeemed and writes a `team_access_log` row (`kind` auth, `event`
  invite_redeemed, `login_id` the new login). Any failure rolls all of it
  back. Two racing redeems of one code: one wins.
- **History (stage 3, migration 0175).** A contact that became a member
  login keeps its old portal history, linked to the login:
  - `team_access_log.login_id` (new, FK `auth.users`, SET NULL, indexed
    with the owner and time): the contact's log rows get the login, and a
    member login's own events (its chat turns and daily-cap denials, which
    named it in `detail.login_id`) get it too. New member events write it.
  - `node_comments.login_id`: the contact's `member` comments from the
    portal get the login, so the author check that knows the login
    (`row.loginId === viewer.loginId`) covers them.
  - Migration 0175 ran both backfills once for every contact with exactly
    one member login (two is ambiguous: left alone); the redeem runs them
    (`linkContactHistoryToLogin`, member-invites.ts) for the contact it
    redeems. Both only fill NULLs.
  - The portal CHAT (`team_messages` rows with the contact and no login) is
    NOT linked (Jason, 2026-09-28): the member's live thread is read by
    `login_id`, and old portal turns must not enter it or the model's
    context. The admin reads them through the login's contact:
    `GET /api/team-admin/member-chats` returns them in
    `selected.portalThread` (`MemberChatPortalThread`: `contactId`, `thread`,
    `windowSize`; `portalBefore` pages older; null when there is no contact
    or no portal chat), and `team_chat_read` with a `loginId` returns them in
    `portal_history` (first window only; page it by `contactId`). Both are
    admin reads: a `used_private` reply shows the placeholder. The member's
    own `GET /api/member/chat` never shows them.
  - `team_access_list` takes a `loginId` filter and returns each row's
    `loginId`.
- **Old team codes no longer work** (migration 0178). Until then an 8-char
  team code redeemed an open invite for its contact once, in place of the
  invite code. Now it is just a wrong code: the same 401 (and the same 404
  on the preview) as any other. Invite links only; a person who held a code
  needs an invite link like anyone else. The audit and the access log still
  write `via: 'invite'`.
- **Contract.** `MemberInviteRow`, `MemberInviteState` (`open`, `redeemed`,
  `expired`), `MemberInviteList`, `MemberInviteCreated`,
  `MemberInvitePreview`, `MemberInviteAccepted` in `@mantle/client-types`
  (`dto/member-invites.ts`).
- **The team portal is retired** (Phase 6, 2026-09-28). With invites in
  place, the forum was closed to writes (410 `forum-closed`) and exported
  into admin-level "Forum archive" pages ([team-forum.md](./team-forum.md)
  section 8), then the whole team-code portal was deleted:
  - `/team`, anything under it, and `/hub` redirect to `/login` (before the
    gate, for everyone, with no `next` and no query); they and `/api/team`
    left `PUBLIC_PATHS`.
  - Every `/api/team/*` route (auth, sso, workspace, list, hub, curated,
    comments, the turn stream, the forum) and `/api/team-portal` are gone,
    with the raw team-code bearer and the signed team-chat credential (kind
    `c`, cookie or bearer): nothing mints or accepts it.
  - The admin forum routes, `/api/team-admin/topics`,
    `/api/team-admin/members/:id/thread-read` and `dashboard-tags` are gone.
    `/api/team-admin/members`, `requests` and `settings` carried the forum,
    upload and curated-tag parts empty for one contract cycle; they are gone
    now. Every tab's `badges` is `{ openRequestCount }` (no `openRequests`,
    no `pendingUploadCount`), requests answers `{ badges, requests }` (no
    `uploads`, `moreUploads`), settings has no `dashboardTags`, and members
    has no `forum` per row and no `posts`, `postTotal`, `authored`,
    `activityPage` or `activityPageSize` in `selected`. The `Forum*` DTOs
    and `PendingForumUpload` left `@mantle/client-types` with them.
  - The forum turn runner is gone; a forum turn left queued or in flight on
    a box that upgrades runs into a no-op stub under the old workflow name
    and ends cleanly (team-forum.md section 8).
  - `runTeamTurn` serves member logins only; `team_member_list`,
    `team_notify` and the `team-notify` group are gone (the boot reconcile
    disables their rows on existing brains), and the `forum` tool surface
    with them.
  - **The team-responder prompt** was rewritten for member chat. Prompts are
    operator-owned, so the boot reconcile replaces a live prompt only when it
    is, byte for byte, one of the earlier shipped defaults
    (`retiredPromptSha256` in the system manifest, checked against the
    commits that shipped them); an edited prompt is kept. The change goes
    through Studio prose versioning, so the old default is v1, one revert
    away.
  - Kept: `team_messages` / `team_access_log` / `team_read_cursors` with
    their admin readers. The forum tables and the archive export were kept
    until migration 0177 dropped them, and the team codes until 0178
    (below).
- **Team links are retired** (Phase 6 stage 6, migration 0176). Members read
  team items by level with their own logins, so a team item has no link:
  - 0176 revoked every team-mode link that was not revoked yet, an expired
    one included. It changes no item's level: a team item stays at team with
    no link (the level is the truth; an expired or revoked team or client
    link leaves the item at its level).
  - Nothing makes a team link. Setting an item to team removes its open link
    (a cascaded sub-page follows its parent to team). `PATCH /api/shares/:id`
    with `mode: 'team'` answers 400 `{ error, reason: 'team-links-retired' }`,
    whose message says members use their own logins and to set the level to
    team instead; `node_share` and `page_share` refuse `mode: 'team'` with
    the same message (their `mode` enum is `['public']`), and
    `createShare` / `applyShareMode` throw `TeamLinkRetiredError`. Public
    links work as before.
  - The share read path never serves a team row, even one 0176 missed
    (`activePredicate` in shares.ts), and a new link on such an item revokes
    it first.
  - An old team link on `/s/<token>` answers a plain page (410, `noindex`):
    "Sign in as a member", with a link to `/login` and a line to ask the admin
    for an invite. Any other dead token keeps the uniform 404.
  - Deleted: `lib/team-gate.ts` and the token prompt island,
    `POST /s/:token/auth`, the share-scoped team visitor cookie
    (`mantle_team`, kind `t`, now reserved and refused by every verifier),
    the contact id (`cid`) on frame tickets, `POST /api/contacts/:id/team`
    (enable, rotate, revoke a team code: nothing mints a code now; an
    unwanted invite is revoked instead), the unused team-hub share resolver,
    and the team-token helpers only those used. The `/s` app brokers admit on
    the active share alone: the tool broker refuses every call (403, "members
    use the app's Mantle tools from their own login"), the db broker takes
    queries only, and `/s/:token/view` always answers `mode: 'public'`.
  - Contract: `ShareMode` is `'public'` (it was `'public' | 'team'`), so
    `AccessLinkView.mode` and `AppRow.shareMode` are `'public'` (or null).
    `DELETE /api/shares/:id` no longer answers `keptTeam`.
- **The forum tables are dropped** (Phase 6, migration 0177). With every
  topic in the Forum archive, `forum_topics`, `forum_posts`,
  `forum_uploads` and `forum_read_cursors` went, and with them the export,
  its boot task and `GET/POST /api/team-admin/forum/export` (now 404). The
  archive pages and the files the export filed stay, and stay un-indexed.
  A topic with no archive page aborts the migration. Details, with every
  foreign key and how it was dropped: [team-forum.md](./team-forum.md)
  section 8. Test: `packages/db/src/drop-forum-tables.db.test.ts` (on a
  scratch database of its own, migrated from scratch and dropped after: its
  DROP CONSTRAINT locks `nodes` and deadlocked with other DB test files).
- **Team codes are dropped** (Phase 6, migration 0178). The last thing a
  code did was redeem an invite once (above); with that gone,
  `contact_team_tokens` went. Its one foreign key (`contact_id` to `nodes`,
  ON DELETE CASCADE, `contact_team_tokens_contact_id_fkey`; `owner_id` has
  none, and nothing references the table) is dropped by name, then the
  table without CASCADE, so an unknown dependency fails the migration. No
  other row changes: contacts, logins, invites, apps, sandboxes and the old
  portal history (`team_messages`, `team_access_log`, `team_read_cursors`)
  all stay. Gone with it: `verifyTeamToken`, the team-code minting and
  status helpers (`team-tokens.ts`; the invite code's alphabet and hash
  moved to `member-invites.ts`), and `ContactRow.team` (when a code was
  made and last used).
  - **The Chat archive needs no code.** `GET /api/team-admin/members`
    (the Members tab) lists every contact with old portal chat, newest
    activity first, with or without a login made from it; it listed code
    holders before, so a contact whose code was redeemed dropped off and
    now shows again. A code holder who never chatted is not listed; their
    access log stays readable with `team_access_list`. A row's
    `memberSince` is its first portal message; `tokenLastUsedAt` (always
    null once codes went) left `TeamMemberActivity` after one contract
    cycle. `team_chat_list` (`portal_archive`),
    `team_chat_read` with a `contactId`, Member chats' `portalThread` and
    `team_chat_read`'s `portal_history` read the chat by contact or login
    as before.
  - Tests: `packages/db/src/drop-contact-team-tokens.db.test.ts` (the FK
    list, no CASCADE, every count kept, a second run a no-op; on its own
    scratch database, like the forum drop test),
    `server/web/app/api/team-admin/members/members-archive.db.test.ts`,
    `packages/content/src/member-invites.db.test.ts` (an 8-char code
    redeems nothing; a pre-0178 invite still redeems) and
    `member-invites.test.ts` (the alphabet and the hash).
- **Tests.** `packages/content/src/member-invites.db.test.ts` and
  `member-history-links.db.test.ts` (Postgres: 0175's backfill and the
  redeem's), `packages/tools/src/builtins-team-portal.db.test.ts`,
  `server/web/app/api/team-admin/member-chats/member-chats-portal.db.test.ts`,
  `server/web/app/api/auth/invite/invite-routes.test.ts` and
  `server/web/app/api/team-admin/invites/invites-admin-routes.test.ts`; the
  member and auth sweeps cover the new routes. The retirement:
  `server/web/server/auth-sweep.test.ts` (the redirects, `/api/team` gone),
  `server/web/server/pages/stubs.test.ts`,
  `lib/auth-tokens.test.ts` (kinds `c` and `t` refused everywhere),
  `server/api/src/workflows/forum-turn-retired{,.db}.test.ts`,
  `lib/system-manifest/prompt-upgrade.db.test.ts` and the manifest drift
  guard. Team links (stage 6): `packages/content/src/retire-team-links.db.test.ts`
  (0176 on seeded rows, the read path, the old-token check),
  `shares-levels.db.test.ts` and `shares-mode.test.ts` (team takes no link,
  refusals), `server/web/server/pages/share-retired-team.test.ts` (the sign-in
  page), `server/web/app/s/share-link-brokers.test.ts`,
  `server/web/app/api/shares/[id]/share-mode-route.test.ts`,
  `server/web/app/api/team-admin/hub-app/hub-app-route.test.ts`,
  `server/web/app/api/team-admin/team-admin-answers.test.ts` and
  `server/web/app/api/users/users-list-route.test.ts` (the exact answer
  shapes, with the one-cycle fields gone), the share
  tool tests and the auth sweep (the deleted routes are not routed).

**In the client.** `/invite` drops the code (`#code=` or an old `?code=`)
from the address as soon as it is read. A password over 1024 characters is
reported as too long. A contact whose invite was accepted shows "Has a
member login" instead of "Invite as member". Team admin > Requests shows
Reply and "View their chat" for a request with a login or a contact
(`TeamRequest.loginId`); a login's chat link opens Member chats for that
login. "Sign out everywhere" sits in the account menu (admins and members)
and on a login's Devices card in Settings > Users. jackdaw CI runs the
member e2e on a mock brain (`pnpm e2e:member`) and a real-brain
`member-smoke.spec.ts` (invite, redeem, upload into Mine, load the image by
`?at=`).

## 10. Admin private items (Phase 7)

Jason, 2026-09-28. An admin (any login that passes the admin gate, the
anchor included) has a private space of their own: they create items there
("Keep private"), edit and save them, and accept them into the brain
themselves, with no review. There is no share, submit, recall or comment
for an admin's items, and nobody else ever reads them: not another admin,
not a member.

**Where they live.** Every login already has a personal space (section 5,
migration 0165); an admin's is the same kind of row, keyed to the acting
login (`actor.id`, never the anchor's for another admin). The routes run the
same content functions inside `withSpace` for that space, so the space
role's row rules hold every read and write, exactly as for a member. A
private item is never indexed, embedded or extracted (the brain filters on
the brain id), and no create, draft or Save version starts LLM work.

**Routes** (`lib/admin-space.ts`). The same methods, bodies, query params
and answers as the member routes of section 5, so a client swaps the base
path:

| Route                                   | Guard                                  |
| --------------------------------------- | -------------------------------------- |
| `GET/POST /api/admin/space`             | `getOwnerOr401`, then the own space    |
| `GET/PATCH/DELETE /api/admin/space/:id` | `getOwnerOr401`, then the own space    |
| `PUT /api/admin/space/:id/draft`        | `getOwnerOr401`, then the own space    |
| `POST /api/admin/space/:id/save`        | `getOwnerOr401`, then the own space    |
| `POST /api/admin/space/:id/accept`      | `getOwnerOr401`, then the own space    |
| `POST /api/admin/space/:id/give-back`   | `getOwnerOr401`, then the own space    |
| `GET /api/admin/space/:id/bytes`        | `getOwnerForAsset` (`?at=`), own space |
| `POST /api/admin/space-files`           | `getOwnerOr401`, then the own space    |

A member gets 403 `member-login`, as on every admin route; members keep
their own routes (`MEMBER_ROUTES` is unchanged). Another login's item,
another admin's included, is a plain 404. The bytes route is an asset path
in the gate: the owner `?at=` token's `act` claim names the login whose
space is read (the anchor's token, with no `act`, reads the anchor's).

**The embed rule** (Save version, a new item's first version, a note's
text). An admin may use their own items and the brain's items at ANY level,
admin included: they can read them all. Never another login's personal
item. The routes pass the brain (`adminOfBrain`); `disallowedRefs`
re-reads the space's login and widens only for an admin that is not
disabled and a real brain row, and reads the brain on the admin pool
(`asSystem`) with the rule in the query. Members keep the rule of section
5, whatever they pass. What `embed-refs.ts` refuses outright (a non-uuid
id, an entity mention, an external image or frame) is refused for an admin
too.

**Accept into brain** (`POST /api/admin/space/:id/accept`, body
`{ audience?, parentPageId?, folderPath?, lowerConfirmed?, confirmedIds? }`, answer
`{ id, audience, moved, linksStayingBehind, alsoLowered, levelWarning? }`: the same as
the team-admin accept). `acceptOwnItem` shares the move with the reviewed
Accept of section 6 (bundle, same ids, re-own, bytes, slug and path
dedupe, drafts discarded, one transaction, the extractor told once per
moved item, on commit). Its own guard: the item is in the caller's own
personal space, the caller is a usable admin, it is not accepted, and it
has no unsaved edits (409 `unsaved-draft`: save a version first).
Anything else is a 404. The same route accepts an item the admin TOOK OVER
from the Review queue (section 11); that item keeps its author record. Unsaved edits on any item the bundle holds refuse
too (409 `unsaved-draft` with the `ids`: Accept would move the saved
version and drop the draft); the bundle's rows are locked first, so the
admin's own autosave cannot slip in. The `space_items` rows of the admin's
OWN items are DROPPED: an admin's own item keeps no author record, so it
never shows the member-authored badge and never lists as a member's
accepted item. A taken member item's row is kept and goes to `accepted`
with this admin as the reviewer, and its author gets the accepted
snapshot.

**Never seen by anyone else.**

- The review side (section 6) reads only a MEMBER's items (the author's
  login is a member, or deleted): the queue, the badge count, a Return, a
  review comment and a discard never touch an admin's item, not even one
  submitted before the login was promoted.
- Team drafts come from member spaces only (migration 0179:
  `mantle_member_space`, in the team-drafts rules on `nodes` and
  `space_items`). A promotion (`PATCH /api/users/:id` with `role: 'admin'`)
  turns the login's shared and submitted items back into private drafts in
  the same transaction (`settleSpaceOnPromotion`; migration 0180 did it once
  for the admins of the day), so a later demotion or delete never brings
  them back, and a submitted item nobody can recall is editable again. A
  deleted login's space is no member's either (0180): a deleted member's
  shared items leave Team drafts; admins still find them in the Review queue
  as left behind.
- The SECURITY DEFINER space functions are not open to PUBLIC (0169 for
  `mantle_personal_space`, 0180 for the rest): `mantle_is_brain_space` runs
  for the team and space roles (their comment rules, and the nodes triggers
  under a member's writes), `mantle_member_space` and
  `mantle_member_space_node` for the team role.
- Admin lists and the brain filter on the brain id, so admin B finds
  nothing of admin A's by id (`/api/admin/space/:id` is a 404) or through
  any brain route.

**Deactivation.** A deactivated (or deleted) admin's private items are
purged after 30 days by the nightly `space-purge`, like a member's (section
6); an admin's item never goes to the Review queue as "left behind". Items
the admin TOOK OVER are a member's work: never purged, and offered in the
Review queue again for another admin (section 11).

**Tests.** `packages/content/src/admin-space.viewer.db.test.ts` (Postgres:
the embed rule both ways, another admin by id and through the brain, the
review side and team drafts with a forced 'team' row, self-accept and its
refusals, no author row, the extractor told once per moved item),
`server/web/server/admin-space-sweep.test.ts` (the exact route list,
anonymous 401, member 403, the own space, the `?at=` token),
`server/web/app/api/admin/space/admin-space-routes.test.ts` (the writer and
the accept wiring), `server/web/server/middleware/gate.test.ts` (the asset
path) and the auth and member sweeps.

## 11. Take over and the accepted snapshot (audit F07)

Jason, 2026-09-28. Two changes to what happens between Submit and Accept,
and after it. Migration 0183.

**Take over.** An admin can take a SUBMITTED member item out of the Review
queue into their OWN private space (section 10: the acting login's, never
the anchor's for another admin), work on it there, and then accept it into
the brain or give it back to the member.

- One transaction, with Accept's locks (the state row, then the bundle's
  rows). The item and the bundle recorded at Submit move with the same node
  ids (`moveBetweenSpaces`, `packages/content/src/member-takeover.ts`):
  `owner_id` re-owned, a table's workbook copied into
  `TABLE_DB_DIR/<admin space>/`, a file's bytes copied into
  `MANTLE_SPACES_ROOT/<admin space>/files/`, the old copies removed after
  the commit and the new ones on a rollback, page paths rebuilt (a page
  whose parent does not move goes to the top), file names made unique,
  leftover drafts dropped. An item of the bundle that is itself submitted
  or accepted stays where it is. The owner-copy registry check (section 6)
  holds for the member's space.
- Every moved item's `space_items` row stays and still names the member
  (`author_login_id`): `review_state` `taken`, `taken_by` (the admin),
  `taken_at`, `taken_root` (NULL on the item itself, the item's id on the
  rest of its bundle), sharing private. The recorded bundle is cleared.
- The title each moved item had is recorded (`taken_title`, migration
  0196, client logins C5 audit L6): the author's `with-admin` row shows it
  and a search matches it, whatever the admin renames the item to while it
  is theirs. A released item taken again by another admin keeps the title
  recorded the first time; Give back and Accept clear it.
- Nothing is indexed, embedded or extracted: it stays a personal item. Take
  over, the admin's edits and Give back start no LLM work; only Accept tells
  the extractor, once per moved item, after the commit and the bytes.
- Nobody else reads it: the queue no longer lists it, another admin gets a
  404 (by id and in the queue), teammates never see it (team drafts come
  from member spaces only), and the member sees only a `with-admin` row.
- A taken item is not frozen: the admin edits it through the ordinary
  admin space routes (section 10), under the admin embed rule.

**Give back** moves a taken item and everything taken with it back to the
member's space: the item (and the group's root) `returned` with the note,
the rest `draft`, sharing private, the taken columns cleared. The member
sees the Return banner, edits and submits again. It is refused while:

- the member cannot take it (deactivated, deleted, or no longer a member):
  409 `author-inactive`; accept it, or delete it (DELETE on the admin space
  item is allowed then, and refused with 409 `taken` while the member can
  still take it back);
- any item of the group has unsaved edits: 409 `unsaved-draft` with `ids`;
- its saved versions use something the AUTHOR may not (section 5's embed
  rule, read at the author's level: only the group itself, the author's own
  items and the brain items that level reads, so client items only for a
  client author): 409 `embed` with `ids`. An admin may have added an admin-level brain item
  or one of their own private items while it was theirs; giving that back
  would show the member an id, a mention chip's title or a link. Remove
  them, save, give it back.

**Accept after Take over** is `POST /api/admin/space/:id/accept` (section
10), with the same body and answer. The taken item's row goes to
`accepted` with the admin as `reviewed_by`, keeping the author, so the
member lists it under Accepted and the member-authored badge names them.
An item a client wrote is accepted by the client rule of section 6 (audit
A6): team by default, and client or public only with `lowerConfirmed` and
every brain item that goes down in `confirmedIds`, else 409
`confirm-level` with `goingDown`. The admin's own item has no author
record: admin by default, no confirmation. Items taken with it that the admin removed from it stay in the admin's
space as taken, each its own root (give them back or accept them).

**What the member sees.** While taken, `GET /api/member/space` lists the
item on page 1 as a `with-admin` row (id, kind, the title it was taken
with; no icon, content, note or bytes), before the own rows; `total` counts them; `?review=` names
`with-admin` to select them and leaves them out otherwise. Every
`/api/member/space/:id…` route (the item, draft, save, share, submit,
recall, bytes, comments) answers 409 `{ error, reason: 'with-admin' }`, so
Recall is refused. `my_items_list` (the team agent's tool) does not list
them. Realtime: Take over, Give back and Accept each raise
`space_item_changed` (kind `state`) with the MEMBER's space, so the
member's `/api/member/realtime` stream gets `{ type: 'space_item', id,
kind: 'state', own: true }` for every moved item, and teammates who were
showing a shared one get theirs.

**Deactivation.** If the admin who took an item is deactivated, deleted or
no longer an admin, the taken item goes back to the Review queue in place
(the queue's `reviewable` rule reads `taken_by`; only the group's root is
listed), with `reviewState: 'taken'` and reason `submitted` (or
`left-behind` when its author is gone too), and it counts in the badge.
Another admin can then Accept it (what was taken with it moves), Return it
(a give-back from the gone admin's space; that admin's unsaved edits are
dropped, the other refusals hold), Take it over (into their own space) or,
when the author is gone too, Discard it (with what was taken with it).
Review comments are not open on it (409 `not-submitted`). The nightly purge
never deletes a taken item (`member-space-purge.ts` skips the state): a
gone admin's own private items go after 30 days, the members' work stays.
Nothing moves on its own when a login is deactivated: no trigger, no cron.

**The accepted snapshot (F07 option A).** At EVERY Accept of a member's
item (a reviewed Accept, a left-behind Accept, an Accept after Take over,
an Accept of a released item) the version accepted is recorded for its
author in `accepted_snapshots`, in the Accept's own transaction
(`packages/content/src/member-snapshots.ts`):

| Kind    | Snapshot                                                                            |
| ------- | ----------------------------------------------------------------------------------- |
| page    | the committed document                                                              |
| note    | its text                                                                            |
| drawing | the committed scene, its saved SVG and its image refs                               |
| table   | a VACUUM INTO copy of the workbook at `TABLE_DB_DIR/accepted-snapshots/<id>.sqlite` |
| file    | sha256, name, type and size only (the bytes stay the brain's)                       |

Plus the title, icon and version number. `GET /api/member/accepted` and
`GET /api/member/accepted/:id` serve the SNAPSHOT (title, icon, content;
the level shown is the item's current one), never the brain's current
version, at any level. A file's bytes are served (by
`/api/member/files/:id`, which also lets an accepted image render in the
author's other drafts) only while the brain file's recorded sha256 AND its
bytes on disk (hashed, cached by path, size and mtime) equal the
snapshot's, under the name and type the file was accepted with (never an
admin's rename, nor the name Accept made unique in its folder); otherwise
the file route is a 404 and the item answers its accepted metadata with
`changedByAdmin: true`. A drawing's picture
(`/api/member/draws/:id/svg`, the author fallback) is the snapshot's SVG,
filtered by the snapshot's own image refs (an image the member wrote stays:
its bytes inside that SVG are the accepted ones); a drawing accepted with
no saved SVG shows the brain's SVG only while it is still at the accepted
version, else `changedByAdmin: true`.

**Redacted at the author's level** (client logins C5 audit L1; tables and
drawings in C6). An item an admin took over is accepted with the admin's
edits, and an admin may mention, link or embed any brain item at any level
while it is theirs. So what the author reads of the snapshot is redacted at
the author's level (team for a member, client for a client), with the
client redactors (`packages/content/src/client-redact.ts`): in a page's doc
and a note's text a mention or a link of an item the author may not read
is "Private item" and an embed of it is left out; a table cell that names
one (a `/n/<id>` link, a `page:` ref, an absolute URL into the brain) reads
"Private item"; a drawing's element link to one loses its href (the element
stays). The author may read the brain's items at their level, their own
items, and the items they wrote that an admin accepted (shown by their
accepted title). Nothing of the live item an admin could change after
Take over or Accept reaches the author either: an accepted table carries
no summary (the extractor's, of the brain's version), description, tags or
app link, and its title, icon and time are the snapshot's.
`packages/content/src/member-accepted.ts`. The table backup
(`snapshotAllTableDatabases`, the scheduled backup and `db-dump.sh`) copies
the snapshot workbooks under the same `accepted-snapshots/` folder, so an
untar into `TABLE_DB_DIR` restores them. Deleting the brain table removes
its copy; deleting the brain item removes the snapshot row with it.

**Items accepted before 0183.** The migration takes their snapshot from
the brain's CURRENT saved version (page, note, drawing, a table with no
workbook, a file's recorded sha256): an admin's edit made before the roll
is in it, since no older copy exists. A file-backed table, and a file with
no recorded sha256, cannot be copied in SQL: their rows are `pending` and
are completed on the author's first read, from the brain's version at that
moment (so an admin edit made between the roll and that first read is in
it too). An accepted item with no snapshot at all (accepted by older code)
is completed the same way. One completion at a time per item (an advisory
lock).

**API** (the DTOs are in `@mantle/client-types`, `dto/member.ts`).

| Route                                            | Body       | Answer                                                                  |
| ------------------------------------------------ | ---------- | ----------------------------------------------------------------------- |
| `POST /api/team-admin/submissions/:id/take-over` | none       | `TakeOverResult` `{ id, moved: MovedSpaceItem[] }`                      |
| `POST /api/admin/space/:id/give-back`            | `{ note }` | `GiveBackResult` `{ id, returned: MovedSpaceItem[] }`                   |
| `POST /api/admin/space/:id/accept`               | as today   | as today (`{ id, audience, moved, linksStayingBehind, alsoLowered }`)   |
| `GET /api/admin/space[?review=taken]`            |            | `AdminSpaceList`: rows are `AdminSpaceItemRow`                          |
| `GET/PATCH /api/admin/space/:id`                 |            | `AdminSpaceItem`: `{ row: AdminSpaceItemRow, body }`                    |
| `GET /api/member/space[?review=with-admin]`      |            | `MemberSpaceList`, with `with-admin` rows on page 1                     |
| `GET /api/member/accepted/:id`                   |            | `{ item: MemberAcceptedItem }`, `changedByAdmin?` on files and drawings |

- `MovedSpaceItem` = `{ id, type, title }`.
- `AdminSpaceItemRow` = `MemberSpaceItemRow & { takenFrom: AdminTakenFrom |
null }`; `AdminTakenFrom` = `{ loginId: string | null, name, canGiveBack:
boolean, takenAt: string | null }` (`name`: display name, else the email's
  local part, "Removed member" once deleted; `canGiveBack` false when give
  back would answer `author-inactive`).
- States: `MemberReviewState` gains `taken` (admin rows and the Review
  queue); `MemberSpaceItemState` = `MemberReviewState | 'with-admin'` is the
  type of `MemberSpaceItemRow.reviewState` (`with-admin` on the member's
  own list only).
- Errors: take-over 404 (not waiting: recalled, handled, taken), 409
  `not-submitted` (a left-behind item never submitted), 409 `too-large`;
  give-back 404 (not a taken item in the caller's space), 400 `invalid` (no
  note), 409 `author-inactive`, 409 `unsaved-draft` + `ids`, 409 `embed` +
  `ids`; admin space DELETE 409 `taken`; every member item route 409
  `with-admin`; Return on a released item can answer the give-back's 409s.

**Rollback.** Code before 0183 does not know `taken`: give back or accept
every taken item before rolling back
(`select node_id from space_items where review_state = 'taken'`). The
snapshot table is only read by the new code.

**Tests.** `packages/content/src/member-takeover.viewer.db.test.ts`
(Postgres: the move and the owner-copy registry, nothing announced or
chunked, another admin, teammates and the member, the `with-admin` rows
and Recall, `takenFrom`, give-back's refusals and the move back, Accept
keeping the author and announcing once, the table's workbook, an admin's
own item unsnapshotted, delete and `author-inactive`, the purge skipping a
taken item, a deactivated taker releasing it to the queue and another
admin taking it over, Return of a released item, a missing snapshot
completed on first read), `member-accepted.viewer.db.test.ts` (an admin's
later saved edits stay the brain's for page, table, drawing and note; a
changed file answers `changedByAdmin`),
`member-draw-images.viewer.db.test.ts` (a changed accepted image leaves a
member's drawing, and stays in their own accepted snapshot),
`client-accepted-c5a.viewer.db.test.ts` (a taken, edited, accepted page,
note, table and drawing redacted at the author's level; the taken title;
an accepted file's name), the route tests in
`server/web/app/api/member/accepted/member-accepted-routes.test.ts`,
`server/web/server/admin-space-sweep.test.ts` and `auth-sweep.test.ts`
(the routes and their gates).

**In the client** (jackdaw, the release after v0.6.163). Team admin > Review
has Take over beside Accept and Return, confirmed in a dialog that lists
what moves (the bundle preview); the admin then lands in the Private view of
the item's kind with it open. A released item says "released" in the queue
and in its header, can be taken over again, and has no comment box. In the
Private view a taken item says "From <member>"; Give back (a required note)
shows while `canGiveBack`, Delete only once it is false; a refused Give back
stays in its dialog and names the items to save or remove. A member's Mine
shows a `with-admin` row as "With admin" and opens nothing of it: the row,
the item's own 409 `with-admin` and a `/n/<id>` link all show the same
notice, and Recall is not offered. The member home lists them apart ("With
an admin", its own `?review=with-admin` read; a brain before 0183 answers
400 and the group stays empty). An accepted file or drawing with
`changedByAdmin` says so instead of the picture. A page frozen inside a
submitted item (409 `frozen` with `ids`) names and links that item, and
Submit's 409 `unsaved-draft` lists the items to save first, each a link.

## 12. "Needs you": admins are told what waits (2026-09-28)

An admin must never be blind to work waiting for them: items members
submitted for review (and what deactivated logins left behind) and open
team requests.

**The event.** Migration 0186 raises `needs_you_changed`, with the brain's
owner id as the payload (the `pending_changed` convention), from triggers,
so no write path can forget it:

- `space_items`: a row enters or leaves `submitted` or `taken`, a taken
  item changes hands, an item is accepted (a left-behind item is a draft
  until then), or a submitted, taken or team-shared row is deleted
  (Discard). Saves, comments and sharing changes do not fire.
- `auth.users`: a role change or a (re)activation (it moves items between
  "submitted" and "left behind", and releases a gone admin's taken items).
- `nodes`: a `team-request` task starts or stops being open (filed, done,
  reopened, deleted). Edits and board moves do not fire.

NOTIFY is transactional, so a bundle moved in one transaction wakes each
listener once and a rolled-back write sends nothing. The trigger functions
only notify (`SECURITY DEFINER` for the brain id lookup: a member's write
runs as the space role). Exactly two listeners, pinned by
`server/web/lib/needs-you-listeners.test.ts`: the owner live stream
(`lib/realtime.ts`, sent as `needs_you` on `/api/realtime`, which refuses
members) and the push worker. Neither starts LLM work.

**The count.** `GET /api/team-admin/needs-you` (admins only) answers
`NeedsYou` (`@mantle/client-types`): `review.submitted`,
`review.leftBehind`, `requests.open`, `total`, and the newest item of each
queue as `{ id, title, from, at }`, never content. The numbers come from
count queries over the same conditions as the lists (`countReviewQueue`,
`countOpenTeamRequests`), never from a capped list, so every window and
device agrees. The Requests badge (`teamAdminBadges`) uses the same count;
it used to stop at 100.

**The phone.** The push worker pushes an ARRIVAL only (the newest item of a
queue, started waiting in the last two minutes, not pushed before), to
devices of active admin logins only (`listAdminSubscriptions`: a member's,
a deactivated admin's or an unattributed device is never listed). The
lock screen shows the title and the member's name. It follows the
approvals toggle in the push preferences. The mobile companion has no Team
admin screen yet, so a tap opens the app.

**The client** (jackdaw): a live "N waiting" notice at the top of the rail,
a toast when something arrives, the browser tab title and favicon, an
opt-in browser notification, and in the desktop app the dock badge, a dock
bounce (macOS) or taskbar flash (Linux) until focused, and a native
notification.

**Tests.** `packages/content/src/needs-you.viewer.db.test.ts` (on its own
scratch database: the event fires once on submit, recall, return, take
over, give back, accept, discard, deactivation and reactivation, request
open, done, reopen and delete, and never on a save, a share, an edit or an
untagged task; the count agrees with the queue on one snapshot and has no
cap; the functions only notify), `server/web/lib/push/needs-you.test.ts`,
`server/web/lib/push/admin-subscriptions.db.test.ts`,
`server/web/lib/realtime.needs-you.test.ts` (members' stream never gets it;
another owner's change is dropped).

## 13. One list per kind (item-list alignment, 2026-09-29)

The member's screen for a kind no longer switches between Mine, Team
drafts, Library and Accepted. One route lists everything the member can see
of that kind, newest first, and each row wears a small state pill instead
of living behind a source:

| Route                                         | What                                      |
| --------------------------------------------- | ----------------------------------------- |
| `GET /api/member/items?kind=&q=&state=&page=` | `MemberItemsPage`: one list, every source |

**Sources.** Own items (with the ones an admin took over), teammates'
shared drafts, the Library, and the member's accepted items at a level the
Library does not list (admin or public; the rest already are Library rows,
marked `byMe`). Each row names its `source`, which picks the item view:
`own` the member's editor, `team` a teammate's saved draft, `library` the
brain item, `accepted` the version accepted.

**No new access.** Each source is read exactly as its own route reads it:
Mine in `withSpace`, team drafts in `withTeamDrafts`, the Library at the
team level, accepted items on the admin pool with the author rule written
in, and the Library rows' authors for exactly the ids the team level
returned. The route only merges them (`member-items.ts`,
`mergeNewestFirst`): page N reads the first N pages of every source and
interleaves them on `updatedAt`, so paging never skips or repeats a row and
`total` is the sum. The depth is capped at page 100.

**Pills and the State filter.** A draft is `private` or `draft` (shared
with the team); then `submitted`, `returned` and `with-admin`. Brain rows
wear none. `state=` takes `all` (default), one pill, `brain` (the rows
without a pill) or `by-me` (every accepted item of this member). The filter
is pushed into each source's own query (`itemsPlan`), never applied to a
loaded page, and the pill a row wears is always the filter that finds it
(pinned in `member-items.test.ts`).

The four source routes stay until no client calls them.

**Tests.** `packages/content/src/member-items.test.ts` (pills, plans, the
merge and its paging), `server/web/app/api/member/items/member-items-route.test.ts`
(each source in its own scope with this member's ids, the filter reaching
exactly its sources, authors on the page's Library rows), and the new cases
in `member-space.viewer.db.test.ts` (sharing and review filters, team
drafts by review state) and `member-accepted.viewer.db.test.ts` (level
filter, row-time order, `acceptedByLogin`).

**The admin side.** The brain lists an admin reads (`/api/pages`,
`/api/notes`, `/api/tables`, `/api/draws`, and the files root and Recent
lists) take `?state=brain|private|all`. `brain`, the default, is the list
exactly as before, so a client that never asks sees no change. `all` merges
the caller's OWN private items (read in the acting login's space, as
`GET /api/admin/space` reads them) into the list in its own sort order
(`mergeSorted` with `listSortCompare`); `private` lists them alone. A
private row is an `AdminPrivateListRow`: the `private` key holds the space
row and marks it, since the item is read and written through
`/api/admin/space`, never the brain route. Private items have no tags and
no parent, so a tag filter, a sub-page level or a files folder other than
the root lists none; in the pages tree they sit at the top level. Tests:
`server/web/lib/admin-private-rows.test.ts`.

## 14. Client logins, for members and admins

What a member or an admin meets of the client tier (client logins C0 to C6,
as they stand after the C5 audit fixes). The operator's guide is
[client-logins.md](./client-logins.md); the security summary is
[security.md](./security.md) section 5a.

**Who a client is.** A login with role `client`: a person at the brain's one
client company (two companies are two brains). No password: a client signs
in with a link an admin issues or a code the brain emails, in a browser
only, for 30 days at most. Every admin and member route refuses a client
(403 `client-login`, section 2), and a client reaches only its own routes
(`CLIENT_ROUTES`). It reads at the client level: client items, never team,
admin or public ones, and never a staff name in a list or the chat (the
brand name stands in). A client writes only in its own space (pages, notes,
uploads; private until submitted), in the comment threads open to it, in
its own chat, and in client apps (client-logins.md section 10).

**For members.**

- **The Library shows what clients see.** It lists team and client items,
  each with its level; a client item wears a Client badge, and every client
  login reads it. Set an item to Client only when the clients should read
  it (section 3).
- **Client requests.** A client's SUBMITTED item, and what renders inside
  it, is a "Client requests" source in the member's one list
  (`GET /api/member/client-requests`, `/:id`, `/:id/bytes`), read only,
  while it waits for review. A client's draft, returned or accepted item is
  not; row security holds this (the team role with the human flag on, never
  an agent; migration 0194). A client's space never shows in Team drafts.
- **The client thread.** An item at client level carries one comment
  thread that members, admins and every client login read and write
  (`/api/member/library/:id/comments`). A member's comment there shows the
  member's display name (else the email's local part) to the clients too.
  A member deletes only their own. The thread closes the moment the item
  is raised above client.
- **The chats are apart.** A member chats with `team-responder` at team
  level, a client with `client-responder` at client level, each login in
  its own thread; nothing of a member's thread reaches a client. Pictures in
  either thread point only at the reader's own routes, for items the reader
  may read (client-logins.md section 8).
- **A member cannot share with clients.** A member's own items go to the
  team at most (sharing `team`); they reach clients only when an admin
  accepts them at client level.

**For admins.**

- **Before the first client.** Acknowledge "What clients see" (every item
  at client, its old links and the team or admin items it names;
  [access-levels.md](./access-levels.md) section 7). Adding a client or
  issuing a sign-in link is refused until the newest acknowledgement covers
  every client item.
- **Team admin > Clients.** Add a client (a contact, or a typed email), issue or revoke
  a sign-in link, pick the sender of emailed codes, End sessions, Disable,
  Delete; each client's chat use today, the storage card (the client total,
  each space, uploads, open submissions and the quota refusals of the last
  7 days), the items with recent client comments, and removing every
  comment one client wrote (client-logins.md sections 2, 3 and 9).
- **Review.** A client's submission waits in the same queue, with a Client
  badge, and counts in the Review badge and in Needs you (section 12) like
  a member's. Accept of a client's item defaults to team; client or public
  needs the explicit confirmation of everything that goes down with it
  (409 `confirm-level` with `goingDown` otherwise, section 6). The badge and
  the rule come from the role stamped on the item, so they hold after the
  client login is deleted.
- **Take over and give back** (section 11) work on a client's item as on a
  member's. Give back checks the item's references at the client level, so
  a team item named in it is refused (409 `embed`). The client lists the
  held item under the title it had when taken; once accepted, the client
  reads the version accepted, redacted at the client level.
- **Comments on client-level items.** An admin's comment on an item at
  client level joins the client thread: every client login reads it, under
  the admin's display name (else the email's local part, never the whole
  email). An agent's comment never joins it. The owner's
  `GET /api/nodes/:id/comments` lists every scope of an item's comments;
  `?scope=client` lists only the client thread, what the clients read,
  paged the same way.
- **Client chats** are read in Team admin > Member chats (Clients filter),
  read only.
- **Client-written text and staff agents.** After an agent turn reads text
  a client wrote (a request, a client's chat thread, an item a client
  wrote, a copy of one), lowering anything to client or public, and writing
  into an item clients already read, wait in Pending for the owner
  (client-logins.md section 8). The owner's MCP surface is not gated.
- **Cost.** No client write starts the extractor, a trigger or a worker;
  a client request reaches no model until an admin acts on it, and Accept
  announces each moved item once.
