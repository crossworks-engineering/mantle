/**
 * Shared helpers for the DB tests (`*.db.test.ts`). NOT a test file (no
 * `.test.ts`), so vitest does not collect it; imported as
 * `@mantle/db/test-support`. Nothing in the product imports it.
 *
 * Why each helper exists:
 *  - ensureTestAnchor: several test files need the brain's anchor (the one
 *    `is_owner` login, `mantle_brain_id()`). Each used to create one when none
 *    existed and delete it (and its brain space) at the end. `nodes.owner_id`
 *    cascades from spaces, so on a fresh database (CI) one file could delete
 *    another file's brain rows mid-test. Now one anchor is made once, by
 *    whichever file asks first, and no test ever deletes it.
 *  - notifyBarrier / pollUntil: tests that check what reached a LISTEN channel
 *    used to sleep a fixed 250 to 400 ms, which flakes under load. A barrier
 *    sends its own sentinel on the channel and waits (with a deadline) until
 *    it arrives: Postgres delivers notifications in commit order, so by then
 *    every notification committed before it has arrived too.
 *  - setLoginRoleUnguarded: a test that pins what the code does after a
 *    login's role changes sets the role directly. The client role guard
 *    (0200) is gone since 0272, so this is a plain UPDATE now; the name
 *    stays so callers need no change.
 *  - createReadOnlyRole: a read path must be served by a database that
 *    refuses writes (a read-only replica, the public demo's reader role). A
 *    test proves it by running the read as a login that can SELECT
 *    everything and write nothing.
 *  - createMigratedScratchDatabase: a test that DROPs or re-creates tables
 *    takes locks on `nodes` that deadlock with other test files deleting
 *    nodes. Such a test runs on a database of its own, migrated from scratch
 *    and dropped after, so it shares no table with anything running in
 *    parallel.
 *  - createScratchDatabaseBefore: the same, migrated up to one migration, so
 *    a test can build the world that migration meets and then run it.
 *  - createEmptyScratchDatabase: the same database before anything is put in
 *    it (no init scripts, no migration): what a dump is restored into
 *    (dump-restore.db.test.ts).
 *  - findPgTools: pg_dump and pg_restore must be at least as new as the
 *    server. CI and the workstation run Postgres in a local Docker
 *    container, so the tests that dump and restore use the tools inside
 *    that container, and a host install only when there is none.
 */
import type { LoginRole } from '@mantle/client-types/role-names';
import { env, envDynamic } from '@mantle/config';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  managedRolePatterns,
  POOL_ROLES,
  RETIRED_POOL_ROLES,
  ensureViewerRoles,
  withRoleRetry,
} from './viewer-roles';
import { viewerRoleName } from './viewer';
import { afterMigrations, type StepLog } from './migrator-steps';
import {
  APP_SCHEMAS,
  applyRuntimeGrants,
  ensureRuntimeRoles,
  ownTables,
  RUNTIME_ROLE,
  RUNTIME_ROLES,
} from './runtime-role';

type Sql = postgres.Sql;

/** Email of the shared test anchor (only ever created on a test database). */
export const TEST_ANCHOR_EMAIL = 'test-anchor@example.invalid';

/**
 * The brain's anchor (`mantle_brain_id()`), created if there is none. Safe
 * when many test files ask at once: `auth.users` allows one owner and one
 * row per email, so a losing insert does nothing (whichever unique rule it
 * meets first) and every caller reads the same id. Never
 * delete the anchor or its brain space in a test.
 */
export async function ensureTestAnchor(sql: Sql): Promise<string> {
  await sql`
    insert into auth.users (id, email, password_hash, is_owner, role)
    values (${randomUUID()}, ${TEST_ANCHOR_EMAIL}, 'x', true, 'admin')
    on conflict do nothing`;
  const [row] = await sql<{ id: string | null }[]>`select mantle_brain_id() as id`;
  if (!row?.id) throw new Error('ensureTestAnchor: no anchor after the insert');
  return row.id;
}

