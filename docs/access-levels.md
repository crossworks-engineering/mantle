# Access levels: one level system, enforced by the database

> Member logins, Phase 0b; client logins C1 to C5. What an agent, a member
> or a client may read is decided by Postgres row level security on a
> limited login role, not by a check in each route or tool. It is live on
> every box: an agent below admin, every member login (team) and every
> client login (client) read through it. The owner and admin-level agents
> read everything. How an admin lets a client in, and what a client reads:
> [client-logins.md](./client-logins.md); the database rules the client
> tier added are section 8.

## 1. The model

Four levels: admin, team, client and public. Admin reads everything; team
reads team, client and public items. **Client and public are siblings, not
a chain** (client logins C1, migration 0187, decision 3): the client role
reads CLIENT items only, not public ones, and the public role public items
only (`levelCovers` in `packages/db/src/viewer.ts`). Migration 0161 set
every item with an open link to public, so on a real box public means
"every item ever link-shared with an outsider"; a client login must not
find all of it. Public items stay reachable by their own open link. Since
migration 0189 the client role reads agents and tool groups at client
level only, too. For lowering an item the order is still
admin > team > client > public (`itemLevelAbove`): public ranks below
client when an embed closure goes down (section 7), never when deciding
what a scope reads.

| Thing             | Column                 | Default | Who changes it    |
| ----------------- | ---------------------- | ------- | ----------------- |
| Brain item (node) | `nodes.audience`       | admin   | an admin, by hand |
| Agent             | `agents.audience`      | admin   | an admin, by hand |
| Tool group        | `tool_groups.audience` | admin   | an admin, by hand |

- **Type ceiling.** Only workspace kinds may go below admin: pages, notes,
  drawings, tables, files, folders, apps, formulas (`mantle_workspace_kind()` in
  migration 0159, mirrored by `WORKSPACE_NODE_TYPES`). Journal, email,
  contacts, secrets, tasks, events and every other kind are admin forever. A
  CHECK and the row policy both enforce it.
