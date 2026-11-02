/**
 * What the narrow login stores on itself (ALTER ROLE ... SET): a raw session
 * takes it, the route's pool overrides it, the boot line names it, and migrate
 * takes it back. Moved out of narrow-login.db.test.ts: the role is the
 * cluster's, and migrate's role step takes back its settings in every database,
 * so a role step in any other test file wiped the row under these cases. This
 * file runs alone (`pnpm test:serial`, vitest.serial.config.ts; the default
 * configs leave `*.serial.db.test.ts` out).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test:serial
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const NARROW = 'mantle_system_narrow';

describe.skipIf(!URL)('settings the narrow login stores on itself (alone on the cluster)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let rr: typeof import('./runtime-role');
  let pools: typeof import('./gateway/pools');
  let nr: typeof import('./gateway/narrow-route');
  let su: ReturnType<typeof postgres>;
  /** A session logged in as the narrow role, one connection. */
  let nl: ReturnType<typeof postgres>;
  let dbName = '';

  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  /** The narrow role's own URL, with its derived password. */
  const narrowUrlOf = () =>
    rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE);

  /** The error a promise failed with (drizzle wraps the driver's). */
  const failure = async (p: PromiseLike<unknown>): Promise<{ code?: string; message?: string }> => {
    try {
      await p;
    } catch (err) {
      const e = err as { cause?: unknown };
      return (e.cause ?? err) as { code?: string; message?: string };
    }
    throw new Error('expected a failure');
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    dbName = new globalThis.URL(scratch.url).pathname.slice(1);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    rr = await import('./runtime-role');
    nl = postgres(narrowUrlOf(), { max: 1, prepare: false, onnotice: () => {} });
    pools = await import('./gateway/pools');
    nr = await import('./gateway/narrow-route');
  }, 120_000);

  afterAll(async () => {
    // Whatever happened above, no setting left on the cluster's role.
    try {
      if (rr) await rr.ensureRuntimeRoles(su, KEY(), { login: true, warn: () => {} });
    } finally {
      await nl?.end();
      await su?.end();
      await scratch?.drop();
    }
  });

  it('a setting the narrow login stores on itself: the pool overrides it, the boot line names it, migrate takes it back', async () => {
    // Stored by the narrow login itself: every database's (a harmless one,
    // the role is the cluster's and other test files use it now) and this
    // database's own (search_path: a session without the startup
    // parameters would take it).
    await nl.unsafe(`alter role current_user set application_name = 'narrow-cell'`);
    await nl.unsafe(`alter role current_user in database "${dbName}" set search_path = pg_catalog`);
    // This database's row only: the every-database row is the server's, and
    // another suite's migrate can take it back at any moment.
    const stored = async () =>
      (
        await su<{ n: number }[]>`
          select count(*)::int as n from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
           where r.rolname = ${NARROW}
             and s.setdatabase = (select oid from pg_database where datname = ${dbName})`
      )[0]!.n;
    expect(await stored()).toBe(1);
    const raw = postgres(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      { max: 1, prepare: false, onnotice: () => {} },
    );
    const pool = pools.newNarrowPool(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
      su,
    );
    try {
      const sp = `select current_setting('search_path') as sp`;
      expect((await raw.unsafe<{ sp: string }[]>(sp))[0]!.sp).toBe('pg_catalog');
      expect((await pool.unsafe<{ sp: string }[]>(sp))[0]!.sp).toBe('"$user", public');
    } finally {
      await raw.end();
      await pool.end();
    }
    // The boot line names it (read as the system pool reads it).
    const probe = await rr.readNarrowLogin(su);
    expect(probe).toMatchObject({ login: true });
    expect(probe!.settings).toBeGreaterThanOrEqual(1);
    expect(rr.narrowLoginNote(probe!, true)).toMatch(/\d stored setting row\(s\).*next migrate/);
    // migrate's role step takes every one back.
    await rr.ensureRuntimeRoles(su, KEY(), { login: true, warn: () => {} });
    expect(await stored()).toBe(0);
  });

  it('every pinned setting, stored by the narrow login: a raw session takes it, the pool pins it, migrate takes it back', async () => {
    // This database's own (IN DATABASE): the role is the cluster's, and the
    // test files beside this one log in as it.
    const stored: [string, string][] = [
      ['default_transaction_read_only', 'on'],
      ['default_transaction_isolation', 'serializable'],
      ['row_security', 'off'],
      ['statement_timeout', '1000'],
      ['lock_timeout', '1'],
      ['idle_in_transaction_session_timeout', '600000'],
      ['idle_session_timeout', '600000'],
      ['transaction_timeout', '600000'],
      ['bytea_output', 'escape'],
      ['extra_float_digits', '-15'],
      ['exit_on_error', 'on'],
      ['synchronous_commit', 'off'],
      ['array_nulls', 'off'],
      ['transform_null_equals', 'on'],
      ['xmloption', 'document'],
      ['gin_fuzzy_search_limit', '1'],
      ['TimeZone', 'Pacific/Chatham'],
      ['DateStyle', 'German, DMY'],
      ['IntervalStyle', 'sql_standard'],
      ['timezone_abbreviations', 'India'],
    ];
    for (const [name, value] of stored) {
      await nl.unsafe(`alter role current_user in database "${dbName}" set ${name} = '${value}'`);
    }
    const count = async () =>
      (
        await su<{ n: number }[]>`
          select count(*)::int as n from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
           join pg_database d on d.oid = s.setdatabase
           where r.rolname = ${NARROW} and d.datname = ${dbName}`
      )[0]!.n;
    expect(await count()).toBe(1);
    const read = `select ${stored.map(([n]) => `current_setting('${n}') as "${n}"`).join(', ')},
                         current_setting('transaction_read_only') as ro`;
    // A session without the startup parameters takes them: read only, and
    // a statement cut short (the auditor's P4). No type fetch: on a busy
    // box the driver's own first query could meet the stored timeout and,
    // with exit_on_error on, end the session before the cell's statements.
    const raw = postgres(narrowUrlOf(), {
      max: 1,
      prepare: false,
      fetch_types: false,
      onnotice: () => {},
    });
    // The route reads the system pool's session-start values before a
    // narrow connect (systemStartup); the pool takes them at connect.
    await nr.systemStartup(su);
    const pool = pools.newNarrowPool(narrowUrlOf(), su);
    try {
      const [rawRow] = await raw.unsafe<Record<string, string>[]>(read);
      expect(rawRow).toMatchObject({
        default_transaction_read_only: 'on',
        ro: 'on',
        exit_on_error: 'on',
        array_nulls: 'off',
      });
      // Cut short at 1 s, and with exit_on_error on the error ends the
      // session too (the driver then answers the close).
      const cut = (await failure(raw.unsafe('select pg_sleep(1.5)'))) as { code?: string };
      expect(['57014', 'CONNECTION_CLOSED']).toContain(cut.code);
      // The pool's session: every one at the value the app runs with.
      const [row] = await pool.unsafe<Record<string, string>[]>(read);
      const want = pools.narrowStartup(nr.systemStartupOf(su)!);
      for (const [name] of stored) {
        expect(row![name], name).toBe(want[name]);
        expect(want[name], name).toBeDefined();
      }
      expect(row!.ro).toBe('off');
      // Past the stored timeout: the pool's own runs.
      await pool.unsafe('select pg_sleep(1.5)');
    } finally {
      await raw.end();
      await pool.end();
    }
    // migrate's role step takes them back.
    await rr.ensureRuntimeRoles(su, KEY(), { login: true, warn: () => {} });
    expect(await count()).toBe(0);
  });
});
