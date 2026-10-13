/**
 * The app list's MCP reach for an Admin user (listAppNavItems, `mcpReach`,
 * access matrix N9), on a real, migrated Postgres, in the Admin user's
 * request scope as the route runs it (fix round 1 of "Team is a normal
 * workspace", 0286):
 *
 *  - an app a shared workspace holds reaches someone, even a workspace the
 *    Admin user is not in (the scope holds Admin: mantle_ws_any_shared
 *    answers for it; the plain workspaces row rule would not);
 *  - an app only Admin holds, or only a private or Former user workspace,
 *    reaches nobody (the one meaning of shared);
 *  - MCP off, or no green published build: no reach.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-nav-reach.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the app list MCP reach, in an Admin user scope', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let nav: typeof import('./app-nav');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `navreach-${randomUUID().slice(0, 8)}`;
  // A brain of this test's own (test files run in parallel).
  const anchor = randomUUID();
  const member = randomUUID();
  const ws = {
    admin: randomUUID(),
    team: randomUUID(),
    field: randomUUID(),
    priv: randomUUID(),
    gone: randomUUID(),
  };
  const ids = {
    team: randomUUID(),
    field: randomUUID(),
    admin: randomUUID(),
    priv: randomUUID(),
    gone: randomUUID(),
    mcpOff: randomUUID(),
    unpublished: randomUUID(),
  };
  const green = JSON.stringify({
    storageKey: 'apps/x.js',
    sha256: 'x',
    builtAt: '2026-10-13T00:00:00Z',
    esbuildVersion: '0',
    bytes: 1,
    ok: true,
  });

  const grant = (node: string, wsId: string, home = false) =>
    m.withHeads([node], 'update', (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${node}, ${wsId}, false, ${home})`),
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    // ONE key for every viewer DB test: roles are cluster-wide (28P01).
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    nav = await import('./app-nav');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);

    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${anchor}, ${`${tag}-admin@example.invalid`}, 'x', 'admin'),
        (${member}, ${`${tag}-mem@example.invalid`}, 'x', 'member')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`);
    await m.systemDb.execute(sqlTag`
      insert into workspaces (id, owner_id, name, is_admin, bridge_key) values
        (${ws.admin}, ${anchor}, ${`${tag} Admin`}, true, 'admin'),
        (${ws.team}, ${anchor}, ${`${tag} Team`}, false, null),
        (${ws.field}, ${anchor}, ${`${tag} Field`}, false, null),
        (${ws.priv}, ${anchor}, ${`${tag} Private`}, false, null),
        (${ws.gone}, ${anchor}, ${`${tag} Former user`}, false, null)`);
    await m.systemDb.execute(sqlTag`
      insert into private_workspaces (login_id, workspace_id) values (${member}, ${ws.priv})`);
    await m.systemDb.execute(sqlTag`
      insert into former_user_workspaces (former_key, workspace_id)
      values (${randomUUID()}, ${ws.gone})`);
    // The Admin user is in Admin and Team, not in Field.
    await m.systemDb.execute(sqlTag`
      insert into workspace_users (workspace_id, login_id, moderator) values
        (${ws.admin}, ${anchor}, true), (${ws.team}, ${anchor}, false)`);
    for (const [key, id] of Object.entries(ids)) {
      await m.systemDb.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, audience)
        values (${id}, ${anchor}, 'app', ${`${tag} ${key}`}, 'apps', 'admin')`);
      await m.systemDb.execute(sqlTag`
        insert into apps (node_id, source, published_build, mcp_access)
        values (${id}, '{}'::jsonb, ${key === 'unpublished' ? null : green}::jsonb,
                ${key !== 'mcpOff'})`);
      await grant(id, ws.admin, true);
    }
    await grant(ids.team, ws.team);
    await grant(ids.field, ws.field);
    await grant(ids.priv, ws.priv);
    await grant(ids.gone, ws.gone);
    await grant(ids.mcpOff, ws.field);
    await grant(ids.unpublished, ws.field);
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`
      delete from item_grants where node_id in (select id from nodes where owner_id = ${anchor})`);
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`delete from workspaces where owner_id = ${anchor}`);
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${anchor}, ${member})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${anchor}, ${member})`);
    await m.closeDb();
  }, 60_000);

  const reachOf = (items: Awaited<ReturnType<typeof nav.listAppNavItems>>) =>
    Object.fromEntries(
      items.map((a) => [Object.entries(ids).find(([, id]) => id === a.id)![0], a.mcpReach]),
    );

  it('reports the reach of an app held by a workspace the Admin user is not in', async () => {
    const items = await m.withScope(
      { kind: 'user', loginId: anchor, ws: [ws.admin, ws.team], modWs: [ws.admin] },
      () => nav.listAppNavItems(anchor),
    );
    expect(reachOf(items)).toEqual({
      team: true,
      field: true,
      admin: false,
      priv: false,
      gone: false,
      mcpOff: false,
      unpublished: false,
    });
  });

  it('the system pool answers the same', async () => {
    expect(reachOf(await nav.listAppNavItems(anchor))).toMatchObject({
      team: true,
      field: true,
      admin: false,
      priv: false,
      gone: false,
    });
  });

  it('a scope without Admin names only its own workspaces (no reach told beyond them)', async () => {
    const items = await m.withScope(
      { kind: 'user', loginId: member, ws: [ws.team], modWs: [] },
      () => nav.listAppNavItems(anchor),
    );
    // Row security shows the member the apps Team holds only.
    expect(reachOf(items)).toEqual({ team: true });
  });
});