- **Embedding means sharing** (Jason, 2026-09-28, audit F19 follow-up).
  Lowering an item is an admin's decision for the item AND what it embeds:
  one decision covers the page and its embeds, so levels still go down only
  by an admin, by hand. When a page, drawing or note goes below admin, its
  **embed closure** goes down to the same level in the same transaction: a
  page's images, file embeds, embedded drawings and page link cards, a
  drawing's images (`draws.file_refs`), a note's images, file embeds and
  drawings, followed transitively (a linked page's images too;
  `packages/content/src/embed-closure.ts`). So the level label tells the
  truth, and the item's link serves what it shows. Nothing is ever raised,
  an embed already at or below the level is left alone, and an embed that
  can never go below admin (the type ceiling) stays admin and is reported
  (`stillAbove`). Links are not embeds: a link mark or a mention chip names
  an item without showing it, and the item keeps its own level. Every setter
  does it and lists what went down in `alsoLowered: [{id, type, title,
from, to}]`: the Access control and `PATCH /api/access/nodes/:id`,
  `access_set`, the share paths (`node_share`, `page_share`,
  `POST /api/shares`, the email link) and Accept at a
  level (member-logins.md section 6; the Library items a member embedded go
  down with it). The older `lowered` field carries the same items at their
  new level.
  A FOLDER share is different: it lowers nothing. What a page, drawing or
  note in a shared folder embeds is read through it only while it is
  (`nodes.embedded_level`, migration 0208; docs/folder-tree.md, "Embeds
  follow their embedder"), so an unshare takes that access back. Only the
  own-level paths above lower embeds for good.
- **Later embeds follow on save.** A page, drawing or note whose own level
  is below admin and that gains an embed takes it to that level, in the
  save's transaction (a folder share it sits in reaches the embed through
  the database instead): a
  page or draft commit (`commitPage`, which the editor, `page_commit` and
  the block tools' commit use), a programmatic page write (`updatePage`), a
  drawing commit (`commitDraw`), a note's text (`updateNote`). Only what was
  ADDED: an embed the item already had keeps its level, so an admin who
  raised one on purpose is not overruled by the next edit. No LLM work: a
  level change announces nothing to the extractor.
- **Folders do not pass levels on.** Lowering a folder does not lower its
  contents (folder links show only their level, section 7), and a file
  uploaded into it later lands at admin. The Access control offers the
  folder's contents as one explicit extra step ("Lower them too",
  `withClosure`, folders only). Raising an item offers the mirror step:
  closure items still below it (a folder taken back to admin whose files
  stay at team, a page's images left public, or a link revoked elsewhere)
  are listed, and "Raise them too" (`raiseClosure`) raises them. Lowering
  never raises and raising never lowers. A raised item that carries its own
  link has the link follow its new level.
- **The gaps from before close once.** A boot reconcile
  (`reconcileEmbedClosuresOnce`, server/web/lib/access/embed-reconcile.ts)
  applies the same admin decision to the pages, drawings and notes lowered
  before embeds followed: every item below admin takes its embed closure
  down to its level, each change logged (`[embeds] ...`). It runs once per
  brain (a marker in the owner's preferences, `embedClosureReconciled`),
  not on every boot: after it an admin may raise one embed on purpose, and
  a later boot must not lower it again. Run again, it finds nothing left.
  Production only, like the manifest reconcile; `MANTLE_DISABLE_BOOT_RECONCILE=1`
  skips both.
- **An agent's level is the switch.** A team-level agent runs every query of
  its turn on the team role, so it reads only team-, client- and public-level
  items. A client-level agent runs on the client role and reads client items
  only, not public ones (migration 0187, decision 3, as a client login does);
  a public-level agent reads public items only. There is no other flag.
  A client scope never runs public-level work, and a public scope never
  client-level work: there is no common level, so the work is refused,
  never widened. `withViewer` rejects with `ViewerLevelConflictError`,
  `invoke_agent` refuses before any trace or LLM work, and one that
  reaches the HTTP layer answers 403 with `reason: 'level-conflict'`
  (`server/web/server/level-conflict.ts`). `team-responder` ships at
  admin, closed to members, on every brain; an admin lowers it once the
  shadow report is clean (section 5).
- **Tool groups.** An agent may hold a tool group only at a level it
  reads: a team agent may hold client and public groups, but a client agent
  holds no public group and a public agent no client group. Refused at grant
  time (`PATCH /api/agents/:id`, `agent_grant_tool_group`) and when an
  agent's or a group's level changes, left out at run time
  (`resolveAgentToolGroups`). Lowering an agent that holds a group above the
  new level is refused (400, code `group_above_agent`); the message names
  each group and the fix. The fix in the same call: `dropGroupsAbove: true`
  on the API (`drop_groups_above: true` on `access_set`) takes those groups
  off the agent with the change and lists them in `removedGroups`. It is
  never the default: a wrong slug must not strip an agent of its groups, and
  raising the level again does not put them back.
- **Which groups ship below admin.** Three, set in the system manifest
  (`level` on the group, `server/web/lib/system-manifest/manifest.ts`):
  `team-read` and `formulas-eval` at team, `client-read` at client. A group
  with a manifest level is product-owned at that level: a fresh install
  seeds it there, and the boot reconcile sets it back there once per
  version, on every brain, also when an admin moved it (the level is what
  the group is for). Every other group is admin by default and its level is
  the admin's to set; the reconcile never touches it. A group's level only
  says who MAY hold it: giving the group to an agent stays an admin's act.
  `manifest.test.ts` pins the three groups and the tool list of the two
  team-level ones, so a change that widens them is made on purpose.

## 2. How it is enforced

- **Limited LOGIN roles**: `mantle_view_team`, `mantle_view_client`,
  `mantle_view_public`, plus `mantle_view_space` for a login's personal space
  (member-logins.md section 5). Real login roles, never a `SET ROLE` on the superuser
  session (that is escapable). Their passwords are HKDF over
  `MANTLE_MASTER_KEY` with a fixed label: no new secret, no `.env` change.
  `ensureViewerRoles` creates or updates them at every migrate, before the
  migrations run; without a master key they exist but cannot log in.
- **The viewer scope.** `withViewer(level, fn)` (`@mantle/db/viewer`) sets
  the level in AsyncLocalStorage; `db` picks that level's small pool (3
  connections) on every access. The level only goes down.
- **Self-wrapping core.** `loadConversationContext`, `assembleResponderTurn`,
  `runResponderLoop` and `runToolLoop` wrap themselves at the agent's level,
  so no entry point can forget. `runToolLoop` refuses an `agentId` without
  `agentLevel`.
- **Row rules** (migration 0159): nodes by brain owner + level + workspace
  kind (0165 adds the personal-space rules and, for the team role with
  `mantle.human` on only, other members' team-shared items; 0179 limits
  those to MEMBER spaces, so an admin's private item is never one,
  member-logins.md section 10); chunks, pages, draws, tables, apps and app databases follow their
  node; facts follow their source node (a fact with no source came from the
  owner's own chats and stays admin).
- **Grants** come from one checked-in list, `ACCESS_MATRIX`
  (`packages/db/src/access-matrix.ts`), applied by `applyViewerGrants` at
  every migrate. SELECT only. Per role since client logins C1 (`byRole`):
  the client role reads agents and tool groups at client level only (a row
  rule for that role alone, migration 0187, narrowed to client by 0189;
  the team role keeps every row, because a team-level agent may still
  delegate to an admin agent), and holds no grant on `auth.users` at all:
  `mantle_brain_id()` is SECURITY DEFINER, and the nodes rule calls it once
  per query as an init plan. Since 0189 only the viewer roles and the space
  role (and the `demo` branch's read-only role, where it exists) may execute
  it. Draft columns (`pages.draft_doc`,
  `draws.draft_scene`, `tables.draft_data`, `apps.draft_source`, …) and login
  secrets are never granted. A table not in the list is a loud
  `permission denied`, never a silent leak.
- **`systemDb`** is the admin pool whatever the viewer, for the
  infrastructure a limited turn still writes: traces, tool-result spills
  (each carries its writer's level, `tool_results.viewer_level`, migration
  0189, and `read_result` answers not found to a reader whose level does
  not read it), the approval queue, access and audit logs, the replay buffer, the embedding
  cache, the member's own thread, the member turn ledger, API key reads. The lint rule
  `mantle-db/system-db-allowlist` lets only those modules import it.
- **`asSystem(fn)`** is the one audited escape for a write a limited turn
  needs: `team_request_create` files its admin-level task through it. The
  personal-space code uses it for a teammate's comment and, for an admin in
  their own private space, the embed rule's read of the brain at every
  level (member-logins.md section 10); each writes its rule in the query.
- **Queues.** A job runs later in a worker that does not inherit the scope,
  so every enqueue helper calls `assertNoViewer`: a limited turn cannot queue
  work.
- **What the loader skips below admin:** entity names and the relation graph
  (learned from every source, email included), the owner's own chat history
  and Journal. Fact vector search joins the visible source nodes (a plain
  HNSW scan returns short under a selective policy).

## 3. Proven (spike, plan page section 14b)

On a 20x copy of the dev brain (27k items, 68k passages, 86k facts): every
search arm under the team role runs in 1 to 69 ms; recall@10 and @50 are
1.00 for items, passages and facts. A real `runTeamTurn` with the responder at
team level reads only team-level items; the same turn at admin reads beyond
them (the control). Tests: `packages/db/src/*.db.test.ts`,
`packages/content/src/access*.test.ts`,
`packages/runtime/src/assistant/run-team-turn.viewer.db.test.ts`.

All of them run in CI on the shared test database
(`MANTLE_TEST_DATABASE_URL`; a CI run without it fails in the vitest global
setup rather than skipping them, docs/scripts.md): the team-turn,
team-groups and shadow-report tests seed a minimal brain of their own (the shared test anchor from
`@mantle/db/test-support`, a team-level agent and tool group, items at team
and admin level with one fixed embedding) instead of needing a copy of a
provisioned brain. `packages/db/src/nodes-owner-rls.db.test.ts` pins the
owner check in the nodes read rule directly: a team-level node the brain does
not own (a personal space, another brain-kind space) is invisible to every
level role. The agent-level wrap on each of the five entry points
(`loadConversationContext`, `runToolLoop`, `assembleResponderTurn`,
`runResponderLoop`, `runTeamTurn`) has its own unit test
(`packages/runtime/src/{agent,assistant}/*.level.test.ts`, no database): each
records `currentViewerLevel()` inside the entry point's collaborators, so
removing any one wrap fails a test.

## 4. Setting levels

- MCP / assistant: `access_get`, `access_set`, `access_shadow_report` (tool
  group `access`, owner-side only, attached to no agent yet).
- API (owner only): `GET|PATCH /api/access/nodes/:id`,
  `PATCH /api/access/agents/:slug`, `PATCH /api/access/tool-groups/:slug`,
  `GET /api/access/shadow?days=30`.
  The agent PATCH takes `{ audience, dropGroupsAbove? }` and answers
  `{ agent: { id, slug, audience, removedGroups } }`.
- Migration 0159 carried today's sharing over: active team shares went to
  team, public links to public, a shared folder's contents with it.
- The member-facing groups `team-read` and `formulas-eval` are team level
  on every brain, from the manifest (section 1, "Which groups ship below
  admin"). Migration 0159 also set them, by UPDATE, but that reached only
  the brains that existed when it ran: a brain installed after it seeded
  both at admin until the manifest carried the level (October 2026). Such
  a brain gets the right levels from the boot reconcile of its next update,
  with no manual step and no migration.

## 5. Turning it on for the team responder

1. Run the shadow report. It lists what recent member turns used (the last
   30 days; traces of the retired forum still count until they age out) that
   is still admin, shared tasks and events (admin forever: members lose
   them), items below admin whose embeds sit above them (`closureGaps`:
   empty once the boot reconcile ran, unless an admin raised an embed on
   purpose), and how many facts stay usable.
2. Set the levels of what the team should keep reading (a page's embeds go
   with it; a folder's contents with "Lower them too").
3. Open the responder, one call:
   `access_set(agent_slug: 'team-responder', level: 'team', drop_groups_above: true)`,
   or `PATCH /api/access/agents/team-responder` with
   `{ "audience": "team", "dropGroupsAbove": true }`. The responder ships
   with three groups: `team-read` and `formulas-eval` (team level) and
   `team-read-admin` (admin level: the knowledge graph, events, tasks,
   contacts, email and Journal reads, which a team-level role may never
   make). The call takes `team-read-admin` off it (`removedGroups`) and sets
   the level. Without `drop_groups_above` the call is refused and the
   message names the group and this fix. From the next turn the responder
   reads only team-level items and members can chat with it.
   Undo: set it back to admin (members can no longer chat). The next
   update's reconcile gives an admin-level responder `team-read-admin`
   back; a team-level one never gets it.

## 6. Operations

- **Restore** (`scripts/db-restore.sh`) creates the four roles
  (`mantle_view_team`, `mantle_view_client`, `mantle_view_public` and
  `mantle_view_space`) before `pg_restore` (a dump does not carry roles, but
  its policies and grants name them; migrate later gives them their login
  and password). It restores into a pristine database (it drops the empty
  `postgres` database the init scripts made and creates a new one, and
  refuses a target that holds any item or login), then exits 2, without
  "Restore complete", when the restored brain has no logins, no role CHECK
  (`users_role_ck`), or misses a viewer policy: `nodes_viewer_read`, and
  from migration 0187 on `agents_viewer_read`, `agents_client_read`,
  `tool_groups_viewer_read` and `tool_groups_client_read`. Each check applies
  once the dump's own migration ledger shows the migration that made it, so
  an older pre-roll dump is judged by what its release had.
- **Backups before a roll.** The updater takes a strict four-part backup
  (Postgres, app-dbs, table-dbs, spaces) into `backups/pre-roll/` before
  every server roll and refuses the roll when it fails (docs/update-prod.md).
  Restoring one of them is the only way back past a forward-only migration.
- **Every box connects as the Postgres superuser**, which bypasses row level
  security: the owner's paths are unaffected. The `demo` branch's
  `demo_reader` role is NOT a superuser: before this migration reaches the
  demo box it needs `ALTER ROLE demo_reader BYPASSRLS` (on the demo branch).
- **Still to come:** share link handlers (`/s/`) running on the link's level
  role ships in a later release (section 7, "Not yet"). What they serve is
  already filtered by level. Member logins and personal spaces, which build on
  this, have shipped (docs/member-logins.md).

## 7. Levels drive links

The level is the truth; an item's share link (docs/sharing.md) follows it.

| Level  | The item's link                                                           |
| ------ | ------------------------------------------------------------------------- |
| admin  | none (revoked)                                                            |
| team   | none (revoked): member logins list and open it in their Library, by level |
| client | none: signed-in clients read it (client logins C1)                        |
| public | open (anyone with the link), shown to the owner                           |

Team links are retired (member logins Phase 6 stage 6, migration 0176; see
docs/member-logins.md section 9): a link is always open, and there is no
share mode but `public`. The team codes those links took are gone too
(migration 0178): members read by level with their own logins, and nothing
outside a login reaches a team item.

- **Level to link.** `setItemLevel` (`@mantle/content` access.ts) writes the
  level, then `applyLevelToShare` (shares.ts) revokes the link (admin, team,
  client) or creates it (public), in ONE transaction: a link that cannot be made leaves the level
  where it was. `PATCH /api/access/nodes/:id` and `access_set` both use it.
  What goes down with the item (its embeds, a folder's contents when asked)
  gets the level only, never a link of their own: it is reached through the
  item that embeds it. The embeds go down in the same transaction. A new link first retires an
  expired one that was never revoked (it still holds the one-link slot).
- **Link to level.** Every share mutation (`createShare`, `applyShareMode`,
  `setShareCascade`, `revokeShare`, `revokeShareTree`) re-derives the level
  of the nodes it touched (`levelForShareMode`): an item at client never
  moves because of its own link (below; being embedded is another matter,
  see "A client item embedded in something shared"); otherwise no link is admin, except
  that an item at team stays at team; an open link keeps public
  and drops anything higher to public (so `node_share` on a team item puts
  it at public: to show an item to members only, set team instead). A
  node a link lowers takes its embeds down with it (section 1). So
  `node_share` / `page_share` and the email link never drift from the level.
  (A page link used to share the page's sub-pages with it; pages do not
  nest since folder phase 7, and that cascade is gone.)
- **No client links** (client logins C1). Client means signed-in clients
  (a client login reads client items with its own login), never "anyone
  with the link": setting an item to client revokes its open link (an item
  already at client keeps its old link: client to client changes nothing),
  and `createShare` refuses an item at client with `client-links-retired`
  (`ClientLinkRetiredError`), so `node_share`, `page_share`,
  `POST /api/shares` and the email link all meet it. Its
  message tells the model to ask the owner before making anything public
  (public puts the item on an open link and takes it out of client logins'
  view). `email_page` with `includeLink` on a client page is refused before
  anything is sent. Old links on client items, made when client meant an
  open link, are retired (client logins C3, migration 0192: revoked and
  marked `settings.retired = 'client'`, every level kept), and no link of
  its OWN moves a client item: `levelForShareMode` keeps a client item at
  client whatever its own link says, and turning an old client link off
  (`unshareItem`) keeps the item at client. The public read path never
  serves a link on a client item (`resolveActiveShareByToken`), and such a
  token, or any link marked retired, answers `/s/` with a 410 "Sign in as a
  client" page (no item title) pointing at `/client-signin`. Shared links
  lists the retired ones, without a token.
- **What clients see** (`GET /api/access/client-report`). Before the first
  client login an admin reads every item at client and acknowledges it
  (`POST /api/access/client-report/ack`); adding a client login stays
  disabled until the newest acknowledgement covers every client item. The
  list shows 2000 items at most (`total` counts all). The admin
  acknowledges by the report's `fingerprint`, a hash of EVERY client item,
  not only the ones shown; if the set moved since the report was loaded
  the answer is 409 `report-changed` and the page reloads the report. Per item
  the report shows:
  - its old live link, made under the old meaning (views, last view);
  - the addresses a page was emailed to: successful `email_page` sends of
    the last 400 days, to, cc and bcc. Sends through the MCP connector
    write no trace step and are not seen;
  - the team or admin items it names (a mention chip, a link or an embed),
    whose title would otherwise reach the client page as a label. Pages,
    notes, drawings and tables are scanned; apps are not. A ref to an item
    outside the brain (a member's personal item, an admin's private one)
    shows no type, title or level;
  - old live links above it (`oldLinksAbove`): a link on a client folder
    that holds it or on a client page that embeds it. Anyone with that
    link opens the item too, although its own row says "no link". The
    Access popover (`GET /api/access/nodes/:id`) names them as well.
- **A client item embedded in something shared goes public with it.**
  Embedding means sharing (section 1): when a page, drawing or note is set
  to public or gets an open link, its embed closure goes down to public in
  the same transaction, and a client item in that closure goes too (public
  ranks below client). So no link of its OWN moves a client item, but a
  link or the public level on an item that EMBEDS it does, and at public it
  leaves the client logins' view (the client role reads client items only,
  decision 3); it is then reached through the public item's link. The
  Access control lists the embedded items that will go down before the
  admin applies, and every setter reports them after, in `alsoLowered`
  (`from: 'client', to: 'public'`): the Access control, `access_set`,
  `node_share`, `page_share`, `POST /api/shares` and the email link. The
  tools also say it in their answer (`clientLeftWarning`): which client
  items left client logins' view, and that the owner decides what to
  change.
- **No team links** (member logins Phase 6 stage 6). Team is a level members
  read by, never a link: setting an item to team revokes its open link, and
  asking for a team link (`PATCH /api/shares/:id` `mode: 'team'`,
  `node_share` / `page_share` `mode: 'team'`, `createShare` /
  `applyShareMode` with team) is refused with `team-links-retired`.
  Migration 0176 revoked the team links there were and left every level as
  it was. (Stage 3 had already made removing a team link keep its item at
  team.)
- **Turning an open link off is setting admin.** The share DELETE route
  (`DELETE /api/shares/:id`), `node_unshare` and `page_unshare` go through
  `unshareItem` (access.ts): revoke the link, then `setItemLevel(admin)`,
  so the closure rule is the Access
  control's. What the item embeds keeps its own level and is reported,
  never raised on its own: `stillBelow` in the route's JSON, and
  `stillBelow` plus a `warning` naming
  `access_set(..., level: 'admin', raise_closure: true)` in the tool result.
- **An expired or revoked link leaves the item at its level** (Jason,
  2026-09-28). The level is the truth; a team or client link only governed
  outside access, so its expiry (or 0176 revoking a team one) changes
  nothing about who inside can read the item. To hide it, raise the level by
  hand.
- **Superseding changes no level.** `content_supersede` only down-weights
  the old version in retrieval; when the old version is below admin the
  tool result warns that it is still visible at that level and names
  `access_set` to raise it.
- **What members and clients list.** Client and public items are readable
  by the team role, so the team agent can read them. The member Library
  lists team and client items, each row with its level (client logins
  decision 6, C2: members see what clients see); a client lists and opens
  client items only. Public items are in nobody's Library list: 0161 made
  every link-shared item public. A member still opens a public item by id
  (anyone with its link can read it), and a client never does
  (docs/member-logins.md section 3).
- **Admin-only kinds** (tasks, events, …) stay admin whatever link they
  carry. Setting one to admin removes an old link.
- Migration 0161 re-derived every level from the links once, for the window
  between 0159 and this rule. Inside nested shared folders an item takes
  the level of the deepest folder above it. The first version of 0161 let
  an arbitrary folder win; boxes that already ran it keep the levels it set
  (the runner never re-runs an applied migration, and there is no
  corrective one).
- **Links show only their level** (audit F19). A link opens at its item's
  own level and lists and serves only what sits at or below it beyond the
  item itself: public items (`linkLevels` in server/web/lib/shares.ts;
  every link is public since the old client links retired in client
  logins C3).
  - A **folder** link: the listing (components/share/folder-presenter.tsx)
    and the asset check `isAssetAllowed`. A file uploaded into a shared
    folder later lands at admin, so it stays out of the link until someone
    lowers it; a subfolder above the level hides everything under it, and
    its file count leaves hidden files out.
  - A **page** link serves an embedded file (`isAssetAllowed`) or drawing
    (`/s/<token>/draw/<drawId>`, `isDrawServable`) only at the link's
    levels. Its embeds followed it down, so this changes nothing in normal
    use; an embed an admin later RAISES on purpose stops being served.
  - A **drawing**'s snapshot carries the images it places, so a drawing
    (shared, or embedded in a shared page) with one image above the link's
    levels is not served at all: there is no serving it without that image.
  - The shared item itself is not filtered: a file link serves the file, a
    page link the page.
- **Not yet:** `/s/` handlers still run at admin; running them on the
  link's level role (after the share render path reads published columns
  only) is a later release. What they serve beyond the item is already
  filtered by level (above).

## 8. Clients in the database (client logins C1 to C5)

What row security and the schema hold for the client tier, beyond the level
model of section 1. Each rule is in the migration named; the app writes its
rule in the query too, but these hold whatever the code asks for.

- **The client role reads client only** (0187, 0189). `mantle_view_client`
  reads brain items at client level, never team, admin or public ones, and
  agents and tool groups at client level only (`agents_client_read`,
  `tool_groups_client_read`). It holds no grant on `auth.users`
  (`mantle_brain_id()` is SECURITY DEFINER, executable by the viewer and
  space roles only). A spilled tool result carries the level it was
  written at (`tool_results.viewer_level`), and `read_result` refuses one
  above the reader.
- **A client's own space runs at client level.** A client's personal space
  is read and written on `mantle_view_space`, and `withSpace` takes the
  scope's level from the login's row (`spaceLevelForLogin`,
  `packages/db/src/client.ts`): client for a client, team for a member or
  an admin. So a brain item a client's page may embed, and a give back's
  check, read at client level.
- **Never a team draft** (0189). The trigger `space_items_client_private`
  refuses `sharing = 'team'` on an item a client wrote: it stays private
  until submitted, and never shows in Team drafts.
- **Who wrote it, for good** (0194). `space_items.author_role` is stamped
  from `auth.users` by a trigger when the row is made and kept by another
  on every update, never written by the app. It outlives the login (whose
  id goes NULL on delete), so Review's Client badge, Accept's client rule,
  the storage total and the lowering guard still know a client wrote it.
- **Members read client requests, while submitted** (0194). The team role,
  with the human flag on (a member's own request, never an agent), reads a
  client's SUBMITTED item and the items submitted in its bundle
  (`nodes_client_requests_read`, `space_items_client_requests_read`,
  through `mantle_client_request_node()`); pages, drawings, tables and
  chunks follow their node. A draft, returned or accepted item never
  matches.
- **Comments.** In a client's space (0194, `node_comments_space_read`,
  `_insert`, `_update`) the client reads only the review talk
  (`thread_scope` 'review') written by a reviewer or by itself, and writes
  only as `author_kind` 'client' in that scope. The client thread
  (`thread_scope` 'client', `node_comments_client_thread_read`) is read by
  the client and team roles, human flag on, only while its item is a brain
  item at client level; raise the item and it reads nothing. No level role
  writes it: the app writes on the admin pool with the item's level checked
  in the same statement (`packages/content/src/client-thread.ts`).
- **Ledgers that deleting does not refund.** `space_submissions` (0194,
  Submit) and `client_comment_ledger` (0195, comments): the space role
  inserts and reads its own rows and has no update or delete rule.
  `client_request_filings` (0197, requests) has no viewer grant at all: the
  app writes it as the system.
- **Storage, one definition** (0195). `mantle_client_space_usage()` sums
  what each client space holds (files, table workbooks, page documents
  saved, draft and plain text, note text, as stored); a deleted client's
  space counts until the purge. The space role may call only
  `mantle_client_space_bytes()`, its total: one number. Quota refusals are
  kept in `client_quota_refusals` (reason and login only), read by admins.
- **The taken title** (0196). `space_items.taken_title` is the title an
  item had when a reviewer took it over; the author's list shows it.
- **The lowering guard's marks** (0197). `client_sourced_nodes` (a node a
  marked staff turn created) and `conversation_taints` (a conversation
  that read client-written text in the last 24 hours) are written by the
  app as the system only; no viewer role reads them
  ([client-logins.md](./client-logins.md) section 8).

Tests: `packages/db/src/*.db.test.ts` for the roles and rules,
`packages/content/src/client-*.viewer.db.test.ts` for the client reads,
threads, space and limits.
