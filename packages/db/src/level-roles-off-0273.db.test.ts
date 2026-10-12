/**
 * 0273 (workspaces W8c): the old pool roles lose their policies and rights,
 * the old per-login MCP switch goes after a check against its archive, and
 * the old-level functions nothing calls go. On a scratch database migrated
 * to just before it.
 *
 *  - a switch table that does not equal its archive raises and drops
 *    nothing; an archive row of a login that is gone is fine;
 *  - after it: no policy and no right of mantle_view_team, _client, _public
 *    or _space, the workspace role's policies unchanged, the table and the
 *    dropped functions gone, mantle_workspace_kind and the switch
 *    functions kept (mantle_ws_reach_diff still runs), the level columns'
 *    data unchanged;
 *  - the retired client-responder agent is disabled, by slug, and kept
 *    (W8 integration); any other agent is left as it was;
 *  - re-runnable: a second run changes nothing.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/level-roles-off-0273.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TAG = '0273_workspaces_level_roles_off';
const OLD = ['mantle_view_team', 'mantle_view_client', 'mantle_view_public', 'mantle_view_space'];
const DROPPED = [
  'mantle_viewer_audiences',
  'mantle_item_team_reads',
  'mantle_space_id',
  'mantle_client_space',
  'mantle_client_request_node',
  'mantle_member_space_node',
  'mantle_mcp_login_access_frozen_trg',
];

describe.skipIf(!URL)('0273: the old pool roles lose their policies and rights', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const member = randomUUID();
  const gone = randomUUID();
  let userPoliciesBefore = '';
  let levelsBefore = '';

  const statements = () =>
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', `${TAG}.sql`),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter(Boolean);
  const run = async () => {
    await sql.begin(async (tx) => {
      for (const stmt of statements()) await tx.unsafe(stmt);
    });
  };
  const userPolicies = async () =>
    (
      await sql<{ p: string }[]>`
        select string_agg(tablename || '.' || policyname || ':' || coalesce(qual, '') || ':' ||
                          coalesce(with_check, ''), '|' order by tablename, policyname) as p
          from pg_policies where 'mantle_view_user' = any(roles)`
    )[0]!.p;
  const levels = async () =>
    createHash('sha256')
      .update(
        JSON.stringify(
          await sql`select id::text, audience, share_level, inherited_level, embedded_level
                      from nodes order by id`,
        ),
      )
      .digest('hex');
  const oldRights = async () =>
    (
      await sql<{ n: number }[]>`
        select ((select count(*) from information_schema.role_table_grants where grantee = any(${OLD}))
              + (select count(*) from information_schema.column_privileges where grantee = any(${OLD}))
              + (select count(*) from information_schema.routine_privileges where grantee = any(${OLD}))
              + (select count(*) from pg_namespace n, aclexplode(n.nspacl) a
                  where a.grantee::regrole::text = any(${OLD})))::int as n`
    )[0]!.n;
  const oldPolicies = async () =>
    (
      await sql<{ n: number }[]>`
        select count(*)::int as n from pg_policies p where p.roles && ${OLD}::name[]`
    )[0]!.n;
  const fn = async (name: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from pg_proc where proname = ${name}`)[0]!
      .n;

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, is_owner, role)
              values (${owner}, ${`o-${owner}@example.invalid`}, 'x', true, 'admin'),
                     (${member}, ${`m-${member}@example.invalid`}, 'x', false, 'member')`;
    // The retired client chat's agent and an operator's own responder.
    await sql`insert into agents (owner_id, slug, name, model, provider, system_prompt, role)
              values (${owner}, 'client-responder', 'Client', 'fake/model', 'local', 'x', 'responder'),
                     (${owner}, 'kept-responder', 'Kept', 'fake/model', 'local', 'x', 'responder')`;
    // The switch is frozen (0268); set the world up past the freeze.
    await sql`alter table mcp_login_access disable trigger mcp_login_access_frozen`;
    await sql`insert into mcp_login_access (login_id, enabled, write_enabled)
              values (${member}, true, false)`;
    await sql`alter table mcp_login_access enable trigger mcp_login_access_frozen`;
    // Archived as it is; and an archive row of a login that is gone.
    await sql`insert into archive_mcp_login_access (login_id, enabled, write_enabled, updated_at)
              values (${member}, true, false, now()), (${gone}, true, true, now())
              on conflict (login_id) do nothing`;
    expect(await oldPolicies()).toBeGreaterThan(0);
    userPoliciesBefore = await userPolicies();
    levelsBefore = await levels();
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('refuses a switch table that does not equal its archive, and drops nothing', async () => {
    await sql`update archive_mcp_login_access set write_enabled = true where login_id = ${member}`;
    await expect(run()).rejects.toMatchObject({ code: '23514' });
    expect((await sql`select to_regclass('public.mcp_login_access') as t`)[0]!.t).not.toBeNull();
    expect(await oldPolicies()).toBeGreaterThan(0);
    await sql`update archive_mcp_login_access set write_enabled = false where login_id = ${member}`;
  });

  it('takes every policy and right of the old pool roles, and keeps the rest', async () => {
    await scratch.migrateRest();
    expect(await oldPolicies()).toBe(0);
    expect(await oldRights()).toBe(0);
    expect(await userPolicies()).toBe(userPoliciesBefore);
    expect((await sql`select to_regclass('public.mcp_login_access') as t`)[0]!.t).toBeNull();
    // The archive keeps every row, the gone login's included.
    expect(
      (
        await sql<{ n: number }[]>`select count(*)::int as n from archive_mcp_login_access
                                   where login_id in (${member}, ${gone})`
      )[0]!.n,
    ).toBe(2);
    for (const name of DROPPED) expect(await fn(name), name).toBe(0);
    for (const name of [
      'mantle_workspace_kind',
      'mantle_team_reads',
      'mantle_ws_migrate_locked',
      'mantle_ws_switch_off',
      'mantle_ws_bridge_off',
      'mantle_bridge_upd_row_trg',
      'mantle_levels_frozen_trg',
      'mantle_tool_levels_frozen_trg',
    ]) {
      expect(await fn(name), name).toBe(1);
    }
    // The roles stay, without a login.
    expect(
      (
        await sql<{ n: number }[]>`select count(*)::int as n from pg_roles
                                   where rolname = any(${OLD}) and not rolcanlogin`
      )[0]!.n,
    ).toBe(4);
    expect(await levels()).toBe(levelsBefore);
  });

  const agentRows = () =>
    sql<{ slug: string; enabled: boolean; prompt: string }[]>`
      select slug, enabled, system_prompt as prompt from agents
       where owner_id = ${owner} order by slug`;

  it('W8 integration: disables the retired client-responder, deletes nothing, leaves the rest', async () => {
    expect(await agentRows()).toEqual([
      { slug: 'client-responder', enabled: false, prompt: 'x' },
      { slug: 'kept-responder', enabled: true, prompt: 'x' },
    ]);
  });

  it('leaves the switch proof working', async () => {
    const rows = await sql`select * from mantle_ws_reach_diff()`;
    expect(Array.isArray(rows)).toBe(true);
  });

  it('is re-runnable: a second run changes nothing', async () => {
    const before = [await userPolicies(), await oldRights(), await levels(), await agentRows()];
    await run();
    expect([await userPolicies(), await oldRights(), await levels(), await agentRows()]).toEqual(
      before,
    );
    expect(await oldPolicies()).toBe(0);
  });
});
