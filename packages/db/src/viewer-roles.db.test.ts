/**
 * Brains sharing one Postgres cluster cannot lock each other out (2026-10-08).
 *
 * The incident: throwaway brains on the workstation's mantle_dev_pg each ran
 * migrate with their own master key. The viewer roles are cluster-wide with one
 * password each, so the last migrate won and every other brain's member pages
 * answered 500 ("password authentication failed for user mantle_view_space").
 *
 * Here two scratch databases play two brains with two keys, both in
 * per-database mode, on the test cluster whose shared roles the test database
 * owns (the global setup migrated it). Both log in after both migrated, the
 * shared roles keep the test key, and a shared-name migrate from a scratch
 * database is refused without changing anything.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/viewer-roles.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createEmptyScratchDatabase } from './test-support';
import { POOL_ROLES, ensureViewerRoles } from './viewer-roles';
import { viewerDatabaseUrl, viewerLoginRoleName, viewerRolePassword } from './viewer';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const INVALID_PASSWORD = '28P01';

describe.skipIf(!URL)('viewer roles on a shared cluster', () => {
  const testKey = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  const brains: { url: string; name: string; key: string; drop: () => Promise<void> }[] = [];

  /** Who a viewer login is, on `url`, with `password`. */
  const whoami = async (url: string) => {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const [row] = await sql<{ s: string; c: string }[]>`
        select session_user as s, current_user as c`;
      return row!;
    } finally {
      await sql.end();
    }
  };

  const migrate = async (url: string, key: string | null, perDatabase: boolean) => {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await ensureViewerRoles(sql, key, perDatabase);
    } finally {
      await sql.end();
    }
  };

  beforeAll(async () => {
    // The test database owns the shared roles, as on a box (idempotent).
    await migrate(URL!, testKey, false);
    for (const key of ['shared-cluster-key-a', 'shared-cluster-key-b']) {
      brains.push({ ...(await createEmptyScratchDatabase(URL!)), key });
    }
  }, 60_000);

  afterAll(async () => {
    for (const b of brains) await b.drop();
    const sql = postgres(URL!, { max: 1, onnotice: () => {} });
    try {
      for (const b of brains) {
        for (const level of POOL_ROLES) {
          await sql.unsafe(`drop role if exists "${viewerLoginRoleName(level, b.name)}"`);
        }
      }
    } finally {
      await sql.end();
    }
  });

  it('two brains with two keys both log in after both migrated', async () => {
    for (const b of brains) await migrate(b.url, b.key, true);
    for (const b of brains) {
      for (const level of POOL_ROLES) {
        const url = viewerDatabaseUrl(b.url, level, viewerRolePassword(b.key, level), true);
        expect(await whoami(url)).toEqual({
          s: viewerLoginRoleName(level, b.name),
          c: `mantle_view_${level}`,
        });
      }
    }
  });

  it("the shared roles keep the owner's password", async () => {
    const url = viewerDatabaseUrl(URL!, 'space', viewerRolePassword(testKey, 'space'));
    expect(await whoami(url)).toEqual({ s: 'mantle_view_space', c: 'mantle_view_space' });
  });

  it('a shared-name migrate from another database is refused, and changes nothing', async () => {
    const [a] = brains;
    await expect(migrate(a!.url, a!.key, false)).rejects.toThrow(/belong to the brain in database/);
    await expect(migrate(a!.url, null, false)).rejects.toThrow(/belong to the brain in database/);
    const url = viewerDatabaseUrl(URL!, 'space', viewerRolePassword(testKey, 'space'));
    expect((await whoami(url)).s).toBe('mantle_view_space');
    // And brain A's key is no password for the shared role.
    const wrong = viewerDatabaseUrl(URL!, 'space', viewerRolePassword(a!.key, 'space'));
    await expect(whoami(wrong)).rejects.toMatchObject({ code: INVALID_PASSWORD });
  });

  it("a brain's login is only its own: in another database it is itself, with no power", async () => {
    const [a, b] = brains;
    // Brain A's space login, pointed at brain B's database.
    const url = new globalThis.URL(
      viewerDatabaseUrl(a!.url, 'space', viewerRolePassword(a!.key, 'space'), true),
    );
    url.pathname = `/${b!.name}`;
    expect(await whoami(url.toString())).toEqual({
      s: viewerLoginRoleName('space', a!.name),
      c: viewerLoginRoleName('space', a!.name),
    });
  });
});
