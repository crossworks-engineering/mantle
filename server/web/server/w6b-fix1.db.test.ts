/**
 * Workspaces W6b fix round 1, through the real app (createApp) on a migrated
 * scratch database with signed session cookies, and through the libraries
 * the routes call:
 *
 *  - H1: a folded member file with a brain file's name: its delete, the
 *    files watcher (sync and unlink) and a re-upload touch only its own row
 *    and bytes; a tree file never takes a folded file's name;
 *  - H2/M2: a member's app made through POST /api/apps is at team rules with
 *    its author named; trustTools, mcpAccess and dataReadOnly are an Admin
 *    user's only (403 admin-only);
 *  - H3: an upload never lands on the bytes of a file its caller cannot read
 *    (a member, an Admin user not in the file's workspace);
 *  - M6: my_app_errors needs edit;
 *  - CEO decision 1: a non-owner's app delete waits for the owner (the
 *    nightly purge skips it, a purge by anyone else is refused);
 *  - CEO decision 2: a snapshot copy is read only for everyone (the routes,
 *    the table writer, the file writer and the database floor), its author
 *    deletes it; its responses carry readOnly;
 *  - the caps on item responses and lists (mayEdit, mayManage, readOnly,
 *    snapshotOf, trashedBeforeFold), the private workspace marked in the
 *    shell, a file's detail open to members;
 *  - a pin makes no private workspace; a create does.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w6b-fix1.db.test.ts
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;

describe.skipIf(!URL)('W6b fix round 1', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let c: typeof import('@mantle/content');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor
  const admin2 = randomUUID(); // a second Admin user, not the owner
  const mem = randomUUID(); // a member: Moderator of Team, reads Ro
  const mem2 = randomUUID(); // a member: makes Side and Ro
  const mem3 = randomUUID(); // a member with nothing yet: reads Ro
  const tag = `w6bf${randomUUID().slice(0, 6)}`;
  let team = '';
  let side = '';
  let ro = '';
  const roNote = randomUUID();

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A fixture write to the four workspace tables, as the superuser: the
   *  system pool only reads them under test:runtime-role. */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const email = (who: string) => `${tag}-${who}@example.invalid`;
  const call = async (
    p: string,
    as: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ status: number; text: string; json: Json }> => {
    const isForm = body instanceof FormData;
    const res = await app.request(p, {
      method,
      headers: {
        ...(isForm ? {} : { 'content-type': 'application/json' }),
        cookie: cookieOf(as),
      },
      ...(method === 'GET' ? {} : { body: isForm ? body : JSON.stringify(body ?? {}) }),
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
  const homeIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)`);
    });
  };
  const homeOf = async (id: string) =>
    (
      await x<{ home: string | null; r: string[] }>(
        sql`select home_ws::text as home, read_ws::text[] as r from nodes where id = ${id}`,
      )
    )[0];
  const privateOf = async (login: string) =>
    (
      await x<{ ws: string }>(
        sql`select workspace_id::text as ws from private_workspaces where login_id = ${login}`,
      )
    )[0]?.ws;
  const privateFor = async (login: string) =>
    (
      await x<{ ws: string }>(
        sql`select "public"."mantle_ws_private_workspace"(set_config('mantle.scope_login', ${login}, true)::uuid)::text as ws`,
      )
    )[0]!.ws;
  const idOf = (r: { json: Json }, key: string) =>
    ((r.json[key] as Json | undefined)?.id ?? r.json.id) as string;
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn, 'test');
  const asLogin = <T>(login: string, fn: () => Promise<T>) => m.withViewer({ login }, fn);
  const bytesOf = async (id: string) =>
    (await sys(() => f.readFileById({ ownerId: owner, fileId: id })))?.bytes.toString('utf8');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  /** A folded member file (W6b): its row in `files`, its bytes in its old
   *  space's directory. `filename` may be a brain file's (the state before
   *  this round's fold fix); the slug is unique. */
  const folded = async (filename: string, body: string, home: string) => {
    const id = randomUUID();
    const space = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, slug, path, data)
      values (${id}, ${owner}, 'file', ${filename}, ${`${randomUUID().slice(0, 8)}-${filename}`},
              'files', ${JSON.stringify({
                filename,
                extension: filename.split('.').pop(),
                mime_type: 'text/plain',
                size_bytes: body.length,
                sha256: sha(body),
                space_file: space,
              })}::jsonb)`);
    const at = f.spaceFilePath(space, id);
    await mkdir(path.dirname(at), { recursive: true });
    await writeFile(at, body);
    await homeIn(id, home);
    return { id, at };
  };
  const brainText = async (filename: string, content: string, as = owner) => {
    const r = await call('/api/files/files', as, 'POST', {
      parentPath: 'files',
      filename,
      content,
    });
    expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
    return idOf(r, 'file');
  };
  const form = (filename: string, content: string, replace: boolean) => {
    const fd = new FormData();
    fd.set('parentPath', 'files');
    if (replace) fd.set('replace', 'true');
    fd.set('file', new Blob([content], { type: 'text/plain' }), filename);
    return fd;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w6b-fix1-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'w6b-fix1-secret-at-least-32-characters!!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    c = await import('@mantle/content');
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${admin2}, ${email('admin2')}, 'x', false, 'admin', 'Ada Admin'),
      (${mem}, ${email('mem')}, 'x', false, 'member', 'Mia Member'),
      (${mem2}, ${email('mem2')}, 'x', false, 'member', 'Max Member'),
      (${mem3}, ${email('mem3')}, 'x', false, 'member', 'Moe Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    side = (await call('/api/workspaces', mem2, 'POST', { name: 'Side' })).json.id as string;
    ro = (await call('/api/workspaces', mem2, 'POST', { name: 'Ro' })).json.id as string;
    expect(side && ro).toBeTruthy();
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${ro}, ${mem}, false), (${ro}, ${mem3}, false)`);
    await x(sql`insert into nodes (id, owner_id, type, title, path) values
      (${roNote}, ${owner}, 'note', ${`${tag} ro note`}, 'notes')`);
    await homeIn(roNote, ro);
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a pin makes no private workspace; a create does (low)', async () => {
    const pin = await call(`/api/tree/items/${roNote}/pin`, mem3, 'PUT', { pinned: true });
    expect(pin.status, pin.text.slice(0, 200)).toBeLessThan(300);
    expect(await privateOf(mem3)).toBeUndefined();
    const opened = await call(`/api/tree/items/${roNote}/opened`, mem3, 'POST', {});
    expect(opened.status, opened.text.slice(0, 200)).toBeLessThan(500);
    expect(await privateOf(mem3)).toBeUndefined();
    const made = await call('/api/notes', mem3, 'POST', { title: `${tag} first` });
    expect(made.status, made.text.slice(0, 200)).toBeLessThan(300);
    expect(await privateOf(mem3)).toBeTruthy();
  });

  it('H2/M2: a member app from POST /api/apps is at team rules with its author; the admin switches are an Admin user’s', async () => {
    const r = await call('/api/apps', mem, 'POST', { name: `${tag} member app` });
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    const id = idOf(r, 'app');
    const row = async () =>
      (
        await x<{ level: string; author: string | null; mcp: boolean; ro: boolean }>(sql`
          select author_level as level, author_login_id::text as author,
                 mcp_access as mcp, data_read_only as ro
            from apps where node_id = ${id}`)
      )[0]!;
    expect(await row()).toMatchObject({ level: 'team', author: mem });
    expect((await call(`/api/apps/${id}`, mem, 'PATCH', { name: `${tag} renamed` })).status).toBe(
      200,
    );
    for (const body of [{ trustTools: true }, { mcpAccess: true }, { dataReadOnly: true }]) {
      const p = await call(`/api/apps/${id}`, mem, 'PATCH', body);
      expect(p.status, JSON.stringify(body)).toBe(403);
      expect(p.json.reason).toBe('admin-only');
    }
    expect(await row()).toMatchObject({ level: 'team', mcp: false, ro: false });
    // An Admin user's own app: made at admin rules, its switches its own.
    const o = await call('/api/apps', owner, 'POST', { name: `${tag} owner app` });
    const oid = idOf(o, 'app');
    const [oa] = await x<{ level: string; author: string | null }>(sql`
      select author_level as level, author_login_id::text as author from apps where node_id = ${oid}`);
    expect(oa).toEqual({ level: 'admin', author: null });
    expect((await call(`/api/apps/${oid}`, owner, 'PATCH', { mcpAccess: true })).status).toBe(200);
  });

  it('H3: an upload never lands on the bytes of a file its caller cannot read', async () => {
    const secret = await brainText('secret.txt', 'TOP SECRET');
    // A member: the JSON create and a multipart replace are refused, the
    // bytes stay.
    const j = await call('/api/files/files', mem, 'POST', {
      parentPath: 'files',
      filename: 'secret.txt',
      content: 'mine',
    });
    expect(j.status, j.text.slice(0, 200)).toBeGreaterThanOrEqual(400);
    expect(j.status).toBeLessThan(500);
    const mp = await call('/api/files/files', mem, 'POST', form('secret.txt', 'mine', true));
    expect(mp.status, mp.text.slice(0, 200)).toBeGreaterThanOrEqual(400);
    expect(mp.status).toBeLessThan(500);
    expect(await bytesOf(secret)).toBe('TOP SECRET');
    await expect(
      asLogin(mem, () =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: 'secret.txt',
          bytes: Buffer.from('mine'),
          overwrite: true,
        }),
      ),
    ).rejects.toBeInstanceOf(f.FileNameTakenError);
    // An Admin user not in the file's workspace (Side).
    const sideFile = await brainText('side.txt', 'SIDE BYTES');
    await homeIn(sideFile, side);
    const a = await call('/api/files/files', admin2, 'POST', form('side.txt', 'over', true));
    expect(a.status, a.text.slice(0, 200)).toBeGreaterThanOrEqual(400);
    expect(a.status).toBeLessThan(500);
    await expect(
      asLogin(admin2, () =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: 'side.txt',
          bytes: Buffer.from('over'),
          overwrite: true,
        }),
      ),
    ).rejects.toBeInstanceOf(f.FileNameTakenError);
    expect(await bytesOf(sideFile)).toBe('SIDE BYTES');
    // A file it reads but may not change (Ro): refused too.
    const roFile = await brainText('ro.txt', 'RO BYTES');
    await homeIn(roFile, ro);
    await expect(
      asLogin(mem, () =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: 'ro.txt',
          bytes: Buffer.from('over'),
          overwrite: true,
        }),
      ),
    ).rejects.toBeInstanceOf(f.FileNameTakenError);
    expect(await bytesOf(roFile)).toBe('RO BYTES');
  });

  it('H1: a folded file with a brain file’s name (ignoring case): its delete, the watcher and a re-upload touch only its own', async () => {
    const priv = await privateFor(mem);
    // The brain's file and a folded member file whose name differs only in
    // case (the state before this round's fold fix; an exact clash the
    // database's own unique index refuses).
    const brain = await brainText('report.txt', 'BRAIN');
    const treePath = f.diskPathForFile('files', 'report.txt')!;
    const one = await folded('REPORT.txt', 'FOLDED', priv);
    expect(await bytesOf(one.id)).toBe('FOLDED');
    expect(await bytesOf(brain)).toBe('BRAIN');
    // The watcher saw the tree file change: the brain row, never the folded.
    const synced = await sys(() =>
      f.syncFileFromDisk({
        ownerId: owner,
        parentPath: 'files',
        filename: 'report.txt',
        bytes: Buffer.from('BRAIN2'),
      }),
    );
    expect(synced.nodeId).toBe(brain);
    const [oneRow] = await x<{ sha: string }>(
      sql`select data->>'sha256' as sha from nodes where id = ${one.id}`,
    );
    expect(oneRow!.sha).toBe(sha('FOLDED'));
    // Its delete leaves the tree file (the brain's bytes) where it is.
    await writeFile(treePath, 'BRAIN2');
    expect((await sys(() => f.deleteFileById({ ownerId: owner, fileId: one.id }))).ok).toBe(true);
    expect(await readFile(treePath, 'utf8')).toBe('BRAIN2');
    expect(await bytesOf(brain)).toBe('BRAIN2');
    // The watcher's unlink of the tree file deletes the brain row only.
    const two = await folded('REPORT.txt', 'FOLDED2', priv);
    expect(
      (
        await sys(() =>
          f.deleteFileByPath({ ownerId: owner, parentPath: 'files', filename: 'report.txt' }),
        )
      ).ok,
    ).toBe(true);
    expect(await homeOf(brain)).toBeUndefined();
    expect(await bytesOf(two.id)).toBe('FOLDED2');
    // A tree file never takes a folded file's name, any case: an upload is
    // refused (the disk cannot tell), and a rename.
    await expect(
      sys(() =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: 'report.txt',
          bytes: Buffer.from('NEW'),
          overwrite: true,
        }),
      ),
    ).rejects.toThrow(/already exists/);
    const b = await brainText('b.txt', 'B');
    await expect(
      sys(() => f.renameFileById({ ownerId: owner, fileId: b, newStem: 'report' })),
    ).rejects.toThrow(/already exists/);
    expect(await bytesOf(two.id)).toBe('FOLDED2');
    // A re-upload of a folded file's own name: refused without overwrite;
    // with it the bytes go to the tree and it no longer reads the space's.
    const solo = await folded('solo.txt', 'SOLO', priv);
    await expect(
      sys(() =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: 'solo.txt',
          bytes: Buffer.from('NEW'),
        }),
      ),
    ).rejects.toThrow(/already exists/);
    const up = await sys(() =>
      f.upsertFile({
        ownerId: owner,
        parentPath: 'files',
        filename: 'solo.txt',
        bytes: Buffer.from('NEW'),
        overwrite: true,
      }),
    );
    expect(up.id).toBe(solo.id);
    const [after] = await x<{ data: Record<string, unknown> }>(
      sql`select data from nodes where id = ${solo.id}`,
    );
    expect(after!.data.space_file).toBeUndefined();
    expect(await bytesOf(solo.id)).toBe('NEW');
    expect(await readFile(f.diskPathForFile('files', 'solo.txt')!, 'utf8')).toBe('NEW');
    // Nothing removed from the space's directory.
    expect(await readFile(solo.at, 'utf8')).toBe('SOLO');
  });

  it('decision 2: a snapshot copy is read only for everyone; its author deletes it; its responses say so', async () => {
    const priv = await privateFor(mem);
    const of = randomUUID();
    const stamp = {
      snapshot_of: of,
      extract_skipped: { reason: 'snapshot_copy', at: new Date().toISOString() },
    };
    const make = <T>(fn: () => Promise<T>) =>
      sys(() => m.withCreateHome({ createWs: priv, privateWs: null, quiet: true, stamp }, fn));
    const page = await make(() => c.createPage(owner, { title: `${tag} copy page` }));
    const note = await make(() => c.createNote(owner, { title: `${tag} copy note`, content: 'c' }));
    const table = await make(() => c.createTable(owner, { title: `${tag} copy table` }));
    const file = await make(() =>
      f.upsertFile({
        ownerId: owner,
        parentPath: 'files',
        filename: 'copy.txt',
        bytes: Buffer.from('COPY'),
      }),
    );
    for (const id of [page.id, note.id, table.id, file.id]) {
      const [n] = await x<{ data: Record<string, unknown>; home: string; r: string[] }>(sql`
        select data, home_ws::text as home, read_ws::text[] as r from nodes where id = ${id}`);
      // Stamped in its insert (M4), homed in the private workspace only.
      expect(n!.data.snapshot_of).toBe(of);
      expect(n).toMatchObject({ home: priv, r: [priv] });
    }
    // Its responses: readOnly, never editable, its author manages it.
    const got = await call(`/api/pages/${page.id}`, mem);
    expect(got.status).toBe(200);
    expect(got.json.page).toMatchObject({
      readOnly: true,
      snapshotOf: of,
      mayEdit: false,
      mayManage: true,
    });
    const list = await call('/api/notes', mem);
    const row = (list.json.notes as Json[]).find((r) => r.id === note.id);
    expect(row).toMatchObject({ readOnly: true, mayEdit: false, mayManage: true });
    // The routes refuse every edit, for the author and the owner.
    for (const [p, method, body] of [
      [`/api/pages/${page.id}`, 'PATCH', { title: 'x' }],
      [`/api/pages/${page.id}/draft`, 'PUT', { doc: { type: 'doc', content: [] } }],
      [`/api/notes/${note.id}`, 'PATCH', { content: 'x' }],
      [`/api/tables/${table.id}/draft-ops`, 'POST', { ops: [{ op: 'row_add' }] }],
      [`/api/files/files/${file.id}`, 'PATCH', { rename: 'other' }],
    ] as const) {
      const r = await call(p, mem, method, body);
      expect(r.status, `${method} ${p} ${r.text.slice(0, 200)}`).toBe(403);
      expect(r.json.readOnly).toBe(true);
    }
    // The writers below the routes refuse it too (an MCP tool, the
    // rollback switch).
    await expect(
      sys(() => c.applyTableOps(owner, table.id, [{ op: 'row_add' }])),
    ).rejects.toBeInstanceOf(m.SnapshotCopyReadOnlyError);
    await expect(
      sys(() =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: 'copy.txt',
          bytes: Buffer.from('OVER'),
          overwrite: true,
        }),
      ),
    ).rejects.toBeInstanceOf(m.SnapshotCopyReadOnlyError);
    await expect(
      sys(() => f.renameFileById({ ownerId: owner, fileId: file.id, newStem: 'other' })),
    ).rejects.toBeInstanceOf(m.SnapshotCopyReadOnlyError);
    // The database floor: no edit, no new grant, no Write.
    const refused = async (q: ReturnType<typeof sql>) => {
      let err: unknown;
      try {
        await m.withHeads([page.id, note.id], 'update', (tx) => tx.execute(q));
      } catch (e) {
        err = e;
      }
      expect(m.isScopeWriteRefusal(err), String(err)).toBe(true);
    };
    await refused(sql`update nodes set title = 'x' where id = ${note.id}`);
    await refused(
      sql`update nodes set data = data || '{"content":"x"}'::jsonb where id = ${note.id}`,
    );
    await refused(sql`update nodes set data = data - 'snapshot_of' where id = ${note.id}`);
    await refused(
      sql`update pages set doc = '{"type":"doc","content":[]}'::jsonb where node_id = ${page.id}`,
    );
    await refused(
      sql`insert into item_grants (node_id, workspace_id) values (${page.id}, ${team})`,
    );
    await refused(sql`update item_grants set write = true where node_id = ${page.id}`);
    // A move out of its private workspace (into a Team folder) is refused.
    const folder = idOf(
      await call(`/api/tree/pages/folders?ws=${team}`, owner, 'POST', {
        parentId: null,
        name: `${tag} tf`,
      }),
      'folder',
    );
    const mv = await call(`/api/pages/${page.id}/move`, mem, 'POST', {
      folderId: folder,
      confirm: true,
    });
    expect(mv.status, mv.text.slice(0, 200)).toBeGreaterThanOrEqual(400);
    expect((await homeOf(page.id))!.r).toEqual([priv]);
    // Its author deletes it.
    expect((await call(`/api/notes/${note.id}`, mem, 'DELETE')).status).toBe(200);
    expect(await homeOf(note.id)).toBeUndefined();
  });

  it('decision 1: a non-owner’s app delete waits for the owner; the nightly purge skips it', async () => {
    const trash = await import('@mantle/content/app-trash');
    // A member's delete: the brain's delete named as the member's (what the
    // my_app tools' delete did; their library went in A6 round 2).
    const mine = await sys(() => c.createApp(owner, { title: `${tag} held` }));
    await sys(() =>
      c.deleteApp(owner, mine.id, { actor: 'member', deletedBy: { loginId: mem, owner: false } }),
    );
    // A second Admin user's delete through the route.
    const a = idOf(await call('/api/apps', admin2, 'POST', { name: `${tag} a2 app` }), 'app');
    expect((await call(`/api/apps/${a}`, admin2, 'DELETE')).status).toBe(200);
    // The owner's own delete: purged as before.
    const o = idOf(await call('/api/apps', owner, 'POST', { name: `${tag} owner del` }), 'app');
    expect((await call(`/api/apps/${o}`, owner, 'DELETE')).status).toBe(200);
    const meta = async (id: string) =>
      (
        await x<{ held: boolean | null; by: string | null }>(sql`
          select (code->'meta'->>'keepForOwner')::boolean as held, code->'meta'->>'deletedBy' as by
            from node_snapshots where node_id = ${id} and trigger = 'pre_delete'
           order by seq desc limit 1`)
      )[0]!;
    expect(await meta(mine.id)).toEqual({ held: true, by: mem });
    expect(await meta(a)).toEqual({ held: true, by: admin2 });
    expect((await meta(o)).held).toBeNull();
    const listed = await sys(() => trash.listDeletedApps(owner));
    expect(listed.find((d) => d.id === mine.id)!.purgeAfter).toBeNull();
    expect(listed.find((d) => d.id === o)!.purgeAfter).toBeTruthy();
    // The purge by someone other than the owner: refused (route and lib).
    const r = await call(`/api/apps/deleted/${a}`, admin2, 'DELETE');
    expect(r.status, r.text.slice(0, 200)).toBe(403);
    const { purgeDeletedApp } = await import('@mantle/content/test-support/app-trash');
    await expect(sys(() => purgeDeletedApp(owner, a))).rejects.toBeInstanceOf(
      trash.AppTrashRefusedError,
    );
    // The nightly purge, 31 days on: the owner's delete goes, the held ones stay.
    const later = new Date(Date.now() + 31 * 86_400_000);
    await sys(() => trash.purgeExpiredDeletedApps({ now: later }));
    const left = async (id: string) =>
      Number(
        (
          await x<{ n: number }>(
            sql`select count(*)::int as n from node_snapshots where node_id = ${id}`,
          )
        )[0]!.n,
      );
    expect(await left(o)).toBe(0);
    expect(await left(mine.id)).toBeGreaterThan(0);
    expect(await left(a)).toBeGreaterThan(0);
    // The owner purges it.
    expect((await call(`/api/apps/deleted/${a}`, owner, 'DELETE')).status).toBe(200);
    expect(await left(a)).toBe(0);
  });

  it('the shell marks the private workspace; a member opens a file’s detail', async () => {
    const priv = await privateFor(mem);
    const shell = await call('/api/shell', mem);
    expect(shell.status).toBe(200);
    const list = shell.json.workspaces as { id: string; private?: boolean }[];
    expect(list.find((w) => w.id === priv)!.private).toBe(true);
    expect(list.filter((w) => w.private).map((w) => w.id)).toEqual([priv]);
    // A file the member made: its detail, with its caps.
    const r = await call('/api/files/files', mem, 'POST', {
      parentPath: 'files',
      filename: 'mine.txt',
      content: 'MINE',
    });
    expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
    const mine = idOf(r, 'file');
    const d = await call(`/api/files/files/${mine}`, mem);
    expect(d.status, d.text.slice(0, 200)).toBe(200);
    expect(d.json.file).toMatchObject({ id: mine, mayEdit: true, mayManage: true });
    expect(d.json.content).toBe('MINE');
    // Its bytes on the same route since W7e (every login, in its scope).
    expect((await call(`/api/files/files/${mine}?raw=1`, mem)).status).toBe(200);
    // An Admin file: not found for the member.
    const adminFile = await brainText('admin-only.txt', 'ADMIN');
    expect((await call(`/api/files/files/${adminFile}`, mem)).status).toBe(404);
    // The node resolver and a list carry the caps too.
    const n = await call(`/api/nodes/${mine}`, mem);
    expect(n.json.node).toMatchObject({ mayEdit: true, mayManage: true });
    const ro2 = await call(`/api/nodes/${roNote}`, mem);
    expect(ro2.json.node).toMatchObject({ mayEdit: false, mayManage: false });
  });
});
