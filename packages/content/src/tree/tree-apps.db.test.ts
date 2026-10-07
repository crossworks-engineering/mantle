/**
 * Apps join the item tree (phase 3): the old layout document and a login's
 * pins and opens move into rows once, and /api/app-nav's view is built from
 * the rows. Against a real, migrated Postgres:
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-apps.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('apps on the item tree', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./index');
  let appNav: typeof import('../app-nav');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `tree-apps-${owner.slice(0, 8)}`;
  const [work, inner, rocket, workToo] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const appIds: string[] = [];

  const pathOf = async (id: string) => {
    const [row] = (await m.db.execute(
      sqlTag`select path::text as path from nodes where id = ${id}`,
    )) as unknown as Array<{ path: string }>;
    return row?.path;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    tree = await import('./index');
    appNav = await import('../app-nav');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    for (const title of ['Zeta', 'Alpha', 'Rocket app', 'Loose']) {
      const [row] = (await m.db.execute(sqlTag`
        insert into nodes (owner_id, type, title, path, data, tags)
        values (${owner}, 'app', ${title}, 'apps', '{}'::jsonb, '{}')
        returning id::text as id`)) as unknown as Array<{ id: string }>;
      appIds.push(row!.id);
    }
    const [zeta, alpha, rocketApp] = appIds;
    const nav = {
      rev: 7,
      entries: [
        {
          kind: 'folder',
          id: work,
          name: 'Work',
          icon: 'lucide:briefcase',
          color: 'blue',
          children: [
            { kind: 'app', id: zeta },
            { kind: 'folder', id: inner, name: 'Clients', children: [{ kind: 'app', id: alpha }] },
          ],
        },
        { kind: 'folder', id: rocket, name: '🚀', children: [{ kind: 'app', id: rocketApp }] },
        { kind: 'folder', id: workToo, name: 'work', children: [] },
      ],
    };
    const prefs = {
      appNav: nav,
      appPins: [rocketApp, zeta],
      appOpens: { [alpha!]: { n: 5, at: '2026-09-01T10:00:00.000Z' } },
    };
    await m.db.execute(sqlTag`
      insert into profiles (user_id, preferences) values (${owner}, ${JSON.stringify(prefs)}::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from item_marks where actor_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from profiles where user_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
  });

  it('moves the layout document into folder rows once, keeping ids, looks and order', async () => {
    expect(await tree.reconcileAppNav(owner)).toBe(true);
    expect(await tree.reconcileAppNav(owner)).toBe(false);
    const folders = await tree.listTreeFolders(owner, 'apps');
    expect(folders.map((f) => [f.id, f.name, f.path])).toEqual([
      [work, 'Work', 'apps.work'],
      [inner, 'Clients', 'apps.work.clients'],
      [rocket, '🚀', 'apps.folder'],
      [workToo, 'work 2', 'apps.work_2'],
    ]);
    expect(folders[0]).toMatchObject({ icon: 'lucide:briefcase', color: 'blue' });
    const [zeta, alpha, rocketApp, loose] = appIds;
    expect(await pathOf(zeta!)).toBe('apps.work');
    expect(await pathOf(alpha!)).toBe('apps.work.clients');
    expect(await pathOf(rocketApp!)).toBe('apps.folder');
    expect(await pathOf(loose!)).toBe('apps');
  });

  it('answers /api/app-nav from the rows, with pins in order and opens', async () => {
    const [zeta, alpha, rocketApp] = appIds;
    const view = await appNav.loadAppNavView(owner, owner);
    expect(view.nav.entries).toEqual([
      {
        kind: 'folder',
        id: work,
        name: 'Work',
        icon: 'lucide:briefcase',
        color: 'blue',
        children: [
          { kind: 'folder', id: inner, name: 'Clients', children: [{ kind: 'app', id: alpha }] },
          { kind: 'app', id: zeta },
        ],
      },
      { kind: 'folder', id: rocket, name: '🚀', children: [{ kind: 'app', id: rocketApp }] },
      { kind: 'folder', id: workToo, name: 'work 2', children: [] },
    ]);
    expect(view.pins).toEqual([rocketApp, zeta]);
    expect(view.opens[alpha!]).toEqual({ n: 5, at: '2026-09-01T10:00:00.000Z' });
    expect(view.apps).toHaveLength(4);

    // The rev follows the layout, wherever it changed.
    await tree.moveTreeItems(owner, 'apps', [zeta!], null);
    const after = await appNav.loadAppNavView(owner, owner);
    expect(after.nav.rev).not.toBe(view.nav.rev);
  });

  it('keeps pins and opens as item marks after the move', async () => {
    const [zeta, alpha, rocketApp] = appIds;
    expect(await appNav.saveAppPins(owner, owner, [zeta!, rocketApp!, randomUUID()])).toEqual([
      zeta,
      rocketApp,
    ]);
    const pinned = await tree.listTreeMarks(owner, owner, 'apps', 'pinned');
    expect(pinned.items.map((i) => i.id)).toEqual([zeta, rocketApp]);
    expect(await appNav.recordAppOpen(owner, owner, alpha!)).toBe(true);
    const view = await appNav.loadAppNavView(owner, owner);
    expect(view.opens[alpha!]?.n).toBe(6);
    // The marks moved once: a repeat does not re-pin what was unpinned.
    expect(await tree.reconcileAppMarks(owner, owner)).toBe(false);
    expect((await appNav.loadAppNavView(owner, owner)).pins).toEqual([zeta, rocketApp]);
  });
});
