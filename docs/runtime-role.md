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

| Role                                                         | Logs in                              | What it is                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` (the compose superuser)                           | yes                                  | the migrator: `DATABASE_URL`. migrate, pg_dump backups, pg-boss, the DBOS runner database, the workspaces switch, hand psql                           |
| `mantle_owner`                                               | no                                   | owns every table and sequence of `public` and `auth`. migrate hands them over after the migrations                                                    |
| `mantle_runtime`                                             | yes, when `MANTLE_DB_RUNTIME_ROLE=1` | the app's system pool and its LISTEN connections. Not a superuser, owns nothing, `BYPASSRLS`, data rights only                                        |
| `mantle_system`                                              | no                                   | holds no right. Owns `mantle_acl_internal()` and may `SET ROLE` to the write role and the gap writer: what the system pool had by being the superuser |
| `mantle_view_user`, `mantle_write_user`, `mantle_gap_writer` | as before                            | the scoped pools, unchanged. They lose `EXECUTE` on the setter functions (below)                                                                      |

`mantle_runtime` holds:

- `SELECT, INSERT, UPDATE, DELETE` on every table of `public` and `auth`, but
  the tables the access matrix marks `runtime: 'none'` (`mantle_heads_key`,
  `mantle_moved_nodes`, `mantle_bridge_pending`: only definer functions touch
  them);
- `USAGE, SELECT, UPDATE` on every sequence there;
- `EXECUTE` on every function there but `RUNTIME_DENIED_FUNCTIONS`: the check
  switches (`mantle_set_actor_check`, `mantle_set_edit_check`,
  `mantle_set_check`, the trigger switches), the heads key's primitives
  (`mantle_heads_mac`, `mantle_heads_sig`, `mantle_heads_set` and the
  named heads-check bypass), the actor setters (`mantle_set_actor`,
  `mantle_operator_actor`: packages/db sets the actor with `set_config`, the
  `actor-setters-in-db-only` lint) and the schema-changing steps
  (`mantle_write_role_sync_table`, `mantle_ws_ddl_retry`,
  `mantle_ws_switch_off`, `mantle_ws_migrate_locked`). The same list is
  taken from `PUBLIC` and from every viewer role. `mantle_ws_migrate()`
  stays open: on a brain already on workspaces it does nothing, and before
  that it is the switch the app runs at boot anyway, with no statement of the
  caller's in it;
- `USAGE` on schema `pgboss` and `SELECT` on its tables, read only: the
  extract backlog, the OCR rescan and the integrity page count its jobs.
  migrate makes the schema when it is missing (pg-boss installs into it), so
  the default privileges cover the tables pgboss:init makes right after;
- membership in `mantle_system` (inherit and set), and nothing else: a hand
  grant is taken back at the next migrate.

`CREATE` on schema `public` is taken from `PUBLIC`, so the runtime role makes
nothing there (it cannot replace a function it could otherwise shadow).

Why `mantle_system`: two tests in SQL were written against a superuser system
pool. `mantle_owner_role()` (0241, the derivation's guards) asks whether
`current_user` has the rights of the owner of `mantle_acl_internal()`: that
function is now `mantle_system`'s, so the runtime role passes as the superuser
did, and the write role does not. And the checked rerun (client.ts) does `SET
LOCAL ROLE` to the write role and the gap writer, which needs a membership.
The membership goes through `mantle_system`, never directly: 0277 and 0278
count only a direct membership as "the write role's login", so the system pool
is still not one, as it was not as the superuser.

Why `mantle_owner` reaches more than its tables: Postgres runs a foreign key's
check and its cascade (and the triggers a cascade fires) as the owner of the
table queried. As the superuser's tables these ran as the superuser, so
`mantle_owner` gets `USAGE` on both schemas, every right on their tables and
`EXECUTE` on every function, and is a member of `mantle_system` (inherit, no
set). Nobody logs in as it.

The password of `mantle_runtime` is derived from `MANTLE_MASTER_KEY`
(HKDF, its own label), as the viewer roles' are. There is no secret to create
or store, and migrate sets it again on every run, after a restore and after a
master-key change. One brain per Postgres cluster: with
`MANTLE_VIEWER_ROLES_PER_DATABASE` the role gets no login and the app refuses
the switch.

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
- `/debug/integrity`, the row `runtime_role_lock`: a row when
  `mantle_runtime` is no longer the lock it was made as (a superuser, a
  CREATEROLE or CREATEDB, owning a table, CREATE on public, able to act as
  `mantle_owner`). migrate puts it back on its next run.

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
   # mantle_owner|f|f|f    mantle_runtime|t|f|t    mantle_system|f|f|f
   docker exec mantle_pg psql -U postgres -d postgres -Atc \
     "select pg_get_userbyid(c.relowner), count(*) from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'auth') and c.relkind in ('r', 'p') group by 1"
   # mantle_owner|<every table>
   ```

   A table still owned by `postgres` was busy when migrate ran (its log says
   which): the next migrate retries. It is untidy, not a hole.

2. **The compose change.** In the box `.env`: `MANTLE_DB_RUNTIME_ROLE=1`.
   There is no secret to create (the password is derived from
   `MANTLE_MASTER_KEY`, which the box already has). Then recreate the stack:
   `docker compose up -d --wait`. migrate runs first and sets the role's
   login and rights again; the app containers start with the switch on.
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
   ```

   Then the app's paths: sign in, a chat turn, a note edit, a file upload, a
   page share. /debug/integrity shows no `runtime_role_lock` row.

4. **Rollback.** Take the line out of `.env` (or set it to `0`) and
   `docker compose up -d --wait`: the app logs in as `DATABASE_URL` again. No
   data changed, so there is nothing to undo. The roles, the ownership and the
   grants stay; the superuser ignores them. To take the ownership back as
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
whole after it.

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
  change), the heads key, the viewer roles and the setters, no definer
  function the runtime role may run with DDL in its body, the ownership, and
  idempotence.
- `pnpm test:runtime-role`: the database suites with the app's pools on the
  runtime role (`vitest.runtime-role.config.ts`).
