/**
 * The app list's MCP reach for an Admin user (listAppNavItems, `mcpReach`,
 * access matrix N9), on a real, migrated Postgres, in the Admin user's
 * request scope as the route runs it (fix round 1 of "Team is a normal
 * workspace", 0286):
 *
 *  - an app a live workspace beyond Admin holds reaches someone, even a
 *    workspace the Admin user is not in (the scope holds Admin:
 *    mantle_ws_any_holder answers for it; the plain workspaces row rule
 *    would not);
 *  - a private or Former user workspace holds too (fix round 2, M1): the
 *    member's MCP reaches an app their private workspace holds
 *    (memberReachSql), so the pill says so; over-reporting is the safe side;
 *  - an app only Admin holds, or only an archived workspace, reaches nobody;
 *  - MCP off, or no green published build: no reach.
 *
 * On a scratch database of its own: the class of a workspace counts this
 * brain's only (mantle_brain_id, the anchor here).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-nav-reach.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the app list MCP reach, in an Admin user scope', () => {
  type Db = typeof import('@mantle/db');
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: Db;
  let nav: typeof import('./app-nav');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `navreach-${randomUUID().slice(0, 8)}`;
  // The brain of this test's scratch database.
  const anchor = randomUUID();
  const member = randomUUID();
  const ws = {
    admin: randomUUID(),
    team: randomUUID(),
    field: randomUUID(),
    priv: randomUUID(),
    gone: randomUUID(),
    old: randomUUID(),
  };
  const ids = {
    team: randomUUID(),
    field: randomUUID(),
    admin: randomUUID(),
    priv: randomUUID(),
    gone: randomUUID(),
    archived: randomUUID(),
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
        values (${node}, ${wsId}, false, ${home})
        on conflict (node_id, workspace_id) do nothing`),
    );

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    nav = await import('./app-nav');
    sqlTag = (await import('drizzle-orm')).sql;
    // Workspace table writes as the superuser: the app's pools only read them.
    const su = (q: Parameters<Ts['superuserExec']>[1]) => ts.superuserExec(scratch!.url, q);
    // The viewer roles: the global setup brings them up once (cluster-wide).
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, is_owner) values
        (${anchor}, ${`${tag}-admin@example.invalid`}, 'x', 'admin', true),
        (${member}, ${`${tag}-mem@example.invalid`}, 'x', 'member', false)`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})
      on conflict (id) do nothing`);
    await su(sqlTag`
      insert into workspaces (id, owner_id, name, is_admin, bridge_key) values
        (${ws.admin}, ${anchor}, ${`${tag} Admin`}, true, 'admin'),
        (${ws.team}, ${anchor}, ${`${tag} Team`}, false, null),
        (${ws.field}, ${anchor}, ${`${tag} Field`}, false, null),
        (${ws.priv}, ${anchor}, ${`${tag} Private`}, false, null),
        (${ws.gone}, ${anchor}, ${`${tag} Former user`}, false, null),
        (${ws.old}, ${anchor}, ${`${tag} Old`}, false, null)`);
    await m.systemDb.execute(sqlTag`
      insert into private_workspaces (login_id, workspace_id) values (${member}, ${ws.priv})`);
    await m.systemDb.execute(sqlTag`
      insert into former_user_workspaces (former_key, workspace_id)
      values (${randomUUID()}, ${ws.gone})`);
    // The Admin user is in Admin and Team, not in Field.
    await su(sqlTag`
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
      // On this brain a new item is homed in Admin already; make sure.
      await grant(id, ws.admin, true);
    }
    await grant(ids.team, ws.team);
    await grant(ids.field, ws.field);
    await grant(ids.priv, ws.priv);
    await grant(ids.gone, ws.gone);
    await grant(ids.archived, ws.old);
    await su(sqlTag`update workspaces set archived_at = now() where id = ${ws.old}`);
    await grant(ids.mcpOff, ws.field);
    await grant(ids.unpublished, ws.field);
  }, 60_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  const reachOf = (items: Awaited<ReturnType<typeof nav.listAppNavItems>>) =>
    Object.fromEntries(
      items.map((a) => [Object.entries(ids).find(([, id]) => id === a.id)![0], a.mcpReach]),
    );

  it('reports the reach of an app held by a workspace the Admin user is not in, a private one too', async () => {
    const items = await m.withScope(
      { kind: 'user', loginId: anchor, ws: [ws.admin, ws.team], modWs: [ws.admin] },
      () => nav.listAppNavItems(anchor),
    );
    expect(reachOf(items)).toEqual({
      team: true,
      field: true,
      admin: false,
      // A private or Former user workspace holds: its user reaches it.
      priv: true,
      gone: true,
      archived: false,
      mcpOff: false,
      unpublished: false,
    });
  });

  it('the system pool answers the same', async () => {
    expect(reachOf(await nav.listAppNavItems(anchor))).toMatchObject({
      team: true,
      field: true,
      admin: false,
      priv: true,
      gone: true,
      archived: false,
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
