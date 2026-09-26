/**
 * The live grants equal the access matrix (member logins Phase 0b). Runs
 * against a MIGRATED database (CI's build-check provisions one; locally point
 * MANTLE_TEST_DATABASE_URL at any database `migrate` just ran on):
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/access-matrix.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  ACCESS_MATRIX,
  WORKSPACE_NODE_TYPES,
  applyViewerGrants,
  type TableAccess,
} from './access-matrix';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const ROLES = ['mantle_view_team', 'mantle_view_client', 'mantle_view_public'];

describe.skipIf(!URL)('access matrix on the migrated database', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = postgres(URL!, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await applyViewerGrants(sql);
    await sql.end();
  });

  async function liveGrants(role: string) {
    const tables = await sql<{ t: string }[]>`
      select table_schema || '.' || table_name as t from information_schema.role_table_grants
      where grantee = ${role} and privilege_type = 'SELECT'
        and table_schema in ('public', 'auth') order by 1`;
    const cols = await sql<{ t: string; c: string }[]>`
      select table_schema || '.' || table_name as t, column_name as c
      from information_schema.column_privileges
      where grantee = ${role} and privilege_type = 'SELECT'
        and table_schema in ('public', 'auth') order by 1, 2`;
    const other = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
      where grantee = ${role} and privilege_type <> 'SELECT'
        and table_schema in ('public', 'auth')`;
    return { tables: tables.map((r) => r.t), cols, other: other[0]!.n };
  }

  const wholeTables = ACCESS_MATRIX.filter((t) => t.read === 'all').map((t) => t.table);
  const columnTables = ACCESS_MATRIX.filter((t): t is TableAccess & { read: readonly string[] } =>
    Array.isArray(t.read),
  );

  it.each(ROLES)('%s holds exactly the matrix: SELECT only, named columns only', async (role) => {
    const live = await liveGrants(role);
    expect(live.other, 'no write privilege of any kind').toBe(0);
    expect(live.tables).toEqual([...wholeTables].sort());
    for (const t of columnTables) {
      const cols = live.cols.filter((c) => c.t === t.table).map((c) => c.c);
      expect(cols.sort(), t.table).toEqual([...t.read].sort());
    }
  });

  it('re-applying heals drift: extra tables and columns are revoked', async () => {
    await sql.unsafe(`GRANT SELECT ON "public"."secrets" TO mantle_view_team`);
    await sql.unsafe(`GRANT SELECT ("draft_doc") ON "public"."pages" TO mantle_view_team`);
    await applyViewerGrants(sql);
    const live = await liveGrants('mantle_view_team');
    expect(live.tables).not.toContain('public.secrets');
    expect(live.cols.filter((c) => c.t === 'public.pages').map((c) => c.c)).not.toContain(
      'draft_doc',
    );
  });

  it('the personal-space role holds exactly its tables, and only those', async () => {
    const wanted = ACCESS_MATRIX.filter((t) => (t.space ?? 'none') === 'write')
      .map((t) => t.table)
      .sort();
    const rows = await sql<{ t: string; p: string }[]>`
      select table_schema || '.' || table_name as t, privilege_type as p
      from information_schema.role_table_grants
      where grantee = 'mantle_view_space' and table_schema in ('public', 'auth')`;
    const tables = [...new Set(rows.map((r) => r.t))].sort();
    expect(tables).toEqual(wanted);
    for (const t of wanted) {
      const privs = rows
        .filter((r) => r.t === t)
        .map((r) => r.p)
        .sort();
      expect(privs, t).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    }
  });

  it('every space table has row level security on and a rule for the space role', async () => {
    for (const t of ACCESS_MATRIX.filter((x) => (x.space ?? 'none') === 'write')) {
      const [schema, name] = t.table.split('.');
      const [rls] = await sql<{ on: boolean }[]>`
        select relrowsecurity as on from pg_class
        where relname = ${name!} and relnamespace = ${schema!}::regnamespace`;
      expect(rls?.on, `${t.table} row level security`).toBe(true);
      const cmds = await sql<{ cmd: string }[]>`
        select cmd from pg_policies where schemaname = ${schema!} and tablename = ${name!}
          and 'mantle_view_space' = any(roles)`;
      expect(
        cmds.map((c) => c.cmd),
        t.table,
      ).toContain('SELECT');
    }
  });

  it('team drafts are the team role only: client and public have no rule', async () => {
    for (const t of ACCESS_MATRIX.filter((x) => x.rule === 'team-drafts')) {
      const [schema, name] = t.table.split('.');
      const policies = await sql<{ roles: string[] }[]>`
        select roles from pg_policies where schemaname = ${schema!} and tablename = ${name!}
          and cmd = 'SELECT'`;
      const covered = new Set(policies.flatMap((p) => p.roles));
      expect(covered.has('mantle_view_team'), t.table).toBe(true);
      expect(covered.has('mantle_view_client'), t.table).toBe(false);
      expect(covered.has('mantle_view_public'), t.table).toBe(false);
    }
  });

  it('every filtered table has row level security on and a policy for each role', async () => {
    const filtered = ACCESS_MATRIX.filter(
      (t) => t.rule !== 'none' && t.rule !== 'all-rows' && t.rule !== 'team-drafts',
    );
    for (const t of filtered) {
      const [schema, name] = t.table.split('.');
      const [rls] = await sql<{ on: boolean }[]>`
        select relrowsecurity as on from pg_class
        where relname = ${name!} and relnamespace = ${schema!}::regnamespace`;
      expect(rls?.on, `${t.table} row level security`).toBe(true);
      const policies = await sql<{ roles: string[] }[]>`
        select roles from pg_policies where schemaname = ${schema!} and tablename = ${name!}
          and cmd = 'SELECT'`;
      const covered = new Set(policies.flatMap((p) => p.roles));
      for (const role of ROLES)
        expect(covered.has(role), `${t.table} policy for ${role}`).toBe(true);
    }
  });

  it('the workspace kinds agree between SQL and TS', async () => {
    const rows = await sql<{ t: string; ok: boolean }[]>`
      select t::text as t, mantle_workspace_kind(t) as ok
      from unnest(enum_range(null::node_type)) as t`;
    const sqlKinds = rows
      .filter((r) => r.ok)
      .map((r) => r.t)
      .sort();
    expect(sqlKinds).toEqual([...WORKSPACE_NODE_TYPES].sort());
  });

  it('the type ceiling holds: a journal entry can never go below admin', async () => {
    await expect(
      sql.begin(async (tx) => {
        // A throwaway login, so the test also runs on an empty database. The
        // failing insert rolls the whole transaction back.
        const [owner] = await tx<{ id: string }[]>`
          insert into auth.users (id, email, password_hash)
          values (gen_random_uuid(), 'ceiling-test@example.invalid', 'x') returning id`;
        await tx`insert into nodes (owner_id, type, title, path, audience)
                 values (${owner!.id}, 'journal', 'x', 'journal', 'team')`;
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