/**
 * The SQL of a Team workspace as a brain switched before migration 0286 has
 * it, for a test that needs a shared workspace beyond Admin: the live
 * non-Admin workspace named "Team" of `owner` (one the switch kept), else a
 * new normal one, with every admin and member login of the database (not a
 * former client) a Moderator, as the switch gave them then. A new brain has
 * no Team (0286). One statement; it answers one row, `id`. Run it with the
 * client's raw text (`sql.raw`, `sql.unsafe`).
 */
export function teamWorkspaceSql(owner: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner)) {
    throw new Error(`teamWorkspaceSql: not a uuid: ${owner}`);
  }
  return `
    with found as (
      select w.id from public.workspaces w
       where w.owner_id = '${owner}' and not w.is_admin and w.archived_at is null
         and w.name = 'Team'
       order by w.created_at limit 1),
    made as (
      insert into public.workspaces (owner_id, name, description)
      select '${owner}', 'Team', 'Work shared with the whole team.'
       where not exists (select 1 from found)
      returning id),
    ws as (select id from found union all select id from made),
    joined as (
      insert into public.workspace_users (workspace_id, login_id, moderator)
      select m.id, u.id, true from made m, auth.users u
       where u.role in ('admin', 'member')
         and not exists (select 1 from public.archive_client_logins a where a.login_id = u.id)
      on conflict do nothing)
    select id::text as id from ws`;
}

/**
 * Set a login's role. The client role guard trigger (0200) was dropped by
 * 0272 and the role CHECK admits only 'admin' and 'member', so this is a
 * plain UPDATE.
 */
export async function setLoginRoleUnguarded(
  sql: Sql,
  loginId: string,
  role: LoginRole,
): Promise<void> {
  await sql`update auth.users set role = ${role} where id = ${loginId}`;
}

/**
 * A LOGIN role that reads everything and writes nothing, as the public demo's
 * reader does: SELECT on every table of the app's schemas, BYPASSRLS, and no
 * INSERT, UPDATE or DELETE anywhere. Returns its name and the database URL
 * that logs in as it; `dropReadOnlyRole` removes it.
 *
 * `adminUrl` must name a superuser (BYPASSRLS is a superuser's to give);
 * the first argument is unused (it was the caller's client, which may now be
 * the runtime role). Grants touch the catalog rows other test files grant
 * on at the same time, hence the retries.
 */
