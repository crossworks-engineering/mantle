/**
 * The before-roll count of team apps Phase 2 (connector-level-report.ts) on
 * a real, migrated Postgres: an app that LOSES a connector tool (it had
 * External access, its connector sits above the run's level), an app that
 * OPENS one (no mark, its connector at the run's level: a write now), the
 * connectors below admin with their read and write tools, and ids and
 * numbers only (no title or slug in the output).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/connector-level-report.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the connector level report', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let report: typeof import('./connector-level-report');
  let ea: typeof import('./external-access');
  let sqlTag: typeof import('drizzle-orm').sql;
  const anchor = randomUUID();
  const tag = `clr-${randomUUID().slice(0, 8)}`;
  const appLose = randomUUID();
  const appOpen = randomUUID();
  const appClient = randomUUID();
  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    report = await import('./connector-level-report');
    ea = await import('./external-access');
    sqlTag = (await import('drizzle-orm')).sql;
    await exec(sqlTag`insert into auth.users (id, email, password_hash, role)
      values (${anchor}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`,
    );
    const h = (group: string, toolName: string) => ({ kind: 'mcp', group, toolName });
    const mark = (handler: object) =>
      JSON.stringify({
        confirmedReadOnlyAt: 't',
        by: { via: 'web' },
        handlerSig: ea.externalAccessHandlerSig(handler as never),
      });
    const binding = (svc: string) =>
      JSON.stringify({ service: svc, mcp: { url: 'https://mcp.example.invalid/mcp' } });
    await exec(sqlTag`
      insert into tools (owner_id, slug, name, description, handler, external_access) values
        (${anchor}, 'mcp_adm_q', 'n', 'd', ${JSON.stringify(h('mcp-adm', 'q'))}::jsonb, ${mark(h('mcp-adm', 'q'))}::jsonb),
        (${anchor}, 'mcp_team_q', 'n', 'd', ${JSON.stringify(h('mcp-team', 'q'))}::jsonb, ${mark(h('mcp-team', 'q'))}::jsonb),
        (${anchor}, 'mcp_team_w', 'n', 'd', ${JSON.stringify(h('mcp-team', 'w'))}::jsonb, null)`);
    await exec(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration) values
        (${anchor}, 'mcp-adm', ${`${tag} secret source`}, ARRAY['mcp_adm_q'], 'admin', true, ${binding('mcp-adm')}::jsonb),
        (${anchor}, 'mcp-team', ${`${tag} team source`}, ARRAY['mcp_team_q','mcp_team_w'], 'team', true, ${binding('mcp-team')}::jsonb)`);
    await exec(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${appLose}, ${anchor}, 'app', ${`${tag} losing app`}, 'apps', 'team'),
        (${appOpen}, ${anchor}, 'app', ${`${tag} opening app`}, 'apps', 'team'),
        (${appClient}, ${anchor}, 'app', ${`${tag} client app`}, 'apps', 'client')`);
    await exec(sqlTag`
      insert into apps (node_id, manifest) values
        (${appLose}, '{"toolSlugs":["mcp_adm_q"]}'::jsonb),
        (${appOpen}, '{"toolSlugs":["mcp_team_q","mcp_team_w"]}'::jsonb),
        (${appClient}, '{"toolSlugs":["mcp_team_q"]}'::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    await exec(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await exec(sqlTag`delete from tool_groups where owner_id = ${anchor}`);
    await exec(sqlTag`delete from tools where owner_id = ${anchor}`);
    await exec(sqlTag`delete from spaces where login_id = ${anchor}`);
    await exec(sqlTag`delete from auth.users where id = ${anchor}`);
    await m.closeDb();
  }, 60_000);

  it('counts what loses, what opens, and the open connectors, ids and numbers only', async () => {
    const r = await report.connectorLevelReport(anchor);
    const [admGroup] = (await exec(
      sqlTag`select id from tool_groups where owner_id = ${anchor} and slug = 'mcp-adm'`,
    )) as unknown as { id: string }[];
    const [teamGroup] = (await exec(
      sqlTag`select id from tool_groups where owner_id = ${anchor} and slug = 'mcp-team'`,
    )) as unknown as { id: string }[];
    const byApp = (id: string) => r.apps.filter((a) => a.appId === id);
    // The marked tool of an admin connector: a member could call it before.
    expect(byApp(appLose)).toEqual([
      { appId: appLose, runner: 'member', loses: [{ groupId: admGroup!.id, count: 1 }], opens: [] },
    ]);
    // The unmarked tool of a team connector: refused before, a write now.
    expect(byApp(appOpen)).toEqual([
      {
        appId: appOpen,
        runner: 'member',
        loses: [],
        opens: [{ groupId: teamGroup!.id, writes: 1 }],
      },
    ]);
    // A client app with a team connector's marked tool: allowed before,
    // refused now (client runs reach client connectors only).
    expect(byApp(appClient)).toEqual([
      {
        appId: appClient,
        runner: 'client',
        loses: [{ groupId: teamGroup!.id, count: 1 }],
        opens: [],
      },
    ]);
    expect(r.openGroups).toEqual([
      { groupId: teamGroup!.id, level: 'team', enabled: true, reads: 1, writes: 1 },
    ]);
    expect(r.totals).toEqual({
      appsLosing: 2,
      toolsLosing: 2,
      appsOpening: 1,
      openGroups: 1,
      openWriteTools: 1,
    });
    // No title, name or slug reaches the output.
    const text = JSON.stringify(r);
    expect(text).not.toContain(tag);
    expect(text).not.toContain('mcp-');
    expect(text).not.toContain('mcp_');
  });
});
