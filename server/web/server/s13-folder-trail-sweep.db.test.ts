/**
 * The folders above what a login reads, as structure only (the owner's
 * rule; migration 0311, mantle_folder_trail), through the real app
 * (createApp) as a member whose workspace reads one note and one file deep
 * in folders it does not read. Runs in every check mode the config sets
 * (off: the actor-off run, warn: the full run, on: the actor-on run).
 *
 *  - the tree: the member's root lists the folder on the way (name and id,
 *    no look, no caps), never a hidden sibling or an empty hidden folder;
 *    that folder opens with its one child on the way and no item; the
 *    item's folder opens with the item and the full crumbs; a hidden
 *    sibling still answers 404; a search names the full chain;
 *  - no write of any kind on such a folder: rename, move, delete, a folder
 *    or an item into it, its Grant Access panel, as before (404, nothing
 *    changed);
 *  - Files: the folder list and the tree rail name the folders on the way
 *    with no caps; the folder's own routes still answer 404; a content
 *    edit of the member's file in such a folder answers 200 (the 400
 *    "parent folder not found" before), a new file there is still refused.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/s13-folder-trail-sweep.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;
type Folder = { id: string; name?: string; title?: string; path: string } & Json;

describe.skipIf(!URL)('S13: the folders above what a login reads, as structure', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID();
  const member = randomUUID();
  const tag = `s13${randomUUID().replace(/-/g, '').slice(0, 6)}`;
  let W = '';
  // Notes: a > b holds the member's note; a > s holds a hidden note; c is
  // an empty hidden folder; v is a folder the member's workspace reads.
  const N = { a: '', b: '', s: '', c: '', v: '' };
  let note = '';
  let hiddenNote = '';
  // Files: fa > fb holds the member's file; fa > fs holds a hidden file.
  let fa = { id: '', path: '' };
  let fb = { id: '', path: '' };
  let fs = { id: '', path: '' };
  let file = { id: '', filename: '' };

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const call = async (p: string, as: string, method = 'GET', body?: unknown) => {
    const res = await app.request(p, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookieOf(as) },
      ...(method === 'GET' || body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      /* not json */
    }
    return { status: res.status, text, json };
  };
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn, 'test');
  const grant = async (id: string, write = false) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                           values (${id}, ${W}, ${write})`);
    });
  };
  const row = async (id: string) =>
    (
      await x<{ path: string; title: string; data: Json }>(
        sql`select path::text as path, title, data from nodes where id = ${id}`,
      )
    )[0];
  const ids = (list: unknown) => (list as Folder[]).map((r) => r.id);
  /** No actor miss but the heads lock reports the edit check may make. */
  const noMisses = () => {
    const other = m.takeActorMisses().filter((y) => !y.check.startsWith('edit: heads lock:'));
    expect(other).toEqual([]);
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 's13-trail-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 's13-folder-trail-secret-at-least-32-chars!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    const [w] = await su<{ id: string }>(sql`
      insert into workspaces (owner_id, name) values (${owner}, ${`${tag} W`})
      returning id::text as id`);
    W = w!.id;
    await su(sql`delete from workspace_users where login_id = ${member}`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${W}, ${member}, false)`);
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();

    // The notes tree, made by the owner (homed in Admin, which the member
    // is not a user of).
    const folder = async (name: string, parentId: string | null) => {
      const r = await call(`/api/tree/notes/folders`, owner, 'POST', { parentId, name });
      expect(r.status, r.text.slice(0, 200)).toBe(201);
      return (r.json.folder as Folder).id;
    };
    N.a = await folder(`${tag} Alpha`, null);
    N.b = await folder(`${tag} Beta`, N.a);
    N.s = await folder(`${tag} Secret`, N.a);
    N.c = await folder(`${tag} Closed`, null);
    N.v = await folder(`${tag} Visible`, null);
    note = randomUUID();
    hiddenNote = randomUUID();
    const bPath = (await row(N.b))!.path;
    const sPath = (await row(N.s))!.path;
    await m.withHeads([N.b, N.s], 'share', (tx) =>
      tx.execute(sql`insert into nodes (id, owner_id, type, title, path) values
        (${note}, ${owner}, 'note', ${`${tag} readable note`}, ${bPath}::ltree),
        (${hiddenNote}, ${owner}, 'note', ${`${tag} hidden note`}, ${sPath}::ltree)`),
    );
    await grant(note);
    await grant(N.v);

    // The Files tree, made on the system pool.
    await sys(() => f.ensureFilesRootBranch(owner));
    fa = await sys(() =>
      f.createFolder({ ownerId: owner, parentPath: 'files', slug: `${tag}-fa` }),
    );
    fb = await sys(() => f.createFolder({ ownerId: owner, parentPath: fa.path, slug: 'fb' }));
    fs = await sys(() => f.createFolder({ ownerId: owner, parentPath: fa.path, slug: 'fs' }));
    file = await sys(() =>
      f.upsertFile({
        ownerId: owner,
        parentPath: fb.path,
        filename: 'shared.md',
        bytes: Buffer.from('before\n'),
      }),
    );
    await sys(() =>
      f.upsertFile({
        ownerId: owner,
        parentPath: fs.path,
        filename: 'hidden.md',
        bytes: Buffer.from('hidden\n'),
      }),
    );
    await grant(file.id, true);
    m.takeActorMisses();
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the member reads its note, its file and the folder Visible, and nothing else made here (the fixture)', async () => {
    const seen = await m.withViewer(
      { login: member },
      async () =>
        (await m.db.execute(sql`select id::text as id from nodes
           where title like ${`${tag}%`} or id = any(${`{${[fa.id, fb.id, fs.id, file.id].join(',')}}`}::uuid[])`)) as unknown as {
          id: string;
        }[],
    );
    expect(new Set(seen.map((r) => r.id))).toEqual(new Set([note, N.v, file.id]));
  });

  it('the tree root names the folder on the way, as structure; never a hidden sibling or an empty hidden folder', async () => {
    const root = await call('/api/tree/notes', member);
    expect(root.status, root.text.slice(0, 200)).toBe(200);
    const folders = root.json.folders as Folder[];
    expect(ids(folders)).toContain(N.a);
    expect(ids(folders)).toContain(N.v);
    expect(ids(folders)).not.toContain(N.c);
    const a = folders.find((r) => r.id === N.a)!;
    expect(a).toMatchObject({
      name: `${tag} Alpha`,
      icon: null,
      color: null,
      system: false,
      itemCount: 0,
      // Beta on the way, not the hidden Secret: what opening it shows.
      folderCount: 1,
      workspaces: [],
      hasLink: false,
      mayEdit: false,
      mayManage: false,
    });
    expect(JSON.stringify(root.json)).not.toContain(`${tag} Secret`);
    expect(JSON.stringify(root.json)).not.toContain(`${tag} Closed`);
    expect(JSON.stringify(root.json)).not.toContain(`${tag} hidden note`);
    noMisses();
  });

  it('the folder on the way opens with its one child on the way and no item; the item folder with the item and full crumbs', async () => {
    const a = await call(`/api/tree/notes?folder=${N.a}`, member);
    expect(a.status, a.text.slice(0, 200)).toBe(200);
    expect(ids(a.json.folders)).toEqual([N.b]);
    expect((a.json.folders as Folder[])[0]).toMatchObject({ folderCount: 0, itemCount: 1 });
    expect(a.json.items).toEqual([]);
    expect(a.json.crumbs).toEqual([]);
    expect((a.json.folder as Folder).id).toBe(N.a);
    expect(JSON.stringify(a.json)).not.toContain(`${tag} Secret`);

    const b = await call(`/api/tree/notes?folder=${N.b}`, member);
    expect(b.status, b.text.slice(0, 200)).toBe(200);
    expect((b.json.items as Folder[]).map((i) => i.id)).toEqual([note]);
    expect(b.json.crumbs).toEqual([{ id: N.a, name: `${tag} Alpha` }]);
    expect((b.json.folder as Folder).parentId).toBe(N.a);

    for (const hidden of [N.s, N.c]) {
      const r = await call(`/api/tree/notes?folder=${hidden}`, member);
      expect(r.status, r.text.slice(0, 200)).toBe(404);
    }
    noMisses();
  });

  it('a search names the full chain of the item it finds', async () => {
    const r = await call(
      `/api/tree/notes/search?q=${encodeURIComponent(`${tag} readable`)}`,
      member,
    );
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const items = r.json.items as Array<{ id: string; crumbs: unknown }>;
    expect(items.map((i) => i.id)).toEqual([note]);
    expect(items[0]!.crumbs).toEqual([
      { id: N.a, name: `${tag} Alpha` },
      { id: N.b, name: `${tag} Beta` },
    ]);
  });

  it('no write of any kind on a folder seen as structure: 404 as before, nothing changed', async () => {
    const before = await row(N.a);
    const refused = [
      await call(`/api/tree/notes/folders/${N.a}`, member, 'PATCH', { name: `${tag} taken` }),
      await call(`/api/tree/notes/folders/${N.a}`, member, 'PATCH', { parentId: N.v }),
      await call(`/api/tree/notes/folders/${N.a}`, member, 'PATCH', { icon: 'lucide:star' }),
      await call(`/api/tree/notes/folders/${N.a}`, member, 'DELETE'),
      await call(`/api/tree/notes/folders`, member, 'POST', { parentId: N.a, name: 'inside' }),
      await call(`/api/tree/notes/move`, member, 'POST', { ids: [note], folderId: N.a }),
      await call(`/api/grants/${N.a}`, member, 'GET'),
      await call(`/api/grants/${N.a}`, member, 'POST', { wsId: W }),
    ];
    expect(refused.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404]);
    expect(await row(N.a)).toEqual(before);
    expect((await row(note))!.path).toBe((await row(N.b))!.path);
    const inside = await x(sql`select 1 from nodes where title = 'inside'`);
    expect(inside).toEqual([]);
  });

  it('Files: the folder list and the rail name the folders on the way, with no caps; never the hidden sibling', async () => {
    const tree = await call('/api/files/folders?tree=true', member);
    expect(tree.status, tree.text.slice(0, 200)).toBe(200);
    const all = tree.json.folders as Folder[];
    expect(ids(all)).toEqual(expect.arrayContaining([fa.id, fb.id]));
    expect(ids(all)).not.toContain(fs.id);
    const rowA = all.find((r) => r.id === fa.id)!;
    expect(rowA).toMatchObject({
      path: fa.path,
      title: `${tag}-fa`,
      description: '',
      icon: null,
      color: null,
      indexing: null,
      mayEdit: false,
      mayManage: false,
    });
    const top = await call('/api/files/folders?parent=files', member);
    expect(top.status).toBe(200);
    expect(ids(top.json.folders)).toContain(fa.id);
    const under = await call(`/api/files/folders?parent=${fa.path}`, member);
    expect(ids(under.json.folders)).toEqual([fb.id]);
    expect(JSON.stringify([tree.json, top.json, under.json])).not.toContain(fs.path);
    noMisses();
  });

  it("Files: a folder's own routes still answer 404 for it", async () => {
    const before = await row(fa.id);
    const refused = [
      await call(`/api/files/folders/${fa.id}`, member, 'GET'),
      await call(`/api/files/folders/${fa.id}`, member, 'PATCH', { rename: 'taken' }),
      await call(`/api/files/folders/${fa.id}`, member, 'PATCH', { description: 'x' }),
      await call(`/api/files/folders/${fa.id}`, member, 'PATCH', { indexing: 'metadata' }),
      await call(`/api/files/folders/${fa.id}`, member, 'PATCH', { look: { icon: 'lucide:star' } }),
      await call(`/api/files/folders/${fa.id}`, member, 'DELETE'),
    ];
    expect(refused.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(await row(fa.id)).toEqual(before);
  });

  it('Files: a content edit of the member’s file in a folder it does not read answers 200; a new file there is refused', async () => {
    const edit = await call(`/api/files/files/${file.id}`, member, 'PATCH', { content: 'after\n' });
    expect(edit.status, edit.text.slice(0, 200)).toBe(200);
    expect((await row(file.id))!.data.content).toBe('after\n');

    const made = await call('/api/files/files', member, 'POST', {
      parentPath: fb.path,
      filename: 'new.md',
      content: 'new\n',
    });
    expect([400, 403, 404]).toContain(made.status);
    expect(
      await x(sql`select 1 from nodes where path = ${fb.path}::ltree and slug = 'new.md'`),
    ).toEqual([]);
    noMisses();
  });

  it('the owner sees every folder as before', async () => {
    const root = await call('/api/tree/notes', owner);
    expect(root.status).toBe(200);
    expect(ids(root.json.folders)).toEqual(expect.arrayContaining([N.a, N.c, N.v]));
    const a = (root.json.folders as Folder[]).find((r) => r.id === N.a)!;
    expect(a.folderCount).toBe(2);
  });
});
