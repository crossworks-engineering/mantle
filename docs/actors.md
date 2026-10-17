# Actors: who every statement runs as

The rules of access in the brain as they hold today (v0.300.83). How they
came to be, and every handover, is history:
[_archive/actors-history.md](./_archive/actors-history.md).

## 1. What this is

The spec of who may read and change what, and how the code makes the
database decide it. Each rule here holds on main. A rule that does not
hold yet is under "Known limits", with the step that ends it. Related:
[workspaces.md](./workspaces.md) (the model as users see it),
[edit-check.md](./edit-check.md) (the database's checks per table),
[runtime-role.md](./runtime-role.md), [update-prod.md](./update-prod.md).

## 2. Words

- **Actor**: who a statement runs as (section 4). Every statement has one.
- **Login**: a signed-in user's row in `auth.users`. A key, a peer acting
  as a login and a phone act as a login.
- **Scope**: the workspaces a statement may read and change, with the
  login it acts for (`mantle_scope_login_id()`). Set per transaction.
- **Workspace**: users, at most one assistant, connectors; items are
  granted to it. **Admin workspace**: the one with rules of its own, whose
  users (**Admin users**) manage the brain.
- **Area**: a part of managing the brain: settings, users, assistants,
  connectors, keys. An Admin user holds each area unless its row in
  Admin switches it off (`workspace_users.limits`).
- **Moderator**: a tick on a user of a workspace.
- **Item**: a node of a workspace kind (`ITEM_KINDS`), or a row an item
  owns. **Home**: the one workspace an item belongs to. **Grant**: an
  item shared to a workspace, with a Write switch.
- **Link**: a public link to one item. **Contact**: a contact share of
  one item. **Key**: an API key (`mtlk_`). **Peer**: a linked brain.

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
pending call, a Telegram turn) runs as that login as it is now:
`loginActorNow` reads the login again when the work runs.

Binding, from `@mantle/db` only (the lint `actor-setters-in-db-only`):

- `runAsSystem(reason, fn)`: a process's own work.
- `runAsActor(loginActor(id, mode), fn)`: work for a login.
- `registerActorWorkflow(name, actorOf, impl)`: the one way a DBOS
  workflow registers; each run binds `actorOf(...args)`.
- `runInActorSlot(initial, fn)`: an entry whose caller is known later.
  The gate opens each request as `system(http:no-login)` and the guard
  names the caller.
- A workspace scope (`withViewer`, a turn scope) runs as its login.

An inner binding replaces an outer one. `systemUnder` keeps system work
read only under a read-only caller (`login(ro)`, `link`, a contact
without Can write). Every binder call is pinned per file
(`eslint-rules/actor-binders.mjs`).

### The process inventory

Every file that starts work on its own, kind by kind, with the actor it
binds, is listed in [process-inventory.md](./process-inventory.md).
`eslint-rules/process-entries.test.ts` fails when a file starts work and
is not listed there, or is listed and no longer does.

## 5. The three routes to Postgres

| Route          | Role                                                  | Who may use it                                                    |
| -------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| system pool    | `mantle_runtime` (or the superuser, runtime role off) | system actors; a named exit (section 8)                           |
| workspace role | `mantle_view_user`                                    | a scope's reads: a login's, an assistant's, a link's served items |
| write role     | `mantle_write_user`                                   | a scope's writes to `WRITE_ROLE_TABLES`                           |

- `db` reads on the workspace role inside a scope and on the system pool
  outside one. `systemDb` is the system pool always; only
  `SYSTEM_DB_MODULES` may import it (`eslint-rules/system-db-allowlist.mjs`).
- The login write gateway (`loginWriteRoute`, `packages/db/src/client.ts`)
  sends a write to the write role when the actor is a login, an
  assistant, a link or a contact and the write carries a scope. One
  `SET LOCAL` with the transaction's first statement carries the scope,
  the actor and the create home. Never a session SET.
