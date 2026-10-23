/**
 * W6a fix round 1, through the real app (createApp) on a migrated scratch
 * database, with signed session cookies:
 *
 *  - H1: a table's draft (rows, distinct values, the detail) is read only by
 *    a caller who may edit the table: an Admin user with Read only and a
 *    member with Read get the published workbook.
 *  - M1: an Admin user cannot move, purge, restore, bulk-delete or create
 *    into an item or folder homed in a workspace it is not in (the guard,
 *    and the database checks under the login's scope on its transactions).
 *  - M2: GET /api/app-nav lists only the apps of the user's workspaces.
 *  - M3: in a request scope a raw execute runs in the scope; a raw write
 *    goes through executeWrite, which refuses a read.
 *  - L1: item marks are the login's own; traces are the login's own turns
 *    or those of a workspace it moderates.
 *  - L3: no owner GET route shows a draft to a caller who may not edit the
 *    item (pages, drawings, apps, tables; an Admin user with Read only and
 *    a member).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w6a-fix-sweep.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isReadRequest, routeClass } from '../lib/auth/route-scope';
import { isMemberRoute } from '../lib/auth/member-routes';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;

/** Streams that never end, and routes that reach outside this box. */
const SKIP = [
  /\/stream$/,
  /^\/api\/realtime$/,
  /^\/api\/updates/,
  /^\/api\/mcp(\/|$)/,
  /^\/api\/oauth(\/|$)/,
];

