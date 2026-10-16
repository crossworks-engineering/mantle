# The runtime role (arch A9)

The app's own database connections stop logging in as the superuser that runs
the migrations. Plan v2 (workspaces arch, phase A9, section 4.2): a role that
is not a superuser and not a table owner cannot disable a trigger, alter a
table, set `session_replication_role` or change `mantle.actor_check`, so the
actor check, the edit check and the row rules hold even against a bug or an
injected statement in the app.

Code: `packages/db/src/runtime-role.ts` (the roles, the rights, the URL),
`packages/db/src/migrator-steps.ts` (what migrate runs around the migrations),
`packages/db/src/runtime-role.db.test.ts` (the proof).

## The roles

| Role                                                         | Logs in                              | What it is                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` (the compose superuser)                           | yes                                  | the migrator: `DATABASE_URL`. migrate, pg_dump backups, pg-boss, the DBOS runner database, the workspaces switch, hand psql                          |
| `mantle_owner`                                               | no                                   | owns every table and sequence of `public` and `auth`, and `mantle_acl_internal()`. migrate hands them over after the migrations. `BYPASSRLS` (below) |
| `mantle_runtime`                                             | yes, when `MANTLE_DB_RUNTIME_ROLE=1` | the app's system pool and its LISTEN connections. Not a superuser, owns nothing, `BYPASSRLS`, `NOINHERIT`, data rights only                          |
| `mantle_system`                                              | no                                   | holds no right and owns nothing. May `SET ROLE` to the write role and the gap writer: what the system pool had by being the superuser                |
| `mantle_view_user`, `mantle_write_user`, `mantle_gap_writer` | as before                            | the scoped pools, unchanged. They lose `EXECUTE` on the setter functions (below)                                                                     |

`mantle_runtime` holds:

- `SELECT, INSERT, UPDATE, DELETE` on every table of `public` and `auth`, but
  the tables the access matrix marks `runtime: 'none'` (`mantle_heads_key`,
  `mantle_moved_nodes`, `mantle_bridge_pending`: only definer functions touch
  them);
- `USAGE, SELECT, UPDATE` on every sequence there;
- `EXECUTE` on an allowlist, not on every function less a denylist
  (`runtimeFunctionAllowlist`): what `PUBLIC` or a viewer role may run, plus
  `RUNTIME_SYSTEM_FUNCTIONS`, the few functions taken from `PUBLIC` that the
  system pool calls itself, each listed with where it is called
  (`mantle_actor_miss_log`, `mantle_bridge_login`, `mantle_check_box_mode`,
  `mantle_embed_host`, `mantle_ws_attach_assistants`,
  `mantle_ws_private_workspace`, `mantle_ws_skip_reason`). Everything else
  taken from `PUBLIC` is out of its reach: the workspaces switch and its steps
  (`mantle_ws_migrate`, `mantle_ws_migrate_bridged`, `mantle_ws_bridge_off`,
  `mantle_ws_spaces_fold`, `mantle_ws_review_off`, `mantle_ws_team_normal`;
  the app runs the switch as the migrator, `mantle_ws_migrate_locked` through
  `executeAsMigrator`), the trigger bodies (a trigger needs no `EXECUTE` to
  fire) and the derivation's internals. A function a new migration takes from
  `PUBLIC` is not the runtime role's until a line in that list says why;
  the test pins the list. Never on the list, and also taken from `PUBLIC`
  and from every viewer role (`RUNTIME_DENIED_FUNCTIONS`): the check switches
  (`mantle_set_actor_check`, `mantle_set_edit_check`, `mantle_set_check`, the
  trigger switches), the heads key's primitives (`mantle_heads_mac`,
  `mantle_heads_sig`, `mantle_heads_set` and the named heads-check bypass),
  the actor setters (`mantle_set_actor`, `mantle_operator_actor`:
  packages/db sets the actor with `set_config`, the
  `actor-setters-in-db-only` lint) and the schema-changing steps
  (`mantle_write_role_sync_table`, `mantle_ws_ddl_retry`,
  `mantle_ws_switch_off`, `mantle_ws_migrate_locked`);
- `USAGE` on schema `pgboss` and `SELECT` on its tables, read only: the
  extract backlog, the OCR rescan and the integrity page count its jobs.
  migrate makes the schema when it is missing (pg-boss installs into it), so
  the default privileges cover the tables pgboss:init makes right after;
- membership in `mantle_owner` without `INHERIT` and without `SET` (a
  member that holds none of its rights and cannot become it), membership in
  `mantle_system` with `SET` only, and nothing else: a hand grant, or one of
  these with other options, is taken back at the next migrate. The role is
  `NOINHERIT`, so a hand `GRANT` without options gives it no rights even
  before that migrate.

No other role is a member of `mantle_owner`, `mantle_system` or
`mantle_runtime`: migrate takes back every membership held in the three but
the two above. A member of `mantle_runtime` is a member of `mantle_owner`
through it, whatever the options (`GRANT mantle_runtime TO mantle_view_user
WITH INHERIT FALSE, SET FALSE` was enough), and `mantle_owner_role()` says
yes to every member.

Each of those revokes names its grantor and cascades. An operator's `GRANT
mantle_system TO ops_a WITH ADMIN OPTION`, passed on by `ops_a` to `ops_b`,
leaves a membership that rests on the first, and a plain `REVOKE` is refused
(`2BP01`, dependent privileges exist): migrate would exit 1, and web and the
workers, which wait on it, would not start. So migrate takes the far end of
a chain first, and the dependents, memberships in the same role, go with
the one they rest on. Every membership taken back is one line in the
migrate log (`WARNING membership taken back: <role> from <member> (granted
by <grantor>)`). A revoke that fails for any other reason is a warning too,
never a failed migrate: the integrity row `runtime_role_lock` shows what is
left.

`CREATE` on schema `public` is taken from `PUBLIC`, so the runtime role makes
nothing there (it cannot replace a function it could otherwise shadow).

Two tests in SQL were written against a superuser system pool.

- `mantle_owner_role()` (0241, the derivation's guards) asks about the owner
  of `mantle_acl_internal()`. Since 0290 it asks for membership (`MEMBER`),
  not for that owner's rights (`USAGE`). The marker is `mantle_owner`'s, and
  the runtime role is its member without `INHERIT` and without `SET`, so the
  guard says yes to the runtime role as it did to the superuser, and no to
  the write role. The runtime role cannot drop or alter the marker, nor
  `DROP OWNED` or `REASSIGN OWNED` for its owner: before 0290 it had to
  inherit the owner to pass, and so could (audit M1). A marker dropped or
  changed anyway (by hand, as the superuser) is made again by the next
  migrate (`ensureAclMarker`), and until then the integrity row
  `runtime_role_lock` names it. A `mantle_owner_role()` that is not the
  `MEMBER` version (0290 skipped) refuses the runtime role at every write
  guard: the integrity row names that too, and migrate warns about it on
  every run until 0290 is in.
- The checked rerun (client.ts) does `SET LOCAL ROLE` to the write role and
  the gap writer, which needs a membership with `SET`. It goes through
  `mantle_system`, never directly: 0277 and 0278 count only a direct
  membership as "the write role's login", so the system pool is still not
  one, as it was not as the superuser. `mantle_system` owns nothing and holds
  no right, so the runtime role gains nothing by `SET ROLE` to it.

Why `mantle_owner` reaches more than its tables: Postgres runs a foreign key's
check and its cascade (and the triggers a cascade fires) as the owner of the
table queried. As the superuser's tables these ran as the superuser, so
`mantle_owner` gets `USAGE` on both schemas, every right on their tables and
`EXECUTE` on every function, and `BYPASSRLS`: a trigger a cascade fires
(`notify_runs_changed`, `notify_conversation_changed`) reads past the row
rules, as the superuser did, also on a table migrate left with its old owner
(a busy one, below), where the owner of the tables is not the table's owner.
As the marker's owner it passes `mantle_owner_role()` there too. Nobody logs
in as it, and nobody holds its rights: the runtime role is its member without
`INHERIT` and without `SET`, and `BYPASSRLS` is never inherited.
So `FORCE ROW LEVEL SECURITY` on a table would not bind a cascade either:
`BYPASSRLS` passes a forced row rule too, so a rule meant to hold a cascade
back needs another way (a trigger, or a check in the definer function).

The password of `mantle_runtime` is derived from `MANTLE_MASTER_KEY`
(HKDF, its own label), as the viewer roles' are. There is no secret to create
or store, and migrate sets it again on every run, after a restore and after a
master-key change. One brain per Postgres cluster: with
`MANTLE_VIEWER_ROLES_PER_DATABASE` the role gets no login and the app refuses
the switch.

`mantle_runtime` logs in only on a box that has switched: migrate gives it
`LOGIN` and its password when it sees `MANTLE_DB_RUNTIME_ROLE=1` (the compose
`migrate` service gets the variable through the `x-app-env` anchor, as every
app service does), and `NOLOGIN` with no password when it does not. So a box
that never switches has no login it does not use, and taking the switch out
again closes the login at the next migrate. Its log says which:
`runtime role mantle_runtime: LOGIN (MANTLE_DB_RUNTIME_ROLE is on)` or
`NOLOGIN (... is off)`.

A statement that sets a password (the runtime role's, the viewer roles')
runs in a transaction of its own that first sets, for that transaction only,
`log_statement = 'none'`, `log_min_duration_statement = -1` and
`log_min_error_statement = 'panic'`: no server log line prints its text, not
even when it fails (a "tuple concurrently updated" retried, say). What
remains: while it runs, `pg_stat_activity` shows the text to a superuser or a
member of `pg_read_all_stats`, and an extension that records statements
(`pg_stat_statements`, `pgaudit`; the compose Postgres loads none) would
see it.

## What runs as what

| Connection                                                                                                         | Role                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| migrate (`pnpm -C packages/db migrate`, the compose `migrate` service)                                             | `DATABASE_URL`                                                                                                                  |
| the system pool (`db`, `systemDb`), the LISTEN connections (realtime, push-notify, turn-cancel, the agent runtime) | `mantle_runtime` with the switch on, `DATABASE_URL` without                                                                     |
| the scoped pools (`mantle_view_user`, `mantle_write_user`)                                                         | unchanged                                                                                                                       |
| the workspaces switch (`mantle_ws_migrate_locked`, at the first owner and at boot)                                 | `DATABASE_URL`, through `executeAsMigrator`: it runs DDL                                                                        |
| pg-boss                                                                                                            | `DATABASE_URL`: its maintenance makes and drops partitions of `pgboss.queue_stats`                                              |
| the DBOS runner database (`mantle_dbos_sys`)                                                                       | `DATABASE_URL`: DBOS makes its own schema                                                                                       |
| the scheduled backup (`packages/content/src/backup.ts`, pg_dump)                                                   | `DATABASE_URL`: the runtime role cannot read `mantle_heads_key`, and a dump without it restores a brain whose heads checks fail |
| one-shot maintenance scripts that open `postgres(DATABASE_URL)` themselves                                         | `DATABASE_URL`                                                                                                                  |

## The switch and the mode report

`MANTLE_DB_RUNTIME_ROLE` (feature `dbRuntimeRole`, off by default; the compose
`x-app-env` anchor passes it to every app service). Off, the app runs as
`DATABASE_URL`'s role, exactly as before.

Which mode a box runs in shows in three places:

- the log of every app process at its start (production): `[db] the system
pool logs in as mantle_runtime (arch A9 runtime role)`, or a warning that it
  logs in as the superuser and how to change that;
- `/api/health`: `postgres.role` is `{ mode, user }`, `mode` one of `runtime`,
  `superuser`, `other`;
- `/debug/integrity`, the row `runtime_role_lock` (`RUNTIME_LOCK_SQL` in
  runtime-role.ts): a row when `mantle_runtime` is no longer the lock it was
  made as (a superuser, a CREATEROLE or CREATEDB, owning a table or a
  function, CREATE on public, holding the rights of `mantle_owner` or
  `mantle_system`, able to become `mantle_owner`), when
  `mantle_acl_internal()` is missing or not `mantle_owner`'s, when
  `mantle_owner_role()` is not the `MEMBER` version of 0290, or when a role
  other than `mantle_runtime` (and a superuser) is a member of
  `mantle_owner`, directly or through another role. migrate puts it back on
  its next run, and logs what it could not put back
  (`WARNING the runtime role lock is not whole`).

## Rolling a box (W9)

This rolls with W9, one box at a time, each with the owner's go. Nothing here
runs on any box before that.

The release that carries A9 is safe on a box that has not switched: its
migrate makes the three roles, hands the tables to `mantle_owner` and grants
the runtime role its rights on every run, and with the switch off the app
logs in as before (with the warning). A box switches by setting one line in
its `.env`, and switches back by taking it out.

0. **Before anything: a backup.** `scripts/db-dump.sh` with
   `MANTLE_DUMP_STRICT=1`, its own exit status checked (never piped), four
   files with one timestamp (docs/update-prod.md, step 1). Where a box has its
   own backup rule (a verified backup, copied off the box, before any roll),
   that rule comes first. Then the owner's go for this box.
1. **The release.** The box runs a release with A9 (rolled the standard way,
   `scripts/roll.sh`). Check that migrate made the roles, as the superuser:

   ```sh
   docker exec mantle_pg psql -U postgres -d postgres -Atc \
     "select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles
       where rolname in ('mantle_owner', 'mantle_runtime', 'mantle_system') order by 1"
   # mantle_owner|f|f|t    mantle_runtime|f|f|t    mantle_system|f|f|f
   # (mantle_runtime has no login until the box switches, step 2)
   docker exec mantle_pg psql -U postgres -d postgres -Atc \
     "select pg_get_userbyid(c.relowner), count(*) from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'auth') and c.relkind in ('r', 'p') group by 1"
   # mantle_owner|<every table>
   ```

   migrate hands the tables over while the old app may still serve, so it
   never waits long for a lock: all in one transaction first, each lock
   waited for at most 200 ms and the whole batch at most a second; past that
   it lets every lock go and takes each table on its own (200 ms, three
   tries). A table still busy then keeps its old owner and migrate goes on:
   its log names it (`WARNING n table(s) busy`), and the next migrate tries
   again. It is untidy, not a hole: the runtime role owns nothing either way,
   and `mantle_owner`, which runs the cascades and the triggers they fire,
   holds every right on that table and `BYPASSRLS`, so it reads there what it
   reads on its own tables.

2. **The compose change.** In the box `.env`: `MANTLE_DB_RUNTIME_ROLE=1`.
   There is no secret to create (the password is derived from
   `MANTLE_MASTER_KEY`, which the box already has). Then recreate the stack:
   `docker compose up -d --wait`. migrate runs first, sees the switch and
   gives the role its login (`runtime role mantle_runtime: LOGIN` in
   `docker logs mantle_migrate`) and its rights; the app containers start
   with the switch on.
3. **Verify.**

   ```sh
   docker logs mantle_web 2>&1 | grep '\[db\]' | tail -3
   # [db] the system pool logs in as mantle_runtime (arch A9 runtime role)
   curl -s -H "Authorization: Bearer $TOKEN" https://<box>/api/health | jq .postgres.role
   # { "mode": "runtime", "user": "mantle_runtime" }
   docker exec mantle_pg psql -U postgres -d postgres -Atc \
     "select usename, count(*) from pg_stat_activity where datname = 'postgres' group by 1 order by 1"
   # mantle_runtime and the viewer roles carry the app; postgres only pg-boss and psql
   ```

   The exit, on the box itself, as the superuser in a transaction rolled
   back:

   ```sql
   BEGIN;
   SET LOCAL ROLE mantle_runtime;
   ALTER TABLE public.nodes DISABLE TRIGGER mantle_actor_check;  -- ERROR: must be owner
   ROLLBACK;
   BEGIN;
   SET LOCAL ROLE mantle_runtime;
   SELECT mantle_set_actor_check('off');  -- ERROR: permission denied for function
   ROLLBACK;
   BEGIN;
   SET LOCAL ROLE mantle_runtime;
   DROP FUNCTION mantle_acl_internal();  -- ERROR: must be owner of function
   ROLLBACK;
   ```

   (`SET ROLE` from there to another role proves nothing in this session:
   Postgres checks it against the session's login, the superuser.
   `runtime-role.db.test.ts` logs in as `mantle_runtime` for that.)

   Then the app's paths: sign in, a chat turn, a note edit, a file upload, a
   page share. /debug/integrity shows no `runtime_role_lock` row.

4. **Rollback.** Take the line out of `.env` (or set it to `0`) and
   `docker compose up -d --wait`: migrate sets `mantle_runtime` to `NOLOGIN`
   again and the app logs in as `DATABASE_URL`. No data changed, so there is
   nothing to undo. The roles, the ownership and the grants stay; the
   superuser ignores them. To take the ownership back as
   well (never needed for the app to run):

   ```sql
   -- as the superuser, connected to the brain's database
   REASSIGN OWNED BY mantle_owner TO postgres;
   ```

   (migrate hands the tables over again on its next run while the release
   carries A9.)

### After a restore

`scripts/db-restore.sh` makes the three roles (no login) before pg_restore,
whose grants and default privileges name them, and marks `ts_match_vq`
LEAKPROOF again. The tables come back owned by the restoring superuser
(`--no-owner`) and the runtime role has no password yet: the migrate of the
next `docker compose up -d --wait` hands the tables to `mantle_owner`, gives
the runtime role its login and rights, and marks the function again
(`afterMigrations`). Start the stack through compose, never one app service on
its own: with the switch on, the app cannot log in before that migrate has
run. `packages/db/src/dump-restore.db.test.ts` proves a restored brain is
whole after it. A backup from before the brain's workspaces switch, with
clients present, needs the manual switch ([workspaces.md](./workspaces.md),
"Operator notes") after the restore and before boot: since A7 the web boot
refuses a brain not on workspaces.

### Operator notes

- Hand psql stays the superuser (`docker exec mantle_pg psql -U postgres`):
  the check switches (`mantle_set_actor_check`, `mantle_set_edit_check`) and a
  manual workspaces switch are run there, as before.
- A maintenance task that needs DDL, run inside `mantle_web` on a switched
  box: `docker exec -e MANTLE_DB_RUNTIME_ROLE=0 mantle_web ...` runs that one
  process as `DATABASE_URL`.
- A box on Postgres before 16 gets no runtime role (migrate warns): the
  memberships need 16. Every box runs 17 or 18.

## Left for later

- The superuser's password is still in every app container's environment
  (`DATABASE_URL`): pg-boss, the DBOS database, the scheduled backup and the
  workspaces switch use it. Taking it out means a pg-boss role that owns the
  `pgboss` schema, a backup role (the owner, or the superuser in the backup
  sidecar), and the switch moved into the migrate service.
- The migrator itself could log in as `mantle_owner` instead of the
  superuser, except for the steps that need one (making roles, `BYPASSRLS`,
  `LEAKPROOF`, `ALTER DATABASE SET` of a check mode).

## Tests

- `packages/db/src/runtime-role.db.test.ts`: the exit (no trigger disabled,
  no table altered, no `session_replication_role`, no `mantle.actor_check`
  change), the marker (no `DROP`, `ALTER` or `DROP OWNED`, also after `SET
ROLE mantle_system`), the workspaces switch denied, the allowlist pinned
  (the functions taken from `PUBLIC` it may run are exactly
  `RUNTIME_SYSTEM_FUNCTIONS`), no definer function it may run reaching DDL
  through any call its body names, the heads key, the viewer roles and the
  setters, the ownership, a broken marker made again, the integrity row,
  idempotence, every membership held in the three roles taken back, a
  `mantle_owner_role()` from before 0290 named, and a table left with its
  old owner still read past the row rules as `mantle_owner`.
- `pnpm test:runtime-role`: the database suites with the app's pools on the
  runtime role (`vitest.runtime-role.config.ts`).
