/**
 * The owner tree routes on a database that refuses writes (docs/folder-tree.md,
 * "Reading"): GET /api/tree/:kind, GET /api/tree/:kind/marks and GET
 * /api/app-nav as HTTP, with the API's own pool logged in as a role that has
 * SELECT only (the public demo's reader: LOGIN, BYPASSRLS, no INSERT, UPDATE
 * or DELETE). Every live kind answers 200: its folders and items where the
 * brain has them, an empty tree where the kind's root row was never made.
 * Nothing is written. Only the owner check is stubbed.
 *
 * These routes answered 500 there: each read began with an unconditional
 * insert of the kind's root row, which Postgres refuses before it looks for
 * the row. The rules themselves are proven in
 * packages/content/src/tree/tree-readonly.db.test.ts.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run tree-readonly-routes.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: h.owner,
    actor: { id: h.owner, displayName: 'Admin' },
  })),
}));

describe.skipIf(!URL)('the owner tree routes as a role with SELECT only', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let tree: typeof import('@mantle/content/tree');
  let sqlTag: typeof import('drizzle-orm').sql;
  let reader: { name: string; url: string } | null = null;
  const owner = randomUUID();
  const tag = `tree-ro-routes-${owner.slice(0, 8)}`;
  const ids = { folder: randomUUID(), note: randomUUID(), page: randomUUID(), app: randomUUID() };
  /** The kinds whose root row exists; the rest were never read or written. */
  const rooted = ['notes', 'pages', 'apps'] as const;
  let nodesBefore = '';

  const adminClient = () => (m.systemDb as unknown as { $client: Admin }).$client;
  const nodesNow = async () => {
    const [row] = (await m.db.execute(sqlTag`
      select coalesce(md5(string_agg(
               id::text || '|' || path::text || '|' || title || '|' || data::text || '|' ||
               updated_at::text, ',' order by id)), '') as nodes
        from nodes where owner_id = ${owner}`)) as unknown as Array<{ nodes: string }>;
    const [marks] = (await m.db.execute(
      sqlTag`select count(*)::int as n from item_marks where actor_id = ${owner}`,
    )) as unknown as Array<{ n: number }>;
    return `${row!.nodes}:${marks!.n}`;
  };
  const get = async (
    route: { GET: (r: Request, c: { params: Promise<{ kind: string }> }) => Promise<Response> },
    kind: string,
    query = '',
  ) =>
    route.GET(new Request(`http://brain.test/api/tree/${kind}${query}`), {
      params: Promise.resolve({ kind }),
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('@mantle/content/tree');
    sqlTag = (await import('drizzle-orm')).sql;
    const { createReadOnlyRole } = await import('@mantle/db/test-support');
    // The caller's private items are read on the personal-space role.
    await m.ensureViewerRoles(adminClient(), process.env.MANTLE_MASTER_KEY);
    h.owner = owner;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    for (const kind of rooted) await tree.ensureKindRoot(owner, kind);
    const node = (id: string, type: string, path: string, title: string) =>
      m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, data, tags)
        values (${id}, ${owner}, ${type}::node_type, ${title}, ${path}::ltree,
                ${type === 'note' ? JSON.stringify({ content: 'x' }) : '{}'}::jsonb, '{}')`);
    await node(ids.folder, 'branch', 'notes.clients', 'Clients');
    await node(ids.note, 'note', 'notes', 'A note');
    await node(ids.page, 'page', 'pages', 'Roadmap');
    await node(ids.app, 'app', 'apps', 'Timer');

    reader = await createReadOnlyRole(adminClient(), URL!);
    // From here the API's pool is the reader, as on the demo.
    await m.closeDb();
    process.env.DATABASE_URL = reader.url;
    nodesBefore = await nodesNow();
  });

  afterAll(async () => {
    if (!m) return;
    await m.closeDb();
    process.env.DATABASE_URL = URL;
    await m.db.execute(sqlTag`delete from item_marks where actor_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from profiles where user_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    if (reader) {
      const { dropReadOnlyRole } = await import('@mantle/db/test-support');
      await dropReadOnlyRole(adminClient(), reader.name);
    }
    await m.closeDb();
  });

  it('GET /api/tree/:kind answers 200 for every live kind, rooted or not', async () => {
    const route = await import('./[kind]/route');
    for (const kind of tree.TREE_LIVE_KINDS) {
      const res = await get(route, kind);
      expect(res.status, kind).toBe(200);
      const page = await res.json();
      expect(page, kind).toMatchObject({ kind, folder: null });
      expect(Array.isArray(page.folders) && Array.isArray(page.items), kind).toBe(true);
    }
  });

  it('answers the folders and items the brain has', async () => {
    const route = await import('./[kind]/route');
    const notes = await (await get(route, 'notes')).json();
    expect(notes.folders.map((f: { id: string }) => f.id)).toEqual([ids.folder]);
    expect(notes.items.map((i: { id: string }) => i.id)).toEqual([ids.note]);
    const pages = await (await get(route, 'pages')).json();
    expect(pages.items.map((i: { id: string }) => i.id)).toEqual([ids.page]);
    const apps = await (await get(route, 'apps')).json();
    expect(apps.items.map((i: { id: string }) => i.id)).toEqual([ids.app]);
  });

  it('GET /api/tree/:kind/marks answers 200 for every live kind', async () => {
    const route = await import('./[kind]/marks/route');
    for (const kind of tree.TREE_LIVE_KINDS) {
      const res = await get(route, kind, '/marks?view=pinned');
      expect(res.status, kind).toBe(200);
      expect((await res.json()).items, kind).toEqual([]);
    }
  });

  it('GET /api/app-nav answers 200 from the rows as they stand', async () => {
    const route = await import('../app-nav/route');
    const res = await route.GET();
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.apps.map((a: { id: string }) => a.id)).toEqual([ids.app]);
    expect(view.pins).toEqual([]);
  });

  it('wrote nothing', async () => {
    expect(await nodesNow()).toBe(nodesBefore);
  });
});
