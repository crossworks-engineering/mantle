/**
 * POST /api/pipelines/:id/reread and `pipeline_reread` on a migrated
 * scratch database, through the real app (createApp) and the real MCP
 * surface (prepareCallerTools). The walk, the cap and the skips are proven
 * in packages/tools/src/pipeline-reread.test.ts; here, the one check of
 * rights, and the notify on a real database.
 *
 *  - A user of Admin passes the policy. The older files are the box's: a
 *    made-up CSV of Admin and one of Team, which it is not in, both read by
 *    an older Spreadsheet. The dry run counts both and sends nothing; its
 *    number is the list's `older`. `apply` with `limit: 1` sends one notify
 *    and gives `next`; the next call sends the other.
 *  - The reader of a PDF drawing is refused with `pdf`; an unknown
 *    pipeline is a 404; a field the body does not take is a 400.
 *  - A login without the settings area (the admin role in Team only, a
 *    member) is refused by the policy: 403, and nothing is sent.
 *  - The tool is listed for the Admin user, and not for the two others.
 *
 * No owner session is made: the logins are rows of the scratch database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/app/api/pipelines/[id]/reread/pipelines-reread-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser, teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)(
  'POST /api/pipelines/:id/reread and pipeline_reread: the settings area is the check',
  () => {
    type Ts = typeof import('@mantle/db/test-support');
    let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
    let m: typeof import('@mantle/db');
    let ls: typeof import('@mantle/mcp-core');
    let app: import('hono').Hono;
    let cookieOf: (id: string) => string;
    let listener: ReturnType<Ts['superuserClient']> | undefined;
    const notifies: string[] = [];
    let dir = '';
    const owner = randomUUID();
    const admin = randomUUID();
    const outsider = randomUUID();
    const member = randomUUID();
    const tag = `pl2m8${randomUUID().slice(0, 6)}`;
    /** A made-up CSV in Admin, and one in Team, which `admin` is not in. */
    let adminFile = '';
    let teamFile = '';

    const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
      (await m.systemDb.execute(q)) as unknown as T[];
    const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
      (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

    const post = (as: string, id: string, body: unknown) =>
      app.request(`/api/pipelines/${id}/reread`, {
        method: 'POST',
        headers: { cookie: cookieOf(as), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    /** The notifies that arrived; a short wait, as LISTEN is async. */
    const sent = async () => {
      await new Promise((r) => setTimeout(r, 300));
      return [...notifies].sort();
    };

    /** The tool names one caller's MCP surface lists. */
    const listedTools = async (caller: import('@mantle/mcp-core').McpCaller) => {
      const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
      const { Client } = await import('@modelcontextprotocol/client');
      const prepared = await ls.prepareCallerTools(caller);
      const server = new McpServer({ name: 'test', version: '0' });
      ls.registerPreparedTools(server, prepared);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: tag, version: '0' });
      await Promise.all([server.connect(a), c.connect(b)]);
      try {
        return (await c.listTools()).tools.map((tool) => tool.name);
      } finally {
        await c.close();
      }
    };
    const callerOf = (loginId: string, role: 'admin' | 'member') =>
      ({
        role,
        anchorId: owner,
        loginId,
        via: 'oauth',
        write: true,
      }) as import('@mantle/mcp-core').McpCaller;

    beforeAll(async () => {
      const ts: Ts = await import('@mantle/db/test-support');
      scratch = await ts.createMigratedScratchDatabase(URL!);
      dir = await mkdtemp(path.join(tmpdir(), 'pipelines-reread-route-'));
      process.env.DATABASE_URL = scratch.url;
      process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
      process.env.TABLE_DB_DIR = path.join(dir, 'tables');
      process.env.APP_DB_DIR = path.join(dir, 'apps');
      process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
      process.env.SESSION_SECRET = 'pipelines-reread-route-secret-at-least-32-characters!';
      delete process.env.MANTLE_DETACHED_DEV;
      m = await import('@mantle/db');
      ls = await import('@mantle/mcp-core');
      await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${admin}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin', 'Admin user'),
      (${outsider}, ${`${tag}-x@example.invalid`}, 'x', false, 'admin', 'Outsider'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
      await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
      await ts.runWorkspacesSwitch();
      await su(sql.raw(teamWorkspaceSql(owner)));
      const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key
        from workspaces where owner_id = ${owner}`);
      const teamWs = ws.find((w) => w.key === 'team')!.id;
      const adminWs = ws.find((w) => w.key === 'admin')!.id;
      await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${admin}, false) on conflict do nothing`);
      await su(
        sql`delete from workspace_users where workspace_id = ${adminWs} and login_id in (${outsider}, ${member})`,
      );
      await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${outsider}, false), (${teamWs}, ${member}, false)
      on conflict do nothing`);
      // The Admin user is in Admin only: Team is a workspace it is not in.
      await su(
        sql`delete from workspace_users where workspace_id = ${teamWs} and login_id = ${admin}`,
      );
      await x(sql`insert into nodes (owner_id, type, title, slug, path)
      values (${owner}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
      const f = await import('@mantle/files');
      const made = (createWs: string, slug: string) =>
        m.runAsSystem('test:pipelines-reread-route', () =>
          m.withCreateHome({ createWs, privateWs: null }, async () => {
            const folder = await f.createFolder({ ownerId: owner, parentPath: 'files', slug });
            return f.upsertFile({
              ownerId: owner,
              parentPath: folder.path,
              filename: 'made-up.csv',
              bytes: Buffer.from('Tag,Size\nP-101,2\n'),
            });
          }),
        );
      adminFile = (await made(adminWs, 'in-admin')).id;
      teamFile = (await made(teamWs, 'in-team')).id;
      // Each file's database, read by an older Spreadsheet (made up).
      const { writeDocFile } = await import('@mantle/tabledb/write');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(f.fileDbsDir(), { recursive: true });
      for (const fileId of [adminFile, teamFile]) {
        const [row] = await x<{ sha: string }>(
          sql`select data->>'sha256' as sha from nodes where id = ${fileId}`,
        );
        writeDocFile(
          f.fileDbPaths(fileId, row!.sha)!.sqlite,
          {
            columns: [{ id: 'c1', name: 'Tag', type: 'text' }],
            rows: [{ id: 'r1', cells: { c1: 'P-101' } }],
          },
          {
            nodeId: fileId,
            ownerId: owner,
            extraMeta: {
              pipeline_id: 'sheet',
              pipeline_version: '0.9.0',
              pipeline_api: '1',
              shapes: '',
            },
          },
        );
      }
      listener = ts.superuserClient(scratch.url);
      await listener.listen(m.PIPELINE_RUN_CHANNEL, (payload) => notifies.push(payload));
      const tokens = await import('@/lib/auth/tokens');
      cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
      const { createApp } = await import('@/server/app');
      app = await createApp();
    }, 240_000);

    afterAll(async () => {
      await listener?.end();
      await m?.closeDb();
      await scratch?.drop();
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('the dry run counts the older files of every workspace, sends nothing, and equals the list', async () => {
      const res = await post(admin, 'sheet', {});
      const text = await res.text();
      expect(res.status, text).toBe(200);
      expect(JSON.parse(text)).toEqual({
        apply: false,
        busy: false,
        choices: [{ pipeline: 'sheet', name: 'Spreadsheet', files: 2, refused: null }],
        queued: 0,
        skipped: {},
        next: null,
      });
      const list = await app.request('/api/pipelines', { headers: { cookie: cookieOf(admin) } });
      const sheet = (
        (await list.json()) as import('@mantle/client-types').PipelineList
      ).pipelines.find((p) => p.id === 'sheet')!;
      expect(sheet.older).toBe(2);
      expect(sheet.versions).toEqual([{ version: '0.9.0', files: 2 }]);
      expect(await sent()).toEqual([]);
    });

    it('apply sends one notify for each older file, a page at a time', async () => {
      const first = await post(admin, 'sheet', { apply: true, limit: 1 });
      const one = (await first.json()) as import('@mantle/client-types').PipelineRunAnswer;
      expect([first.status, one.queued]).toEqual([200, 1]);
      expect(one.next).not.toBeNull();
      const second = await post(admin, 'sheet', { apply: true, limit: 1, after: one.next });
      const two = (await second.json()) as import('@mantle/client-types').PipelineRunAnswer;
      expect([two.queued, two.next]).toEqual([1, null]);
      expect(await sent()).toEqual([`sheet:${adminFile}`, `sheet:${teamFile}`].sort());
      notifies.length = 0;
    });

    it('refuses the reader of a PDF drawing, an unknown pipeline and a field it does not take', async () => {
      const pdf = await post(admin, 'drawing-pdf', { apply: true });
      expect(((await pdf.json()) as { choices: { refused: string }[] }).choices[0]!.refused).toBe(
        'pdf',
      );
      const none = await post(admin, 'no-such', {});
      expect(none.status).toBe(404);
      expect(await none.json()).toEqual({ error: 'no pipeline has that id' });
      const extra = await post(admin, 'sheet', { pipeline: 'sheet' });
      expect(extra.status).toBe(400);
      expect(await sent()).toEqual([]);
    });

    it('a login without the settings area is refused by the policy: 403, and nothing is sent', async () => {
      for (const who of [outsider, member]) {
        const out = await post(who, 'sheet', { apply: true });
        expect(out.status, await out.clone().text()).toBe(403);
      }
      expect(await sent()).toEqual([]);
    });

    it('the tool is listed for the Admin user only', async () => {
      expect(await listedTools(callerOf(admin, 'admin'))).toContain('pipeline_reread');
      expect(await listedTools(callerOf(outsider, 'admin'))).not.toContain('pipeline_reread');
      expect(await listedTools(callerOf(member, 'member'))).not.toContain('pipeline_reread');
    });
  },
);
