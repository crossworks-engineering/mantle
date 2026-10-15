/**
 * Search across workspaces (task f26a516e), on a migrated scratch database
 * through the real app (createApp), with signed session cookies:
 *
 *  - GET /api/search and GET /api/tree/:kind/search?across=1 find an item in
 *    every workspace the login reads, the switcher's workspace (`ws`) first,
 *    each hit naming the workspace it opens in;
 *  - nothing of a workspace the login is not in comes back: another
 *    member's workspace, another login's private workspace, the workspace of
 *    an outside login (a client set up as a workspace of its own), Admin for
 *    a member; an Admin user does not see a member's private workspace;
 *  - a `ws` the login may not name answers 404, never a wider search;
 *  - an empty folder under `ws` names where its items are (`elsewhere`), and
 *    each folder counts them (`itemsElsewhere`), from the login's own
 *    workspaces and its scope only;
 *  - a link scope reads none of it.
 *
 * The rule is the database's: the routes read in the login's request scope,
 * so the row rules keep out what the login does not read. Nothing here is
 * filtered in TypeScript.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/search-across-workspaces.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, any>;

describe.skipIf(!URL)('search across workspaces (task f26a516e)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  const owner = randomUUID(); // the anchor, an Admin user (in Admin and Team)
  const mem = randomUUID(); // a member: Team and its private workspace
  const mem2 = randomUUID(); // a member: Team and Side (alone)
  const out = randomUUID(); // an outside login, alone in Outside
  const tag = `wsx${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  let team = '';
  let admin = '';
  let side = '';
  let priv = '';
  let outside = '';
  let folder = '';
  let folderPath = '';
  const uid = (): string => randomUUID();
  const id = {
    admin: uid(),
    team: uid(),
    side: uid(),
    priv: uid(),
    out: uid(),
    privInF: uid(),
    sideInF: uid(),
    adminInF: uid(),
    outInF: uid(),
  };

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (who: string) => `${tag}-${who}@example.invalid`;

  const call = async (
    path: string,
    as: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ status: number; text: string; json: Json }> => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookieOf(as) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      // a non-JSON answer: the status says what it was
    }
    return { status: res.status, text, json };
  };

  const homeIn = async (node: string, ws: string) => {
    await m.withHeads([node], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${node}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${node}, ${ws}, true)
                           on conflict (node_id, workspace_id)
                           do update set is_home = true, via_folder_id = null, excluded = false`);
    });
  };
  const alsoIn = async (node: string, ws: string) => {
    await m.withHeads([node], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id) values (${node}, ${ws})
                           on conflict do nothing`);
    });
  };
  const page = async (node: string, title: string, path: string, ws: string) => {
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${node}, ${owner}, 'page', ${title}, ${path}::ltree)`);
    await homeIn(node, ws);
    // An item in a folder takes the folder's grants; "Removed here" on
    // each, so the item is read by its home only.
    await m.withHeads([node], 'update', async (tx) => {
      await tx.execute(sql`update item_grants set excluded = true
                            where node_id = ${node} and via_folder_id is not null
                              and not is_home`);
    });
  };

  /** Every title of the brain's test items, keyed by id. */
  const titles = () => ({
    [id.admin]: `${tag} admin page`,
    [id.team]: `${tag} team page`,
    [id.side]: `${tag} side page`,
    [id.priv]: `${tag} mine page`,
    [id.out]: `${tag} outside page`,
    [id.privInF]: `${tag} folder mine`,
    [id.sideInF]: `${tag} folder side`,
    [id.adminInF]: `${tag} folder admin`,
    [id.outInF]: `${tag} folder outside`,
  });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'search-across-ws-secret-at-least-32-characters';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${mem}, ${email('mem')}, 'x', false, 'member', 'Mia Member'),
      (${mem2}, ${email('mem2')}, 'x', false, 'member', 'Max Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    // The outside login comes after the switch: it joins no workspace by
    // itself (0286), only the one it makes.
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
                values (${out}, ${email('out')}, 'x', false, 'member', 'Otto Outside')`);
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id,
             (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key
        from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    admin = ws.find((w) => w.key === 'admin')!.id;
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (who) => `mantle_session=${tokens.buildSessionCookie(who).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    const made = async (as: string, name: string) => {
      const r = await call('/api/workspaces', as, 'POST', { name });
      expect(r.status, r.text).toBeLessThan(300);
      return String(r.json.id);
    };
    side = await made(mem2, 'Side');
    priv = await made(mem, 'Mia private');
    outside = await made(out, 'Outside');

    await page(id.admin, titles()[id.admin]!, 'pages', admin);
    await page(id.team, titles()[id.team]!, 'pages', team);
    await page(id.side, titles()[id.side]!, 'pages', side);
    await page(id.priv, titles()[id.priv]!, 'pages', priv);
    await page(id.out, titles()[id.out]!, 'pages', outside);

    // A folder Team reads, holding one item of each other workspace and none
    // of Team's.
    const f = await call('/api/tree/pages/folders', owner, 'POST', {
      parentId: null,
      name: `${tag} shared folder`,
    });
    expect(f.status, f.text).toBeLessThan(300);
    folder = String(f.json.folder.id);
    folderPath = (
      await x<{ path: string }>(sql`select path::text as path from nodes where id = ${folder}`)
    )[0]!.path;
    await alsoIn(folder, team);
    expect(
      await x(sql`select 1 from nodes where id = ${folder} and ${team}::uuid = any(read_ws)`),
    ).toHaveLength(1);
    await page(id.privInF, titles()[id.privInF]!, folderPath, priv);
    await page(id.sideInF, titles()[id.sideInF]!, folderPath, side);
    await page(id.adminInF, titles()[id.adminInF]!, folderPath, admin);
    await page(id.outInF, titles()[id.outInF]!, folderPath, outside);
    // Each test item is read by its home alone.
    const homes = await x<{ id: string; n: number }>(sql`
      select id::text as id, cardinality(read_ws)::int as n from nodes
       where id = any(${`{${Object.keys(titles()).join(',')}}`}::uuid[])`);
    expect(homes.map((h) => [h.id, h.n]).sort()).toEqual(
      Object.keys(titles())
        .map((k) => [k, 1])
        .sort(),
    );
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  /** The ids of `rows` among the test items, in order. */
  const ours = (rows: Json[], key = 'id') =>
    rows.map((r) => String(r[key])).filter((v) => v in titles());

  it('the palette search: every workspace the member reads, the switcher’s first, each hit tagged', async () => {
    const r = await call(`/api/search?q=${tag}&ws=${team}&limit=50`, mem);
    expect(r.status, r.text).toBe(200);
    expect(r.json.ws).toBe(team);
    const rows = r.json.results as Json[];
    const got = ours(rows);
    expect(new Set(got)).toEqual(new Set([id.team, id.priv, id.privInF]));
    expect(got[0]).toBe(id.team);
    const byId = new Map(rows.map((h) => [String(h.id), h]));
    expect(byId.get(id.team)!.workspace).toEqual({ id: team, name: 'Team' });
    expect(byId.get(id.priv)!.workspace).toEqual({ id: priv, name: 'Mia private' });
    expect(byId.get(id.privInF)!.workspace).toEqual({ id: priv, name: 'Mia private' });
  }, 60_000);

  it('the palette search: nothing of a workspace the login is not in, for every login', async () => {
    const reads: Record<string, string[]> = {
      [mem]: [id.team, id.priv, id.privInF],
      [mem2]: [id.team, id.side, id.sideInF],
      [out]: [id.out, id.outInF],
      // The Admin user: Admin and Team, never a member's private workspace,
      // Side or Outside.
      [owner]: [id.admin, id.team, id.adminInF],
    };
    for (const [who, want] of Object.entries(reads)) {
      const r = await call(`/api/search?q=${tag}&limit=50`, who);
      expect(r.status, r.text).toBe(200);
      expect(new Set(ours(r.json.results as Json[])), who).toEqual(new Set(want));
      // Not even a title of another item in the answer.
      for (const [other, title] of Object.entries(titles())) {
        if (!want.includes(other)) expect(r.text, `${who} sees ${title}`).not.toContain(title);
      }
      // Each tag names a workspace of the login's own.
      const mine = new Set(
        (
          await x<{ id: string }>(
            sql`select workspace_id::text as id from workspace_users where login_id = ${who}`,
          )
        ).map((w) => w.id),
      );
      for (const h of r.json.results as Json[]) {
        if (h.workspace) expect(mine.has(String(h.workspace.id)), who).toBe(true);
      }
    }
  }, 120_000);

  it('a workspace the login may not name is 404, never a wider search', async () => {
    for (const ws of [side, outside, admin, randomUUID(), 'not-an-id']) {
      const r = await call(`/api/search?q=${tag}&ws=${ws}`, mem);
      expect(r.status, `${ws} ${r.text}`).toBe(404);
      expect(r.text).not.toContain(tag);
      const t = await call(`/api/tree/pages/search?q=${tag}&ws=${ws}&across=1`, mem);
      expect(t.status, `${ws} ${t.text}`).toBe(404);
      expect(t.text).not.toContain(tag);
    }
  }, 60_000);

  it('the list search across: every workspace the member reads, Team first; without across it narrows', async () => {
    const r = await call(`/api/tree/pages/search?q=${tag}&ws=${team}&across=1`, mem);
    expect(r.status, r.text).toBe(200);
    expect(r.json.across).toBe(true);
    expect(r.json.ws).toBe(team);
    const items = r.json.items as Json[];
    expect(ours(items)).toEqual([id.team, id.privInF, id.priv]);
    expect(items[0]!.workspace).toEqual({ id: team, name: 'Team' });
    expect(items[1]!.workspace).toEqual({ id: priv, name: 'Mia private' });
    // The folder that matches comes too (a search across is not filtered).
    expect((r.json.folders as Json[]).map((f) => f.id)).toContain(folder);
    for (const [other, title] of Object.entries(titles())) {
      if (![id.team, id.priv, id.privInF].includes(other)) expect(r.text).not.toContain(title);
    }
    // Paged one at a time, the same order (the cursor carries the part).
    const paged: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const p = await call(
        `/api/tree/pages/search?q=${tag}&ws=${team}&across=1&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        mem,
      );
      paged.push(...ours(p.json.items as Json[]));
      cursor = p.json.nextCursor as string | null;
      if (!cursor) break;
    }
    expect(paged).toEqual([id.team, id.privInF, id.priv]);
    // Without across: the list filter, as before.
    const narrow = await call(`/api/tree/pages/search?q=${tag}&ws=${team}`, mem);
    expect(ours(narrow.json.items as Json[])).toEqual([id.team]);
    expect(narrow.json.across).toBeUndefined();
    expect((narrow.json.items as Json[])[0]!.workspace).toBeUndefined();
    // An empty term (the A to Z view) ignores across.
    const az = await call(`/api/tree/pages/search?q=&ws=${team}&across=1`, mem);
    expect(az.json.across).toBeUndefined();
    expect(ours(az.json.items as Json[])).toEqual([id.team]);
  }, 60_000);

  it('the list search across as an Admin user and as an outside login', async () => {
    const a = await call(`/api/tree/pages/search?q=${tag}&ws=${admin}&across=1`, owner);
    expect(a.status, a.text).toBe(200);
    expect(ours(a.json.items as Json[])).toEqual([id.admin, id.adminInF, id.team]);
    const o = await call(`/api/tree/pages/search?q=${tag}&ws=${outside}&across=1`, out);
    expect(ours(o.json.items as Json[])).toEqual([id.outInF, id.out]);
    expect(o.text).not.toContain(`${tag} team page`);
  }, 60_000);

  it('an empty folder names where its items are, from the login’s own workspaces only', async () => {
    const r = await call(`/api/tree/pages?folder=${folder}&ws=${team}`, mem);
    expect(r.status, r.text).toBe(200);
    expect(r.json.items).toEqual([]);
    expect(r.json.elsewhere).toEqual([{ id: priv, name: 'Mia private', count: 1 }]);
    // The folder's row at the root counts them too.
    const root = await call(`/api/tree/pages?ws=${team}`, mem);
    const row = (root.json.folders as Json[]).find((f) => f.id === folder)!;
    expect(row.itemCount).toBe(0);
    expect(row.itemsElsewhere).toBe(1);
    // The root itself holds a Team item: no hint there.
    expect(root.json.elsewhere).toBeUndefined();

    const a = await call(`/api/tree/pages?folder=${folder}&ws=${team}`, owner);
    expect(a.json.items).toEqual([]);
    expect(a.json.elsewhere).toEqual([{ id: admin, name: 'Admin', count: 1 }]);
    const b = await call(`/api/tree/pages?folder=${folder}&ws=${team}`, mem2);
    expect(b.json.elsewhere).toEqual([{ id: side, name: 'Side', count: 1 }]);
    // Without ws nothing is hidden, so nothing is counted elsewhere.
    const all = await call(`/api/tree/pages?folder=${folder}`, mem);
    expect(ours(all.json.items as Json[])).toEqual([id.privInF]);
    expect(all.json.elsewhere).toBeUndefined();
    expect((all.json.folder as Json).itemsElsewhere).toBeUndefined();
  }, 60_000);

  it('a link scope reads none of it', async () => {
    const tree = await import('@mantle/content/tree');
    const { searchNodes } = await import('@mantle/search');
    const found = await m.withViewer({ link: { served: [] } }, () =>
      tree.searchTree(owner, 'pages', tag, { cover: { ws: null, current: team, across: true } }),
    );
    expect(found.items).toEqual([]);
    expect(found.folders).toEqual([]);
    const counted = await m.withViewer({ link: { served: [] } }, () =>
      tree.itemsElsewhereIn(owner, 'pages', folderPath, team, [admin, side, priv, outside]),
    );
    expect(counted).toEqual([]);
    const hits = await m.withViewer({ link: { served: [] } }, () =>
      searchNodes({ ownerId: owner, q: tag, limit: 50 }),
    );
    expect(hits.filter((h) => h.id in titles())).toEqual([]);
    // The control: the system pool reads them all, so the empty answers
    // above are the scope's doing.
    const sys = await tree.searchTree(owner, 'pages', tag, {
      cover: { ws: null, current: team, across: true },
    });
    expect(ours(sys.items as unknown as Json[]).length).toBe(9);
  }, 60_000);
});
