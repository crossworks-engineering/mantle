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
 *  - createMigratedScratchDatabase: a test that DROPs or re-creates tables
 *    takes locks on `nodes` that deadlock with other test files deleting
 *    nodes. Such a test runs on a database of its own, migrated from scratch
 *    and dropped after, so it shares no table with anything running in
 *    parallel.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';
import { POOL_ROLES, ensureViewerRoles } from './viewer-roles';
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