export async function createReadOnlyRole(
  _sql: Sql,
  adminUrl: string,
): Promise<{ name: string; url: string }> {
  // The superuser of `adminUrl`, on a connection of its own: the caller's
  // client may be the app's pool, which logs in as the runtime role under
  // MANTLE_DB_RUNTIME_ROLE (arch A9) and may not make roles.
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const name = `mantle_test_reader_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const password = randomUUID().replace(/-/g, '');
  try {
    await sql.unsafe(
      `create role "${name}" with login bypassrls nosuperuser nocreatedb nocreaterole noinherit password '${password}'`,
    );
    const schemas = await sql<{ nspname: string }[]>`
      select nspname from pg_namespace
       where nspname !~ '^pg_' and nspname <> 'information_schema'`;
    for (const { nspname } of schemas) {
      await withRoleRetry(() => sql.unsafe(`grant usage on schema "${nspname}" to "${name}"`));
      await withRoleRetry(() =>
        sql.unsafe(`grant select on all tables in schema "${nspname}" to "${name}"`),
      );
    }
    // What the demo's reader is granted besides SELECT (0256): the owner's
    // app sidebar asks for the Team workspace; the chips ask each workspace's
    // kind (0285); the grant reads ask whether a workspace is shared, and the
    // app sidebar whether one holds an app (0286).
    await withRoleRetry(() =>
      sql.unsafe(
        `grant execute on function "public"."mantle_brain_team_ws"(), "public"."mantle_brain_id"(), "public"."mantle_ws_kind"(uuid), "public"."mantle_ws_any_shared"(uuid[]), "public"."mantle_ws_any_holder"(uuid[]) to "${name}"`,
      ),
    );
  } finally {
    await sql.end();
  }
  readerAdminUrls.set(name, adminUrl);
  const url = new URL(adminUrl);
  url.username = name;
  url.password = password;
  return { name, url: url.toString() };
}

/** The superuser URL each reader was made on (dropReadOnlyRole). */
const readerAdminUrls = new Map<string, string>();

/** Remove a role `createReadOnlyRole` made, as the superuser that made it.
 *  Close every connection made with its URL first: a role that is logged in
 *  cannot be dropped. */
export async function dropReadOnlyRole(_sql: Sql, name: string): Promise<void> {
  if (!/^mantle_test_reader_[0-9a-f]+$/.test(name)) {
    throw new Error('dropReadOnlyRole: not a test reader role');
  }
  const adminUrl = readerAdminUrls.get(name);
  if (!adminUrl) throw new Error(`dropReadOnlyRole: ${name} was not made here`);
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await withRoleRetry(() => sql.unsafe(`drop owned by "${name}"`));
    await sql.unsafe(`drop role if exists "${name}"`);
  } finally {
    await sql.end();
  }
  readerAdminUrls.delete(name);
}

/**
 * Work only the migrator does (arch A9): a migration run again, a schema
 * change, a role made or dropped, the heads check's named bypass. On its
 * own connection as the superuser of `url`, in one transaction as
 * system(migration), as migrate.ts runs one; never through the app's
 * pools, which log in as the runtime role under MANTLE_DB_RUNTIME_ROLE.
 */
export async function asMigrator<T>(
  url: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return (await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:migration', true),
                      set_config('mantle.write_mode', 'rw', true)`;
      return fn(tx);
    })) as T;
  } finally {
    await sql.end();
  }
}

/** A client of its own as the superuser of `url` (arch A9), for a package
 *  that has no postgres dependency of its own: a migrator's step under
 *  test (CREATE INDEX CONCURRENTLY runs outside a transaction). The caller
 *  ends it. */
export function superuserClient(url: string, max = 1): Sql {
  return postgres(url, { max, onnotice: () => {} });
}

/**
 * One statement as the superuser of `url`, as system(test), in a transaction
 * of its own (arch A9): a fixture that switches a box mode, makes a table
 * or a trigger function, or sets the heads check, which the app's pool may
 * not do when it logs in as the runtime role. A drizzle `sql` query or raw
 * text.
 */