describe.skipIf(!URL)('W6a fix round 1: drafts, item writes, app-nav, marks, traces', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let manifest: Array<{ pattern: string; methods: string[] }>;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor, an Admin user
  const mem = randomUUID(); // a member (Team)
  const mem2 = randomUUID(); // a member, Moderator of Side and Ro
  const noUsers = randomUUID(); // an Admin user without the users area
  const tag = `w6f${randomUUID().slice(0, 6)}`;
  const DRAFT = `${tag}draftmark`;
  let team = '';
  let side = '';
  let ro = '';
  let adminWs = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A fixture write to the workspace tables, as the superuser: the app
   *  pools only read them. */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const email = (who: string) => `${tag}-${who}@example.invalid`;

  const call = async (
    p: string,
    as: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ status: number; text: string }> => {
    const res = await Promise.race([
      app.request(p, {
        method,
        headers: { 'content-type': 'application/json', cookie: cookieOf(as) },
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body ?? {}) }),
      }),
      new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
    ]);
    if (!res) return { status: 0, text: 'timeout' };
    return { status: res.status, text: method === 'HEAD' ? '' : await res.text().catch(() => '') };
  };
  const json = (t: string): Json => {
    try {
      return JSON.parse(t) as Json;
    } catch {
      return {};
    }
  };

  const homeIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)
                           on conflict (node_id, workspace_id)
                           do update set is_home = true, via_folder_id = null, excluded = false`);
    });
  };
  const alsoIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id) values (${id}, ${ws})
                           on conflict do nothing`);
    });
  };
  const node = async (type: string, title: string, p: string): Promise<string> => {
    const id = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${id}, ${owner}, ${type}::node_type, ${title}, ${p}::ltree)`);
    return id;
  };
  const exists = async (id: string) =>
    (await x<{ n: number }>(sql`select count(*)::int as n from nodes where id = ${id}`))[0]!.n;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w6a-fix-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'w6a-fix-sweep-secret-at-least-32-characters!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${mem}, ${email('mem')}, 'x', false, 'member', 'Mia Member'),
      (${mem2}, ${email('mem2')}, 'x', false, 'member', 'Max Member'),
      (${noUsers}, ${email('nousers')}, 'x', false, 'admin', 'Nell Nousers')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    adminWs = ws.find((w) => w.key === 'admin')!.id;
    await su(sql`update workspace_users set limits = ${JSON.stringify({ areas: { users: false } })}::jsonb
                 where workspace_id = ${adminWs} and login_id = ${noUsers}`);
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    manifest = (await import('./route-manifest.gen')).routeManifest;
    side = json((await call('/api/workspaces', mem2, 'POST', { name: 'Side' })).text).id as string;
    ro = json((await call('/api/workspaces', mem2, 'POST', { name: 'Ro' })).text).id as string;
    expect(side && ro).toBeTruthy();
    // The Admin user reads Ro but moderates nothing there and has no Write
    // grant in it (Read only); the member reads Side.
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${ro}, ${owner}, false), (${side}, ${mem}, false)`);
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('bench: the scope read with the login row is the scope the lookup builds', async () => {
    const { loadLoginRow } = await import('../lib/auth/login-row');
    for (const login of [owner, mem, mem2]) {
      const looked = await m.loginScopeFor(login); // outside a request: the lookup
      const seeded = await m.runInRequestSlot(async () => {
        await loadLoginRow(login);
        return m.loginScopeFor(login);
      });
      expect(seeded).toEqual(looked);
      expect(seeded.ws.length).toBeGreaterThan(0);
    }
  });

  // ── H1 ────────────────────────────────────────────────────────────────────

  it('H1: a table draft is read only by a caller who may edit the table', async () => {
    const made = await call('/api/tables', owner, 'POST', { title: `${tag} table` });
    expect(made.status, made.text.slice(0, 200)).toBeLessThan(300);
    const tableId = ((json(made.text).table as Json | undefined)?.id ??
      json(made.text).id) as string;
    expect(tableId).toBeTruthy();
    const colId = `c${tag}`;
    const ops = await call(`/api/tables/${tableId}/draft-ops`, owner, 'POST', {
      ops: [
        { op: 'column_add', column: { id: colId, name: 'Name', type: 'text' } },
        { op: 'row_add', cells: { [colId]: DRAFT } },
      ],
    });
    expect(ops.status, ops.text.slice(0, 200)).toBeLessThan(300);
    // An editor (a Moderator of the table's home, Admin) reads the draft.
    const mine = await call(`/api/tables/${tableId}/rows?draft=1`, owner);
    expect(mine.text).toContain(DRAFT);
    expect(json(mine.text).source).toBe('draft');
    expect((await call(`/api/tables/${tableId}`, owner)).text).toContain(DRAFT);

    // Homed in Ro, also in Team: the Admin user has Read only, the member Read.
    await homeIn(tableId, ro);
    await alsoIn(tableId, team);
    for (const who of [owner, mem]) {
      const rows = await call(`/api/tables/${tableId}/rows?draft=1`, who);
      expect(rows.status, rows.text.slice(0, 200)).toBe(200);
      expect(rows.text).not.toContain(DRAFT);
      expect(json(rows.text).source).toBe('published');
      const off = await call(`/api/tables/${tableId}/rows?draft=1&offset=0`, who);
      expect(off.text).not.toContain(DRAFT);
      const distinct = await call(`/api/tables/${tableId}/rows?draft=1&distinct=${colId}`, who);
      expect(distinct.text).not.toContain(DRAFT);
      const detail = await call(`/api/tables/${tableId}`, who);
      expect(detail.status).toBe(200);
      expect(detail.text).not.toContain(DRAFT);
    }
    // The package reads ask the row too (getTable, the tools' window file).
    const content = await import('@mantle/content');
    await m.withViewer({ login: owner }, async () => {
      const t = await content.getTable(owner, tableId);
      expect(JSON.stringify(t)).not.toContain(DRAFT);
    });
    const storage = await import('@mantle/content/table-storage');
    await m.withViewer({ login: owner }, async () => {
      // windowFile (the tools) reads the draft file only when draftOk.
      const surface = await storage.tableSqlSurface(owner, tableId);
      expect(surface?.draftOk).toBe(false);
    });
    // Back home in Admin: the editor reads its draft again.
    await homeIn(tableId, adminWs);
    expect((await call(`/api/tables/${tableId}/rows?draft=1`, owner)).text).toContain(DRAFT);
  }, 120_000);

  // ── M1 ────────────────────────────────────────────────────────────────────

  it('M1: an Admin user cannot create into, move into or out of, or bulk-delete in a workspace it is not in', async () => {
    await x(sql`insert into nodes (owner_id, type, title, path)
                values (${owner}, 'branch', 'Notes', 'notes'::ltree) on conflict do nothing`);
    const sideFolder = await node('branch', `${tag} side folder`, 'notes.sidef');
    await homeIn(sideFolder, side);
    const adminNote = await node('note', `${tag} admin note`, 'notes');
    const sideNote = await node('note', `${tag} side note`, 'notes');
    await homeIn(sideNote, side);
    const sideInFolder = await node('note', `${tag} side in folder`, 'notes.sidef');

    // Create a folder in the Side folder: refused, nothing made.
    const before = (
      await x<{ n: number }>(sql`select count(*)::int as n from nodes where path <@ 'notes.sidef'`)
    )[0]!.n;
    const mk = await call('/api/tree/notes/folders', owner, 'POST', {
      parentId: sideFolder,
      name: 'inner',
    });
    // Since F4 the request reads in its scope: a folder it does not read is
    // not found (the 403 item-workspace before, which told it existed).
    expect(mk.status, mk.text.slice(0, 200)).toBe(404);
    const after = (
      await x<{ n: number }>(sql`select count(*)::int as n from nodes where path <@ 'notes.sidef'`)
    )[0]!.n;
    expect(after).toBe(before);

    // Move an Admin note into the Side folder: refused (may_edit the folder).
    const into = await call('/api/tree/notes/move', owner, 'POST', {
      ids: [adminNote],
      folderId: sideFolder,
      confirm: true,
    });
    const pathOf = async (id: string) =>
      (await x<{ p: string }>(sql`select path::text as p from nodes where id = ${id}`))[0]!.p;
    expect(await pathOf(adminNote), into.text.slice(0, 200)).toBe('notes');
    // Refused: the folder is not found in its scope since F4 (403 before).
    expect(
      [403, 404].includes(into.status) || (json(into.text).failed as unknown[] | undefined)?.length,
      `${into.status} ${into.text.slice(0, 200)}`,
    ).toBeTruthy();

    // Move a Side note out to the top: refused (may_manage its home).
    const out = await call('/api/tree/notes/move', owner, 'POST', {
      ids: [sideInFolder],
      folderId: null,
      confirm: true,
    });
    expect(await pathOf(sideInFolder), out.text.slice(0, 200)).toBe('notes.sidef');

    // Delete (the item route) and bulk delete (ids in the body): refused.
    expect((await call(`/api/notes/${sideNote}`, owner, 'DELETE')).status).toBe(404);
    expect(await exists(sideNote)).toBe(1);
    const sideFile = await node('file', `${tag} side file`, 'files');
    await homeIn(sideFile, side);
    const bulk = await call('/api/files/files', owner, 'DELETE', { ids: [sideFile] });
    // F4: a file its scope does not read is not among what it deletes (it
    // reads in its scope): nothing deleted, nothing said of the file (403
    // before, which told it existed).
    expect(bulk.status, bulk.text.slice(0, 200)).toBe(200);
    expect(json(bulk.text).deleted).toBe(0);
    expect(await exists(sideFile)).toBe(1);

    // Its own workspaces: a folder, a move and a delete go through.
    const ok = await call('/api/tree/notes/folders', owner, 'POST', {
      parentId: null,
      name: 'mine',
    });
    expect(ok.status, ok.text.slice(0, 200)).toBeLessThan(300);
    const adminFile = await node('file', `${tag} admin file`, 'files');
    const bulkOk = await call('/api/files/files', owner, 'DELETE', { ids: [adminFile] });
    expect(bulkOk.status, bulkOk.text.slice(0, 200)).toBe(200);
    expect(await exists(adminFile)).toBe(0);
  }, 120_000);

  it('M1: a deleted app is purged and restored only by a Moderator of its home', async () => {
    const apps = await import('@mantle/content');
    const sideApp = await apps.createApp(owner, { title: `${tag} side app` });
    await homeIn(sideApp.id, side);
    await apps.deleteApp(owner, sideApp.id);
    const snap = await x<{ home: string | null }>(sql`
      select s.code->'meta'->>'homeWs' as home from node_snapshots s
       where s.node_id = ${sideApp.id} and s.trigger = 'pre_delete'`);
    expect(snap[0]?.home).toBe(side);
    // Not its home's Moderator: the one 404, as an app it does not read
    // (F4 fix round 1; a 403 item-workspace before).
    const purge = await call(`/api/apps/deleted/${sideApp.id}`, owner, 'DELETE');
    expect(purge.status, purge.text.slice(0, 200)).toBe(404);
    expect(json(purge.text)).toEqual({ ok: false, error: 'not found' });
    const restore = await call(`/api/apps/deleted/${sideApp.id}/restore`, owner, 'POST');
    expect(restore.status, restore.text.slice(0, 200)).toBe(404);
    expect(await exists(sideApp.id)).toBe(0);
    const kept = await x<{ n: number }>(
      sql`select count(*)::int as n from node_snapshots where node_id = ${sideApp.id}`,
    );
    expect(kept[0]!.n).toBeGreaterThan(0);

    // An app of its own workspace: purged.
    const mineApp = await apps.createApp(owner, { title: `${tag} admin app` });
    await apps.deleteApp(owner, mineApp.id);
    const ok = await call(`/api/apps/deleted/${mineApp.id}`, owner, 'DELETE');
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
  }, 120_000);

  it('M1: tasks, recall maps and shares of a workspace it is not in are refused', async () => {
    const task = await node('task', `${tag} side task`, 'tasks');
    await homeIn(task, side);
    for (const [method, p, body] of [
      ['PATCH', `/api/tasks/${task}`, { title: 'x' }],
      ['DELETE', `/api/tasks/${task}`, {}],
      ['PATCH', `/api/v1/tasks/${task}`, { title: 'x' }],
    ] as const) {
      const r = await call(p, owner, method, body);
      // F4: not found (403 item-workspace before).
      expect(r.status, `${method} ${p} ${r.text.slice(0, 120)}`).toBe(404);
    }
    const shareId = randomUUID();
    const noteForShare = await node('note', `${tag} shared side note`, 'notes');
    await homeIn(noteForShare, side);
    await x(sql`insert into shares (id, owner_id, node_id, node_type, token)
                values (${shareId}, ${owner}, ${noteForShare}, 'note', ${`${tag}tok`})`);
    // Changing the link is refused; closing it is not: an Admin user with
    // the users area may close any link (docs/workspaces.md, A0).
    // F4: the link of an item the scope does not read is not found (403
    // before), but for the users area's close.
    const change = await call(`/api/shares/${shareId}`, owner, 'PATCH', { serve: [] });
    expect(change.status, change.text.slice(0, 120)).toBe(404);
    const shut = await call(`/api/shares/${shareId}`, noUsers, 'DELETE');
    expect(shut.status, shut.text.slice(0, 120)).toBe(404);
    const revoke = await call(`/api/shares/${shareId}`, owner, 'DELETE');
    expect(revoke.status, revoke.text.slice(0, 120)).toBe(200);
    expect(json(revoke.text).ok).toBe(true);
  }, 60_000);

  it('A0: a link needs edit to change or close (an app: manage), as the guide says', async () => {
    // Homed in Side (mem2 moderates), granted to Ro with Write on: the
    // Admin user (a user of Ro) edits these items but does not manage them.
    const grantWrite = async (id: string) =>
      m.withHeads([id], 'update', async (tx) => {
        await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                             values (${id}, ${ro}, true)
                             on conflict (node_id, workspace_id) do update set write = true`);
      });
    const linkOn = async (id: string, type: string) => {
      const sid = randomUUID();
      await x(sql`insert into shares (id, owner_id, node_id, node_type, token)
                  values (${sid}, ${owner}, ${id}, ${type}, ${`${tag}${sid.slice(0, 8)}`})`);
      return sid;
    };
    const note = await node('note', `${tag} a0 link note`, 'notes');
    await homeIn(note, side);
    await grantWrite(note);
    const noteLink = await linkOn(note, 'note');
    // noUsers is no user of Ro: it may not read the note, so it may not close
    // the link either (no users area): not found since F4 (403 before).
    const shut = await call(`/api/shares/${noteLink}`, noUsers, 'DELETE');
    expect(shut.status, shut.text.slice(0, 120)).toBe(404);
    const change = await call(`/api/shares/${noteLink}`, owner, 'PATCH', { serve: [] });
    expect(change.status, change.text.slice(0, 200)).toBe(200);

    const apps = await import('@mantle/content');
    const app = await apps.createApp(owner, { title: `${tag} a0 link app` });
    await homeIn(app.id, side);
    await grantWrite(app.id);
    const appLink = await linkOn(app.id, 'app');
    const appChange = await call(`/api/shares/${appLink}`, owner, 'PATCH', { serve: [] });
    expect(appChange.status, appChange.text.slice(0, 200)).toBe(403);
    expect(appChange.text).toContain('item-workspace');
  }, 60_000);

  // ── M2 ────────────────────────────────────────────────────────────────────

  it('M2: the Apps sidebar lists only apps of the user’s workspaces', async () => {
    const apps = await import('@mantle/content');
    const mine = await apps.createApp(owner, { title: `${tag} nav admin app` });
    const theirs = await apps.createApp(owner, { title: `${tag} nav side app` });
    await homeIn(theirs.id, side);
    const r = await call('/api/app-nav', owner);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.text).toContain(mine.id);
    expect(r.text).not.toContain(theirs.id);
  }, 60_000);

  // ── M3 ────────────────────────────────────────────────────────────────────

  it('M3: a raw read never leaves the request scope; executeWrite refuses a read', async () => {
    const sideNote = await node('note', `${tag} m3 side note`, 'notes');
    await homeIn(sideNote, side);
    const scope = await m.loginScopeFor(owner);
    await m.runInRequestSlot(async () => {
      m.enterRequestScope(scope, { writes: false, drafts: true });
      // A statement the old router took for a write (a row lock) reads in
      // the scope now: the Side note is not there, or the role is refused.
      const read = await m.db
        .execute(sql`select id from nodes where id = ${sideNote} for update`)
        .then((rows) => (rows as unknown as unknown[]).length)
        .catch(() => 0);
      expect(read).toBe(0);
      const plain = (await m.db.execute(
        sql`select id from nodes where id = ${sideNote}`,
      )) as unknown as unknown[];
      expect(plain.length).toBe(0);
      expect(() => m.executeWrite(sql`select 1`)).toThrow(m.NotAWriteError);
      await m.executeWrite(sql`select pg_notify('w6a_fix_probe', 'x')`);
    });
  });

  // ── L1 ────────────────────────────────────────────────────────────────────

  it('L1: marks are the login’s own; traces the login’s own turns or a moderated workspace’s', async () => {
    const shared = await node('note', `${tag} marked`, 'notes');
    await alsoIn(shared, side);
    await x(sql`insert into item_marks (actor_id, node_id, open_count, opened_at) values
                (${mem}, ${shared}, 1, now()), (${mem2}, ${shared}, 1, now())`);
    const marksOf = (login: string) =>
      m.withViewer({ login }, async () =>
        (
          (await m.db.execute(
            sql`select actor_id::text as a from item_marks where node_id = ${shared}`,
          )) as unknown as { a: string }[]
        ).map((r) => r.a),
      );
    expect(await marksOf(mem)).toEqual([mem]);
    expect(await marksOf(mem2)).toEqual([mem2]);

    const t1 = randomUUID();
    const t2 = randomUUID();
    const t3 = randomUUID();
    await x(sql`insert into traces (id, owner_id, kind, workspace_id, login_id) values
                (${t1}, ${owner}, 'responder_turn', ${side}, ${mem2}),
                (${t2}, ${owner}, 'responder_turn', ${side}, ${mem}),
                (${t3}, ${owner}, 'responder_turn', null, null)`);
    const tracesOf = (login: string) =>
      m.withViewer({ login }, async () =>
        (
          (await m.db.execute(
            sql`select id::text as id from traces where id in (${t1}, ${t2}, ${t3}) order by id`,
          )) as unknown as { id: string }[]
        ).map((r) => r.id),
      );
    // mem reads Side but moderates nothing: its own turn only.
    expect(await tracesOf(mem)).toEqual([t2]);
    // mem2 moderates Side: both Side turns, not the system one.
    expect(await tracesOf(mem2)).toEqual([t1, t2].sort());
    // The Admin user moderates Admin: the unstamped (system) one.
    const mine = await tracesOf(owner);
    expect(mine).toContain(t3);
    expect(mine).not.toContain(t1);
  });

  // ── L3 ────────────────────────────────────────────────────────────────────

  it('L3: no owner GET shows a draft to a caller who may not edit the item', async () => {
    const doc = (text: string) =>
      JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      });
    const page = await node('page', `${tag} l3 page`, 'pages');
    await x(sql`insert into pages (node_id, doc, draft_doc, draft_rev, draft_updated_at)
                values (${page}, ${doc('published')}::jsonb, ${doc(DRAFT)}::jsonb, 1, now())`);
    const draw = await node('draw', `${tag} l3 draw`, 'draws');
    await x(sql`insert into draws (node_id, scene, draft_scene, draft_rev, draft_updated_at)
                values (${draw}, '{"elements":[]}'::jsonb,
                        ${JSON.stringify({ elements: [{ text: DRAFT }] })}::jsonb, 1, now())`);
    const apps = await import('@mantle/content');
    const appRow = await apps.createApp(owner, { title: `${tag} l3 app` });
    await x(sql`update apps set draft_source = ${JSON.stringify({ files: { 'App.tsx': DRAFT } })}::jsonb,
                               draft_updated_at = now()
                 where node_id = ${appRow.id}`);
    const ids = [page, draw, appRow.id];
    for (const id of ids) {
      await homeIn(id, ro);
      await alsoIn(id, team);
    }
    const failures: string[] = [];
    let calls = 0;
    for (const e of manifest) {
      if (!e.methods.includes('GET') || SKIP.some((re) => re.test(e.pattern))) continue;
      if (routeClass(e.pattern)?.kind !== 'content' || !isReadRequest('GET', e.pattern)) continue;
      if (isMemberRoute('GET', e.pattern) || e.pattern.startsWith('/api/client/')) continue;
      const segs = e.pattern.split('/');
      const paths = segs.includes(':id')
        ? ids.map((id) =>
            segs
              .map((s) =>
                s === ':id' ? id : s === ':kind' ? 'pages' : s.startsWith(':') ? 'x' : s,
              )
              .join('/'),
          )
        : [segs.map((s) => (s === ':kind' ? 'pages' : s.startsWith(':') ? 'x' : s)).join('/')];
      for (const p of paths) {
        for (const who of [owner, mem]) {
          const r = await call(`${p}${p.includes('?') ? '&' : '?'}draft=1`, who);
          calls += 1;
          if (r.text.includes(DRAFT)) failures.push(`${who === owner ? 'admin' : 'member'} ${p}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(calls).toBeGreaterThan(100);
    // The editor still reads them (Admin, back home).
    await homeIn(page, adminWs);
    expect((await call(`/api/pages/${page}`, owner)).text).toContain(DRAFT);
  }, 900_000);

  // ── Fix round 2 ───────────────────────────────────────────────────────────

  it('M-a: the integrity delete removes the node and its traces (no 500)', async () => {
    const note = await node('note', `${tag} landed note`, 'notes');
    const trace = randomUUID();
    await x(sql`insert into traces (id, owner_id, kind, subject_id)
                values (${trace}, ${owner}, 'responder_turn', ${note})`);
    const r = await call('/api/debug/integrity/landed/delete', owner, 'POST', { nodeId: note });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(json(r.text).ok).toBe(true);
    expect(await exists(note)).toBe(0);
    const left = await x<{ n: number }>(
      sql`select count(*)::int as n from traces where id = ${trace}`,
    );
    expect(left[0]!.n).toBe(0);
    // An id no row has: the handler's own answer, not a 500.
    const gone = await call('/api/debug/integrity/landed/delete', owner, 'POST', {
      nodeId: randomUUID(),
    });
    expect(gone.status, gone.text.slice(0, 200)).toBe(400);
  }, 60_000);

  it('L-a: a files create in a folder of a workspace it is not in is refused, telling nothing of the folder (F4)', async () => {
    // Since F4 the request reads in its scope: the folder is not found, the
    // answer of a parent path no row has (403 item-workspace before, which
    // told the folder existed). Never the database's own words.
    await call('/api/files/folders', owner, 'GET');
    const folder = await node('branch', `${tag} side files`, 'files.w6af2side');
    await homeIn(folder, side);
    const mk = await call('/api/files/folders', owner, 'POST', {
      parentPath: 'files.w6af2side',
      slug: 'inner',
    });
    const none = await call('/api/files/folders', owner, 'POST', {
      parentPath: 'files.w6af2nosuch',
      slug: 'inner',
    });
    expect(mk.status, mk.text.slice(0, 200)).toBe(none.status);
    expect(mk.text.replace('w6af2side', 'X')).toBe(none.text.replace('w6af2nosuch', 'X'));
    expect(mk.text).not.toContain('not allowed');
    const file = await call('/api/files/files', owner, 'POST', {
      parentPath: 'files.w6af2side',
      filename: 'note.txt',
      content: 'hello',
      confirm: true,
    });
    const fileNone = await call('/api/files/files', owner, 'POST', {
      parentPath: 'files.w6af2nosuch',
      filename: 'note.txt',
      content: 'hello',
      confirm: true,
    });
    expect(file.status, file.text.slice(0, 200)).toBe(fileNone.status);
    expect(file.status).toBeGreaterThanOrEqual(400);
    expect(file.text.replace('w6af2side', 'X')).toBe(fileNone.text.replace('w6af2nosuch', 'X'));
    const made = await x<{ n: number }>(
      sql`select count(*)::int as n from nodes where path <@ 'files.w6af2side' and id <> ${folder}`,
    );
    expect(made[0]!.n).toBe(0);
  }, 60_000);

  it('L-b: a deleted app with no stored home is purged and restored by the owner only', async () => {
    const admin2 = randomUUID();
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
                values (${admin2}, ${email('admin2')}, 'x', false, 'admin', 'Ada Admin')`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${adminWs}, ${admin2}, true) on conflict do nothing`);
    const apps = await import('@mantle/content');
    const stripHome = (id: string) =>
      x(sql`update node_snapshots set code = code #- '{meta,homeWs}'
             where node_id = ${id} and trigger = 'pre_delete'`);

    // Homed in Admin and stored: a Moderator of Admin (not the owner) purges it.
    const stored = await apps.createApp(owner, { title: `${tag} l-b stored` });
    await apps.deleteApp(owner, stored.id);
    const ok = await call(`/api/apps/deleted/${stored.id}`, admin2, 'DELETE');
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);

    // No home stored: refused for that Admin user, both ways, with the one
    // 404 (F4 fix round 1; a 403 item-workspace before).
    const old = await apps.createApp(owner, { title: `${tag} l-b old` });
    await apps.deleteApp(owner, old.id);
    await stripHome(old.id);
    const purge = await call(`/api/apps/deleted/${old.id}`, admin2, 'DELETE');
    expect(purge.status, purge.text.slice(0, 200)).toBe(404);
    expect(json(purge.text)).toEqual({ ok: false, error: 'not found' });
    const restore = await call(`/api/apps/deleted/${old.id}/restore`, admin2, 'POST');
    expect(restore.status, restore.text.slice(0, 200)).toBe(404);
    expect(await exists(old.id)).toBe(0);
    // The owner restores it.
    const back = await call(`/api/apps/deleted/${old.id}/restore`, owner, 'POST');
    expect(back.status, back.text.slice(0, 200)).toBeLessThan(300);
    expect(await exists(old.id)).toBe(1);
  }, 120_000);

  it('L-c: a request scope notes its system transactions', async () => {
    const scope = await m.loginScopeFor(owner);
    const writes = await m.runInRequestSlot(async () => {
      m.enterRequestScope(scope, { writes: false, drafts: true });
      await m.withSystemTx(async (tx) => tx.execute(sql`select 1`));
      return m.requestSystemWrites();
    });
    expect(writes.some((w) => w.startsWith('withSystemTx '))).toBe(true);
    expect(writes.join('\n')).toContain('w6a-fix-sweep.db.test.ts');
  });

  it('L-d: profiles: the login’s own row and the brain’s, every row only in an Admin scope', async () => {
    await x(sql`insert into profiles (user_id) values (${owner}), (${mem}), (${mem2})
                on conflict (user_id) do nothing`);
    const rowsFor = (login: string) =>
      m.withViewer({ login }, async () =>
        (
          (await m.db.execute(
            sql`select user_id::text as u from profiles
                 where user_id in (${owner}, ${mem}, ${mem2}) order by 1`,
          )) as unknown as { u: string }[]
        ).map((r) => r.u),
      );
    expect(await rowsFor(mem)).toEqual([owner, mem].sort());
    expect(await rowsFor(mem2)).toEqual([owner, mem2].sort());
    expect(await rowsFor(owner)).toEqual([owner, mem, mem2].sort());
  });

  it('pages: the block-id repair lands from a request scope, and never runs inside a transaction', async () => {
    const bare = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'no ids yet' }] }],
    });
    const mkPage = async (title: string) => {
      const id = await node('page', title, 'pages');
      await x(sql`insert into pages (node_id, doc, draft_doc, draft_rev, draft_updated_at)
                  values (${id}, ${bare}::jsonb, ${bare}::jsonb, 1, now())`);
      return id;
    };
    const hasIds = async (id: string) =>
      (
        await x<{ d: string }>(sql`select draft_doc::text as d from pages where node_id = ${id}`)
      )[0]!.d.includes('"id"');
    const settle = async (id: string, want: boolean) => {
      for (let i = 0; i < 40 && (await hasIds(id)) !== want; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return hasIds(id);
    };

    // An Admin user's GET (its request scope): the repair goes to the system
    // pool (it failed on the workspace role before).
    const viaRoute = await mkPage(`${tag} backfill route`);
    const r = await call(`/api/pages/${viaRoute}`, owner);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(await settle(viaRoute, true)).toBe(true);

    // Inside a system transaction: no repair; the next plain read makes it.
    const pagesApi = await import('@mantle/content/pages');
    const inTx = await mkPage(`${tag} backfill tx`);
    const read = await m.withSystemTx(async () => pagesApi.getPage(owner, inTx));
    expect(read?.id).toBe(inTx);
    await new Promise((r) => setTimeout(r, 300));
    expect(await hasIds(inTx)).toBe(false);
    await pagesApi.getPage(owner, inTx);
    expect(await settle(inTx, true)).toBe(true);
  }, 60_000);
});
