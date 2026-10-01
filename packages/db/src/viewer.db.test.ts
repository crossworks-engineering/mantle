/**
 * The access adapter against a real Postgres (member logins Phase 0b): the
 * `db` proxy switches to a limited LOGIN role inside withViewer, row level
 * security filters what it reads, and `systemDb` stays admin.
 *
 * Self-contained: it creates the viewer roles (ensureViewerRoles) and one
 * probe table with a policy in its own schema (so the access-matrix test's
 * grant reset in public never touches it), and drops the schema after. The roles stay: they
 * are cluster objects, and migrate owns them. Gated on a throwaway database:
 *   MANTLE_TEST_DATABASE_URL=postgres://postgres:…@host:port/db \
 *     pnpm vitest run packages/db/src/viewer.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
/** Postgres SQLSTATE for "permission denied" (drizzle wraps it in `cause`). */
const INSUFFICIENT_PRIVILEGE = '42501';

describe.skipIf(!URL)('viewer pools on Postgres', () => {
  type DbModule = typeof import('./index');
  let m: DbModule;
  let sqlTag: typeof import('drizzle-orm').sql;

  const probe = async (handle: DbModule['db']) =>
    (
      (await handle.execute(
        sqlTag`select id from viewer_test.viewer_probe order by id`,
      )) as unknown as {
        id: number;
      }[]
    ).map((r) => r.id);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    // ONE key for every viewer DB test: roles are cluster-wide, so tests with
    // different keys running at once reset each other's passwords (28P01).
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    const postgres = (await import('postgres')).default;
    const { ensureViewerRoles } = await import('./viewer-roles');
    const admin = postgres(URL!, { max: 1 });
    try {
      await ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
      await admin.unsafe(`
        create schema if not exists viewer_test;
        grant usage on schema viewer_test to mantle_view_team, mantle_view_client, mantle_view_public;
        set search_path = viewer_test;
        drop table if exists viewer_probe;
        create table viewer_probe (id int primary key, audience text not null);
        insert into viewer_probe values (1,'admin'),(2,'team'),(3,'client'),(4,'public');
        alter table viewer_probe enable row level security;
        create policy viewer_probe_read on viewer_probe for select
          to mantle_view_team, mantle_view_client, mantle_view_public
          using (audience = any (case current_user
            when 'mantle_view_team' then array['team','client','public']
            when 'mantle_view_client' then array['client','public']
            when 'mantle_view_public' then array['public']
            else array[]::text[] end));
        grant select on viewer_probe to mantle_view_team, mantle_view_client, mantle_view_public;
      `);
    } finally {
      await admin.end();
    }
    m = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
  });

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`drop schema if exists viewer_test cascade`);
    await m.closeDb();
  });

  it('outside a viewer scope, db is the admin pool and sees every row', async () => {
    expect(await probe(m.db)).toEqual([1, 2, 3, 4]);
  });

  it('inside withViewer, row level security filters by level', async () => {
    expect(await m.withViewer('team', () => probe(m.db))).toEqual([2, 3, 4]);
    expect(await m.withViewer('client', () => probe(m.db))).toEqual([3, 4]);
    expect(await m.withViewer('public', () => probe(m.db))).toEqual([4]);
  });

  it('really is the limited role, not a role switch on the admin session', async () => {
    const who = await m.withViewer(
      'team',
      async () =>
        (await m.db.execute(sqlTag`select session_user as s, current_user as c`)) as unknown as {
          s: string;
          c: string;
        }[],
    );
    expect(who[0]).toEqual({ s: 'mantle_view_team', c: 'mantle_view_team' });
    // And it cannot climb out.
    await expect(
      m.withViewer('team', () => m.db.execute(sqlTag`set role postgres`)),
    ).rejects.toThrow();
  });

  it('systemDb ignores the viewer (infrastructure writes)', async () => {
    expect(await m.withViewer('public', () => probe(m.systemDb))).toEqual([1, 2, 3, 4]);
  });

  it('a transaction opened inside the scope is filtered too', async () => {
    const ids = await m.withViewer('client', () =>
      m.db.transaction(async (tx) =>
        (
          (await tx.execute(
            sqlTag`select id from viewer_test.viewer_probe order by id`,
          )) as unknown as {
            id: number;
          }[]
        ).map((r) => r.id),
      ),
    );
    expect(ids).toEqual([3, 4]);
  });

  it('a limited role has no write grant: writes fail loudly', async () => {
    await expect(
      m.withViewer('team', () =>
        m.db.execute(sqlTag`insert into viewer_test.viewer_probe values (9, 'team')`),
      ),
    ).rejects.toMatchObject({ cause: { code: INSUFFICIENT_PRIVILEGE } });
  });

  it('a table the grant matrix does not name is an error, not an empty result', async () => {
    await expect(
      m.withViewer('team', () => m.db.execute(sqlTag`select 1 from pg_catalog.pg_authid`)),
    ).rejects.toMatchObject({ cause: { code: INSUFFICIENT_PRIVILEGE } });
  });
});
