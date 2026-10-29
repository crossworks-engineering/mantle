# Actors: who every statement runs as

## 1. What this is

The spec of who may read and change what, and how the code makes the database decide it. A rule that
does not hold yet is under "Known limits", with its owner and date. History:
[_archive/actors-history.md](./_archive/actors-history.md).

## 2. Words

- **Actor**: who a statement runs as (section 4); every statement has one. **Login**: a signed-in
  user's row in `auth.users`; a key, a peer acting as a login and a phone act as a login.
- **Scope**: the workspaces a statement may read and change, with the login it acts for
  (`mantle_scope_login_id()`); set per transaction. **Workspace**: users, at most one assistant,
  connectors; items are granted to it. **Admin workspace**: the one with rules of its own, whose
  users (**Admin users**) manage the brain. **Area**: a part of managing the brain: settings, users,
  assistants, connectors, keys; an Admin user holds each unless its Admin row switches it off
  (`workspace_users.limits`).
- **Moderator**: a tick on a user of a workspace. **Item**: a node of a workspace kind
  (`ITEM_KINDS`), or a row an item owns. **Home**: the one workspace an item belongs to. **Grant**:
  an item shared to a workspace, with a Write switch. **Link**: a public link to one item.
  **Contact**: a contact share of one item. **Key**: an API key (`mtlk_`). **Peer**: a linked brain.

## 3. The one rule

Every statement carries an actor and, when it serves a login, that login's scope. The database
decides: row rules on reads, triggers and definers on writes. TypeScript may refuse earlier for a
better answer, never instead of the database.

## 4. Actor kinds and how code binds one

| Kind             | Who                                                                             | Writes                               |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| `login(rw)`      | a user, a read-write key, a peer acting as a login, Write on                    | what the login may change            |
| `login(ro)`      | a read-only key, a peer acting as a login, Write off                            | nothing                              |
| `login(owner)`   | the Admin assistant with no user, a run with no login, the owner's Telegram bot | what the owner may change            |
| `assistant`      | a workspace assistant with no user asking                                       | nothing                              |
| `link`           | an open public link                                                             | nothing                              |
| `contact`        | a contact share                                                                 | its app's data, when Can write is on |
| `peer(share)`    | a peer without Acts as, reading what is shared to it                            | nothing                              |
| `system(reason)` | a process, a named exit (section 8), a migration, a script                      | what the reason needs                |

Work done later for a login (a run, a heartbeat with a maker, an approved pending call, a Telegram
turn) runs as that login is then (`loginActorNow`).

Binding, from `@mantle/db` only (the lint `actor-setters-in-db-only`): `runAsSystem(reason, fn)` for
a process's own work; `runAsActor(loginActor(id, mode), fn)` for a login;
`registerActorWorkflow(name, actorOf, impl)` (`server/api/src/workflows/actor-workflow.ts`), the one
way a DBOS workflow registers, each run binding `actorOf(...args)`; `runReadPathWrite(name, fn)` for
a named write inside a read path (section 8); `runInActorSlot(initial, fn)` for an entry whose
caller is known later (the gate opens each request as `system(http:no-login)`, the guard names it).
A workspace scope (`withViewer`, a turn scope) runs as its login. An inner binding replaces an outer
one. `systemUnder` keeps system work read only under a read-only caller (`login(ro)`, `link`, a
contact without Can write). Every binder call is pinned per file (`eslint-rules/actor-binders.mjs`).
Every file that starts work on its own, with the actor it binds:
[process-inventory.md](./process-inventory.md) (`eslint-rules/process-entries.test.ts` fails a file
missing or stale).

## 5. The three routes to Postgres

| Route          | Role                                                  | Who may use it                                                    |
| -------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| system pool    | `mantle_runtime` (or the superuser, runtime role off) | system actors; a named exit (section 8)                           |
| workspace role | `mantle_view_user`                                    | a scope's reads: a login's, an assistant's, a link's served items |
| write role     | `mantle_write_user`                                   | a scope's writes to `WRITE_ROLE_TABLES`                           |