export async function superuserExec<T = Record<string, unknown>>(
  url: string,
  query: SQL | string,
): Promise<T[]> {
  const { sql: text, params } =
    typeof query === 'string' ? { sql: query, params: [] } : new PgDialect().sqlToQuery(query);
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true),
                      set_config('mantle.write_mode', 'rw', true)`;
      return [...(await tx.unsafe(text, params as never[]))];
    });
    return rows as unknown as T[];
  } finally {
    await sql.end();
  }
}

/**
 * The workspaces switch (mantle_ws_migrate), as the migrator runs it: on a
 * connection of its own as the superuser of `url` (default DATABASE_URL,
 * the database a test points the app's pools at), as system(test). Never
 * through the app's pools: under MANTLE_DB_RUNTIME_ROLE they log in as the
 * runtime role, which may not run it (arch A9: the switch reaches DDL; the
 * app runs it as the migrator, executeAsMigrator). Returns its rows.
 */
export async function runWorkspacesSwitch<T = Record<string, unknown>>(
  url: string | undefined = env('DATABASE_URL'),
): Promise<T[]> {
  if (!url) throw new Error('runWorkspacesSwitch: no database URL (set DATABASE_URL)');
  return superuserExec<T>(url, 'select * from mantle_ws_migrate()');
}

/** Poll `check` until it holds, or fail after `timeoutMs`. */
export async function pollUntil(
  check: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`pollUntil: timed out waiting for ${opts.what ?? 'the condition'}`);
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 20));
  }
}

/**
 * Wait until every notification committed on `channel` before this call has
 * reached the test's listener. Sends a sentinel (a fresh uuid, wrapped by
 * `payload` for channels that carry JSON) and polls `seen` until the
 * listener has recorded it. Other listeners on the channel get one payload
 * naming an id that does not exist.
 */
export async function notifyBarrier(
  sql: Sql,
  channel: string,
  opts: {
    seen: (sentinel: string) => boolean;
    payload?: (sentinel: string) => string;
    timeoutMs?: number;
  },
): Promise<void> {
  const sentinel = randomUUID();
  const payload = opts.payload ? opts.payload(sentinel) : sentinel;
  await sql`select pg_notify(${channel}, ${payload})`;
  await pollUntil(() => opts.seen(sentinel), {
    timeoutMs: opts.timeoutMs,
    what: `the ${channel} barrier`,
  });
}

/** The migrator steps' lines, unprinted in a test. */
const QUIET: StepLog = { info: () => {}, warn: () => {} };

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'migrations');
const INIT_DIR = join(here, '..', '..', '..', 'infra', 'postgres', 'init');

/** The same database URL with another database name. */
function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** CREATE DATABASE copies template1; two at once can collide on it. */
async function createDatabase(adminUrl: string, name: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await sql.unsafe(`create database "${name}"`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt >= 10 || !/being accessed by other users/.test(msg)) throw err;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  } finally {
    await sql.end();
  }
}

/**
 * A new, empty database on the same server as `adminUrl` (a copy of
 * template1: no init script, no migration). Returns its URL and a `drop()`
 * that removes it, open connections included.
 */
export async function createEmptyScratchDatabase(
  adminUrl: string,
): Promise<{ url: string; name: string; drop: () => Promise<void> }> {
  const name = `mantle_scratch_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await createDatabase(adminUrl, name);
  const url = withDatabase(adminUrl, name);
  const drop = async () => {
    const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`drop database if exists "${name}" with (force)`);
    } finally {
      await sql.end();
    }
  };
  return { url, name, drop };
}

/**
 * A new database on the same server as `adminUrl`, prepared the way CI's
 * throwaway database is (infra/postgres/init, then every migration, each in
 * its own transaction, then the access matrix's grants, as migrate.ts runs
 * them). Returns its URL and a
 * `drop()` that removes it, open connections included.
 *
 * The viewer roles are cluster-wide and already exist wherever the shared
 * test database was migrated; a missing one is created without a login
 * (never altered: other test files hold live connections on them).
 */
export async function createMigratedScratchDatabase(
  adminUrl: string,
): Promise<{ url: string; name: string; drop: () => Promise<void> }> {
  const { url, name, drop } = await createEmptyScratchDatabase(adminUrl);
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await prepareScratch(sql);
    await applyMigrations(sql, readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR }));
    // Grants are per database: migrate applies the access matrix after the
    // migrations, so a limited role (a member's space) can work here too,
    // and the runtime role's (arch A9), as migrate.ts runs them.
    await afterMigrations(sql, 'ok', QUIET);
    await applyTestEditCheck(sql);
  } catch (err) {
    await sql.end();
    await drop();
    throw err;
  }
  await sql.end();
  return { url, name, drop };
}

/**
 * The edit check's box mode for a test's scratch database (arch A3a):
 * MANTLE_TEST_EDIT_CHECK (warn or on; a test config sets it, never a box)
 * runs mantle_set_edit_check on it, as an operator would on a box. Unset or
 * off: the database stays off, as every box starts.
 */
async function applyTestEditCheck(sql: ReturnType<typeof postgres>): Promise<void> {
  // A test config's own dial (vitest.edit-on.config.ts), never a box's.
  const mode = (envDynamic('MANTLE_TEST_EDIT_CHECK') ?? '').trim().toLowerCase();
  if (mode !== 'warn' && mode !== 'on') return;
  await sql`select mantle_set_edit_check(${mode})`;
}

/**
 * The same scratch database, migrated only up to (not including) the
 * migration `tag` (`0261_workspaces_bridge_off`): a test builds the world
 * that migration meets, then `migrateRest()` applies it and every later one,
 * and the grants, as migrate.ts would on a live box.
 */
