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
  readFor,
  ruleFor,
} from './access-matrix';
import type { LimitedLevel } from './viewer';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const ROLES = ['mantle_view_team', 'mantle_view_client', 'mantle_view_public'];
const LEVELS: LimitedLevel[] = ['team', 'client', 'public'];

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

  // Per role (client logins C1): the client role differs from the others.
  it.each(LEVELS)(
    'mantle_view_%s holds exactly its matrix: SELECT only, named columns only',
    async (level) => {
      const live = await liveGrants(`mantle_view_${level}`);
      expect(live.other, 'no write privilege of any kind').toBe(0);
      const whole = ACCESS_MATRIX.filter((t) => readFor(t, level) === 'all').map((t) => t.table);
      expect(live.tables).toEqual([...whole].sort());
      for (const t of ACCESS_MATRIX) {
        const read = readFor(t, level);
        if (!Array.isArray(read)) continue;
        const cols = live.cols.filter((c) => c.t === t.table).map((c) => c.c);
        expect(cols.sort(), t.table).toEqual([...read].sort());
      }
      // Tables the role may not read carry no column grant either.
      for (const t of ACCESS_MATRIX.filter((x) => readFor(x, level) === 'none')) {
        expect(
          live.cols.filter((c) => c.t === t.table),
          `${t.table} columns`,
        ).toEqual([]);
      }
    },
  );

  // Facts about the client role read straight from Postgres and written out
  // here, not derived from ACCESS_MATRIX (client logins audit A31): the test
  // above compares the live grants with the matrix, so a matrix edit that
  // grants the client role auth.users passes it. This one does not.
  it('the client role: fixed facts, whatever the matrix says', async () => {
    const role = 'mantle_view_client';
    const holds = async (q: ReturnType<typeof sql>) =>
      ((await q) as unknown as { ok: boolean }[])[0]!.ok;
    // Nothing of a login, a link, a trace, a team message, an ack or a secret.
    for (const t of [
      'auth.users',
      'public.shares',
      'public.traces',
      'public.trace_steps',
      'public.team_messages',
      'public.client_report_acks',
      'public.client_signin_codes',
      'public.member_invites',
      'public.mobile_tokens',
      'public.oauth_access_tokens',
      'public.api_keys',
      'public.secrets',
      'public.emails',
      'public.assistant_messages',
      'public.space_uploads',
    ]) {
      expect(
        await holds(sql`select has_any_column_privilege(${role}, ${t}, 'SELECT') as ok`),
        `${t}: no SELECT on the table or any column`,
      ).toBe(false);
    }
    // Content with drafts: named columns only, never a draft column.
    const drafts: Record<string, string[]> = {
      'public.pages': ['draft_doc', 'draft_updated_at', 'draft_rev'],
      'public.draws': ['draft_scene', 'draft_updated_at', 'draft_rev'],
      'public.tables': ['draft_data', 'draft_updated_at', 'draft_rev'],
    };
    for (const [t, cols] of Object.entries(drafts)) {
      expect(
        await holds(sql`select has_table_privilege(${role}, ${t}, 'SELECT') as ok`),
        `${t}: no whole-table SELECT`,
      ).toBe(false);
      expect(
        await holds(sql`select has_column_privilege(${role}, ${t}, 'node_id', 'SELECT') as ok`),
        `${t}.node_id`,
      ).toBe(true);
      for (const c of cols) {
        expect(
          await holds(sql`select has_column_privilege(${role}, ${t}, ${c}, 'SELECT') as ok`),
          `${t}.${c}`,
        ).toBe(false);
      }
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

  it('level-rows tables: RLS on, the client role filtered by level, the others all rows', async () => {
    for (const t of ACCESS_MATRIX.filter((x) =>
      LEVELS.some((l) => ruleFor(x, l) === 'level-rows'),
    )) {
      const [schema, name] = t.table.split('.');
      const [rls] = await sql<{ on: boolean }[]>`
        select relrowsecurity as on from pg_class
        where relname = ${name!} and relnamespace = ${schema!}::regnamespace`;
      expect(rls?.on, `${t.table} row level security`).toBe(true);
      const policies = await sql<{ roles: string[]; qual: string }[]>`
        select roles, qual from pg_policies where schemaname = ${schema!} and tablename = ${name!}
          and cmd = 'SELECT'`;
      for (const level of LEVELS) {
        const mine = policies.filter((p) => p.roles.includes(`mantle_view_${level}`));
        expect(mine.length, `${t.table} policy for ${level}`).toBe(1);
        if (ruleFor(t, level) === 'level-rows') expect(mine[0]!.qual).toMatch(/audience/);
        else expect(mine[0]!.qual, `${t.table} ${level}`).toBe('true');
      }
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
      // The client role reads a team-drafts table only where the matrix
      // names its own rule for it (the client thread on node_comments, 0194).
      expect(covered.has('mantle_view_client'), t.table).toBe(
        ruleFor(t, 'client') !== 'team-drafts',
      );
      expect(covered.has('mantle_view_public'), t.table).toBe(false);
    }
  });

  it('the client thread is the only comment rule of the client role, and needs the human flag', async () => {
    const tables = ACCESS_MATRIX.filter((t) => ruleFor(t, 'client') === 'client-thread');
    expect(tables.map((t) => t.table)).toEqual(['public.node_comments']);
    const rows = await sql<{ qual: string }[]>`
      select qual from pg_policies
       where schemaname = 'public' and tablename = 'node_comments' and cmd = 'SELECT'
         and 'mantle_view_client' = any(roles)`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qual).toContain('mantle.human');
    expect(rows[0]!.qual).toContain("'client'::text");
  });

  it('every filtered table has row level security on and a policy for each role', async () => {
    const filtered = ACCESS_MATRIX.filter(
      (t) =>
        t.rule !== 'none' &&
        t.rule !== 'all-rows' &&
        t.rule !== 'team-drafts' &&
        t.rule !== 'level-rows',
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
          insert into auth.users (id, email, password_hash, role)
          values (gen_random_uuid(), 'ceiling-test@example.invalid', 'x', 'admin') returning id`;
        await tx`insert into nodes (owner_id, type, title, path, audience)
                 values (${owner!.id}, 'journal', 'x', 'journal', 'team')`;
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
