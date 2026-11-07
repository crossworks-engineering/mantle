/**
 * Favorite items (navFavoriteItemsFor): what the rail's Favorites tab shows
 * for the `/n/<id>` entries of a login's navFavorites. On a migrated scratch
 * brain on workspaces:
 *
 *  - the owner gets each item it reads, in list order, with its title, icon
 *    and colour; a screen href, a folder, an unknown id and an archived task
 *    are left out;
 *  - a member of one workspace gets the canvas granted to it, and not the
 *    one homed in Admin (the read runs in its own scope, no check of its
 *    own);
 *  - a deleted item is gone.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/favorites.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('favorite items', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tree: typeof import('./index');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const member = randomUUID();
  const W = randomUUID();
  const tag = `fv${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  const C = { team: randomUUID(), admin: randomUUID(), gone: randomUUID() };
  const T = { open: randomUUID(), archived: randomUUID() };
  const folder = randomUUID();
  const n = (id: string) => `/n/${id}`;

  const x = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const asMember = <T>(fn: () => Promise<T>) => m.withViewer({ login: member }, fn);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    const su = (q: ReturnType<typeof sqlTag>) => ts.superuserExec(scratch!.url, q);
    await x(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin', true)`);
    await ts.runWorkspacesSwitch(scratch.url);
    await x(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', false)`);
    await su(
      sqlTag`insert into workspaces (id, owner_id, name) values (${W}, ${owner}, ${`${tag} W`})`,
    );
    await su(sqlTag`delete from workspace_users where login_id = ${member}`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id, moderator)
      values (${W}, ${member}, false)`);
    await tree.ensureKindRoot(owner, 'present');
    await tree.ensureKindRoot(owner, 'tasks');
    await m.withNodeInsertHeads(owner, [{ type: 'branch', path: 'present.f' }], (tx) =>
      tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, slug, path, data)
        values (${folder}, ${owner}, 'branch', ${`${tag} folder`}, 'f', 'present.f'::ltree,
                ${JSON.stringify({ slug: 'f' })}::jsonb)`),
    );
    const canvases: [string, Record<string, unknown>][] = [
      [C.team, { icon: 'lucide:rocket', color: 'violet' }],
      [C.admin, {}],
      [C.gone, {}],
    ];
    for (const [id, data] of canvases) {
      await m.withNodeInsertHeads(owner, [{ type: 'present', path: 'present' }], async (tx) => {
        await tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path, data)
          values (${id}, ${owner}, 'present', ${`${tag} canvas ${id.slice(0, 6)}`},
                  'present'::ltree, ${JSON.stringify(data)}::jsonb)`);
        await tx.execute(sqlTag`insert into presents (node_id, source, meta)
          values (${id}, '<div>fv</div>', '{}'::jsonb)`);
      });
    }
    const tasks: [string, Record<string, unknown>][] = [
      [T.open, {}],
      [T.archived, { archived_at: '2026-11-01T00:00:00Z' }],
    ];
    for (const [id, data] of tasks) {
      await m.withNodeInsertHeads(owner, [{ type: 'task', path: 'tasks' }], (tx) =>
        tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path, data)
          values (${id}, ${owner}, 'task', ${`${tag} task ${id.slice(0, 6)}`}, 'tasks'::ltree,
                  ${JSON.stringify(data)}::jsonb)`),
      );
    }
    await m.withHeads([C.team], 'update', (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id) values (${C.team}, ${W})`),
    );
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('the owner: each item it reads, in list order, with its look', async () => {
    const got = await tree.navFavoriteItemsFor(owner, [
      n(T.open),
      '/settings/agents',
      n(C.team),
      n(folder),
      n(randomUUID()),
      n(T.archived),
      n(C.admin),
      'not-an-href',
    ]);
    expect(got.map((i) => i.id)).toEqual([T.open, C.team, C.admin]);
    expect(got[1]).toEqual({
      href: n(C.team),
      id: C.team,
      kind: 'present',
      title: `${tag} canvas ${C.team.slice(0, 6)}`,
      icon: 'lucide:rocket',
      color: 'violet',
    });
    expect(got[0]).toMatchObject({ kind: 'tasks', icon: null, color: null });
  });

  it('a member: the canvas its workspace reads, not the Admin one', async () => {
    const got = await asMember(() => tree.navFavoriteItemsFor(owner, [n(C.admin), n(C.team)]));
    expect(got.map((i) => i.id)).toEqual([C.team]);
  });

  it('a deleted item is gone', async () => {
    expect((await tree.navFavoriteItemsFor(owner, [n(C.gone)])).map((i) => i.id)).toEqual([C.gone]);
    await m.withHeads([C.gone], 'update', (tx) =>
      tx.execute(sqlTag`delete from nodes where id = ${C.gone}`),
    );
    expect(await tree.navFavoriteItemsFor(owner, [n(C.gone)])).toEqual([]);
  });

  it('no item entry: no read', async () => {
    expect(await tree.navFavoriteItemsFor(owner, ['/settings/agents', '/'])).toEqual([]);
  });
});
