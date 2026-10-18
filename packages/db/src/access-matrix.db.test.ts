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
  WRITE_ROLE_SYSTEM_ONLY,
  WRITE_ROLE_TABLES,
  applyViewerGrants,
  userReadFor,
  writeColumnsFor,
} from './access-matrix';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const USER_ROLE = 'mantle_view_user';
const WRITE_ROLE = 'mantle_write_user';
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

  it('mantle_write_user reads exactly what mantle_view_user reads, and writes only the write tables', async () => {
    const view = await liveGrants(USER_ROLE);
    const write = await liveGrants(WRITE_ROLE);
    expect(write.tables).toEqual(view.tables);
    expect(write.cols).toEqual(view.cols);
    const privs = await sql<{ t: string; p: string }[]>`
      select table_schema || '.' || table_name as t, privilege_type as p
        from information_schema.role_table_grants
       where grantee = ${WRITE_ROLE} and privilege_type <> 'SELECT'
         and table_schema in ('public', 'auth') order by 1, 2`;
    // DELETE on every write table; INSERT and UPDATE on the whole table
    // where the role reads it whole and derives nothing, else on exactly the
    // columns it reads less the derived ones (writeColumnsFor).
    expect(privs.map((r) => `${r.t} ${r.p}`)).toEqual(
      ACCESS_MATRIX.filter((t) => WRITE_ROLE_TABLES.includes(t.table))
        .map((t) => t.table)
        .sort()
        .flatMap((t) => {
          const whole = writeColumnsFor(ACCESS_MATRIX.find((x) => x.table === t)!) === 'all';
          return whole ? [`${t} DELETE`, `${t} INSERT`, `${t} UPDATE`] : [`${t} DELETE`];
        }),
    );
    for (const t of ACCESS_MATRIX.filter((x) => WRITE_ROLE_TABLES.includes(x.table))) {
      const write = writeColumnsFor(t);
      if (!Array.isArray(write)) continue;
      for (const priv of ['INSERT', 'UPDATE']) {
        const cols = await sql<{ c: string }[]>`
          select column_name as c from information_schema.column_privileges
           where grantee = ${WRITE_ROLE} and privilege_type = ${priv}
             and table_schema || '.' || table_name = ${t.table} order by 1`;
        expect(cols.map((c) => c.c).sort(), `${t.table} ${priv}`).toEqual([...write].sort());
      }
    }
    // A grant's attribution, bridge mark and folder are never the role's to
    // write (via_folder_id: the propagation triggers make the folder rows).
    for (const c of ['granted_by', 'granted_at', 'bridge', 'via_folder_id']) {
      const [r] = await sql<{ ok: boolean }[]>`
        select has_column_privilege(${WRITE_ROLE}, 'public.item_grants', ${c}, 'INSERT, UPDATE') as ok`;
      expect(r!.ok, `item_grants.${c}`).toBe(false);
    }
    // The content tables with no read rule: no right of any kind, column
    // rights included (node_embeds has row level security off).
    expect(WRITE_ROLE_SYSTEM_ONLY).toContain('public.node_embeds');
    for (const t of WRITE_ROLE_SYSTEM_ONLY) {
      const [r] = await sql<{ ok: boolean }[]>`
        select has_table_privilege(${WRITE_ROLE}, ${t},
                 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            or has_any_column_privilege(${WRITE_ROLE}, ${t}, 'SELECT, INSERT, UPDATE, REFERENCES')
            as ok`;
      expect(r!.ok, t).toBe(false);
    }
    // The role itself: a lock like the workspace role, with a smaller cap.
    const [attrs] = await sql<
      { rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean; rolconnlimit: number }[]
    >`select rolsuper, rolbypassrls, rolinherit, rolconnlimit from pg_roles where rolname = ${WRITE_ROLE}`;
    expect(attrs).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolinherit: false,
      rolconnlimit: 20,
    });
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
    // And the write role: a write right on a system-only table, a truncate.
    await sql.unsafe(`GRANT INSERT ON "public"."node_embeds" TO mantle_write_user`);
    await sql.unsafe(`GRANT TRUNCATE ON "public"."nodes" TO mantle_write_user`);
    await applyViewerGrants(sql);
    for (const [t, p] of [
      ['public.node_embeds', 'INSERT'],
      ['public.nodes', 'TRUNCATE'],
    ] as const) {
      const [r] = await sql<{ ok: boolean }[]>`
        select has_table_privilege('mantle_write_user', ${t}, ${p}) as ok`;
      expect(r!.ok, `${t} ${p}`).toBe(false);
    }
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

  it('profiles and app_table_exports: the write rules of plan v3 S3 (owner decision 2026-10-17)', async () => {
    // profiles: the write role writes its own row, or the brain's with the
    // Settings area; never every row in an Admin scope (the read rule's).
    const writes = await sql<{ cmd: string; qual: string | null; chk: string | null }[]>`
      select cmd, qual, with_check as chk from pg_policies
       where schemaname = 'public' and tablename = 'profiles'
         and 'mantle_write_user'::name = any(roles) and cmd <> 'SELECT' order by cmd`;
    expect(writes.map((w) => w.cmd)).toEqual(['DELETE', 'INSERT', 'UPDATE']);
    // Fix round 4: the write rule is written once, mantle_profile_writable
    // (profileRowWritable asks the same function).
    const [fn] = await sql<{ def: string }[]>`
      select pg_get_functiondef('public.mantle_profile_writable(uuid)'::regprocedure) as def`;
    for (const w of writes) {
      const rule = (w.cmd === 'INSERT' ? w.chk : w.qual) ?? '';
      expect(rule, w.cmd).not.toContain('mantle_scope_is_admin');
      // Fix round 3: a delete is the login's own row only.
      if (w.cmd === 'DELETE') {
        expect(rule, w.cmd).toContain('mantle_login_id');
        expect(rule, w.cmd).not.toContain('mantle_brain_id');
        expect(rule, w.cmd).not.toContain('mantle_scope_has_area');
        expect(rule, w.cmd).not.toContain('mantle_profile_writable');
        continue;
      }
      expect(rule, w.cmd).toBe('mantle_profile_writable(user_id)');
      if (w.cmd === 'UPDATE') expect(w.chk, w.cmd).toBe('mantle_profile_writable(user_id)');
    }
    // The body as written (pg_get_functiondef keeps its quoted names).
    expect(fn!.def).toContain('"public"."mantle_login_id"()');
    expect(fn!.def).toContain('"public"."mantle_brain_id"()');
    expect(fn!.def).toContain(`"public"."mantle_scope_has_area"('settings')`);
    expect(fn!.def).not.toContain('mantle_scope_is_admin');
    expect(fn!.def).not.toContain('SECURITY DEFINER');
    // The read rule's subquery names its column with the table (fix round 3).
    expect(
      (
        await sql<{ qual: string }[]>`
          select qual from pg_policies where schemaname = 'public'
             and tablename = 'app_table_exports' and cmd = 'SELECT'`
      )[0]?.qual,
    ).toContain('app_table_exports.app_node_id');
    // app_table_exports: row level security on, one read rule (manage of
    // the app), which the write role reads and writes by.
    const [rls] = await sql<{ on: boolean }[]>`
      select relrowsecurity as on from pg_class where oid = 'public.app_table_exports'::regclass`;
    expect(rls?.on).toBe(true);
    const reads = await sql<{ roles: string[]; qual: string }[]>`
      select roles::text[] as roles, qual from pg_policies
       where schemaname = 'public' and tablename = 'app_table_exports' and cmd = 'SELECT'`;
    expect(reads).toHaveLength(1);
    expect([...reads[0]!.roles].sort()).toEqual(['mantle_view_user', 'mantle_write_user']);
    // Fix round 4: manage of the app is mantle_may_manage_home (0279), the
    // one place its test is written (assertManageOrAdmin asks it too).
    expect(reads[0]!.qual).toContain('mantle_may_manage_home(a.home_ws)');
    // Both functions are the workspace role's and the write role's to run,
    // never PUBLIC's.
    const run = await sql<{ fn: string; pub: boolean; view: boolean; write: boolean }[]>`
      select f as fn,
             has_function_privilege('public', f::regprocedure, 'EXECUTE') as pub,
             has_function_privilege('mantle_view_user', f::regprocedure, 'EXECUTE') as view,
             has_function_privilege('mantle_write_user', f::regprocedure, 'EXECUTE') as write
        from unnest(array['public.mantle_may_manage_home(uuid)',
                          'public.mantle_profile_writable(uuid)']) f order by 1`;
    expect(run.map((r) => [r.fn, r.pub, r.view, r.write])).toEqual([
      ['public.mantle_may_manage_home(uuid)', false, true, true],
      ['public.mantle_profile_writable(uuid)', false, true, true],
    ]);
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
