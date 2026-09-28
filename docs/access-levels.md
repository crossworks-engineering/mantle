# Access levels: one level system, enforced by the database

> Member logins, Phase 0b. What an agent (and later a member) may read is
> decided by Postgres row level security on a limited login role, not by a
> check in each tool. Built and tested; nothing changes on a box until an
> admin lowers an agent's level.

## 1. The model

Four levels, one rule: **admin > team > client > public**. A caller sees an
item when the caller's level is at or above the item's level.

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
  page's images, file embeds, embedded drawings and child page cards, a
  drawing's images (`draws.file_refs`), a note's images, file embeds and
  drawings, followed transitively (a child page's images too;
  `packages/content/src/embed-closure.ts`). So the level label tells the
  truth, and the item's link serves what it shows. Nothing is ever raised,
  an embed already at or below the level is left alone, and an embed that
  can never go below admin (the type ceiling) stays admin and is reported
  (`stillAbove`). Links are not embeds: a link mark or a mention chip names
  an item without showing it, and the item keeps its own level. Every setter
  does it and lists what went down in `alsoLowered: [{id, type, title,
  from, to}]`: the Access control and `PATCH /api/access/nodes/:id`,
  `access_set`, the share paths (`node_share`, `page_share` and its
  sub-page cascade, `POST /api/shares`, the email link) and Accept at a
  level (member-logins.md section 6; the Library items a member embedded go
  down with it). The older `lowered` field carries the same items at their
  new level.
- **Later embeds follow on save.** A page, drawing or note below admin that
  gains an embed takes it to its own level, in the save's transaction: a
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
  items. There is no other flag. `team-responder` ships at admin; an admin
  lowers it once the shadow report is clean (section 5).
- **Tool groups.** An agent may hold only groups at or below its level:
  refused at grant time (`PATCH /api/agents/:id`, `agent_grant_tool_group`),
  left out at run time (`resolveAgentToolGroups`).

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
  every migrate. SELECT only. Draft columns (`pages.draft_doc`,
  `draws.draft_scene`, `tables.draft_data`, `apps.draft_source`, …) and login
  secrets are never granted. A table not in the list is a loud
  `permission denied`, never a silent leak.
- **`systemDb`** is the admin pool whatever the viewer, for the
  infrastructure a limited turn still writes: traces, tool-result spills, the
  approval queue, access and audit logs, the replay buffer, the embedding
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
(`MANTLE_TEST_DATABASE_URL`): the team-turn, team-groups and shadow-report
tests seed a minimal brain of their own (the shared test anchor from
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
- Migration 0159 carried today's sharing over: active team shares went to
  team, public links to public, a shared folder's contents with it. The
  member-facing groups `team-read` and `formulas-eval` are team level.

## 5. Turning it on for the team responder

1. Run the shadow report. It lists what recent member turns used (the last
   30 days; traces of the retired forum still count until they age out) that
   is still admin, shared tasks and events (admin forever: members lose
   them), items below admin whose embeds sit above them (`closureGaps`:
   empty once the boot reconcile ran, unless an admin raised an embed on
   purpose), and how many facts stay usable.
2. Set the levels of what the team should keep reading (a page's embeds go
   with it; a folder's contents with "Lower them too").
3. `access_set(agent_slug: 'team-responder', level: 'team')`. From the next
   turn it reads only team-level items. Undo: set it back to admin.

## 6. Operations

- **Restore** (`scripts/db-restore.sh`) creates the four roles
  (`mantle_view_team`, `mantle_view_client`, `mantle_view_public` and
  `mantle_view_space`) before `pg_restore` (a dump does not carry roles, but
  its policies and grants name them; migrate later gives them their login
  and password) and warns if the policies did not restore.
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
| client | open (anyone with the link), shown to the owner                           |
| public | open (anyone with the link), shown to the owner                           |

Team links are retired (member logins Phase 6 stage 6, migration 0176; see
docs/member-logins.md section 9): a link is always open, and there is no
share mode but `public`. The team codes those links took are gone too
(migration 0178): members read by level with their own logins, and nothing
outside a login reaches a team item.

- **Level to link.** `setItemLevel` (`@mantle/content` access.ts) writes the
  level, then `applyLevelToShare` (shares.ts) revokes the link (admin, team)
  or creates it (client, public), in ONE transaction: a link that cannot be made leaves the level
  where it was. `PATCH /api/access/nodes/:id` and `access_set` both use it.
  What goes down with the item (its embeds, a folder's contents when asked)
  gets the level only, never a link of their own: it is reached through the
  item that embeds it. The embeds go down in the same transaction. A new link first retires an
  expired one that was never revoked (it still holds the one-link slot).
- **Link to level.** Every share mutation (`createShare`, `applyShareMode`,
  `setShareCascade`, `revokeShare`, `revokeShareTree`) re-derives the level
  of the nodes it touched (`levelForShareMode`): no link is admin, except
  that an item at team stays at team; an open link keeps client or public
  and drops anything higher to public (so `node_share` on a team item puts
  it at public: to show an item to members only, set team instead). A
  node a link lowers takes its embeds down with it (section 1).
  Cascaded sub-pages take the parent's level, passed into every step, so a
  sub-page goes straight to it and never passes through public on the way;
  when a cascading link is revoked, a parent that went to admin takes its
  sub-pages with it, and a parent that went to team takes them to team. So
  `node_share` / `page_share` and the email link never drift from the level.
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
- **What an open link means for members.** Client and public items are
  readable by the team role, so a member can open one by id and the team
  agent can read it. The member Library does not LIST them: it lists team
  items only (docs/member-logins.md section 3).
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
  item itself: a public link public items, a client link client and public
  ones (`linkLevels` in server/web/lib/shares.ts).
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
