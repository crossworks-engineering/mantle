/**
 * Folder counts as each caller sees them (task b6e4a8aa; workspaces arch
 * plan v2, A8 surface cells against the oracle's `expectedFolderCount`,
 * packages/db/src/matrix/oracle.ts). Through the real app (a session cookie
 * per login, GET /api/tree/notes with and without `?ws=`) and the real MCP
 * surface (the Admin-only `tree_folders` tool).
 *
 * The fixture: folders F and G, homed in H and granted to S. F holds three
 * notes, two of them "Removed here" for S: S reads one of three. G holds
 * three notes and a subfolder, all "Removed here" for S: S reads nothing in
 * G, which still shows (an Admin user shares empty folders to give a
 * workspace its structure). The callers: a member (a user of S), an Admin
 * user who is a user of S, and an Admin user who is a user of H and S.
 *
 * Each count must also be what the folder shows when opened in the same
 * scope (the one count path). Subfolders are not narrowed by `?ws=`: the
 * folder list keeps every folder the caller reads (W5b2 contract 14).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/folder-count-cells.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expectedFolderCount,
  type FolderCountCaller,
  type FolderCountCase,
  type FolderCountScope,
} from '@mantle/db/matrix/oracle';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, any>;
type Counts = { itemCount: number; folderCount: number };

const CASES: readonly FolderCountCase[] = ['oneOfThree', 'noneShared'];
const CALLERS: readonly FolderCountCaller[] = ['member', 'adminUser', 'adminUserInHome'];
const SCOPES: readonly FolderCountScope[] = ['all', 'S'];

describe.skipIf(!DB_URL)('A8 cells: folder counts are the caller’s', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let dir = '';
  const tag = `fc${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const login: Record<FolderCountCaller, string> = {
    member: randomUUID(),
    adminUser: randomUUID(),
    adminUserInHome: randomUUID(),
  };
  const cookie: Partial<Record<FolderCountCaller, string>> = {};
  const ws = { H: randomUUID(), S: randomUUID() };
  /** Each case's folder and its path. */
  const folder: Record<FolderCountCase, string> = { oneOfThree: '', noneShared: '' };
  const pathOf: Record<FolderCountCase, string> = {
    oneOfThree: `notes.${tag}_one`,
    noneShared: `notes.${tag}_none`,
  };
  /** The subfolder of G, not read by S. */
  let sub = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A new row under `parent` (heads first, `share` on the folder). */
  const insert = (parent: string, id: string, type: string, title: string, at: string) =>
    m.withHeads([parent], 'share', (tx) =>
      tx.execute(sql`insert into nodes (id, owner_id, type, title, path, data)
        values (${id}, ${owner}, ${type}::node_type, ${title}, ${at}::ltree,
                ${type === 'note' ? '{"content":"x"}' : '{}'}::jsonb)`),
    );
  /** Home H and a grant to S (a folder passes the grant on to what it holds). */
  const homeH = (id: string) =>
    m.withSubtreeHeads(id, [], async (tx) => {
      await tx.execute(
        sql`delete from item_grants where node_id = ${id} and via_folder_id is null`,
      );
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home) values
        (${id}, ${ws.H}, true), (${id}, ${ws.S}, false)`);
    });
  /** "Remove from this workspace": S marked "Removed here" on `id`. */
  const removeFromS = (id: string) =>
    m.withSubtreeHeads(id, [], (tx) =>
      tx.execute(sql`insert into item_grants (node_id, workspace_id, excluded)
        values (${id}, ${ws.S}, true)
        on conflict (node_id, workspace_id) do update set excluded = true, via_folder_id = null`),
    );

  const get = async (who: FolderCountCaller, url: string): Promise<Json> => {
    const res = await app.request(url, { headers: { cookie: cookie[who]! } });
    const text = await res.text();
    expect(res.status, `${who} GET ${url}: ${text.slice(0, 200)}`).toBe(200);
    return JSON.parse(text) as Json;
  };
  const wsQuery = (scope: FolderCountScope) => (scope === 'S' ? `&ws=${ws.S}` : '');

  /** The counts the root lists for each case's folder, as `who` in `scope`;
   *  null for a folder the root does not list. */
  const listed = async (who: FolderCountCaller, scope: FolderCountScope) => {
    const root = await get(who, `/api/tree/notes?sort=name${wsQuery(scope)}`);
    const by = new Map((root.folders as Json[]).map((f) => [f.id as string, f]));
    const out = {} as Record<FolderCountCase, Counts | null>;
    for (const c of CASES) {
      const f = by.get(folder[c]);
      out[c] = f ? { itemCount: f.itemCount, folderCount: f.folderCount } : null;
    }
    return out;
  };
  /** What the folder shows when `who` opens it in `scope`. */
  const opened = async (who: FolderCountCaller, scope: FolderCountScope, id: string) => {
    const page = await get(who, `/api/tree/notes?folder=${id}&sort=name${wsQuery(scope)}`);
    expect(page.folder?.id).toBe(id);
    return {
      shown: {
        itemCount: (page.items as Json[]).length,
        folderCount: (page.folders as Json[]).length,
      },
      self: { itemCount: page.folder.itemCount, folderCount: page.folder.folderCount },
    };
  };

  const mcpFolders = async (who: FolderCountCaller): Promise<Map<string, Json>> => {
    const ls = await import('@mantle/mcp-core');
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(
      server,
      await ls.prepareCallerTools({
        role: 'admin',
        anchorId: owner,
        loginId: login[who],
        via: 'oauth',
        write: false,
      }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'test-client', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    try {
      const res = (await m.runAsActor(m.loginActor(login[who], 'ro'), () =>
        c.callTool({ name: 'tree_folders', arguments: { kind: 'notes' } }),
      )) as { isError?: boolean; content?: { text?: string }[] };
      expect(res.isError, JSON.stringify(res.content)).not.toBe(true);
      const rows = JSON.parse(res.content![0]!.text!) as Json[];
      return new Map(rows.map((r) => [r.id as string, r]));
    } finally {
      await c.close();
    }
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'folder-counts-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'folder-count-cells-secret-at-least-32-characters';
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    const email = (who: string) => `${tag}-${who}@example.invalid`;
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${email('o')}, 'x', true, 'admin'),
      (${login.member}, ${email('m')}, 'x', false, 'member'),
      (${login.adminUser}, ${email('a')}, 'x', false, 'admin'),
      (${login.adminUserInHome}, ${email('h')}, 'x', false, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    await x(sql`insert into workspaces (id, owner_id, name) values
      (${ws.H}, ${owner}, ${`${tag} H`}), (${ws.S}, ${owner}, ${`${tag} S`})`);
    await x(sql`insert into workspace_users (workspace_id, login_id) values
      (${ws.S}, ${login.member}), (${ws.S}, ${login.adminUser}),
      (${ws.S}, ${login.adminUserInHome}), (${ws.H}, ${login.adminUserInHome})`);
    // The member's Team seat would not change a cell (nothing is granted to
    // Team); taken out so its scope is exactly S.
    await x(sql`delete from workspace_users u using workspaces w
      where w.id = u.workspace_id and w.bridge_key = 'team' and u.login_id = ${login.member}`);
    // Both Admin users sit in Admin (the switch seats admin rows).
    const seated = await x<{ n: number }>(sql`select count(*)::int as n
      from workspace_users u join workspaces w on w.id = u.workspace_id and w.is_admin
      where u.login_id in (${login.adminUser}, ${login.adminUserInHome})`);
    expect(seated[0]!.n).toBe(2);

    const tree = await import('@mantle/content/tree');
    await tree.ensureKindRoot(owner, 'notes');
    const [root] = await x<{ id: string }>(sql`select id::text as id from nodes
      where owner_id = ${owner} and type = 'branch' and path = 'notes'::ltree`);
    for (const c of CASES) {
      const id = randomUUID();
      folder[c] = id;
      await insert(root!.id, id, 'branch', `${tag} ${c}`, pathOf[c]);
      await homeH(id);
      for (let i = 0; i < 3; i += 1) {
        const note = randomUUID();
        await insert(id, note, 'note', `${tag} ${c} ${i}`, pathOf[c]);
        // S keeps the first note of "one of three", none of "none shared".
        if (c === 'noneShared' || i > 0) await removeFromS(note);
      }
      if (c === 'noneShared') {
        sub = randomUUID();
        await insert(id, sub, 'branch', `${tag} sub`, `${pathOf[c]}.sub`);
        await removeFromS(sub);
      }
    }
    const tokens = await import('../lib/auth/tokens');
    for (const who of CALLERS) {
      cookie[who] = `mantle_session=${tokens.buildSessionCookie(login[who]).value}`;
    }
    const { createApp } = await import('./app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the fixture: H is the home of all, S reads one note of F and nothing in G', async () => {
    const rows = await x<{ path: string; s: boolean; home: string }>(sql`
      select path::text as path, ${ws.S}::uuid = any(read_ws) as s, home_ws::text as home
        from nodes
       where owner_id = ${owner}
         and (path <@ ${pathOf.oneOfThree}::ltree or path <@ ${pathOf.noneShared}::ltree)`);
    // Two folders, six notes, one subfolder.
    expect(rows.length).toBe(9);
    for (const r of rows) expect(r.home).toBe(ws.H);
    const sReads = (c: FolderCountCase) =>
      rows.filter((r) => (r.path === pathOf[c] || r.path.startsWith(`${pathOf[c]}.`)) && r.s)
        .length;
    // F's own row and one note; G's own row only.
    expect(sReads('oneOfThree')).toBe(4 - 2);
    expect(sReads('noneShared')).toBe(1);
  });

  it('the tree (http): each caller and scope gets the oracle’s count, and opening shows it', async () => {
    const failures: string[] = [];
    for (const who of CALLERS) {
      for (const scope of SCOPES) {
        const got = await listed(who, scope);
        for (const c of CASES) {
          const want = expectedFolderCount(c, who, scope);
          const cell = `${who} ${scope} ${c}`;
          const row = got[c];
          if (!row) {
            failures.push(`${cell}: not listed, the oracle shows it`);
            continue;
          }
          if (row.itemCount !== want.items) {
            failures.push(`${cell}: ${row.itemCount} items, the oracle says ${want.items}`);
          }
          const open = await opened(who, scope, folder[c]);
          if (JSON.stringify(open.shown) !== JSON.stringify(row)) {
            failures.push(
              `${cell}: lists ${JSON.stringify(row)}, opens to ${JSON.stringify(open.shown)}`,
            );
          }
          if (JSON.stringify(open.self) !== JSON.stringify(row)) {
            failures.push(`${cell}: the open folder says ${JSON.stringify(open.self)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('a subfolder the caller does not read is not counted', async () => {
    for (const who of ['member', 'adminUser'] as const) {
      for (const scope of SCOPES) {
        expect((await listed(who, scope)).noneShared, `${who} ${scope}`).toEqual({
          itemCount: 0,
          folderCount: 0,
        });
      }
    }
    // A user of H reads it. `?ws=` keeps the folders (contract 14), so the
    // count stays what opening G shows.
    expect((await listed('adminUserInHome', 'all')).noneShared).toEqual({
      itemCount: 3,
      folderCount: 1,
    });
    expect((await listed('adminUserInHome', 'S')).noneShared).toEqual({
      itemCount: 0,
      folderCount: 1,
    });
  }, 60_000);

  it('the MCP tree_folders tool (Admin only, all the login’s workspaces) gives the same counts', async () => {
    for (const who of ['adminUser', 'adminUserInHome'] as const) {
      const rows = await mcpFolders(who);
      for (const c of CASES) {
        const want = expectedFolderCount(c, who, 'all');
        expect(rows.get(folder[c]), `${who} ${c}`).toMatchObject({ items: want.items });
      }
      expect(rows.get(folder.noneShared)?.subfolders, who).toBe(who === 'adminUser' ? 0 : 1);
      expect(rows.has(sub), who).toBe(who === 'adminUserInHome');
    }
  }, 60_000);
});