- `db` reads on the workspace role inside a scope and on the system pool outside one. `systemDb` is
  system work's handle (only `SYSTEM_DB_MODULES` may import it,
  `eslint-rules/system-db-allowlist.mjs`): the narrow route in a scope, the system pool outside.
- The login write gateway (`loginWriteRoute`, `packages/db/src/gateway/write-route.ts`) sends a
  write to the write role when the actor is a login, an assistant, a link or a contact and the write
  carries a scope, in every check mode: the mode decides refuse or report, never the pool. One
  transaction-local set (`set_config(..., true)`) with the transaction's first statement carries the
  scope, the actor and the create home. Never a session SET.
- **The narrow route**: `systemDb` in a scope, and an exit routed narrow (`AS_SYSTEM_ROUTE`,
  `REQUEST_SYSTEM_ROUTE`: each reason picks), run as `mantle_system_narrow` on its own pool
  (`packages/db/src/gateway/narrow-route.ts`), always (no switch). Its rights come from the access
  matrix (`narrowFor`, `NARROW_WRITES`): content read only, no item written. A block that must run
  full is a named spot (`FULL_ROUTE_SPOTS`). A refused statement is counted (`narrow-denied`, with
  its epoch). Work outside every scope (workers, boot) runs full.
- The scoped pools never run the setter functions. Only `packages/db` sets `mantle.*` settings.
- Transactions: `withSystemTx` in an open system transaction is its savepoint, same actor and create
  home only. No nested write in a loop: Postgres keeps each written subtransaction's id to the top
  one's end, and past 64 every snapshot on the box slows (over 32 log a warning,
  `NESTED_SAVEPOINT_WARN`). Take the heads in the outer call before a nested call that can fail;
  only the outermost call retries. No transaction spans a model call, fetch or stream
  (`no-model-in-transaction`).

## 6. Who may do what

| To do this                            | You need                                        |
| ------------------------------------- | ----------------------------------------------- |
| read an item                          | to be a user of a workspace it is granted to    |
| edit it                               | Moderator of its home, or a grant with Write on |
| manage it (app code, links of an app) | Moderator of its home                           |
| delete it                             | Moderator of its home (an app: Admin users too) |
| move it from H to T                   | Moderator of H and of T                         |
| add a grant to T, Write on            | Moderator of its home and of T                  |
| remove a grant, Write off             | Moderator of its home, or of T                  |
| open or change its link               | edit (an app: manage)                           |
| export it into your files             | read (the copy lands in your create home)       |
| re-run its extraction                 | edit (it spends model work)                     |
| close any link                        | an Admin user with the users area               |
| tick or clear Moderator               | an Admin user with the users area               |
| share it with a contact               | an Admin user (its home is not checked)         |
| an Admin area                         | an Admin user holding that area                 |

The database's needs (`mantle_check_row`, `mantle_check_item`): `read`, `edit`, `manage`, `admin`,
`appdata`, `link`, `link_close` ([edit-check.md](./edit-check.md)). An item the caller does not read
answers the 404 of none, as a random id; one it reads but may not change, 403.

