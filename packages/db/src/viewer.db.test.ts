/**
 * The access adapter against a real Postgres (member logins Phase 0b; the
 * workspace role since W8c retired the level roles): the `db` proxy switches
 * to the workspace LOGIN role inside a workspace scope, row level security
 * filters what it reads by the scope's workspaces, and `systemDb` stays
 * admin.
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
const W1 = '00000000-0000-4000-8000-00000000f101';
const W2 = '00000000-0000-4000-8000-00000000f102';
const W3 = '00000000-0000-4000-8000-00000000f103';

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

  /** A turn scope reading `ws` (no lookup: the probe needs no workspace rows). */
  const inScope = <T>(ws: string[], fn: () => Promise<T>) =>
    m.withTurnScope({ kind: 'assistant', loginId: null, ws, modWs: [] }, async () => await fn());

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
        grant usage on schema viewer_test to mantle_view_user;
        set search_path = viewer_test;
        drop table if exists viewer_probe;
        create table viewer_probe (id int primary key, ws uuid not null);
        insert into viewer_probe values (1,'${W1}'),(2,'${W2}'),(3,'${W3}'),(4,'${W3}');
        alter table viewer_probe enable row level security;
        create policy viewer_probe_read on viewer_probe for select to mantle_view_user
          using (ws = any (coalesce(nullif(current_setting('mantle.ws', true), ''), '{}')::uuid[]));
        grant select on viewer_probe to mantle_view_user;
      `);
    } finally {
      await admin.end();
    }
    m = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`drop schema if exists viewer_test cascade`);
    await m.closeDb();
  });

  it('outside a viewer scope, db is the admin pool and sees every row', async () => {
    expect(await probe(m.db)).toEqual([1, 2, 3, 4]);
  });

  it("inside a workspace scope, row level security filters by the scope's workspaces", async () => {
    expect(await inScope([W1], () => probe(m.db))).toEqual([1]);
    expect(await inScope([W3], () => probe(m.db))).toEqual([3, 4]);
    expect(await inScope([W1, W2], () => probe(m.db))).toEqual([1, 2]);
  });

  it('really is the limited role, not a role switch on the admin session', async () => {
    const who = await inScope(
      [W1],
      async () =>
        (await m.db.execute(sqlTag`select session_user as s, current_user as c`)) as unknown as {
          s: string;
          c: string;
        }[],
    );
    expect(who[0]).toEqual({ s: 'mantle_view_user', c: 'mantle_view_user' });
    // And it cannot climb out.
    await expect(inScope([W1], () => m.db.execute(sqlTag`set role postgres`))).rejects.toThrow();
  });

  it('a retired level role cannot log in (W8c)', async () => {
    const rows = (await m.systemDb.execute(
      sqlTag`select rolname, rolcanlogin from pg_roles
              where rolname in ('mantle_view_team', 'mantle_view_client', 'mantle_view_public')
              order by rolname`,
    )) as unknown as { rolname: string; rolcanlogin: boolean }[];
    expect(rows).toEqual([
      { rolname: 'mantle_view_client', rolcanlogin: false },
      { rolname: 'mantle_view_public', rolcanlogin: false },
      { rolname: 'mantle_view_team', rolcanlogin: false },
    ]);
  });

  it('systemDb ignores the viewer (infrastructure writes)', async () => {
    expect(await inScope([W1], () => probe(m.systemDb))).toEqual([1, 2, 3, 4]);
  });

  it('a transaction opened inside the scope is filtered too', async () => {
    const ids = await inScope([W3], () =>
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
      inScope([W1], () =>
        m.db.execute(sqlTag`insert into viewer_test.viewer_probe values (9, ${W1})`),
      ),
    ).rejects.toMatchObject({ cause: { code: INSUFFICIENT_PRIVILEGE } });
  });

  it('a table the grant matrix does not name is an error, not an empty result', async () => {
    await expect(
      inScope([W1], () => m.db.execute(sqlTag`select 1 from pg_catalog.pg_authid`)),
    ).rejects.toMatchObject({ cause: { code: INSUFFICIENT_PRIVILEGE } });
  });
});