export async function createScratchDatabaseBefore(
  adminUrl: string,
  tag: string,
): Promise<{
  url: string;
  name: string;
  drop: () => Promise<void>;
  /** Applies `tag` and every later migration, or only those before
   *  `untilTag` when given (a test of one migration stops before the next
   *  one that rewrites the same rows), then the grants. */
  migrateRest: (untilTag?: string) => Promise<void>;
}> {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  if (at < 0) throw new Error(`createScratchDatabaseBefore: no migration ${tag}`);
  const all = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
  const { url, name, drop } = await createEmptyScratchDatabase(adminUrl);
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await prepareScratch(sql);
    await applyMigrations(sql, all.slice(0, at));
    // The runtime role's rights on the tables of that older schema (arch
    // A9), as a box at that migration has them: a test seeds the old world
    // through the app's pool.
    await ownTables(sql);
    await applyRuntimeGrants(sql);
    // And EXECUTE on every function of that schema: the allowlist reads
    // the viewer roles' grants of the final schema (0278 gives the write
    // role mantle_is_brain_space, say), which an older one lacks, and no
    // box ever ran an older schema under the runtime role. The rest of the
    // migrations' afterMigrations puts the allowlist back.
    await sql.unsafe(
      `GRANT EXECUTE ON ALL ROUTINES IN SCHEMA ${APP_SCHEMAS.join(', ')} TO "${RUNTIME_ROLE}"`,
    );
  } catch (err) {
    await sql.end();
    await drop();
    throw err;
  }
  await sql.end();
  const migrateRest = async (untilTag?: string) => {
    const until = untilTag ? journal.entries.findIndex((e) => e.tag === untilTag) : -1;
    if (untilTag && until < 0) throw new Error(`migrateRest: no migration ${untilTag}`);
    const rest = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await applyMigrations(rest, until < 0 ? all.slice(at) : all.slice(at, until));
      await afterMigrations(rest, 'ok', QUIET);
    } finally {
      await rest.end();
    }
  };
  return { url, name, drop, migrateRest };
}

/** infra/postgres/init, and the viewer roles a scratch database needs. */
async function prepareScratch(sql: Sql): Promise<void> {
  const initFiles = readdirSync(INIT_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of initFiles) await sql.unsafe(readFileSync(join(INIT_DIR, f), 'utf8'));
  const roles = new Set(
    (
      await sql<
        { rolname: string }[]
      >`select rolname from pg_roles where rolname like any(${managedRolePatterns()}::text[])`
    ).map((r) => r.rolname),
  );
  // The retired roles too: the old migrations still grant to them. And the
  // runtime roles (arch A9), without a login, when the global setup made
  // none (afterMigrations grants to them).
  for (const role of [
    ...[...POOL_ROLES, ...RETIRED_POOL_ROLES].map((l) => viewerRoleName(l)),
    ...RUNTIME_ROLES,
  ]) {
    if (roles.has(role)) continue;
    await sql
      .unsafe(`create role "${role}" with nologin nosuperuser nobypassrls noinherit`)
      .catch((err: Error) => {
        // Another scratch database created it first.
        if (!/already exists/.test(err.message)) throw err;
      });
  }
}

/** Each migration in its own transaction, as migrate.ts runs them. */
async function applyMigrations(
  sql: Sql,
  migrations: ReturnType<typeof readMigrationFiles>,
): Promise<void> {
  for (const migration of migrations) {
    await sql.begin(async (tx) => {
      // As migrate.ts: a migration's writes run as system(migration).
      await tx`select set_config('mantle.actor', 'system:migration', true),
                      set_config('mantle.write_mode', 'rw', true)`;
      for (const stmt of migration.sql) await tx.unsafe(stmt);
    });
  }
}

