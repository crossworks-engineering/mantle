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
  userReadFor,
} from './access-matrix';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const USER_ROLE = 'mantle_view_user';
/** Retired in W6b (space) and W8c (the level roles): no grant, no policy. */
const RETIRED = [
  'mantle_view_team',
  'mantle_view_client',
  'mantle_view_public',
  'mantle_view_space',
];
/** Configuration every scope reads whole, by design (no per-row secrecy):
 *  no row rule of the workspace role needed. */
const EVERY_ROW = [
  'public.tools',
  'public.skills',
  'public.embedding_config',
  'public.ai_workers',
  'auth.users',
];

describe.skipIf(!URL)('access matrix on the migrated database', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = postgres(URL!, { max: 1, onnotice: () => {} });
  }, 60_000);
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

  it('mantle_view_user holds exactly its matrix: SELECT only, named columns only', async () => {
    const live = await liveGrants(USER_ROLE);
    expect(live.other, 'no write privilege of any kind').toBe(0);
    const whole = ACCESS_MATRIX.filter((t) => userReadFor(t) === 'all').map((t) => t.table);
    expect(live.tables).toEqual([...whole].sort());
    for (const t of ACCESS_MATRIX) {
      const read = userReadFor(t);
      if (!Array.isArray(read)) continue;
      const cols = live.cols.filter((c) => c.t === t.table).map((c) => c.c);
      expect(cols.sort(), t.table).toEqual([...read].sort());
    }
    // Tables the role may not read carry no column grant either.
    for (const t of ACCESS_MATRIX.filter((x) => userReadFor(x) === 'none')) {
      expect(
        live.cols.filter((c) => c.t === t.table),
        `${t.table} columns`,
      ).toEqual([]);
    }
  });

  it.each(RETIRED)(
    '%s holds no table, column or routine grant, no schema right and no policy (W8c)',
    async (role) => {
      const [g] = await sql<{ tables: number; cols: number; routines: number; schemas: number }[]>`
        select
          (select count(*)::int from information_schema.role_table_grants
            where grantee = ${role} and table_schema in ('public', 'auth')) as tables,
          (select count(*)::int from information_schema.column_privileges
            where grantee = ${role} and table_schema in ('public', 'auth')) as cols,
          (select count(*)::int from information_schema.routine_privileges
            where grantee = ${role} and routine_schema in ('public', 'auth')) as routines,
          (select count(*)::int from pg_namespace n, aclexplode(n.nspacl) a
            where n.nspname in ('public', 'auth') and a.grantee = ${role}::regrole::oid) as schemas`;
      expect(g).toEqual({ tables: 0, cols: 0, routines: 0, schemas: 0 });
      const policies = await sql<{ t: string }[]>`
        select schemaname || '.' || tablename || '.' || policyname as t from pg_policies
         where ${role} = any(roles)`;
      expect(policies.map((p) => p.t)).toEqual([]);
      // And it cannot log in (ensureViewerRoles, every migrate).
      const [attrs] = await sql<{ rolcanlogin: boolean }[]>`
        select rolcanlogin from pg_roles where rolname = ${role}`;
      expect(attrs?.rolcanlogin).toBe(false);
    },
  );

  // Facts about the workspace role read straight from Postgres and written
  // out here, not derived from ACCESS_MATRIX (as the client role's were,
  // client logins audit A31): a matrix edit that grants a secret passes the
  // test above. This one does not.
  it('the workspace role: fixed facts, whatever the matrix says', async () => {
    const role = USER_ROLE;
    const holds = async (q: ReturnType<typeof sql>) =>
      ((await q) as unknown as { ok: boolean }[])[0]!.ok;
    // Nothing of a credential, an invite, a token or a secret.
    for (const t of [
      'public.member_invites',
      'public.mobile_tokens',
      'public.oauth_access_tokens',
      'public.api_keys',
      'public.access_keys',
      'public.secrets',
      'public.email_accounts',
      'public.space_uploads',
    ]) {
      expect(
        await holds(sql`select has_any_column_privilege(${role}, ${t}, 'SELECT') as ok`),
        `${t}: no SELECT on the table or any column`,
      ).toBe(false);
    }
    // A login's secrets never, whatever else of the row is read.
    for (const c of ['password_hash', 'email']) {
      expect(
        await holds(sql`select has_column_privilege(${role}, 'auth.users', ${c}, 'SELECT') as ok`),
        `auth.users.${c}`,
      ).toBe(false);
    }
    // Content with drafts: named columns only, never the whole table.
    for (const t of ['public.pages', 'public.draws', 'public.tables']) {
      expect(
        await holds(sql`select has_table_privilege(${role}, ${t}, 'SELECT') as ok`),
        `${t}: no whole-table SELECT`,
      ).toBe(false);
      expect(
        await holds(sql`select has_column_privilege(${role}, ${t}, 'node_id', 'SELECT') as ok`),
        `${t}.node_id`,
      ).toBe(true);
    }
    // Items: readable, but only through a row rule that is not "every row".
    expect(
      await holds(sql`select has_table_privilege(${role}, 'public.nodes', 'SELECT') as ok`),
    ).toBe(true);
    for (const priv of ['INSERT', 'UPDATE', 'DELETE']) {
      expect(
        await holds(sql`select has_table_privilege(${role}, 'public.nodes', ${priv}) as ok`),
        `nodes ${priv}`,
      ).toBe(false);
    }
    const [rls] = await sql<{ on: boolean; force: boolean }[]>`
      select relrowsecurity as on, relforcerowsecurity as force from pg_class
       where oid = 'public.nodes'::regclass`;
    expect(rls?.on).toBe(true);
    const nodePolicies = await sql<{ qual: string }[]>`
      select qual from pg_policies where schemaname = 'public' and tablename = 'nodes'
        and cmd = 'SELECT' and ${role} = any(roles)`;
    expect(nodePolicies.length).toBeGreaterThan(0);
    for (const p of nodePolicies) expect(p.qual).not.toBe('true');
    // The role itself: no superuser, no bypass of row security, no inherit.
    const [attrs] = await sql<{ rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean }[]>`
      select rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = ${role}`;
    expect(attrs).toEqual({ rolsuper: false, rolbypassrls: false, rolinherit: false });
  });

  it('re-applying heals drift: extra tables and columns are revoked', async () => {
    await sql.unsafe(`GRANT SELECT ON "public"."secrets" TO mantle_view_user`);
    await sql.unsafe(`GRANT SELECT ("email") ON "auth"."users" TO mantle_view_user`);
    // An old migration's grant to a retired role, as on a fresh install.
    await sql.unsafe(`GRANT SELECT ON "public"."nodes" TO mantle_view_team`);
    await applyViewerGrants(sql);
    const live = await liveGrants(USER_ROLE);
    expect(live.tables).not.toContain('public.secrets');
    expect(live.cols.filter((c) => c.t === 'auth.users').map((c) => c.c)).not.toContain('email');
    expect((await liveGrants('mantle_view_team')).tables).toEqual([]);
  });

  it('every table the workspace role reads has row level security and a rule for it (W6a fix H2)', async () => {
    // A table read whole by design (EVERY_ROW: settings and catalogs) needs
    // no rule; every other table the workspace role (mantle_view_user) may
    // SELECT is filtered by a policy of its own.
    const missing: string[] = [];
    for (const t of ACCESS_MATRIX) {
      if (userReadFor(t) === 'none' || (EVERY_ROW.includes(t.table) && !t.userRule)) continue;
      const [schema, name] = t.table.split('.');
      const [rls] = await sql<{ on: boolean }[]>`
        select relrowsecurity as on from pg_class
        where relname = ${name!} and relnamespace = ${schema!}::regnamespace`;
      if (rls?.on !== true) missing.push(`${t.table}: row level security off`);
      const policies = await sql<{ roles: string[] }[]>`
        select roles from pg_policies where schemaname = ${schema!} and tablename = ${name!}
          and cmd in ('SELECT', 'ALL')`;
      if (!policies.some((p) => p.roles.includes('mantle_view_user'))) {
        missing.push(`${t.table}: no rule for mantle_view_user`);
      }
    }
    expect(missing).toEqual([]);
    // The two the audit found (mail rows) are among them.
    for (const t of ['public.emails', 'public.email_attachments']) {
      const entry = ACCESS_MATRIX.find((e) => e.table === t)!;
      expect(userReadFor(entry), t).not.toBe('none');
    }
  });

  it('profiles: the workspace role has its own-login rule, and only it has a rule (W6a fix round 2, W8c)', async () => {
    const entry = ACCESS_MATRIX.find((e) => e.table === 'public.profiles')!;
    expect(entry.userRule).toBe('own-login');
    const policies = await sql<{ roles: string[]; qual: string }[]>`
      select roles, qual from pg_policies
       where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT'`;
    const user = policies.filter((p) => p.roles.includes('mantle_view_user'));
    expect(user).toHaveLength(1);
    expect(user[0]!.qual).toContain('mantle_login_id');
    expect(user[0]!.qual).toContain('mantle_brain_id');
    expect(user[0]!.qual).toContain('mantle_scope_is_admin');
    for (const role of RETIRED) {
      expect(
        policies.filter((p) => p.roles.includes(role)),
        role,
      ).toEqual([]);
    }
  });

  // Re-pinned in workspaces arch A1: the TS list is the registry's workspace
  // class, so it follows mantle_kind_class (0241). mantle_workspace_kind
  // (0159, the tier model's list) stays for unmigrated brains until A7.
  it('the workspace kinds agree between SQL and TS', async () => {
    const rows = await sql<{ t: string; ok: boolean }[]>`
      select t::text as t, mantle_kind_class(t) = 'workspace' as ok
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
          insert into auth.users (id, email, password_hash, role)
          values (gen_random_uuid(), 'ceiling-test@example.invalid', 'x', 'admin') returning id`;
        await tx`insert into nodes (owner_id, type, title, path, audience)
                 values (${owner!.id}, 'journal', 'x', 'journal', 'team')`;
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
