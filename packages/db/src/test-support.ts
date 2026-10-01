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
 *  - setLoginRoleUnguarded: a login's role never changes to or from client
 *    (0200). A test that pins what the code does for a login that is no
 *    longer a client (or turned client) makes that state around the guard.
 *  - createReadOnlyRole: a read path must be served by a database that
 *    refuses writes (a read-only replica, the public demo's reader role). A
 *    test proves it by running the read as a login that can SELECT
 *    everything and write nothing.
 *  - createMigratedScratchDatabase: a test that DROPs or re-creates tables
 *    takes locks on `nodes` that deadlock with other test files deleting
 *    nodes. Such a test runs on a database of its own, migrated from scratch
 *    and dropped after, so it shares no table with anything running in
 *    parallel.
 *  - createEmptyScratchDatabase: the same database before anything is put in
 *    it (no init scripts, no migration): what a dump is restored into
 *    (dump-restore.db.test.ts).
 *  - findPgTools: pg_dump and pg_restore must be at least as new as the
 *    server. CI and the workstation run Postgres in a local Docker
 *    container, so the tests that dump and restore use the tools inside
 *    that container, and a host install only when there is none.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';
import { POOL_ROLES, ensureViewerRoles, withRoleRetry } from './viewer-roles';
import { applyViewerGrants } from './access-matrix';
import { viewerRoleName } from './viewer';

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
 * Set a login's role with the client role guard (0200) off for that one
 * UPDATE. The trigger is disabled and enabled again in one transaction, so
 * no other session ever sees it off (their writes to auth.users wait for
 * the lock meanwhile).
 */
export async function setLoginRoleUnguarded(
  sql: Sql,
  loginId: string,
  role: 'admin' | 'member' | 'client',
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`alter table auth.users disable trigger users_client_role_guard`;
    await tx`update auth.users set role = ${role} where id = ${loginId}`;
    await tx`alter table auth.users enable trigger users_client_role_guard`;
  });
}

/**
 * A LOGIN role that reads everything and writes nothing, as the public demo's
 * reader does: SELECT on every table of the app's schemas, BYPASSRLS, and no
 * INSERT, UPDATE or DELETE anywhere. Returns its name and the database URL
 * that logs in as it; `dropReadOnlyRole` removes it.
 *
 * `sql` must be a superuser connection to the database `adminUrl` names
 * (BYPASSRLS is a superuser's to give). Grants touch the catalog rows other
 * test files grant on at the same time, hence the retries.
 */
export async function createReadOnlyRole(
  sql: Sql,
  adminUrl: string,
): Promise<{ name: string; url: string }> {
  const name = `mantle_test_reader_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const password = randomUUID().replace(/-/g, '');
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
  const url = new URL(adminUrl);
  url.username = name;
  url.password = password;
  return { name, url: url.toString() };
}

/** Remove a role `createReadOnlyRole` made. Close every connection made with
 *  its URL first: a role that is logged in cannot be dropped. */
export async function dropReadOnlyRole(sql: Sql, name: string): Promise<void> {
  if (!/^mantle_test_reader_[0-9a-f]+$/.test(name)) {
    throw new Error('dropReadOnlyRole: not a test reader role');
  }
  await withRoleRetry(() => sql.unsafe(`drop owned by "${name}"`));
  await sql.unsafe(`drop role if exists "${name}"`);
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
    const initFiles = readdirSync(INIT_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of initFiles) await sql.unsafe(readFileSync(join(INIT_DIR, f), 'utf8'));
    const roles = new Set(
      (
        await sql<
          { rolname: string }[]
        >`select rolname from pg_roles where rolname like 'mantle_view_%'`
      ).map((r) => r.rolname),
    );
    for (const level of POOL_ROLES) {
      const role = viewerRoleName(level);
      if (roles.has(role)) continue;
      await sql
        .unsafe(`create role "${role}" with nologin nosuperuser nobypassrls noinherit`)
        .catch((err: Error) => {
          // Another scratch database created it first.
          if (!/already exists/.test(err.message)) throw err;
        });
    }
    for (const migration of readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR })) {
      await sql.begin(async (tx) => {
        for (const stmt of migration.sql) await tx.unsafe(stmt);
      });
    }
    // Grants are per database: migrate applies the access matrix after the
    // migrations, so a limited role (a member's space) can work here too.
    await applyViewerGrants(sql);
  } catch (err) {
    await sql.end();
    await drop();
    throw err;
  }
  await sql.end();
  return { url, name, drop };
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
  const sql = postgres(url, { max: 1 });
  try {
    await sql`select pg_advisory_lock(hashtextextended(${`mantle-test:${name}`}, 0))`;
    return await fn();
  } finally {
    await sql`select pg_advisory_unlock_all()`.catch(() => {});
    await sql.end();
  }
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
