# Actors: who every statement runs as

## 1. What this is

The spec of who may read and change what, and how the code makes the
database decide it, as it holds on main (v0.300.83). A rule that does not
hold yet is under "Known limits", with the step that ends it. History and
every handover: [_archive/actors-history.md](./_archive/actors-history.md).
Related: [workspaces.md](./workspaces.md) (the model as users see it),
[edit-check.md](./edit-check.md) (the database's checks per table),
[runtime-role.md](./runtime-role.md), [update-prod.md](./update-prod.md).

## 2. Words

- **Actor**: who a statement runs as (section 4); every statement has one.
  **Login**: a signed-in user's row in `auth.users`; a key, a peer acting
  as a login and a phone act as a login.
- **Scope**: the workspaces a statement may read and change, with the
  login it acts for (`mantle_scope_login_id()`); set per transaction.
  **Workspace**: users, at most one assistant, connectors; items are
  granted to it. **Admin workspace**: the one with rules of its own, whose
  users (**Admin users**) manage the brain. **Area**: a part of managing
  the brain: settings, users, assistants, connectors, keys; an Admin user
  holds each unless its Admin row switches it off (`workspace_users.limits`).
- **Moderator**: a tick on a user of a workspace. **Item**: a node of a
  workspace kind (`ITEM_KINDS`), or a row an item owns. **Home**: the one
  workspace an item belongs to. **Grant**: an item shared to a workspace,
  with a Write switch. **Link**: a public link to one item. **Contact**: a
  contact share of one item. **Key**: an API key (`mtlk_`). **Peer**: a
  linked brain.

## 3. The one rule

Every statement carries an actor and, when it serves a login, that
login's scope. The database decides: row rules on reads, triggers and
definers on writes. TypeScript may refuse earlier for a better answer,
never instead of the database.

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

Work done later for a login (a run, a heartbeat with a maker, an approved
pending call, a Telegram turn) runs as that login is then (`loginActorNow`).

Binding, from `@mantle/db` only (the lint `actor-setters-in-db-only`):

- `runAsSystem(reason, fn)`: a process's own work;
  `runAsActor(loginActor(id, mode), fn)`: work for a login.
- `registerActorWorkflow(name, actorOf, impl)`
  (`server/api/src/workflows/actor-workflow.ts`): the one way a DBOS
  workflow registers; each run binds `actorOf(...args)`.
- `runReadPathWrite(name, fn)`: a named write inside a read path (section 8).
- `runInActorSlot(initial, fn)`: an entry whose caller is known later (the
  gate opens each request as `system(http:no-login)`, the guard names it).
- A workspace scope (`withViewer`, a turn scope) runs as its login.

An inner binding replaces an outer one. `systemUnder` keeps system work
read only under a read-only caller (`login(ro)`, `link`, a contact
without Can write). Every binder call is pinned per file
(`eslint-rules/actor-binders.mjs`). Every file that starts work on its
own, with the actor it binds: [process-inventory.md](./process-inventory.md)
(`eslint-rules/process-entries.test.ts` fails a file missing or stale).

## 5. The three routes to Postgres

| Route          | Role                                                  | Who may use it                                                    |
| -------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| system pool    | `mantle_runtime` (or the superuser, runtime role off) | system actors; a named exit (section 8)                           |
| workspace role | `mantle_view_user`                                    | a scope's reads: a login's, an assistant's, a link's served items |
| write role     | `mantle_write_user`                                   | a scope's writes to `WRITE_ROLE_TABLES`                           |

- `db` reads on the workspace role inside a scope and on the system pool
  outside one. `systemDb` is the system pool always; only
  `SYSTEM_DB_MODULES` may import it (`eslint-rules/system-db-allowlist.mjs`).
- The login write gateway (`loginWriteRoute`, `packages/db/src/gateway/write-route.ts`)
  sends a write to the write role when the actor is a login, an
  assistant, a link or a contact and the write carries a scope, in every
  check mode: the mode decides refuse or report, never the pool. One
  `SET LOCAL` with the transaction's first statement carries the scope,
  the actor and the create home. Never a session SET.
- A typed write to a table the write role holds no right on goes to the system
  pool by its drizzle table (`typed-write`, counted unless named, S4b); a raw one goes to the write
  role (no table read from text) and Postgres refuses it. Nothing runs again.
- The scoped pools never run the setter functions. Only `packages/db`
  sets `mantle.*` settings.
- Transactions: `withSystemTx` in an open system transaction is its
  savepoint, same actor and create home only. No nested write in a loop:
  Postgres keeps each written subtransaction's id to the top one's end,
  and past 64 every snapshot on the box slows (over 32 log a warning,
  `NESTED_SAVEPOINT_WARN`). Take the heads in the outer call before a
  nested call that can fail; only the outermost call retries. No
  transaction spans a model call, fetch or stream (`no-model-in-transaction`).

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

The database's needs (`mantle_check_row`, `mantle_check_item`): `read`,
`edit`, `manage`, `admin`, `appdata`, `link`, `link_close`
([edit-check.md](./edit-check.md)). An item the caller does not read answers
the 404 of none, as a random id; one it reads but may not change, 403.

Admin is management, not reading. An Admin login is an enabled user of the
live Admin workspace (`mantle_login_is_admin`, `..._admin_user`); the role
column follows, written by the membership definers only, and is shown, not
asked, except by the narrowing checks under Known limits (`Login` has no kind
or role: `adminFacts`; `mantle_role_drift` counts). `mantle_area_rule` answers `loginHasArea`
and `areasFor`; `requireArea` asks `mantle_scope_has_area` (the rule plus
"Admin in the scope") in its login's own scope, the rule unscoped.
`mantle_login_area` adds a counted fail-open (S4b removes it).

Owner rules (each holds today unless "Known limits" says otherwise):

- Moderator (owner decision 2026-10-13): only an Admin user with the users
  area ticks or clears it, or removes a Moderator, on every workspace; a
  Moderator adds users without the tick and removes plain users. Short of
  the users area nobody makes themselves one but a workspace's maker. The
  last is never cleared or removed (409 `last_moderator`). Admin users are
  always Moderators of Admin (409 `admin_workspace`) until removed from
  Admin; adding a user to Admin, or removing one, needs the users area.
- App code (build, edit, publish, history) needs manage of the app (D4);
  a new app's import, manage of its create home. Its data needs edit, and
  while Informational is on an Admin user. Its delete is an archive
  (Recently deleted, with a snapshot); one a login other than the owner
  deleted is purged by the owner only.
- A snapshot copy (`data.snapshot_of`) is read only for all, its author
  too, who may delete it. A new folder's indexing goes with the create
  rule (whoever may make it there sets it); an existing one's, its manage.
- The brain's profile row (owner decision 2026-10-17): the approval and
  egress gates go with the assistants area, `teamPrivateReads` with the
  users area, any other brain-row write with the settings area. Every
  login changes its own row; house style, purpose, archetype: owner only.
  On the write role the row rule holds it (`mantle_profile_writable`):
  the own row, the brain's with the settings area, a delete the own only.
- An app's export links (`app_table_exports`) are read and written with
  manage of the app (`mantle_may_manage_home`: no home, an Admin scope);
  a write also needs edit of the linked Table.
- Keys, links, contacts and peers are never widened. A key or a peer acts
  as its login as it is now and only narrows it (read only, areas, risky
  tools); neither changes the content of a page or note others read. A
  link and a `peer(share)` write nothing; a contact, its app's data only,
  with Can write on.
- Nothing grants by itself, but an item placed in a folder takes the
  folder's grants, and the dialog says so first.

## 7. Checks and modes

- **The actor check** (`mantle.actor_check`): a statement with no actor is
  a miss. TypeScript checks every statement through `db`, `systemDb` and
  `withSystemTx`; SQL, a statement trigger on every item table
  (`mantle_actor_check_tables()`).
- **The edit check** (`mantle.edit_check`): the write role's per-table
  checks and the read-only refusal (`mantle.write_mode = 'ro'`). It bites
  only while the actor check is warn or on.
- **Row rules**: the workspace and write roles read only rows the scope
  holds; a hidden row is absent, never an error.
- **Modes**: `off`, `warn` (run and report to `actor_check_misses`), `on`
  (refuse, 42501 with a detail the one mapper reads). The mode decides
  refuse or report; a session can only raise its own.
- **The floor** (0301): a box runs both checks on. Lowering needs an
  operator's reason (`mantle_set_check(setting, mode, tries, reason)`) and
  leaves a record (`mantle_check_lowered()`); migrate raises a box below on
  with no record (`MANTLE_CHECK_FLOOR=keep`, for CI and test databases,
  leaves it and records why); every process logs `[db] SECURITY:` while one
  is below. Change a mode only with `mantle_set_actor_check` or
  `mantle_set_edit_check` (they switch the triggers with the setting), as
  the superuser that runs migrations ([update-prod.md](./update-prod.md),
  "The checks' floor").
- **Fail-open counts** (S4a): five branches fail open, counted. S4b refuses them; a scoped typed write
  unless its matrix row names a `scopedSystemWrite` reason ([fail-open.md](./fail-open.md)).

## 8. Exits

An exit leaves the caller's scope for the system pool; each is named.
`asSystem(fn, reason)`: inside a turn or request scope only a reason of
`AS_SYSTEM_TURN_REASONS` (`packages/db/src/viewer.ts`, each with why);
each calling file is pinned (`eslint-rules/as-system-allowlist.mjs`).

| Reason             | Why the scope cannot do it                                |
| ------------------ | --------------------------------------------------------- |
| agent-workspace    | the workspace an assistant runs in, read before its scope |
| connector-binding  | a connector's binding and OAuth config                    |
| connector-call     | the remote call reads and refreshes its own credentials   |
| heartbeat-own-row  | the firing heartbeat changes its own row                  |
| app-data           | an app's SQLite work after the scope found the app        |
| rule-in-query      | any-login routes holding the rule in their own SQL        |
| admin-area         | an Admin area tool's system tables, after the area check  |
| keyword-candidates | ranked ids of a text match, re-read in the scope by id    |
| app-trash          | a deleted app's snapshots, after the manage check         |
| login-telegram     | a login's own Telegram chats (no role holds those tables) |
| audit-log          | a connector call's audit row                              |
| pending-approval   | an approved call re-enters the scope it was asked in      |
| page-refold        | the pages a grant change reaches                          |
| brain-bookkeeping  | `systemStep`'s brain-wide counts and reaps                |

- **Request exits** (`noteRequestSystem`, `server/web/lib/auth/session.ts`):
  `area` (an Admin area route, after the area check), `login-self` (a
  login's own things); `admin-write` has no site since S6 c3 (an Admin
  user's writes run in its scope). `first-owner` (`firstOwnerSwitch`, `packages/db/src/first-owner-exit.ts`): the signup's switch of a fresh install onto workspaces as `system:first-owner-attach`, full route, that one call; refused outside a request no login made, in any scope, twice, or unless the brain's one login is the new anchor and it has no workspace (the terminal wizard switches as its own script actor).
- **`systemStep(step, { items, need }, fn)`**
  (`packages/db/src/system-step.ts`): bookkeeping after the write's item
  check; it answers the caller numbers, yes or no, or rows its scope reads.
- **`systemWork(fn, reason)`**: system work that never runs in a scope
  (it refuses in one); files pinned (`eslint-rules/system-work-allowlist.mjs`).
- **Read-path writes** (`READ_PATH_WRITES`, `packages/db/src/actor.ts`): a
  write inside a read request or tool (a missing root row, a backfill, a
  link's view count) runs by `runReadPathWrite` as `system(<name>)`, even
  for a read-only key. `readPathWrites` only goes down, to workers.
- **How to add one**: name the reason with why, pin the file, raise
  `asSystemExits` with a reason in review. Prefer a definer.

## 9. Definers

A definer answers in the scope what the scope cannot read itself, and
nothing more. Shape: `SECURITY DEFINER`, a fixed `search_path` with
`pg_temp` last, `PUBLIC` revoked, `EXECUTE` for the workspace role (the
write role mirrors it) or the write role alone (`WRITE_ROLE_FUNCTIONS`).
In a scope the caller comes from its settings (`mantle_scope_login_id()`),
never an argument, and what the scope does not read answers NULL or
nothing. Families: grants and workspace screens (0291); 0293's scope exits
(kind roots, read cursors, access keys, pending counts, connectors,
contact sharing, name checks, `mantle_ws_create`); the write role's grant
change and its audit row (`mantle_grant_change`, `mantle_grant_move_home`,
`mantle_workspace_event`, 0279), folder subtree (`mantle_subtree_rewrite`,
`mantle_subtree_refuse_hidden`, 0282), edit check writes
(`mantle_secret_put`, `mantle_recall_retarget`, 0281), a workspace's users, resources and assistant (0307), its row, contact, landing app and archive (0309); a Telegram chat's block or unpair (`mantle_tg_chat_set`, 0313: its own login, or the bot's Moderator rule `mantle_tg_login_moderates`, 0313, which `loginModeratesBot` and `mantle_tg_moderated_chats` ask too: a Moderator of its bot's workspace, an Admin user with the users area; the write and narrow roles; refused read only or off this brain); a raced snapshot copy's home (`mantle_file_restamp_home`, 0313: the snapshot copies' system work only, the runtime role); the folder trail (`mantle_folder_trail`, 0311: the folders at or above a row a login's scope reads, by id, path and name only, for a login's own session's tree reads; no write asks it, so such a folder answers 404 to every write).
With no acting login the 0307 and 0309 writers and `mantle_file_restamp_home` refuse all but one named actor per definer (`mantle_ws_system_work(fn)`, three pairs); `mantle_tg_chat_set` with no scope consults no allowlist and acts for the login it is passed (only the narrow and system routes run without a scope);
no TS writes the four workspace tables; named: login bridge, bridge connector, the switch, guards.

## 10. HTTP

- Every route of the manifest and method has one `ROUTE_POLICY` row
  (`lib/auth/route-policy.ts`): class, scope, area, effect, open, logins,
  creates, item, key area, limits; a route with none is refused. Its route
  file declares it too (`routePolicy`; lint and boot refuse a file without).
- The gate (`packages/db/src/gate.ts`, `enterCall`) runs eight steps for
  every way in: resolve, bind the caller, look up the policy and bind the
  actor and scope, narrow by surface, the Admin step, the create home,
  run, map a refusal. Listing equals calling.
- A write handler reads its item in the caller's scope first, or asks
  `assertItemRight` (`packages/db/src/item-rights.ts`) before any side effect;
  a hidden item is the 404 of none. Its declaration's `item` says which right, or none and why (intent only).

## 11. Tools

- Every builtin declares a `ToolPolicy` (`packages/tools/src/tool-policy.ts`),
  among its fields `effect`, `spends`, `scope` (`any`, `admin`,
  `admin-kind`, or an area), `creates`, `itemArgs`, `peerRisky`,
  `keyArea`, `keySharedContent`, `clientSourced`. The gate reads it; no
  list is keyed by tool name.
- `itemArgs` names the items a write touches: the audit row's targets and
  the queue-time check of a call that waits for approval; it decides nothing
  at run time. Tool item pre-checks (policy lists): none. The database
  decides a tool's write; the library asks `assertItemRight` first only for
  a clear answer before a side effect (section 10). So both checks run on.
- An approved pending call runs in the scope it was asked in, judged
  again with its asker's rights now (`pending-approval.ts`).

## 12. Adding a kind, route, tool, table, exit or definer

- **A kind**: add it to `ITEM_KINDS`; the route lists, the access matrix
  and the A8 grid read the registry. `handKindLists` fails a hand list.
- **A route**: a policy row; `route-scope.test.ts` fails an unclassified
  route, the gate refuses one with no row; its route file declares it. A write naming its
  item gets A8 route cells (`server/web/server/test-support/a8-route-cells.ts`, warn and on), or runs refused cells only; its need is the lowest right its handler takes (a higher one gets its own cells: the app snapshot restore's code restore, an app's description, a file's or folder's move).
- **A tool**: a `ToolPolicy` (typecheck fails without one); a write
  declares its `clientSourced` rule (unset, a client-sourced call waits),
  `itemArgs` and A8 `matrix` (action and argument, or `none` and why; an
  id-taking read too), read by no gate: the tool cells (one allowed, one
  refused at least); `a8-coverage.test.ts` pins `a8Uncovered` 0, `a8Exempt` 112.
- **A table**: a row in `packages/db/src/access-matrix.ts` (with none no
  scoped role may touch it); an item table gets the actor trigger
  (`actor-trigger-coverage.db.test.ts`).
- **An exit**: section 8 (`asSystemExits` and the allowlists fail first).
  **A definer**: section 9's shape, a DB test of its scope answer, the
  runtime role's allowlist when the system pool calls it. **A process
  entry**: [process-inventory.md](./process-inventory.md).

## 13. Proof

- Suites: `pnpm test`, `test:actor-off`, `test:actor-on`, `test:edit-on`,
  `test:runtime-role`, `test:matrix` (A8 cells), `test:serial`. An actor miss fails a test.
- The scoreboard (`pnpm arch:check`, `scripts/arch-scoreboard.pins.json`):
  each count only goes down; a raise needs a reason in review.
- `pnpm docs:check`: every path a doc names exists, and every
  `docs/<file>.md, "Heading"` quote names a heading.

## 14. Operating a box

- **The runtime role**: `MANTLE_DB_RUNTIME_ROLE=1` makes the system pool
  log in as `mantle_runtime`, which cannot disable a trigger, alter a table
  or change a mode; off, it is the superuser, said at every start
  (`[db] SECURITY:`). A new install writes 1; a roll writes the value a box
  runs with into a `.env` with no line (S4a, [runtime-role.md](./runtime-role.md)).
  `/api/health` shows `postgres.role`.
- **Modes**: both checks on (section 7). **Emergency switches**: lowering
  a check (a reason, recorded and logged) and the runtime role.
- **Box counts** (numbers only): `scripts/arch-scoreboard-box.sh <ssh-alias>`;
  `/debug/integrity` shows `check_floor`, `actor_check_drift`,
  `edit_check_drift`, `runtime_role_lock`.
- **Repair**: a named command, or hand psql as the superuser after
  `mantle_operator_actor('reason')`.

## 15. Known limits

Each ends in the step of plan v3.2 (2026-10-17) named.

- `mantle_login_area` is the area rule or, with no Admin workspace, yes. S4.
- A definer asked with no scope answers as the system pool would;
  `mantle_grant_change` then takes the caller from its `actor`. S2, S7.
- The seven Admin acts' definers (0308, 0310) run by `loginDefinerCall` on the
  system pool: the write role holds no EXECUTE on them yet. S7.
- The system pool is the whole runtime role; the narrow role exists, unused. S7.
- Route policy is spread over lists, not declared per route. S9.
- Five branches fail open, counted since S4a (section 7, Fail-open counts). S4.
- Five checks still ask the role column, each only narrowing while drift is 0:
  `findMemberAsset`, `memberLoginActive`, `mcp-auth.ts` (2), `login-notices.ts`. S8 follow-up.
- Accepted, no step: any role can `set_config('mantle.actor', …)`, so the
  settings are no credential; access is never decided from them on a role
  that runs caller-shaped SQL.
- Code comments still carry history and point at the history file
  (`actorsHistoryRefs`, `actorsStepRefs`). D2.