- A write to a table the write role holds no right on goes to the system
  pool up front. Two tables still take a checked rerun
  (`WRITE_ROLE_GAP_TABLES`: `profiles`, `app_table_exports`).
- The scoped pools never run the setter functions. Only `packages/db`
  sets `mantle.*` settings.

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
| close any link                        | an Admin user with the users area               |
| share it with a contact               | an Admin user (its home is not checked)         |
| an Admin area                         | an Admin user holding that area                 |

The database's needs (`mantle_check_row`, `mantle_check_item`): `read`,
`edit`, `manage`, `admin`, `appdata`, `link`, `link_close`
([edit-check.md](./edit-check.md)). An item the caller does not read
answers the 404 of none, the same as a random id. One it reads but may
not change answers 403.

Admin users and areas. Being an Admin user is management, not reading:
an Admin user reads what is granted to the workspaces it is in. In a
scope the area is asked through `mantle_scope_has_area(area)`, for the
scope's own login. About another login, `loginHasArea` asks it (the
brain's live Admin workspace, an enabled login with a user row there,
the area not switched off) and `loginHoldsAdmin` the same without an area.

Owner rules (each holds today unless "Known limits" says otherwise):

- Admin users are always Moderators of Admin. The tick is never cleared
  (409 `admin_workspace`); removing the user from Admin is the only way.
- Adding a user to Admin, or removing one, needs the users area.
- App code (build, edit, publish, history) needs manage of the app (D4).
  Its data needs edit, and while Informational is on an Admin user.
- A new folder's indexing follows the create rule: whoever may make the
  folder there sets it.
- The brain's profile row: the approval and egress gates go with the
  assistants area, `teamPrivateReads` with the users area, every other
  brain-row write needs the settings area (owner decision 2026-10-17).
  Every login changes its own row. The house style, purpose and
  archetype are the owner's alone.
- Keys, links, contacts and peers are never widened. A key or a peer acts
  as its login as it is now and only narrows it (read only, areas, risky
  tools); neither changes the content of a page or note others read. A
  link and a `peer(share)` write nothing. A contact writes its app's
  data only, with Can write on.
- Nothing grants by itself, but an item placed in a folder takes the
  folder's grants, and the dialog says so first.

## 7. Checks and modes

- **The actor check** (`mantle.actor_check`): a statement with no actor is
  a miss. The TypeScript side checks every statement through `db`,
  `systemDb` and `withSystemTx`; the SQL side is a statement trigger on
  every item table (`mantle_actor_check_tables()`).
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
  with no record; every process logs `[db] SECURITY:` while one is below.
- Change a mode only with `mantle_set_actor_check` or
  `mantle_set_edit_check`: they switch the triggers with the setting.

## 8. Exits

An exit leaves the caller's scope for the system pool. Each is named.

- `asSystem(fn, reason)`: inside a turn or request scope only a reason of
  `AS_SYSTEM_TURN_REASONS` (`packages/db/src/viewer.ts`, each with why).
  Each calling file is pinned (`eslint-rules/as-system-allowlist.mjs`).

| Reason             | Why the scope cannot do it                                  |
| ------------------ | ----------------------------------------------------------- |
| agent-workspace    | the workspace an assistant runs in, read before its scope   |
| connector-binding  | a connector's binding and OAuth config                      |
| connector-call     | the remote call reads and refreshes its own credentials     |
| heartbeat-own-row  | the firing heartbeat changes its own row                    |
| app-data           | an app's SQLite work after the scope found the app          |
| rule-in-query      | any-login routes holding the rule in their own SQL          |
| admin-area         | an Admin area tool's system tables, after the area check    |
| keyword-candidates | ranked ids of a text match, re-read in the scope by id      |
| app-trash          | a deleted app's snapshots, after the manage check           |
| login-telegram     | a login's own Telegram chats (no role holds those tables)   |
| audit-log          | a connector call's audit row                                |
| pending-approval   | an approved call re-enters the scope it was asked in        |
| workspace-write    | a login's change of a workspace (the four workspace tables) |
| page-refold        | the pages a grant change reaches                            |
| brain-bookkeeping  | `systemStep`'s brain-wide counts and reaps                  |