Admin is management, not reading. An Admin login is an enabled user of the live Admin workspace
(`mantle_login_is_admin`); a member is a usable login that is not one (`memberLogin`). The role
column follows membership, written by the membership definers only, and is shown, never asked: no
decision reads a caller's role (`Login` has no kind or role, `adminFacts` asks; `mantle_role_drift`
counts drift). `mantle_area_rule` answers `loginHasArea` and, over every area, `areasFor`
(`mantle_login_areas`); `requireArea` asks `mantle_scope_has_area` (the rule plus "Admin in the
scope") in its login's own scope, the rule unscoped.

Owner rules:

- Moderator: only an Admin user with the users area ticks or clears it, or removes a Moderator; a
  Moderator adds users without the tick and removes plain users; short of the users area only a
  workspace's maker makes itself one. The last is never cleared or removed (409 `last_moderator`).
  Admin users are always Moderators of Admin (409 `admin_workspace`); adding a user to Admin, or
  removing one, needs the users area.
- App code (build, edit, publish, history) needs manage of the app; a new app's import, manage of
  its create home. Its data needs edit, and while Informational is on an Admin user. Its delete is
  an archive (Recently deleted, with a snapshot); one a login other than the owner deleted is purged
  by the owner only.
- A snapshot copy (`data.snapshot_of`) is read only for all, its author too, who may delete it. A
  new folder's indexing goes with the create rule (whoever may make it there sets it); an existing
  one's, its manage.
- The brain's profile row: the approval and egress gates go with the assistants area,
  `teamPrivateReads` with the users area, any other brain-row write with the settings area; house
  style, purpose, archetype: owner only. Every login changes its own row (`mantle_profile_writable`
  on the write role: the own row, the brain's with the settings area, a delete the own only).
- An app's export links (`app_table_exports`) are read and written with manage of the app
  (`mantle_may_manage_home`: no home, an Admin scope); a write also needs edit of the linked Table.
- Keys, links, contacts and peers are never widened. A key or a peer acts as its login as it is now
  and only narrows it (read only, areas, risky tools); neither changes the content of a page or note
  others read. A link and a `peer(share)` write nothing; a contact, its app's data only, with Can
  write on.
- Nothing grants by itself, but an item placed in a folder takes the folder's grants, and the dialog
  says so first.

## 7. Checks and modes

- **The actor check** (`mantle.actor_check`): a statement with no actor is a miss. TypeScript checks
  every statement through `db`, `systemDb` and `withSystemTx`; SQL, a statement trigger on every
  item table (`mantle_actor_check_tables()`).
- **The edit check** (`mantle.edit_check`): the write role's per-table checks and the read-only
  refusal (`mantle.write_mode = 'ro'`). It bites only while the actor check is warn or on.
- **Row rules**: the workspace and write roles read only rows the scope holds; a hidden row is
  absent, never an error.
- **Modes**: `off`, `warn` (run and report to `actor_check_misses`), `on` (refuse, 42501 with a
  detail the one mapper reads). The mode decides refuse or report; a session can only raise its own.
- **The floor**: a box runs both checks on. Lowering needs an operator's reason
  (`mantle_set_check(setting, mode, tries, reason)`) and leaves a record (`mantle_check_lowered()`);
  migrate raises a box below on with no record (`MANTLE_CHECK_FLOOR=keep`, for CI and test
  databases, leaves it and records why); every process logs `[db] SECURITY:` while one is below.
  Change a mode only with `mantle_set_actor_check` or `mantle_set_edit_check` (they switch the
  triggers with the setting), as the superuser that runs migrations
  ([update-prod.md](./update-prod.md), "The checks' floor").
- **Fail closed**: unscoped, `scopeHoldsAdmin` and `scopeHasArea` say yes to system work only and
  throw otherwise; a scoped typed write to a table the write role holds no right on is refused
  before it is sent, unless its matrix row names `scopedSystemWrite` (a login's write; pin
  `scopedSystemWriteTables`), and a raw one goes to the write role, which refuses it; an unlisted
  exit and an off-list `systemDb` caller throw in production too ([fail-open.md](./fail-open.md)).

## 8. Exits

An exit leaves the caller's scope for the system pool; each is named, on its route. Inside a turn or
request scope `asSystem(fn, reason)` takes only a reason of `AS_SYSTEM_TURN_REASONS`
(`packages/db/src/viewer.ts`); each calling file is pinned (`eslint-rules/as-system-allowlist.mjs`).

| Reason             | Route  | Why the scope cannot do it                                |
| ------------------ | ------ | --------------------------------------------------------- |
| agent-workspace    | narrow | the workspace an assistant runs in, read before its scope |
| connector-binding  | narrow | a connector's binding and OAuth config                    |
| connector-call     | narrow | the remote call reads and refreshes its own credentials   |
| heartbeat-own-row  | narrow | the firing heartbeat changes its own row                  |
| app-data           | full   | an app's SQLite work after the scope found the app        |
| rule-in-query      | full   | any-login routes holding the rule in their own SQL        |
| admin-area         | narrow | an Admin area tool's system tables, after the area check  |
| keyword-candidates | narrow | ranked ids of a text match, re-read in the scope by id    |
| app-trash          | full   | a deleted app's snapshots, after the manage check         |
| login-telegram     | narrow | a login's own Telegram chats (no role holds those tables) |
| audit-log          | narrow | a connector call's audit row                              |
| pending-approval   | narrow | an approved call re-enters the scope it was asked in      |
| page-refold        | full   | the pages a grant change reaches                          |
| brain-bookkeeping  | full   | `systemStep`'s brain-wide counts and reaps                |

- **Request exits** (`noteRequestSystem`, called by the session guard): `area` (an Admin area route,
  after the area check) and `login-self` (a login's own things), both narrow; an Admin user's other
  writes run in its scope. `first-owner` (`firstOwnerSwitch`,
  `packages/db/src/first-owner-exit.ts`): the signup's one switch of a fresh install onto
  workspaces, full route, as `system:first-owner-attach`; refused but in a request no login made,
  outside every scope, once, on a brain whose one login is the new anchor and has no workspace.
- **`systemStep(step, { items, need }, fn)`** (`packages/db/src/system-step.ts`): bookkeeping after
  the write's item check, answering numbers, yes or no, or rows the scope reads. **`systemWork(fn,
  reason)`**: work that never runs in a scope (it refuses one), full route; files pinned
  (`eslint-rules/system-work-allowlist.mjs`).
- **The SQL system-work allowlist** (`mantle_ws_system_work(fn)`, `WORKSPACE_SYSTEM_REASONS`): with
  no acting login, a workspace definer or `mantle_file_restamp_home` runs only for its one listed
  actor: `system:ws-clear-ticks` (`mantle_ws_set_moderator`), `system:boot:migrate-workspaces`
  (`mantle_ws_attach_assistants`), `system:snapshot-copies` (`mantle_file_restamp_home`).
  `system:operator:*` is on no line: a hand repair there is the superuser's (section 14).
- **Logs**: the audit rows (`audit_log`, `system:audit:tool-call`) and the MCP call log
  (`mcp_calls`, `system:audit:mcp-call`; a login reads only its own rows) go through `systemDb`,
  which on the narrow route may only INSERT them.
- **Read-path writes** (`READ_PATH_WRITES`, `packages/db/src/actor.ts`): a write inside a read
  request or tool (a missing root row, a link's view count) runs by `runReadPathWrite` as
  `system(<name>)`, even for a read-only key. `readPathWrites` only goes down, to workers.
- **How to add one**: a reason with why and its route (typecheck fails one without), the file
  pinned, `asSystemExits` raised with a reason in review. Prefer a definer.

## 9. Definers

A definer answers in the scope what the scope cannot read itself, and nothing more. Shape: `SECURITY
DEFINER`, a fixed `search_path` with `pg_temp` last, `PUBLIC` revoked, `EXECUTE` for the workspace
role (the write role mirrors it) or the write role alone (`WRITE_ROLE_FUNCTIONS`). In a scope the
caller comes from its settings (`mantle_scope_login_id()`), never an argument, and what the scope
does not read answers NULL or nothing. A workspace definer acts for the scope's login; with none,
only Admin's add and remove of a user take the exit's acting login (`mantle_ws_exit_login`), and the
rest refuse unless the SQL system-work allowlist names the actor (section 8). With no scope, the
other definers that act for a login take only the acting login (`mantle.acting_login`) from a system
session (`mantle_system_session`), but for two (Known limits).

Families: grants and workspace screens (0291); scope exits (0293: kind roots, read cursors, access
keys, pending counts, connectors, contact sharing, name checks, `mantle_ws_create`); the grant
change and its audit row (`mantle_grant_change`, `mantle_grant_move_home`, `mantle_workspace_event`,
0279); the folder subtree (`mantle_subtree_rewrite`, `mantle_subtree_refuse_hidden`, 0282); the edit
check's writes (`mantle_secret_put`, `mantle_recall_retarget`, 0281); a workspace's users, resources
and assistant (0307), its row, contact, landing app and archive (0309); the Admin acts (0308, 0310)
and the member turn ledger (0326, 0327), each one call by `loginDefinerCall` in the login's scope; a
Telegram chat's block or unpair (`mantle_tg_chat_set`: its own login, or the bot's Moderator rule
`mantle_tg_login_moderates`, which `loginModeratesBot` and `mantle_tg_moderated_chats` ask too: a
Moderator of the bot's workspace, an Admin user with the users area); a raced snapshot copy's home
(`mantle_file_restamp_home`, system work only); the folder trail (`mantle_folder_trail`, 0311: id,
path and name of the folders above a row the scope reads; no write asks it, so such a folder answers
404 to every write).

No TypeScript writes the four workspace tables (`workspaceTableRawWrites` 0; the runtime role holds
SELECT only there); each SQL function writing them has a rule (the acting login) or a named
exemption: the switch's steps (the migrator only), two guard triggers, one private helper no role
runs (`WRITERS`, `packages/db/src/ws-user-definers.db.test.ts`; pin `workspaceTableWriterFns`).

## 10. HTTP

- Every route and method has one `ROUTE_POLICY` row (`server/web/lib/auth/route-policy.ts`), read
  from its file's declaration (`routePolicy`, `server/web/lib/auth/route-declaration.ts`): class,
  area, effect, open, caller, creates, item, key area, limits, audit. The lint
  `route-policy-declared` and the boot refuse a file without one; a route with no row is refused.
- The gate (`packages/db/src/gate.ts`, `enterCall`) runs eight steps for every way in: resolve, bind
  the caller, look up the policy and bind the actor and scope, narrow by surface, the Admin step,
  the create home, run, map a refusal. Listing equals calling.
- A write handler reads its item in the caller's scope first, or asks `assertItemRight`
  (`packages/db/src/item-rights.ts`) before any side effect; a hidden item is the 404 of none.

## 11. Tools

- Every builtin declares a `ToolPolicy` (`packages/tools/src/tool-policy.ts`), among its fields
  `effect`, `spends`, `scope`, `creates`, `itemArgs`, `peerRisky`, `keyArea`, `keySharedContent`,
  `clientSourced`, `matrix`. The gate reads it; no list is keyed by tool name.
- `itemArgs` (the audit row's targets, the queue-time check of a call that waits) and `matrix` (the
  A8 action and argument, or `none` and why, read only by the A8 tool cells) decide nothing at run
  time. No tool runs an item pre-check (`itemPrecheckTools` 0): the database decides a tool's write,
  and the library asks `assertItemRight` first only for a clear answer before a side effect.
- An approved pending call runs in the scope it was asked in, judged again with its asker's rights
  now (`packages/tools/src/pending-approval.ts`); a delegated child in its caller's
  ([workspaces.md](./workspaces.md)).

## 12. Adding a kind, route, tool, table, exit or definer

- **A kind**: add it to `ITEM_KINDS`; the route lists, the access matrix and the A8 grid read the
  registry. `handKindLists` (`pnpm arch:check`) fails a hand list; `a8-coverage.test.ts` fails a
  kind in neither the grid nor `A8_EXEMPT`.
- **A route**: its file's declaration (section 10: the lint and the boot fail a file without one;
  `route-policy-declarations.test.ts` holds the rows to their snapshot). A write names its item
  (`item: { param, need }`, the lowest right its handler takes) or says `none` and why;
  `a8-coverage.test.ts` fails a write naming its item with neither A8 route cells
  (`server/web/server/test-support/a8-route-cells.ts`) nor an exemption.
- **A tool**: a `ToolPolicy`; typecheck fails a builtin without one or a write without its `matrix`,
  and `tool-matrix.test.ts` a read taking an item id without one. A write also declares
  `clientSourced` (unset, a client-sourced call waits) and `itemArgs`. `a8-coverage.test.ts` fails
  an action without an allowed and a refused tool cell
  (`packages/db/src/matrix/test-support/a8-tool-cells.ts`), or a write without its member-negative
  cells (pins `a8Uncovered`, only down; `a8Exempt`, each new exemption reviewed).
- **A table**: a row in `packages/db/src/access-matrix.ts`; `access-matrix.test.ts` fails a Drizzle
  table without one (no scoped or narrow role may touch it until then). A new content table gets no
  narrow writes (`narrowFor`). An item table gets the actor trigger
  (`actor-trigger-coverage.db.test.ts`). Raw write SQL fails the lint `no-raw-write-sql` (pin
  `rawWriteSqlScoped`).
- **An exit**: section 8. Typecheck fails a reason with no route; the lints `as-system-allowlist`,
  `system-work-allowlist` and `system-db-allowlist` fail an unpinned file; `asSystemExits` and
  `asSystemReasons` fail a new one until raised with a reason. **A process entry**:
  [process-inventory.md](./process-inventory.md) (`process-entries.test.ts`).
- **A definer**: section 9's shape, with a DB test of its scope answer and catalog. The write role
  runs only `WRITE_ROLE_FUNCTIONS` (`write-role.db.test.ts`), the system pool only
  `RUNTIME_SYSTEM_FUNCTIONS` (`runtime-role.db.test.ts`), the narrow role only its lists
  (`narrow-login.db.test.ts`). A new function writing a workspace table fails
  `workspaceTableWriterFns`, a new SQL reader of `auth.users.role` `sqlRoleReaders`
  (`rights-catalog.db.test.ts`, `role-readers-catalog.db.test.ts` hold the count to the catalog).

## 13. Proof

- Suites: `pnpm test`, `test:actor-off`, `test:actor-on`, `test:edit-on`, `test:runtime-role`,
  `test:matrix` (the A8 cells), `test:serial`. An actor miss fails a test. `pnpm verify` runs the
  gates and every suite but `test:runtime-role`, which CI runs as a subset.
- The scoreboard (`pnpm arch:check`, `scripts/arch-scoreboard.pins.json`): each count only goes
  down; a raise needs a reason in review. `pnpm docs:check`: every path a doc names exists, and
  every `docs/<file>.md, "Heading"` quote names a heading.

## 14. Operating a box

- **The runtime role**: `MANTLE_DB_RUNTIME_ROLE=1` makes the system pool log in as `mantle_runtime`,
  which cannot disable a trigger, alter a table or change a mode, and writes the four workspace
  tables only through definers. Off, it is the superuser and Postgres refuses it nothing; every
  start says so (`[db] SECURITY:`). A new install writes 1; a roll writes the running value into a
  `.env` with no line ([runtime-role.md](./runtime-role.md)); `/api/health` shows `postgres.role`.
- **Modes**: both checks on (section 7); the one emergency switch is lowering a check. The narrow
  route has none ([runtime-role.md](./runtime-role.md), "The narrow route").
- **Box counts** (numbers only): `scripts/arch-scoreboard-box.sh <ssh-alias>` (the check modes, role
  drift, brains without an Admin workspace, `env_names_runtime_role`, `narrow_misses:denied`);
  `/debug/integrity` (`check_floor`, `actor_check_drift`, `edit_check_drift`, `runtime_role_lock`).
- **Repair**: a named command, or hand psql as the superuser after `mantle_operator_actor('reason')`
  (the session runs as `system:operator:<reason>`, which the workspace definers refuse:
  [update-prod.md](./update-prod.md), "Hand psql on a box").

## 15. Known limits

- With no scope, `mantle_grant_change` and `mantle_grant_move_home` take the caller from their
  `actor` argument, not only the acting login (section 9). Owner: `packages/db`. By 2026-11-30.
- The seven Admin acts' definers (0308, 0310) run by `loginDefinerCall` on the system pool: the
  write role holds no EXECUTE on them yet. Owner: `packages/db`. By 2026-11-30.
- The narrow role writes no item but still reads the `content` tables (`narrowFor`): at least 17
  code sites read content on a narrow exit (the measured list:
  [_archive/plan-v3-s7c-handover.md](./_archive/plan-v3-s7c-handover.md)); each moves to a read
  definer, the caller's scope or a named full-route spot. Owner: `packages/db`. By 2026-12-15.
- Accepted: any role can `set_config('mantle.actor', ...)`, so the settings are no credential;
  access is never decided from them on a role that runs caller-shaped SQL. Owner: `packages/db`,
  reviewed at every security audit; next by 2026-12-31.
