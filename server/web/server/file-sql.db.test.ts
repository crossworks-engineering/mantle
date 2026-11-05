/**
 * file_sql on a migrated scratch database and a real files root: real databases
 * written by buildFileDatabase, read through the tool, in every scope it meets.
 * An app's calls go through the one app tool broker (lib/app-tool-broker.ts) as
 * its routes configure it, with the real verdict, gate and scope.
 *
 *  1. the rows and the tabs of a real database, and table_sql's refusals;
 *  2. the refusal's system step runs in each scope: a plain viewer, a turn, an
 *     app run and a system caller; in a scope's open transaction it stays the
 *     step's fault, and no rows;
 *  3. the shared refusal: a flagged folder the member cannot read, a flip on the
 *     next read, an email attachment below Admin, a drive-synced file;
 *  4. E's answers on real rows, in order;
 *  5. rights: no read of the row gets no rows and no path, on the app broker, a
 *     read-only login and a contact share;
 *  6. the broker gate, with the line and without, at admin and team rules, and
 *     app_tools_set.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/file-sql.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordAppAccess: vi.fn(),
  recordAppError: vi.fn(),
  recordShareAccess: vi.fn(),
}));

type Answer = { status: number; body: { ok: boolean; error?: string; output?: unknown } };
type Rows = { columns: string[]; rows: unknown[][]; row_count: number; truncated?: boolean };
type Tabs = { tabs: { name: string; columns: { name: string }[] }[]; description?: string };

const CSV = 'Tag,Size\nV-101,150\nV-102,200\nV-103,250\n';

describe.skipIf(!URL)('file_sql', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let files: typeof import('@mantle/files');
  let content: typeof import('@mantle/content');
  let build: typeof import('@mantle/content/file-database').buildFileDatabase;
  let broker: typeof import('@/lib/app-tool-broker');
  let dir = '';
  const tag = `fsql${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  /** A user of the holder workspace, who reads its files. */
  const member = randomUUID();
  /** A user of another workspace, who reads none of them. */
  const outsider = randomUUID();
  let adminWs = '';
  let holderWs = '';
  let otherWs = '';
  let teamApp = '';
  let adminApp = '';
  let open = '';
  /** A folder only Admin reads, marked metadata. */
  let flaggedHidden = '';
  let csvFile = '';

  const SLUGS = ['file_sql', 'table_sql', 'table_alias', 'calculate'];

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn, 'test');

  const grants = async (id: string, rows: [string, boolean, boolean][]) =>
    m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      for (const [ws, write, home] of rows) {
        await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
          values (${id}, ${ws}, ${write}, ${home})`);
      }
    });

  /** A file in `folder` that the holder workspace reads. */
  const upload = async (name: string, bytes: string | Buffer, folder = open) =>
    sys(async () => {
      const file = await m.withCreateHome(
        { createWs: holderWs, privateWs: null, quiet: true },
        () =>
          files.upsertFile({
            ownerId: owner,
            parentPath: folder,
            filename: name,
            bytes: Buffer.from(bytes),
          }),
      );
      // In the holder's folder it takes that home. Anywhere else, the holder
      // reads it by a grant of its own.
      if (folder !== open) {
        await m.withHeads([file.id], 'update', (tx) =>
          tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
            values (${file.id}, ${holderWs}, false, false)
            on conflict (node_id, workspace_id) do nothing`),
        );
      }
      return file.id;
    });
  const sha256Of = (bytes: string | Buffer) =>
    createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  /** Its database, built as the extract builds it. */
  const buildDb = async (fileId: string, name: string, bytes: string | Buffer = CSV) => {
    const out = await sys(() =>
      build({
        fileId,
        ownerId: owner,
        sha256: sha256Of(bytes),
        bytes: Buffer.from(bytes),
        filename: name,
      }),
    );
    expect(out, name).toMatchObject({ status: 'built' });
  };
  const setData = (id: string, patch: Record<string, unknown>) =>
    x(sql`update nodes set data = data || ${JSON.stringify(patch)}::jsonb where id = ${id}`);
  const uploadWithDb = async (name: string, folder = open) => {
    const id = await upload(name, CSV, folder);
    await buildDb(id, name);
    return id;
  };
  /** A file with a database in the flagged folder: the writer skips a private
   *  file, so the file's own flag lifts it for the build, then goes. */
  const hiddenWithDb = async (name: string) => {
    const id = await upload(name, CSV, flaggedHidden);
    await setData(id, { indexing: 'full' });
    await buildDb(id, name);
    await x(sql`update nodes set data = data - 'indexing' where id = ${id}`);
    return id;
  };

  const def = () => t.BUILTIN_TOOLS.find((d) => d.slug === 'file_sql')!;
  const handler = (id: string, input: Record<string, unknown> = {}) =>
    def().handler({ file_id: id, ...input }, { ownerId: owner });

  const asViewer = (login: string, id: string, input?: Record<string, unknown>) =>
    m.withViewer({ login }, () => handler(id, input));
  const errorAs = async (login: string, id: string) => {
    const res = await asViewer(login, id);
    if (res.ok) throw new Error(`expected a refusal, got ${JSON.stringify(res.output)}`);
    return res.error;
  };
  const errorOf = async (id: string) => {
    const res = await sys(() => handler(id));
    if (res.ok) throw new Error(`expected a refusal, got ${JSON.stringify(res.output)}`);
    return res.error;
  };

  /** `fn` in `login`'s request scope, as the session guard enters it. */
  const inRequest = async <T>(
    login: string,
    fn: () => Promise<T>,
    mode: 'rw' | 'ro' = 'rw',
  ): Promise<T> => {
    const scope = await m.viewerScopeFor({ login });
    return m.runInRequestSlot(
      async () => {
        if (!m.enterRequestScope(scope, { writes: mode === 'rw', drafts: true })) {
          throw new Error('the request scope was not entered');
        }
        return fn();
      },
      { startsAs: m.loginActor(login, mode) },
    ) as Promise<T>;
  };
  const request = (slug: string, input: Record<string, unknown>) =>
    new Request('http://brain.invalid/api/apps/x/tool-broker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, input }),
    });
  const answer = async (res: Response): Promise<Answer> => ({
    status: res.status,
    body: (await res.json()) as Answer['body'],
  });
  /** A member's run of the team app, by the one broker. */
  const memberCall = (
    login: string,
    slug: string,
    input: Record<string, unknown>,
    mode: 'rw' | 'ro' = 'rw',
  ) =>
    inRequest(
      login,
      async () =>
        answer(
          await broker.runAppToolBroker(request(slug, input), {
            via: 'member',
            ownerId: owner,
            runner: { loginId: login, name: 'Runner' },
            maxBytes: 8 * 1024 * 1024,
            fileMaxBytes: 24 * 1024 * 1024,
            app: async () => ({ id: teamApp, manifest: { toolSlugs: SLUGS } }),
            system: (fn) => m.asSystem(fn, 'app-data'),
          }),
        ),
      mode,
    );
  const linkCall = (slug: string, input: Record<string, unknown>) =>
    sys(async () =>
      answer(
        await broker.runAppToolBroker(request(slug, input), {
          via: 'contact',
          ownerId: owner,
          share: { id: randomUUID(), contactId: randomUUID() },
          served: async () => [teamApp],
          app: async () => ({ id: teamApp, manifest: { toolSlugs: SLUGS } }),
        }),
      ),
    );

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'file-sql-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    m.openLoginWritePool({ max: 2 });
    t = await import('@mantle/tools');
    files = await import('@mantle/files');
    content = await import('@mantle/content');
    build = (await import('@mantle/content/file-database')).buildFileDatabase;
    broker = await import('@/lib/app-tool-broker');

    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${member}, ${`${tag}-u@example.invalid`}, 'x', false, 'member', 'Member'),
      (${outsider}, ${`${tag}-x@example.invalid`}, 'x', false, 'member', 'Outsider')`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    holderWs = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Holder`}) returning id::text`)
    )[0]!.id;
    otherWs = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Other`}) returning id::text`)
    )[0]!.id;
    await su(sql`delete from workspace_users where login_id in (${member}, ${outsider})`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${holderWs}, ${member}, false),
      (${otherWs}, ${outsider}, false)`);
    await sys(() => t.seedBuiltinTools(owner));
    await x(sql`insert into tools (owner_id, slug, name, description, handler, requires_confirm)
      values (${owner}, 'table_alias', 'n', 'd', '{"kind":"builtin","ref":"table_sql"}'::jsonb, false)`);
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled)
      values (${owner}, ${`${tag}-reads`}, 'Reads', ${`{${SLUGS.join(',')}}`}::text[], 'team', true)`);

    await sys(async () => {
      await files.ensureFilesRootBranch(owner);
      const folder = async (slug: string, rows: [string, boolean, boolean][]) => {
        const f = await m.withCreateHome({ createWs: adminWs, privateWs: null, quiet: true }, () =>
          files.createFolder({ ownerId: owner, parentPath: 'files', slug }),
        );
        await grants(f.id, rows);
        return f;
      };
      open = (await folder(`${tag}-open`, [[holderWs, true, true]])).path;
      const flagged = await folder(`${tag}-flagged`, [[adminWs, true, true]]);
      flaggedHidden = flagged.path;
      await setData(flagged.id, { indexing: 'metadata' });
    });

    const app = async (slug: string, holds: [string, boolean, boolean][]) => {
      const id = randomUUID();
      await x(sql`insert into nodes (id, owner_id, type, title, path)
        values (${id}, ${owner}, 'app', ${`${tag} ${slug}`}, 'apps')`);
      await x(sql`insert into apps (node_id, manifest)
        values (${id}, ${JSON.stringify({ toolSlugs: SLUGS })}::jsonb)`);
      await grants(id, holds);
      return id;
    };
    teamApp = await app('team', [[holderWs, false, true]]);
    adminApp = await app('admin', [[adminWs, false, true]]);
    csvFile = await uploadWithDb(`${tag}-valves.csv`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('a real database', () => {
    it('answers a SELECT with columns and rows', async () => {
      const res = await asViewer(member, csvFile, {
        sql: 'SELECT "Tag" FROM "Sheet1" ORDER BY "Tag"',
      });
      expect(res).toMatchObject({ ok: true });
      const out = (res as { output: Rows }).output;
      expect(out.columns).toEqual(['Tag']);
      expect(out.rows).toEqual([['V-101'], ['V-102'], ['V-103']]);
      expect(out.row_count).toBe(3);
    });

    it('with no sql gives the tabs and the columns', async () => {
      const res = await asViewer(member, csvFile);
      expect(res).toMatchObject({ ok: true });
      const out = (res as { output: Tabs }).output;
      expect(out.tabs).toHaveLength(1);
      expect(out.tabs[0]!.columns.map((c) => c.name)).toEqual(['Tag', 'Size']);
      expect(JSON.stringify(out)).not.toContain('table_sql');
    });

    it("keeps table_sql's refusals and row cap, under its own name", async () => {
      for (const statement of ['ATTACH DATABASE "x" AS y', 'PRAGMA table_info("Sheet1")']) {
        const res = await asViewer(member, csvFile, { sql: statement });
        expect(res, statement).toMatchObject({ ok: false });
        const error = (res as { error: string }).error;
        expect(error, statement).toContain('file_sql');
        expect(error, statement).not.toContain('table_sql');
        expect(error, statement).not.toContain(dir);
      }
      const capped = await asViewer(member, csvFile, {
        sql: 'SELECT "Tag" FROM "Sheet1"',
        max_rows: 2,
      });
      expect((capped as { output: Rows }).output).toMatchObject({ row_count: 2, truncated: true });
    });

    it('a statement that fails names no path', async () => {
      const res = await asViewer(member, csvFile, { sql: 'SELECT nope FROM "Sheet1"' });
      expect(res).toMatchObject({ ok: false });
      expect((res as { error: string }).error).not.toContain(dir);
    });
  });

  describe('the system step, in every scope file_sql meets', () => {
    const readsRows = (res: { ok: boolean }) => {
      expect(res).toMatchObject({ ok: true });
      expect(((res as unknown as { output: Rows }).output.rows ?? []).length).toBeGreaterThan(0);
    };
    const ask = () => handler(csvFile, { sql: 'SELECT "Tag" FROM "Sheet1"' });

    it('a plain viewer scope', async () => {
      readsRows(await m.withViewer({ login: member }, ask));
    });

    it('a request scope, read-only too', async () => {
      readsRows(await inRequest(member, ask));
      readsRows(await inRequest(member, ask, 'ro'));
    });

    it("an assistant's turn scope", async () => {
      const scope = { kind: 'assistant' as const, loginId: null, ws: [holderWs], modWs: [] };
      readsRows(await m.withTurnScope(scope, ask));
    });

    it('a turn, through dispatchTool, with a caller that holds team-read', async () => {
      const { MANIFEST_TOOL_GROUPS } = await import('@/lib/system-manifest/manifest');
      const group = MANIFEST_TOOL_GROUPS.find((g) => g.slug === 'team-read');
      expect(group?.toolSlugs).toContain('file_sql');
      const scope = { kind: 'assistant' as const, loginId: null, ws: [holderWs], modWs: [] };
      const tool = {
        slug: 'file_sql',
        name: def().name,
        description: def().description,
        handler: { kind: 'builtin', ref: 'file_sql' },
        inputSchema: def().inputSchema,
        requiresConfirm: false,
      } as unknown as import('@mantle/db').Tool;
      readsRows(
        await m.withTurnScope(scope, () =>
          t.dispatchTool(
            tool,
            { file_id: csvFile, sql: 'SELECT "Tag" FROM "Sheet1"' },
            {
              ownerId: owner,
              surface: { kind: 'team', loginId: member, privateReads: false },
              caller: t.turnCaller(),
            },
          ),
        ),
      );
    });

    it('an app run, by the broker', async () => {
      const res = await memberCall(member, 'file_sql', {
        file_id: csvFile,
        sql: 'SELECT "Tag" FROM "Sheet1"',
      });
      expect(res).toMatchObject({ status: 200, body: { ok: true } });
    });

    it("a system caller, the owner's stdio MCP", async () => {
      readsRows(await sys(ask));
    });

    it("a scope's open transaction is the step's fault, and gives no rows", async () => {
      const scope = { kind: 'assistant' as const, loginId: null, ws: [holderWs], modWs: [] };
      await expect(m.withScope(scope, ask)).rejects.toThrow(/inside an open transaction/);
    });

    it("a row's own flag needs no chain, so it answers in that transaction too", async () => {
      const id = await uploadWithDb(`${tag}-own-full.csv`);
      const scope = { kind: 'assistant' as const, loginId: null, ws: [holderWs], modWs: [] };
      await setData(id, { indexing: 'full' });
      expect(await m.withScope(scope, () => handler(id, { sql: 'SELECT 1 AS one' }))).toMatchObject(
        { ok: true },
      );
      await setData(id, { indexing: 'metadata' });
      const res = await m.withScope(scope, () => handler(id));
      expect((res as { error: string }).error).toMatch(/stay out of the brain/);
    });

    it('the list form takes one step over many rows', async () => {
      const a = await uploadWithDb(`${tag}-list-a.csv`);
      const b = await hiddenWithDb(`${tag}-list-b.csv`);
      const rows = await sys(async () => [
        (await files.fileDataRow(owner, a))!,
        (await files.fileDataRow(owner, b))!,
      ]);
      const out = await m.withViewer({ login: member }, () => files.fileDataRefusals(owner, rows));
      expect(out.get(a)).toBeUndefined();
      expect(out.get(b)?.code).toBe('private');
    });
  });

  describe('the shared refusal', () => {
    it('a member with a file in a flagged folder they cannot read is refused', async () => {
      const id = await hiddenWithDb(`${tag}-hidden.csv`);
      // The member reads the row, and not the folder that holds the flag.
      const row = await m.withViewer({ login: member }, () => files.fileDataRow(owner, id));
      expect(row?.id).toBe(id);
      const folderSeen = await m.withViewer({ login: member }, () =>
        m.db.execute(
          sql`select 1 from nodes where path = ${flaggedHidden}::ltree and type = 'branch'`,
        ),
      );
      expect(folderSeen).toHaveLength(0);
      expect(await errorAs(member, id)).toBe(
        'This file is set to stay out of the brain. Set its indexing to full to read it.',
      );
      // Its own flag overrides the folder's.
      await setData(id, { indexing: 'full' });
      expect((await asViewer(member, id)).ok).toBe(true);
    });

    it('a flip takes effect on the next read, and back', async () => {
      const id = await uploadWithDb(`${tag}-flip.csv`);
      expect((await asViewer(member, id)).ok).toBe(true);
      await setData(id, { indexing: 'metadata' });
      expect(await errorAs(member, id)).toMatch(/stay out of the brain/);
      expect(await errorOf(id)).toMatch(/stay out of the brain/);
      await setData(id, { indexing: 'full' });
      expect((await asViewer(member, id)).ok).toBe(true);
    });

    it('an email attachment is refused below Admin, and read by an Admin user', async () => {
      const inbox = await sys(async () => {
        const home = { createWs: holderWs, privateWs: null, quiet: true };
        const mail = await m.withCreateHome(home, () =>
          files.createFolder({ ownerId: owner, parentPath: 'files', slug: `${tag}-inbox` }),
        );
        await grants(mail.id, [[holderWs, true, true]]);
        const f = await m.withCreateHome(home, () =>
          files.createFolder({ ownerId: owner, parentPath: mail.path, slug: 'attachments' }),
        );
        return f.path;
      });
      const id = await uploadWithDb(`${tag}-mail.csv`, inbox);
      await setData(id, { emailAttachment: true });
      // Admin reads it too: an Admin user meets no refusal.
      await m.withHeads([id], 'update', (tx) =>
        tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
          values (${id}, ${adminWs}, false, false)`),
      );
      expect(await errorAs(member, id)).toBe(
        'This file is an email attachment: only an Admin user may read its rows.',
      );
      expect((await asViewer(owner, id, { sql: 'SELECT 1 AS one' })).ok).toBe(true);
    });

    it('a key on an Admin login: the drawing tools follow Files, and no Search means no attachment', async () => {
      const inbox = await sys(async () => {
        const home = { createWs: holderWs, privateWs: null, quiet: true };
        const mail = await m.withCreateHome(home, () =>
          files.createFolder({ ownerId: owner, parentPath: 'files', slug: `${tag}-keyinbox` }),
        );
        await grants(mail.id, [
          [holderWs, true, true],
          [adminWs, false, false],
        ]);
        const f = await m.withCreateHome(home, () =>
          files.createFolder({ ownerId: owner, parentPath: mail.path, slug: 'attachments' }),
        );
        return f.path;
      });
      const name = `${tag}-keymail.dwg`;
      const id = await upload(name, 'an attached drawing', inbox);
      await setData(id, { emailAttachment: true });
      await m.withHeads([id], 'update', (tx) =>
        tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
          values (${id}, ${adminWs}, false, false) on conflict do nothing`),
      );

      const mcp = await import('@mantle/mcp-core');
      const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
      const { Client } = await import('@modelcontextprotocol/client');
      const trace = async (areas: string[] | null) => {
        const prepared = await mcp.prepareCallerTools({
          role: 'admin',
          anchorId: owner,
          loginId: owner,
          via: 'key',
          write: false,
          areas,
          riskyAllowed: [],
        } as import('@mantle/mcp-core').McpCaller);
        const server = new McpServer({ name: 'test', version: '0' });
        mcp.registerPreparedTools(server, prepared);
        const [a, b] = InMemoryTransport.createLinkedPair();
        const c = new Client({ name: 'file-sql', version: '0' });
        await Promise.all([server.connect(a), c.connect(b)]);
        try {
          const listed = (await c.listTools()).tools.map((tool) => tool.name);
          if (!listed.includes('circuit_trace')) return { listed, text: '' };
          const reply = await c.callTool({ name: 'circuit_trace', arguments: { circuit: 'K-1' } });
          return { listed, text: JSON.stringify(reply) };
        } finally {
          await c.close();
        }
      };

      const tablesKey = await trace(['tables']);
      expect(tablesKey.listed).not.toContain('circuit_trace');

      const filesKey = await trace(['files']);
      expect(filesKey.listed).toContain('circuit_trace');
      expect(filesKey.text).toContain('1 email attachment left out of this trace');
      expect(filesKey.text).not.toContain(name.replace(/\.dwg$/, ''));

      const allAreas = await trace(null);
      expect(allAreas.text).not.toContain('email attachment');
      expect(allAreas.text).toContain(name.replace(/\.dwg$/, ''));

      // Below Admin, a count and no name.
      const tool = t.CIRCUIT_TOOLS.find((d) => d.slug === 'circuit_trace')!;
      const asMember = JSON.stringify(
        await m.withViewer({ login: member }, () =>
          tool.handler({ circuit: 'K-1' }, { ownerId: owner }),
        ),
      );
      expect(asMember).toContain('1 email attachment left out of this trace');
      expect(asMember).not.toContain(name.replace(/\.dwg$/, ''));
    });

    it('a drive-synced file has no filename, is no attachment, and a member reads it', async () => {
      const id = await uploadWithDb(`${tag}-drive.csv`);
      await x(sql`update nodes set data = data - 'filename', title = ${`${tag}-drive.csv`}
        where id = ${id}`);
      const res = await asViewer(member, id, { sql: 'SELECT count(*) AS n FROM "Sheet1"' });
      expect(res).toMatchObject({ ok: true });
      expect((res as { output: Rows }).output.rows).toEqual([[3]]);
    });

    it('not a table type, and no valid sha256', async () => {
      const txt = await upload(`${tag}-notes.txt`, 'just words');
      expect(await errorAs(member, txt)).toMatch(/has no database: only xlsx/);
      const csv = await upload(`${tag}-badsha.csv`, CSV);
      await setData(csv, { sha256: 'nope' });
      expect(await errorAs(member, csv)).toMatch(/no checksum/);
    });
  });

  describe("E's answers on real rows", () => {
    it('a non-plan XML says so', async () => {
      const id = await upload(`${tag}-note.xml`, '<?xml version="1.0"?><note>hello</note>');
      expect(await errorAs(member, id)).toMatch(/^This XML is not a Microsoft Project plan\./);
    });

    it('a replaced workbook with a word and an old Table gives the word', async () => {
      const id = await upload(`${tag}-big.xlsx`, 'stand-in bytes');
      await sys(() =>
        content.createTable(owner, {
          title: `${tag} big`,
          sourceFileId: id,
          data: { columns: [], rows: [] },
        }),
      );
      await files.writeFileDbNone(id, sha256Of('stand-in bytes'), 'too-large');
      const error = await errorOf(id);
      expect(error).toMatch(/too large to read/);
      expect(error).toMatch(/save it as CSV/);
      expect(error).not.toContain('table_sql');
    });

    it('a Table names the file: told to a caller who reads it, never an app run', async () => {
      const id = await upload(`${tag}-tabled.csv`, CSV);
      const table = await sys(() =>
        content.createTable(owner, {
          title: `${tag} tabled`,
          sourceFileId: id,
          data: { columns: [], rows: [] },
        }),
      );
      await grants(table.id, [[holderWs, false, true]]);
      expect(await errorOf(id)).toBe(
        `Its rows are in Table ${table.id}: use table_sql. This Table may hold an older version of the file.`,
      );
      expect(await errorAs(member, id)).toMatch(/^Its rows are in Table/);
      const res = await memberCall(member, 'file_sql', { file_id: id });
      expect(res.body.ok).toBe(false);
      expect(res.body.error).not.toContain('table_sql');
      expect(res.body.error).toMatch(/No database yet/);
    });

    it('a caller who cannot read that Table is not told of it', async () => {
      const id = await upload(`${tag}-tabled2.csv`, CSV);
      const table = await sys(() =>
        content.createTable(owner, {
          title: `${tag} tabled2`,
          sourceFileId: id,
          data: { columns: [], rows: [] },
        }),
      );
      await grants(table.id, [[adminWs, false, true]]);
      const error = await errorAs(member, id);
      expect(error).toMatch(/^No database yet/);
      expect(error).not.toContain(table.id);
    });

    it('a quiet copy was not read into the brain', async () => {
      const id = await upload(`${tag}-copy.csv`, CSV);
      await setData(id, { snapshot_of: randomUUID() });
      expect(await errorAs(member, id)).toBe(
        'This file was not read into the brain, so it has no database.',
      );
    });

    it('otherwise no database yet, and a removed name brings the list back', async () => {
      const id = await uploadWithDb(`${tag}-gone.csv`);
      expect((await asViewer(member, id)).ok).toBe(true);
      await files.removeFileDbNames(id);
      expect(existsSync(files.fileDbsDir())).toBe(true);
      expect(readdirSync(files.fileDbsDir()).filter((n) => n.startsWith(id))).toEqual([]);
      expect(await errorAs(member, id)).toMatch(/^No database yet/);
    });

    it('with no mount it says so', async () => {
      const id = await upload(`${tag}-nomount.csv`, CSV);
      vi.stubEnv('MANTLE_FILES_ROOT', path.join(dir, 'not-mounted'));
      expect(await errorAs(member, id)).toMatch(/not mounted/);
    });
  });

  describe('rights: no read of the row gets no rows and no path', () => {
    const clean = (error: string | undefined) => {
      expect(error).toBeTruthy();
      expect(error).not.toContain(dir);
      expect(error).not.toContain('.file-dbs');
      expect(error).not.toContain('V-101');
    };

    it('an id that is no file, or a file of another owner, is not found', async () => {
      const table = await sys(() =>
        content.createTable(owner, { title: `${tag} no file`, data: { columns: [], rows: [] } }),
      );
      const asTable = await sys(() => handler(table.id));
      expect((asTable as { error: string }).error).toMatch(/^file not found/);
      const asOther = await sys(() =>
        def().handler({ file_id: csvFile }, { ownerId: randomUUID() }),
      );
      expect((asOther as { error: string }).error).toMatch(/^file not found/);
    });

    it('a viewer scope', async () => {
      const error = await errorAs(outsider, csvFile);
      expect(error).toMatch(/^file not found/);
      clean(error);
    });

    it('the app broker', async () => {
      const res = await memberCall(outsider, 'file_sql', {
        file_id: csvFile,
        sql: 'SELECT * FROM "Sheet1"',
      });
      expect(res.body.ok).toBe(false);
      clean(res.body.error);
    });

    it('a read-only login reads what it may, and no more', async () => {
      const denied = await inRequest(outsider, () => handler(csvFile), 'ro');
      expect(denied).toMatchObject({ ok: false });
      clean((denied as { error: string }).error);
      const read = await inRequest(
        member,
        () => handler(csvFile, { sql: 'SELECT 1 AS one' }),
        'ro',
      );
      expect(read).toMatchObject({ ok: true });
    });

    it('a contact share runs no built-in', async () => {
      const res = await linkCall('file_sql', { file_id: csvFile, sql: 'SELECT * FROM "Sheet1"' });
      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
      clean(res.body.error);
    });
  });

  describe('the broker gate', () => {
    const plan = (via: 'owner' | 'member', appId: string, rules: 'admin' | 'team', slug: string) =>
      t.appToolRunPlan(
        { via, ownerId: owner, runner: { loginId: via === 'owner' ? owner : member, name: 'R' } },
        { id: appId, manifest: { toolSlugs: SLUGS }, toolRules: rules },
        slug,
        {},
      );

    it('without the line a declared tool still runs, at admin and team rules', async () => {
      for (const slug of ['table_sql', 'table_alias', 'file_sql']) {
        expect((await sys(() => plan('owner', adminApp, 'admin', slug).verdict())).ok, slug).toBe(
          true,
        );
        expect((await sys(() => plan('member', teamApp, 'team', slug).verdict())).ok, slug).toBe(
          true,
        );
      }
    });

    it('with the line any of the 34, or an alias, is refused at both rules', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      for (const slug of ['table_sql', 'table_alias']) {
        const admin = plan('owner', adminApp, 'admin', slug);
        expect(admin.rules, slug).toBe('admin');
        expect(await sys(() => admin.verdict()), slug).toMatchObject({ ok: false, status: 403 });
        const team = plan('member', teamApp, 'team', slug);
        expect(team.rules, slug).toBe('team');
        expect(await sys(() => team.verdict()), slug).toMatchObject({ ok: false, status: 403 });
      }
      expect((await sys(() => plan('owner', adminApp, 'admin', 'file_sql').verdict())).ok).toBe(
        true,
      );
      expect((await sys(() => plan('member', teamApp, 'team', 'file_sql').verdict())).ok).toBe(
        true,
      );
    });

    it('with the line the broker answers the refusal, by the one gate', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const res = await memberCall(member, 'table_alias', { table_id: randomUUID(), sql: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/no app reaches a Table/);
      expect(res.body.error).toContain('file_sql');
    });

    describe('app_tools_set', () => {
      const set = (id: string, tool_slugs: string[]) =>
        sys(() =>
          t.BUILTIN_TOOLS.find((d) => d.slug === 'app_tools_set')!.handler(
            { id, tool_slugs },
            { ownerId: owner, surface: { kind: 'web' } },
          ),
        );
      const held = async (id: string) =>
        (
          await x<{ slugs: string[] }>(
            sql`select manifest->'toolSlugs' as slugs from apps where node_id = ${id}`,
          )
        )[0]!.slugs;

      it('refuses a new one, by slug or by alias, and keeps the list', async () => {
        const id = randomUUID();
        await x(sql`insert into nodes (id, owner_id, type, title, path)
          values (${id}, ${owner}, 'app', ${`${tag} set`}, 'apps')`);
        await x(sql`insert into apps (node_id, manifest)
          values (${id}, ${JSON.stringify({ toolSlugs: ['calculate'] })}::jsonb)`);
        for (const slug of ['table_sql', 'table_alias', 'node_read', 'export_node']) {
          const res = await set(id, ['calculate', slug]);
          expect(res, slug).toMatchObject({ ok: false });
          expect((res as { error: string }).error, slug).toContain(slug);
          expect((res as { error: string }).error, slug).toContain('file_sql');
          expect(await held(id), slug).toEqual(['calculate']);
        }
        expect((await set(id, ['calculate', 'file_sql'])).ok).toBe(true);
        expect(await held(id)).toEqual(['calculate', 'file_sql']);
      });

      it('a list that already holds one can still be set, and shrink', async () => {
        const id = randomUUID();
        await x(sql`insert into nodes (id, owner_id, type, title, path)
          values (${id}, ${owner}, 'app', ${`${tag} held`}, 'apps')`);
        await x(sql`insert into apps (node_id, manifest)
          values (${id}, ${JSON.stringify({ toolSlugs: ['table_sql'] })}::jsonb)`);
        expect((await set(id, ['table_sql', 'calculate'])).ok).toBe(true);
        expect(await held(id)).toEqual(['table_sql', 'calculate']);
        expect((await set(id, ['calculate'])).ok).toBe(true);
        // Dropped, it is new again.
        expect((await set(id, ['calculate', 'table_sql'])).ok).toBe(false);
      });

      it('with the line it refuses the same', async () => {
        vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
        const res = await set(teamApp, ['calculate', 'table_get']);
        expect(res).toMatchObject({ ok: false });
      });
    });
  });
});
