/**
 * The migrator's role steps are idempotent, and a hand grant is taken back. A
 * grant of a role to a role is the cluster's: while this case holds its hand
 * grants, mantle_runtime inherits mantle_owner in every database, and a test
 * file beside it that reads the runtime role's rights met that. This file runs
 * alone (`pnpm test:serial`, vitest.serial.config.ts; the default configs leave
 * `*.serial.db.test.ts` out).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test:serial
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createMigratedScratchDatabase } from './test-support';
import { afterMigrations } from './migrator-steps';
import {
  ACL_MARKER_FUNCTION,
  DB_ROLE_SQL,
  NARROW_ROLE,
  OWNER_ROLE,
  RUNTIME_LOCK_SQL,
  RUNTIME_ROLE,
  SYSTEM_ROLE,
  dbRoleMode,
  ensureRuntimeRoles,
  ownTables,
  runtimeDatabaseUrl,
  runtimeRolePassword,
  type DbRoleRow,
} from './runtime-role';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const KEY = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

describe.skipIf(!URL)("a hand grant on the cluster's roles (alone on the cluster)", () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let admin: ReturnType<typeof postgres>;
  let rt: ReturnType<typeof postgres>;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    admin = postgres(scratch.url, { max: 1, onnotice: () => {} });
    expect(await ensureRuntimeRoles(admin, KEY, { login: true })).toBe('ok');
    rt = postgres(runtimeDatabaseUrl(scratch.url, runtimeRolePassword(KEY)), {
      max: 1,
      onnotice: () => {},
    });
  }, 180_000);

  afterAll(async () => {
    // Whatever happened above, the wanted memberships again.
    try {
      if (admin) await ensureRuntimeRoles(admin, KEY, { login: true, warn: () => {} });
    } finally {
      await rt?.end();
      await admin?.end();
      await scratch?.drop();
    }
  }, 60_000);

  it('the migrator steps are idempotent, and a hand grant is taken back', async () => {
    await admin.unsafe(`GRANT ${OWNER_ROLE} TO ${RUNTIME_ROLE} WITH INHERIT TRUE, SET TRUE`);
    await admin.unsafe(`GRANT ${SYSTEM_ROLE} TO ${RUNTIME_ROLE} WITH INHERIT TRUE`);
    await admin.unsafe(`GRANT ${NARROW_ROLE} TO ${RUNTIME_ROLE} WITH INHERIT TRUE`);
    await admin.unsafe(`GRANT TRUNCATE ON public.nodes TO ${RUNTIME_ROLE}`);
    await admin.unsafe(`GRANT INSERT ON public.nodes TO ${NARROW_ROLE}`);
    await admin.unsafe(`GRANT EXECUTE ON FUNCTION mantle_role_drift() TO ${NARROW_ROLE}`);
    await admin.unsafe(`GRANT EXECUTE ON FUNCTION mantle_ws_migrate() TO ${RUNTIME_ROLE}`);
    await admin.unsafe(`ALTER TABLE public.actor_check_misses OWNER TO postgres`);
    // A function the runtime role owns: the integrity row says so.
    await admin.unsafe(`ALTER FUNCTION ${ACL_MARKER_FUNCTION} OWNER TO ${RUNTIME_ROLE}`);
    const broken = (await admin.unsafe(RUNTIME_LOCK_SQL)) as unknown as { detail: string }[];
    expect(broken[0]?.detail).toMatch(/owns functions/);
    expect(broken[0]?.detail).toMatch(/holds the rights of/);
    expect(broken[0]?.detail).toMatch(/may become mantle_owner/);
    const [mode] = (await rt.unsafe(DB_ROLE_SQL)) as unknown as DbRoleRow[];
    expect(dbRoleMode(mode!)).toBe('other');
    // While migrate puts the wanted memberships right, the runtime role
    // never stops being able to become the narrow and the system role: a
    // wanted membership with the wrong options is set right in place, never
    // taken back and granted again (that left a moment, cluster-wide, in
    // which every database's SET ROLE failed 42501: the narrow write
    // count's cascade cell met it once beside this file).
    let migrating = true;
    const refused: string[] = [];
    let tries = 0;
    const becomes = (async () => {
      while (migrating) {
        for (const role of [NARROW_ROLE, SYSTEM_ROLE]) {
          tries += 1;
          await rt
            .begin((tx) => tx.unsafe(`select set_config('role', '${role}', true)`))
            .catch((err: { code?: string }) => refused.push(`${role} ${err.code}`));
        }
      }
    })();
    const warned: string[] = [];
    try {
      expect(
        await ensureRuntimeRoles(admin, KEY, {
          login: true,
          warn: (l) => warned.push(l),
        }),
      ).toBe('ok');
    } finally {
      migrating = false;
      await becomes;
    }
    expect(refused).toEqual([]);
    expect(tries).toBeGreaterThan(2);
    expect(warned.filter((l) => l.includes(`from ${RUNTIME_ROLE} `))).toEqual([]);
    await afterMigrations(admin, 'ok', { info: () => {}, warn: () => {} });
    const ms = await admin<{ role: string; inherit: boolean; set: boolean }[]>`
      select r.rolname as role, m.inherit_option as inherit, m.set_option as set
        from pg_auth_members m
        join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
       where u.rolname = ${RUNTIME_ROLE} order by 1`;
    expect(ms).toEqual([
      { role: OWNER_ROLE, inherit: false, set: false },
      { role: SYSTEM_ROLE, inherit: false, set: true },
      { role: NARROW_ROLE, inherit: false, set: true },
    ]);
    const [t] = await admin<{ ok: boolean; ws: boolean; ni: boolean; nd: boolean }[]>`
      select has_table_privilege(${RUNTIME_ROLE}, 'public.nodes', 'TRUNCATE') as ok,
             has_function_privilege(${RUNTIME_ROLE}, 'mantle_ws_migrate()', 'EXECUTE') as ws,
             has_table_privilege(${NARROW_ROLE}, 'public.nodes', 'INSERT') as ni,
             has_function_privilege(${NARROW_ROLE}, 'mantle_role_drift()', 'EXECUTE') as nd`;
    expect(t).toEqual({ ok: false, ws: false, ni: false, nd: false });
    expect(await admin.unsafe(RUNTIME_LOCK_SQL)).toEqual([]);
    expect((await ownTables(admin)).owned).toEqual([]);
  });
});
