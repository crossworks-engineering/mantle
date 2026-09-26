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
- **No inheritance.** Lowering a folder does not lower its contents. The
  Access control offers the item's **closure** (a page's embedded files and
  drawings, a folder's contents, a drawing's images) as one explicit extra
  step. The closure is only ever lowered, never raised.
- **An agent's level is the switch.** A team-level agent runs every query of
  its turn on the team role, so it reads only team-, client- and public-level
  items. There is no other flag. `team-responder` ships at admin; an admin
  lowers it once the shadow report is clean (section 5).
- **Tool groups.** An agent may hold only groups at or below its level:
  refused at grant time (`PATCH /api/agents/:id`, `agent_grant_tool_group`),
  left out at run time (`resolveAgentToolGroups`).

## 2. How it is enforced

- **Limited LOGIN roles**: `mantle_view_team`, `mantle_view_client`,
  `mantle_view_public`. Real login roles, never a `SET ROLE` on the superuser
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
  kind; chunks, pages, draws, tables, apps and app databases follow their
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
  cache, the member's own thread, API key reads. The lint rule
  `mantle-db/system-db-allowlist` lets only those modules import it.
- **`asSystem(fn)`** is the one audited escape for a write a limited turn
  needs: `team_request_create` files its admin-level task through it.
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

1. Run the shadow report. It lists what recent team and forum turns used that
   is still admin, shared tasks and events (admin forever: members lose
   them), shares whose embeds sit above them, and how many facts stay
   usable.
2. Set the levels of what the team should keep reading (with closure where
   an item is shared).
3. `access_set(agent_slug: 'team-responder', level: 'team')`. From the next
   turn it reads only team-level items. Undo: set it back to admin.

## 6. Operations

- **Restore** (`scripts/db-restore.sh`) creates the three roles before
  `pg_restore` (a dump does not carry roles, but its policies name them) and
  warns if the policies did not restore.
- **Every box connects as the Postgres superuser**, which bypasses row level
  security: the owner's paths are unaffected. The `demo` branch's
  `demo_reader` role is NOT a superuser: before this migration reaches the
  demo box it needs `ALTER ROLE demo_reader BYPASSRLS` (on the demo branch).
- **Still to come:** share links (`/s/`) running at the link's level ships in
  a later release, after the closure gaps the shadow report lists are fixed;
  member logins (Phase 1) and personal spaces (Phase 2) build on this.

## 7. Levels drive links

The level is the truth; an item's share link (docs/sharing.md) follows it.

| Level  | The item's link                                                   |
| ------ | ----------------------------------------------------------------- |
| admin  | none (revoked)                                                    |
| team   | team-only: the `/team` workspace lists and opens items through it |
| client | open (anyone with the link), shown to the owner                   |
| public | open (anyone with the link), shown to the owner                   |

- **Level to link.** `setItemLevel` (`@mantle/content` access.ts) writes the
  level, then `applyLevelToShare` (shares.ts) revokes, creates or re-modes
  the link. `PATCH /api/access/nodes/:id` and `access_set` both use it.
  Closure items get the level only, never a link of their own: they are
  reached through the item that embeds them.
- **Link to level.** Every share mutation (`createShare`, `setShareMode`,
  `applyShareMode`, `setShareCascade`, `revokeShare`, `revokeShareTree`)
  re-derives the level of the nodes it touched (`levelForShareMode`): no link
  is admin, a team-only link is team, an open link keeps client or public and
  drops anything higher to public. Cascaded sub-pages take the parent's
  level. So `node_share` / `page_share`, the hub app and the email link never
  drift from the level. (Closure items are the exception: revoking or
  raising an item does not raise what it embeds.)
- **What an open link means for members.** Client and public items are
  readable by the team role, so a member can open one by id and the team
  agent can read it. The member Library does not LIST them: it lists team
  items only (docs/member-logins.md section 3).
- **Admin-only kinds** (tasks, events, …) stay admin whatever link they
  carry. Setting one to admin removes an old link.
- Migration 0161 re-derived every level from the links once, for the window
  between 0159 and this rule.
- **Not yet:** `/s/` handlers run at admin; running them at the link's level
  (after the share render path reads published columns only) is a later
  release. Until then a link can show an embed above its level, which is
  why the Access control offers the closure.
