/**
 * Workspaces W6b fix round 2, through the real app (createApp) on a migrated
 * scratch database with signed session cookies, through the MCP surface and
 * through the libraries the routes call:
 *
 *  - M-1: a snapshot copy (table, drawing, file) is deleted by its author
 *    and by the owner; an app-bound table is still refused;
 *  - M-2: app_delete holds the app for the owner unless the caller is the
 *    brain's anchor login: the assistant tool (the web turn's login), MCP
 *    (an OAuth login) and an API key (its login);
 *  - L-1: a snapshot copy carries no link and no contact share (the
 *    libraries and the database);
 *  - L-3: the files watcher skips a disk file that takes a folded member
 *    file's name (any case);
 *  - L-4: a snapshot copy's file row made first by the watcher is stamped
 *    and homed by its create;
 *  - GET /api/shell answers isOwner, true only for the anchor login.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w6b-fix2.db.test.ts
 */
import { randomUUID, createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;

describe.skipIf(!URL)('W6b fix round 2', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let c: typeof import('@mantle/content');
  let support: typeof import('@mantle/content/test-support');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor
  const admin2 = randomUUID(); // a second Admin user, not the owner
  const mem = randomUUID(); // a member
  const tag = `w6bg${randomUUID().slice(0, 6)}`;

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
    const res = await app.request(p, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookieOf(as) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
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
  const rowOf = async (id: string) =>
    (
      await x<{ home: string | null; r: string[]; w: string[]; data: Json }>(sql`
        select home_ws::text as home, read_ws::text[] as r, write_ws::text[] as w, data
          from nodes where id = ${id}`)
    )[0];
  const privateFor = async (login: string) =>
    (
      await x<{ ws: string }>(
        sql`select "public"."mantle_ws_private_workspace"(set_config('mantle.scope_login', ${login}, true)::uuid)::text as ws`,
      )
    )[0]!.ws;
  const idOf = (r: { json: Json }, key: string) =>
    ((r.json[key] as Json | undefined)?.id ?? r.json.id) as string;
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn, 'test');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  /** A snapshot copy's stamp (as snapshot-copies.ts makes it). */
  const stampOf = (of: string) => ({
    snapshot_of: of,
    extract_skipped: { reason: 'snapshot_copy', at: new Date().toISOString() },
  });
  // As snapshot-copies.ts makes one: its system work (a raced copy's home
  // is mantle_file_restamp_home's, which takes that actor only, 0313).
  const makeCopy = <T>(home: string, of: string, fn: () => Promise<T>) =>
    m.systemWork(
      () =>
        m.withCreateHome({ createWs: home, privateWs: null, quiet: true, stamp: stampOf(of) }, fn),
      'snapshot-copies',
    );
  /** A folded member file (W6b): its row in `files`, its bytes in its old
   *  space's directory. */
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
  const filesNamed = async (name: string) =>
    Number(
      (
        await x<{ n: number }>(sql`
          select count(*)::int as n from nodes
           where type = 'file' and path = 'files' and lower(data->>'filename') = lower(${name})`)
      )[0]!.n,
    );

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w6b-fix2-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'w6b-fix2-secret-at-least-32-characters!!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    c = await import('@mantle/content');
    support = await import('@mantle/content/test-support');
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${admin2}, ${email('admin2')}, 'x', false, 'admin', 'Ada Admin'),
      (${mem}, ${email('mem')}, 'x', false, 'member', 'Mia Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    await m.asSystem(() => f.ensureFilesRootBranch(owner), 'test');
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('M-1: a snapshot copy (table, drawing, file) is deleted by its author and by the owner', async () => {
    const priv = await privateFor(mem);
    const copies = async (n: string) => {
      const of = randomUUID();
      const table = await makeCopy(priv, of, () =>
        c.createTable(owner, { title: `${tag} copy table ${n}` }),
      );
      const draw = await makeCopy(priv, of, () =>
        c.createDraw(owner, { title: `${tag} copy draw ${n}` }),
      );
      const file = await makeCopy(priv, of, () =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: `copy-${n}.txt`,
          bytes: Buffer.from('COPY'),
        }),
      );
      for (const id of [table.id, draw.id, file.id]) {
        expect((await rowOf(id))!.data.snapshot_of).toBe(of);
      }
      return { table: table.id, draw: draw.id, file: file.id };
    };
    // Its author, through the routes.
    const a = await copies('a');
    for (const [p, id] of [
      [`/api/tables/${a.table}`, a.table],
      [`/api/draws/${a.draw}`, a.draw],
      [`/api/files/files/${a.file}`, a.file],
    ] as const) {
      const r = await call(p, mem, 'DELETE');
      expect(r.status, `DELETE ${p} ${r.text.slice(0, 200)}`).toBe(200);
      expect(await rowOf(id)).toBeUndefined();
    }
    // The owner, through the routes: the workspace rule holds for it as for
    // any Admin user (a private workspace's item is not found until it
    // joins that workspace: a 404 since F4, 403 item-workspace before);
    // joined as its Moderator, it deletes the copies.
    const o = await copies('o');
    const before = await call(`/api/tables/${o.table}`, owner, 'DELETE');
    expect(before.status, before.text.slice(0, 200)).toBe(404);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${priv}, ${owner}, true)`);
    for (const [p, id] of [
      [`/api/tables/${o.table}`, o.table],
      [`/api/draws/${o.draw}`, o.draw],
      [`/api/files/files/${o.file}`, o.file],
    ] as const) {
      const r = await call(p, owner, 'DELETE');
      expect(r.status, `DELETE ${p} ${r.text.slice(0, 200)}`).toBe(200);
      expect(await rowOf(id)).toBeUndefined();
    }
    await su(sql`delete from workspace_users where workspace_id = ${priv} and login_id = ${owner}`);
    // The owner's tools (MCP, the system pool): the table delete no longer
    // refuses a copy; its grid writes still do.
    const l = await copies('l');
    await expect(
      sys(() => c.applyTableOps(owner, l.table, [{ op: 'row_add' }])),
    ).rejects.toBeInstanceOf(m.SnapshotCopyReadOnlyError);
    expect(await sys(() => c.deleteTable(owner, l.table))).toBe(true);
    expect(await sys(() => c.deleteDraw(owner, l.draw))).toBe(true);
    expect((await sys(() => f.deleteFileById({ ownerId: owner, fileId: l.file }))).ok).toBe(true);
    for (const id of [l.table, l.draw, l.file]) expect(await rowOf(id)).toBeUndefined();
    // An app-bound table is still refused (the split kept that check).
    const bound = await sys(() => c.createTable(owner, { title: `${tag} bound` }));
    const appId = idOf(await call('/api/apps', owner, 'POST', { name: `${tag} binder` }), 'app');
    await x(sql`insert into app_table_exports (owner_id, app_node_id, table_node_id, sqlite_table)
                values (${owner}, ${appId}, ${bound.id}, 'items')`);
    await expect(sys(() => c.deleteTable(owner, bound.id))).rejects.toBeInstanceOf(
      c.AppBoundTableError,
    );
  });

  it('M-2: app_delete holds the app unless the caller is the anchor login (assistant, MCP, API key)', async () => {
    const tools = await import('@mantle/tools');
    const del = tools.APP_TOOLS.find((t) => t.slug === 'app_delete')!;
    const trash = await import('@mantle/content/app-trash');
    const newApp = async (n: string) =>
      idOf(await call('/api/apps', owner, 'POST', { name: `${tag} ${n}` }), 'app');
    const meta = async (id: string) =>
      (
        await x<{ held: boolean | null; by: string | null }>(sql`
          select (code->'meta'->>'keepForOwner')::boolean as held, code->'meta'->>'deletedBy' as by
            from node_snapshots where node_id = ${id} and trigger = 'pre_delete'
           order by seq desc limit 1`)
      )[0]!;
    const purgeAfter = async (id: string) =>
      (await sys(() => trash.listDeletedApps(owner))).find((d) => d.id === id)!.purgeAfter;

    // The assistant tool: the web turn names its signed-in login.
    const runTool = async (id: string, surface: import('@mantle/tools').ToolSurface) => {
      const r = await sys(() => del.handler({ id }, { ownerId: owner, surface }));
      expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true);
    };
    const t1 = await newApp('turn owner');
    await runTool(t1, { kind: 'web', loginId: owner });
    expect((await meta(t1)).held).toBeNull();
    expect(await purgeAfter(t1)).toBeTruthy();
    const t2 = await newApp('turn admin2');
    await runTool(t2, { kind: 'web', loginId: admin2 });
    expect(await meta(t2)).toEqual({ held: true, by: admin2 });
    expect(await purgeAfter(t2)).toBeNull();
    // A path that names no login (a Telegram turn, a run, stdio): held.
    const t3 = await newApp('turn none');
    await runTool(t3, { kind: 'telegram', telegramChatId: '1' });
    expect(await meta(t3)).toEqual({ held: true, by: null });
    expect(await purgeAfter(t3)).toBeNull();

    // MCP: the owner surface carries the connection's login.
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const ls = await import('@mantle/mcp-core');
    const connect = async (caller: import('@mantle/mcp-core').McpCaller) => {
      const server = new McpServer({ name: 'test', version: '0' });
      ls.registerPreparedTools(server, await ls.prepareCallerTools(caller));
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '0' });
      await Promise.all([server.connect(a), client.connect(b)]);
      return client;
    };
    const viaMcp = async (caller: import('@mantle/mcp-core').McpCaller, id: string) => {
      const client = await connect(caller);
      const r = (await client.callTool({ name: 'app_delete', arguments: { id } })) as {
        isError?: boolean;
        content?: { text?: string }[];
      };
      expect(r.isError, JSON.stringify(r.content).slice(0, 200)).toBeFalsy();
      await client.close();
    };
    const base = { role: 'admin' as const, anchorId: owner, write: true };
    const m1 = await newApp('mcp owner');
    await viaMcp({ ...base, loginId: owner, via: 'oauth' }, m1);
    expect((await meta(m1)).held).toBeNull();
    const m2 = await newApp('mcp admin2');
    await viaMcp({ ...base, loginId: admin2, via: 'oauth' }, m2);
    expect(await meta(m2)).toEqual({ held: true, by: admin2 });

    // An API key acting as the owner (via 'key', the app_delete risk named).
    const key = { via: 'key' as const, riskyAllowed: ['app_delete'], areas: null, keyId: 'k1' };
    const k1 = await newApp('key owner');
    await viaMcp({ ...base, ...key, loginId: owner }, k1);
    expect((await meta(k1)).held).toBeNull();
    expect(await purgeAfter(k1)).toBeTruthy();
    const k2 = await newApp('key admin2');
    await viaMcp({ ...base, ...key, loginId: admin2 }, k2);
    expect(await meta(k2)).toEqual({ held: true, by: admin2 });
    expect(await purgeAfter(k2)).toBeNull();

    // The nightly purge, 31 days on: the anchor's deletes go, the held stay.
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
    for (const id of [t1, m1, k1]) expect(await left(id)).toBe(0);
    for (const id of [t2, t3, m2, k2]) expect(await left(id)).toBeGreaterThan(0);
  });

  it('L-1: a snapshot copy carries no link and no contact share; the database refuses it too', async () => {
    const priv = await privateFor(mem);
    const copy = await makeCopy(priv, randomUUID(), () =>
      c.createPage(owner, { title: `${tag} copy for links` }),
    );
    // Its author may edit nothing of it, and may not link it.
    await expect(c.assertMayLink(owner, mem, copy.id)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    const r = await call('/api/shares', mem, 'POST', { nodeId: copy.id });
    expect(r.status, r.text.slice(0, 200)).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    await expect(sys(() => c.createShare(owner, copy.id))).rejects.toBeInstanceOf(
      c.ShareInputError,
    );
    await expect(
      sys(() => support.createContactShares(owner, copy.id, [randomUUID()])),
    ).rejects.toBeInstanceOf(c.ContactShareRefusedError);
    // The database floor: no share row on a copy, made or moved onto it.
    const refused = async (q: ReturnType<typeof sql>) => {
      let err: unknown;
      try {
        await x(q);
      } catch (e) {
        err = e;
      }
      expect(m.isScopeWriteRefusal(err), String(err)).toBe(true);
    };
    await refused(sql`insert into shares (token, owner_id, node_id, node_type)
                      values (${randomUUID()}, ${owner}, ${copy.id}, 'page')`);
    const page = await sys(() => c.createPage(owner, { title: `${tag} linkable` }));
    const share = await sys(() => c.createShare(owner, page.id));
    await refused(sql`update shares set node_id = ${copy.id} where id = ${share.id}`);
    // A revoke always passes.
    expect(await sys(() => c.revokeShare(owner, share.id))).toBe(true);
    const n = await x<{ n: number }>(
      sql`select count(*)::int as n from shares where node_id = ${copy.id}`,
    );
    expect(n[0]!.n).toBe(0);
  });

  it('L-3: the watcher skips a disk file that takes a folded member file’s name, any case', async () => {
    const priv = await privateFor(mem);
    const one = await folded('Clash.txt', 'FOLDED', priv);
    for (const name of ['clash.txt', 'Clash.txt', 'CLASH.TXT']) {
      const r = await sys(() =>
        f.syncFileFromDisk({
          ownerId: owner,
          parentPath: 'files',
          filename: name,
          bytes: Buffer.from('DISK'),
        }),
      );
      expect(r, name).toEqual({ status: 'skipped', nodeId: null });
    }
    expect(await filesNamed('clash.txt')).toBe(1);
    const [row] = await x<{ sha: string }>(
      sql`select data->>'sha256' as sha from nodes where id = ${one.id}`,
    );
    expect(row!.sha).toBe(sha('FOLDED'));
    expect(await readFile(one.at, 'utf8')).toBe('FOLDED');
    // Another name in the folder still syncs.
    const other = await sys(() =>
      f.syncFileFromDisk({
        ownerId: owner,
        parentPath: 'files',
        filename: 'unclashed.txt',
        bytes: Buffer.from('NEW'),
      }),
    );
    expect(other.status).toBe('inserted');
  });

  it('L-4: a copy’s file row the watcher made first is stamped and homed by its create', async () => {
    const priv = await privateFor(mem);
    const of = randomUUID();
    const name = 'raced-copy.txt';
    const disk = f.diskPathForFile('files', name)!;
    const watcherRow = randomUUID();
    let upsert: Promise<{ id: string }> | undefined;
    // The watcher's row, inserted in a transaction held open while the
    // copy's create writes its bytes and reaches its own insert: that insert
    // waits on this row, then finds it (the race path).
    await m.systemDb.transaction(async (tx) => {
      await tx.execute(sql`insert into nodes (id, owner_id, type, title, slug, path, data, tags)
        values (${watcherRow}, ${owner}, 'file', ${name}, ${name}, 'files', ${JSON.stringify({
          filename: name,
          extension: 'txt',
          mime_type: 'text/plain',
          size_bytes: 4,
          sha256: sha('COPY'),
          content: 'COPY',
        })}::jsonb, '{file}')`);
      upsert = makeCopy(priv, of, () =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: name,
          bytes: Buffer.from('COPY'),
        }),
      );
      // The create has written its bytes (its lookup saw no row): it is at
      // or near its insert now.
      for (let i = 0; i < 200; i++) {
        if (
          await access(disk).then(
            () => true,
            () => false,
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 300));
    });
    const made = await upsert!;
    // The create landed on the watcher's row (the race path).
    expect(made.id).toBe(watcherRow);
    const row = (await rowOf(made.id))!;
    expect(row.data.snapshot_of).toBe(of);
    expect((row.data.extract_skipped as Json).reason).toBe('snapshot_copy');
    expect({ home: row.home, r: row.r, w: row.w }).toEqual({ home: priv, r: [priv], w: [] });
    expect(await filesNamed(name)).toBe(1);
    // Read only now, as its own insert would have made it.
    await expect(
      sys(() =>
        f.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: name,
          bytes: Buffer.from('OVER'),
          overwrite: true,
        }),
      ),
    ).rejects.toBeInstanceOf(m.SnapshotCopyReadOnlyError);
    const r = await call(`/api/files/files/${made.id}`, mem, 'PATCH', { rename: 'other' });
    expect(r.status, r.text.slice(0, 200)).toBe(403);
  });

  it('GET /api/shell answers isOwner: true for the anchor login only', async () => {
    const of = async (as: string) => {
      const r = await call('/api/shell', as);
      expect(r.status, r.text.slice(0, 200)).toBe(200);
      return r.json.isOwner;
    };
    expect(await of(owner)).toBe(true);
    expect(await of(admin2)).toBe(false);
    expect(await of(mem)).toBe(false);
  });
});