- **Request exits** (`noteRequestSystem`, `server/web/lib/auth/session.ts`):
  `area` (an Admin area route, after the area check), `login-self` (a
  login's own things), `admin-write` (the Admin acts of `ADMIN_ACT_WRITES`
  and an Admin user's any-login write but the grants panel).
- **`systemStep(step, { items, need }, fn)`**
  (`packages/db/src/system-step.ts`): bookkeeping after the write's item
  check; it answers the caller numbers, yes or no, or rows its scope reads.
- **`systemWork(fn, reason)`**: system work that never runs in a scope;
  it refuses inside one. Files pinned in
  `eslint-rules/system-work-allowlist.mjs`.
- **How to add one**: name the reason with why, pin the file, raise
  `asSystemExits` with a reason in review. Prefer a definer.

## 9. Definers

A definer answers in the scope what the scope cannot read itself, and
nothing more (0291, 0293). Shape: `SECURITY DEFINER`, a fixed
`search_path` with `pg_temp` last, `PUBLIC` revoked, `EXECUTE` for the
workspace role (the write role mirrors it). The caller comes from the
scope's settings (`mantle_scope_login_id()`), never from an argument.
Inside a scope it checks the scope and returns NULL or nothing for what
the scope does not read. Families: grants and workspace screens (0291),
the scope exits of 0293 (kind roots, read cursors, access keys, pending
counts, connectors, contact sharing, name checks, `mantle_ws_create`),
the edit check's writes (`mantle_secret_put`, `mantle_recall_retarget`).

## 10. HTTP

- Every route of the manifest and method has one `ROUTE_POLICY` row
  (`server/web/lib/auth/route-policy.ts`, built by `buildRouteRow`):
  class, scope, area, effect, open, logins, creates, item, key area,
  limits. A route with no row is refused.
- The gate (`packages/db/src/gate.ts`, `enterCall`) runs the same eight
  steps for every way in: resolve, bind the caller, look up the policy
  and bind the actor and scope, narrow by surface, the Admin step, the
  create home, run, map a refusal. Listing equals calling.
- A write handler reads its item in the caller's scope first, or asks
  `assertItemRight` (`packages/db/src/item-rights.ts`) before any side
  effect. A hidden item is the 404 of none.

## 11. Tools

- Every builtin declares a `ToolPolicy` (`packages/tools/src/tool-policy.ts`),
  among its fields `effect`, `spends`, `scope` (`any`, `admin`,
  `admin-kind`, or an area), `creates`, `itemArgs`, `peerRisky`,
  `keyArea`, `keySharedContent`, `clientSourced`. The gate reads it; no
  list is keyed by tool name.
- `itemArgs` names the items a write touches: the audit row's targets and
  the queue-time check of a call that waits for approval. It decides
  nothing at run time: the database and `assertItemRight` do.
- Tool item pre-checks: none. A tool's write is checked by the database
  only, so both checks run on (section 7).
- An approved pending call runs in the scope it was asked in, judged
  again with its asker's rights now (`pending-approval.ts`).

## 12. Adding a kind, route, tool, table, exit or definer

- **A kind**: add it to `ITEM_KINDS`; the route lists, the access matrix
  and the A8 grid read the registry. `handKindLists` fails a hand list.
- **A route**: it needs a policy row; `route-scope.test.ts` fails an
  unclassified route, the gate refuses one with no row.
- **A tool**: a `ToolPolicy` (typecheck fails without one); a write
  declares its `clientSourced` rule (unset, a client-sourced call waits)
  and the `itemArgs` it touches.
- **A table**: a row in the access matrix
  (`packages/db/src/access-matrix.ts`); with none no scoped role may touch
  it. An item table gets the actor trigger
  (`actor-trigger-coverage.db.test.ts`).
- **An exit**: section 8; `asSystemExits` and the allowlists fail first.
- **A definer**: the shape of section 9, a DB test of its scope answer,
  and the runtime role's allowlist when the system pool calls it.
- **A process entry**: [process-inventory.md](./process-inventory.md).

## 13. Proof

- Suites: `pnpm test` (unit and DB), `test:actor-off`, `test:actor-on`,
  `test:edit-on`, `test:runtime-role`, `test:matrix` (the A8 grid,
  `packages/db/src/matrix/`, against the guide's oracle). `vitest.setup.ts`
  fails a test on any actor miss.
- The scoreboard (`pnpm arch:check`, `scripts/arch-scoreboard.pins.json`):
  each count only goes down; a raise needs a reason in review.
- `pnpm docs:check`: every path a doc names exists, and every
  `docs/<file>.md, "Heading"` quote names a heading.

## 14. Operating a box

- **Modes**: both checks on (the floor). Set them only with the setters,
  as the superuser that runs migrations ([update-prod.md](./update-prod.md),
  "The checks' floor").
- **The runtime role**: `MANTLE_DB_RUNTIME_ROLE=1` in `.env` makes the
  system pool log in as `mantle_runtime`, which cannot disable a trigger,
  alter a table or change a mode. Off means the system pool runs as the
  superuser, so nothing in Postgres stops a bug there from doing either
  ([runtime-role.md](./runtime-role.md)). Every app process says which at
  start; `/api/health` shows `postgres.role`.
- **Emergency switches**: lowering a check (with a reason, recorded and
  logged); the runtime role switch.
- **Box counts**: `scripts/arch-scoreboard-box.sh <ssh-alias>`, numbers
  only. `/debug/integrity` shows `check_floor`, `actor_check_drift`,
  `edit_check_drift`, `runtime_role_lock`.
- **Repair**: a named command, or hand psql as the superuser after
  `mantle_operator_actor('reason')`.

## 15. Known limits

Each ends in the step of plan v3.2 (2026-10-17) named.

- Off still decides the pool: with the actor check off a login's write
  runs on the system pool (`loginWritesMayRoute`). S3.
- Two gap tables take a checked rerun on the system pool (`profiles`,
  `app_table_exports`). S3.
- The brain's profile row: today the profile route asks the settings
  area for the brand keys only; the per-area split of section 6 is built
  with S3.
- The four workspace tables are written on the system pool
  (`workspace-write` exits, raw writes in `workspaces.ts` and
  `workspace-ticks.ts`), and `mantle_ws_create` skips its check with no
  scope. S2.
- The area rule is written in four SQL places and in TypeScript, and
  `mantle_login_area` says yes on a brain with no Admin workspace. S2a,
  S4.
- A definer asked with no scope answers as the system pool would. S2, S7.
- Seven Admin acts run on the system pool with no scope
  (`ADMIN_ACT_WRITES`, the link close, the deleted-app trash, the contact
  share's Can write), and two HTTP item checks remain (`ITEM_REF_PREFIXES`:
  share, deleted-app). S6.
- The system pool is the whole runtime role, not a narrow one. S7.
- A login carries a kind and a role, and code branches on them. S8.
- Route policy is spread over lists, not declared per route. S9.
- Scoped code still holds raw write SQL. S10.
- The A8 matrix does not yet cover every kind, route and tool. S11.
- The runtime role is off by default for a new install, and a few
  defaults fail open in production (an unlisted exit is logged, not
  refused). S4.
- Accepted, no step: any role can `set_config('mantle.actor', …)`, so
  the settings are not a credential. Access is never decided from them on
  a role that runs caller-shaped SQL.
- Code comments still carry history and quote headings of the history
  file (`actorsHistoryRefs`). D2.