/**
 * Bring the viewer roles to their wanted state once, before any test file
 * runs (vitest.global-setup.ts). The roles are cluster-wide rows: dozens of
 * parallel files each creating or altering them raced ("tuple concurrently
 * updated", folder audit T2). With them in place first, no CREATE races and
 * the ALTERs each file still runs retry with jitter.
 */
export async function ensureTestViewerRoles(url: string, masterKey: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    await ensureViewerRoles(sql, masterKey);
    // And the runtime roles (arch A9), with a login: a run with
    // MANTLE_DB_RUNTIME_ROLE=1 logs its pools in as mantle_runtime, its
    // password from this key.
    await ensureRuntimeRoles(sql, masterKey, { login: true });
  } finally {
    await sql.end();
  }
}

/**
 * Run `fn` holding a cluster-wide test lock named `name`: test files that
 * measure one shared total (the brain-wide client bytes) while another file
 * changes it take the same lock, so neither sees the other mid-way (folder
 * audit T3). A session lock on its own connection, released at the end.
 */
export async function withTestLock<T>(url: string, name: string, fn: () => Promise<T>): Promise<T> {
  const release = await holdTestLock(url, name);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Take the cluster-wide test lock `name` and return its release: for a file
 * that holds it from its first fixture to the end of its cleanup (a
 * beforeAll takes it, the afterAll releases it), when a single test's
 * withTestLock would leave its other tests and its cleanup outside. A
 * session lock on its own connection; the release also closes it.
 */
export async function holdTestLock(url: string, name: string): Promise<() => Promise<void>> {
  const sql = postgres(url, { max: 1 });
  try {
    await sql`select pg_advisory_lock(hashtextextended(${`mantle-test:${name}`}, 0))`;
  } catch (err) {
    await sql.end();
    throw err;
  }
  return async () => {
    await sql`select pg_advisory_unlock_all()`.catch(() => {});
    await sql.end();
  };
}

export type PgToolRun = { status: number | null; stdout: Buffer; stderr: string };
export type PgTools = {
  /** The local Docker container the tools run in; null for a host install. */
  container: string | null;
  /** Run pg_dump or pg_restore against database `db` of the test server. */
  run(tool: 'pg_dump' | 'pg_restore', db: string, args: string[], input?: Buffer): PgToolRun;
};

/** Run a command to its end; a command that is not there gives status null. */
export function runCommand(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: Buffer; cwd?: string } = {},
): PgToolRun {
  const r = spawnSync(cmd, args, { ...opts, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: String(r.stderr ?? '') };
}

/**
 * pg_dump and pg_restore for the server at `url`: the ones inside the local
 * Docker container that publishes the URL's port (`containerName` names
 * another one: the tests pass MANTLE_TEST_PG_CONTAINER), else a host install
 * (one older than the server refuses to dump, and says so), else null.
 */
export function findPgTools(url: string, containerName?: string): PgTools | null {
  const u = new URL(url);
  const user = decodeURIComponent(u.username) || 'postgres';
  const port = u.port || '5432';
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password) };

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  const publishing = local
    ? runCommand('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], { env })
        .stdout.toString()
        .split('\n')
        .filter((l) => new RegExp(`:${port}->\\d+/tcp`).test(l))
        .map((l) => l.split('\t')[0]!)
    : [];
  const container = containerName ?? (publishing.length === 1 ? publishing[0]! : null);
  if (
    container &&
    runCommand('docker', ['exec', container, 'pg_dump', '--version'], { env }).status === 0
  ) {
    // Its own tools match its server, and the local socket needs no host or
    // port.
    return {
      container,
      run: (tool, db, args, input) =>
        runCommand(
          'docker',
          ['exec', '-i', '-e', 'PGPASSWORD', container, tool, '-U', user, '-d', db, ...args],
          { env, input },
        ),
    };
  }
  if (runCommand('pg_dump', ['--version'], { env }).status === 0) {
    return {
      container: null,
      run: (tool, db, args, input) =>
        runCommand(tool, ['-h', u.hostname, '-p', port, '-U', user, '-d', db, ...args], {
          env,
          input,
        }),
    };
  }
  return null;
}
