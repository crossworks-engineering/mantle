/**
 * Folders that hold items the mover cannot read (workspaces arch A3a fix
 * rounds 1 and 2), through the real app (createApp), a Moderator of the
 * folder's home whose writes run on the write role:
 *
 *  - a RENAME (the same parent) takes every row along, the hidden ones too;
 *    for a Files folder the hidden file's row keeps its disk path;
 *  - a MOVE (a new parent) of such a folder answers 409 (the owner's rule),
 *    and nothing moves: no row, and for a Files folder nothing on disk;
 *  - a DELETE of such a folder answers 409 (node folders and Files
 *    folders), nothing orphaned.
 * The 409 says only "This folder holds items you cannot move."
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a3a-folders.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;

describe.skipIf(!URL)('A3a: folders with items the mover cannot read', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID();
  const mod = randomUUID(); // a member, Moderator of H
  const tag = `a3f${randomUUID().slice(0, 6)}`;
  let H = '';
  let O = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
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
  /** PATCH a folder; a visibility question (409 'visibility') is answered
   *  once with confirm, as the UI does. */
  const patch = async (kind: string, id: string, body: Json) => {
    const first = await call(`/api/tree/${kind}/folders/${id}`, mod, 'PATCH', body);
    if (first.status !== 409 || first.json.error !== 'visibility') return first;
    return call(`/api/tree/${kind}/folders/${id}`, mod, 'PATCH', {
      ...body,
      confirm: true,
      seen: first.json.total,
    });
  };
  /** DELETE a folder, answering a visibility question once, as the UI does. */
  const del = async (kind: string, id: string) => {
    const first = await call(`/api/tree/${kind}/folders/${id}`, mod, 'DELETE');
    if (first.status !== 409 || first.json.error !== 'visibility') return first;
    return call(
      `/api/tree/${kind}/folders/${id}?confirm=true&seen=${String(first.json.total)}`,
      mod,
      'DELETE',
    );
  };
  const grantsHome = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(
        sql`delete from item_grants where node_id = ${id} and via_folder_id is null`,
      );
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)
                           on conflict (node_id, workspace_id) do update set is_home = true`);
    });
  };
  /** Hide an item from H: its folder's grants "Removed here", its home O. */
  const hide = async (id: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`update item_grants set excluded = true, is_home = false, write = false
                           where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${O}, true)`);
    });
  };
  const pathOf = async (id: string) =>
    (await x<{ p: string }>(sql`select path::text as p from nodes where id = ${id}`))[0]?.p;
  const folder = async (kind: string, name: string, parentId: string | null = null) => {
    const r = await call(`/api/tree/${kind}/folders`, owner, 'POST', { parentId, name });
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    const id = (r.json.folder as Json).id as string;
    await grantsHome(id, H);
    return id;
  };
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn, 'test');
  /** With the edit check in warn (MANTLE_TEST_EDIT_CHECK), the subtree heads
   *  lock reports the hidden rows' heads it would drop in on (the rewrite then
   *  takes them itself): expected, and the only miss allowed here. */
  const onlyHeadsMisses = () => {
    const other = m.takeActorMisses().filter((x) => !x.check.startsWith('edit: heads lock:'));
    expect(other).toEqual([]);
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a3a-folders-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a3a-folders-secret-at-least-32-characters!';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${mod}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Moderator')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    for (const [key, name] of [
      ['H', 'Home'],
      ['O', 'Other'],
    ] as const) {
      const [row] = await x<{ id: string }>(sql`
        insert into workspaces (owner_id, name) values (${owner}, ${`${tag} ${name}`})
        returning id::text as id`);
      if (key === 'H') H = row!.id;
      else O = row!.id;
    }
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${H}, ${mod}, true)`);
    await x(sql`delete from workspace_users u using workspaces w
                 where w.id = u.workspace_id and w.bridge_key = 'team' and u.login_id = ${mod}`);
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a node folder: the move and the delete answer 409; the rename takes the hidden note along', async () => {
    const src = await folder('notes', `${tag} src`);
    const dst = await folder('notes', `${tag} dst`);
    const srcPath = (await pathOf(src))!;
    const hidden = randomUUID();
    await m.withHeads([src], 'share', (tx) =>
      tx.execute(sql`insert into nodes (id, owner_id, type, title, path)
                     values (${hidden}, ${owner}, 'note', ${`${tag} hidden`}, ${srcPath}::ltree)`),
    );
    await hide(hidden);

    const moved = await patch('notes', src, { parentId: dst });
    expect(moved.status, moved.text.slice(0, 200)).toBe(409);
    expect(moved.json).toMatchObject({
      error: 'This folder holds items you cannot move.',
      code: 'hidden_items',
    });
    expect(await pathOf(src)).toBe(srcPath);
    expect(await pathOf(hidden)).toBe(srcPath);

    const deleted = await del('notes', src);
    expect(deleted.status, deleted.text.slice(0, 200)).toBe(409);
    expect(deleted.json.code).toBe('hidden_items');
    expect(await pathOf(src)).toBe(srcPath);

    const renamed = await patch('notes', src, { name: `${tag} renamed` });
    expect(renamed.status, renamed.text.slice(0, 200)).toBe(200);
    const newPath = (await pathOf(src))!;
    expect(newPath).not.toBe(srcPath);
    expect(await pathOf(hidden)).toBe(newPath);
    onlyHeadsMisses();
  });

  it('a Files folder holding a hidden empty subfolder: the plain delete answers 409 (the one rule, N3); off, the rule never fires (N1)', async () => {
    const g = await folder('files', `${tag}h`);
    const gPath = (await pathOf(g))!;
    const sub = await call('/api/tree/files/folders', mod, 'POST', {
      parentId: g,
      name: `${tag}sub`,
    });
    expect(sub.status, sub.text.slice(0, 200)).toBe(201);
    const subId = (sub.json.folder as Json).id as string;
    await hide(subId);
    const refused = await call(`/api/files/folders/${g}`, mod, 'DELETE');
    expect(refused.status, refused.text.slice(0, 200)).toBe(409);
    expect(refused.json).toMatchObject({
      error: 'This folder holds items you cannot move.',
      code: 'hidden_items',
    });
    expect(refused.text).not.toContain(`${tag}sub`);
    // Nothing went: the hidden subfolder is still under the folder.
    expect((await pathOf(subId))!.startsWith(`${gPath}.`)).toBe(true);
    // A box whose actor check is off: writes on the system pool, and the
    // one rule never fires there (the answer is main's: not a 409 of ours).
    const was = process.env.MANTLE_ACTOR_CHECK;
    process.env.MANTLE_ACTOR_CHECK = 'off';
    try {
      const off = await del('files', g);
      expect(off.json.code).not.toBe('hidden_items');
      expect(off.text).not.toContain('This folder holds items you cannot move.');
    } finally {
      process.env.MANTLE_ACTOR_CHECK = was;
    }
    onlyHeadsMisses();
  });

  it('a Files folder: the rename keeps the hidden file’s row on its disk path; the move and the delete answer 409, nothing moves on disk', async () => {
    const g = await folder('files', `${tag}g`);
    const e = await folder('files', `${tag}e`);
    const gPath = (await pathOf(g))!;
    const body = { parentPath: gPath, filename: `${tag}.txt`, content: 'hidden bytes' };
    let up = await call('/api/files/files', mod, 'POST', body);
    // The Moderator of the folder's home files it (the owner is not in H).
    // Filing into a shared folder asks first (who will see it), as the UI
    // does.
    if (up.status === 409 && up.json.error === 'visibility') {
      up = await call('/api/files/files', mod, 'POST', {
        ...body,
        confirm: true,
        seen: up.json.total,
      });
    }
    expect(up.status, up.text.slice(0, 200)).toBeLessThan(300);
    const file = ((up.json.file as Json | undefined)?.id ?? up.json.id) as string;
    expect(await pathOf(file)).toBe(gPath);
    await hide(file);
    const bytes = async () =>
      (await sys(() => f.readFileById({ ownerId: owner, fileId: file })))?.bytes.toString('utf8');
    expect(await bytes()).toBe('hidden bytes');

    const moved = await patch('files', g, { parentId: e });
    expect(moved.status, moved.text.slice(0, 200)).toBe(409);
    expect(moved.json.code).toBe('hidden_items');
    expect(await pathOf(g)).toBe(gPath);
    expect(await pathOf(file)).toBe(gPath);
    // The directory went back: the bytes are where the row says.
    expect(await bytes()).toBe('hidden bytes');

    const deleted = await del('files', g);
    expect(deleted.status, deleted.text.slice(0, 200)).toBe(409);
    expect(deleted.json.code).toBe('hidden_items');
    expect(await bytes()).toBe('hidden bytes');

    const renamed = await patch('files', g, { name: `${tag}g2` });
    expect(renamed.status, renamed.text.slice(0, 200)).toBe(200);
    const newPath = (await pathOf(g))!;
    expect(newPath).not.toBe(gPath);
    expect(await pathOf(file)).toBe(newPath);
    expect(await bytes()).toBe('hidden bytes');
    onlyHeadsMisses();
  });
});
