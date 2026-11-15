/**
 * An own pipeline's install, package and remove (docs/pipelines.md, "Own
 * pipelines") on a migrated scratch database, through the real app
 * (createApp) and the real MCP surface (prepareCallerTools), with a
 * made-up mount folder (MANTLE_PIPELINES_DIR) and the Bun template.
 *
 *  - A user of Admin installs it (POST /api/pipelines): the folder, then the
 *    row; the list shows it as an own Reader with no problem; it starts no
 *    job (no request leaves the process). GET /api/pipelines/:id/package
 *    gives its files back.
 *  - A row whose files are not on disk shows its problem in the list; the
 *    same files again write the folder and clear it.
 *  - DELETE /api/pipelines/:id takes the row and the folder; again: done; a
 *    built-in is refused.
 *  - A curated box refuses the install, and the list shows its own rows
 *    with the curated sentence; a box with no mount refuses it.
 *  - A login without the settings area (the admin role in Team only, a
 *    member) is refused by the policy on the three routes: 403, nothing
 *    stored.
 *  - The tools: the Admin user's own connection installs; a key acts as its
 *    login (the tool named on an Admin key passes, a member's key is
 *    refused). A read-only key of the Admin user gets neither write; a
 *    peer gets none of the three tools.
 *
 * No owner session is made: the logins are rows of the scratch database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/app/api/pipelines/pipelines-install-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PipelineInstallAnswer, PipelineList, PipelineRow } from '@mantle/client-types';
import { asSuperuser, teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const TEMPLATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../docs/pipeline-template/bun',
);
/** The Bun template as an install sends it. */
const PKG = {
  files: Object.fromEntries(
    readdirSync(TEMPLATE).map((n) => [n, readFileSync(path.join(TEMPLATE, n), 'utf8')]),
  ),
};

type Json = Record<string, unknown>;

describe.skipIf(!URL)(
  'POST /api/pipelines, GET /api/pipelines/:id/package, DELETE /api/pipelines/:id: the settings area is the check',
  () => {
    let mount = '';
    type Ts = typeof import('@mantle/db/test-support');
    let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
    let m: typeof import('@mantle/db');
    let ls: typeof import('@mantle/mcp-core');
    let app: import('hono').Hono;
    let cookieOf: (id: string) => string;
    let dir = '';
    const owner = randomUUID(); // the anchor (no session made for it)
    const admin = randomUUID(); // a user of Admin
    const outsider = randomUUID(); // the admin role, a user of Team only
    const member = randomUUID();
    let adminWs = '';
    let teamWs = '';
    const tag = `p31i${randomUUID().slice(0, 6)}`;

    const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
      (await m.systemDb.execute(q)) as unknown as T[];
    const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
      (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

    /** The MCP surface of one caller, as the HTTP route registers it. */
    const connect = async (caller: import('@mantle/mcp-core').McpCaller) => {
      const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
      const { Client } = await import('@modelcontextprotocol/client');
      const prepared = await ls.prepareCallerTools(caller);
      const server = new McpServer({ name: 'test', version: '0' });
      ls.registerPreparedTools(server, prepared);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: tag, version: '0' });
      await Promise.all([server.connect(a), c.connect(b)]);
      const names = (await c.listTools()).tools.map((tool) => tool.name);
      const call = async (tool: string, args: Json) =>
        (await c.callTool({ name: tool, arguments: args }).catch((err: unknown) => ({
          isError: true,
          content: [{ type: 'text', text: `protocol: ${String(err)}` }],
        }))) as { isError?: boolean; content: { text?: string }[] };
      return { names, call, close: () => c.close() };
    };
    /** A key of `loginId`, resolved as /api/mcp resolves its bearer. */
    const keyCaller = async (
      loginId: string,
      areas: import('@mantle/client-types').AccessKeyArea[] | null,
      riskyTools: string[],
      access: 'read' | 'read_write' = 'read_write',
    ) => {
      const keys = await import('@/lib/access-keys');
      const auth = await import('@/lib/mcp-auth');
      const minted = await keys.mintAccessKey({
        name: `${tag} key ${randomUUID().slice(0, 4)}`,
        loginId,
        access,
        areas,
        riskyTools,
        expiresAt: null,
        createdBy: loginId,
        maxLive: 50,
      });
      return auth.resolveMcpCaller(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${minted!.key}` },
        }),
      );
    };

    beforeAll(async () => {
      const ts: Ts = await import('@mantle/db/test-support');
      scratch = await ts.createMigratedScratchDatabase(URL!);
      dir = await mkdtemp(path.join(tmpdir(), 'pipelines-install-route-'));
      mount = path.join(dir, 'pipelines');
      await mkdir(mount, { recursive: true });
      process.env.MANTLE_PIPELINES_DIR = mount;
      process.env.DATABASE_URL = scratch.url;
      process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
      process.env.TABLE_DB_DIR = path.join(dir, 'tables');
      process.env.APP_DB_DIR = path.join(dir, 'apps');
      process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
      process.env.SESSION_SECRET = 'pipelines-install-route-secret-at-least-32-chars!';
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
      teamWs = ws.find((w) => w.key === 'team')!.id;
      adminWs = ws.find((w) => w.key === 'admin')!.id;
      await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${admin}, false) on conflict do nothing`);
      await su(
        sql`delete from workspace_users where workspace_id = ${adminWs} and login_id in (${outsider}, ${member})`,
      );
      await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${outsider}, false), (${teamWs}, ${member}, false)
      on conflict do nothing`);
      const tokens = await import('@/lib/auth/tokens');
      cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
      const { createApp } = await import('@/server/app');
      app = await createApp();
    }, 240_000);

    afterAll(async () => {
      await m?.closeDb();
      await scratch?.drop();
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    const send = (as: string, method: string, url: string, body?: unknown) =>
      app.request(url, {
        method,
        headers: { cookie: cookieOf(as), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const install = (as: string, body: unknown = PKG) => send(as, 'POST', '/api/pipelines', body);
    const row = async (as: string, id = 'lx9-logger'): Promise<PipelineRow | undefined> => {
      const res = await app.request('/api/pipelines', { headers: { cookie: cookieOf(as) } });
      expect(res.status).toBe(200);
      return ((await res.json()) as PipelineList).pipelines.find((p) => p.id === id);
    };
    const stored = async () =>
      JSON.stringify(
        await su(sql`select pipeline_id, package is not null as pkg from pipeline_state
                    where owner_id = ${owner} order by pipeline_id`),
      );
    const folder = () => path.join(mount, 'lx9-logger', '1.0.0', 'pipeline.json');

    it('a user of Admin installs, reads and removes an own pipeline; the install starts no job', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const res = await install(admin);
      const text = await res.text();
      expect(res.status, text).toBe(200);
      const answer = JSON.parse(text) as PipelineInstallAnswer;
      expect(answer.note).toMatch(/^This runs code on files of this box/);
      expect(answer.row).toMatchObject({
        id: 'lx9-logger',
        source: 'own',
        kind: 'reader',
        reads: ['lx9'],
      });
      expect(existsSync(folder())).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      expect(await row(admin)).toMatchObject({ source: 'own', problem: null, version: '1.0.0' });

      const got = await send(admin, 'GET', '/api/pipelines/lx9-logger/package');
      expect(got.status).toBe(200);
      expect(((await got.json()) as { files: Json }).files).toEqual(PKG.files);
      expect((await send(admin, 'GET', '/api/pipelines/sheet/package')).status).toBe(400);
      expect((await send(admin, 'GET', '/api/pipelines/no-such/package')).status).toBe(404);

      // A restore of Postgres alone: the files are gone, the list says so,
      // and the same files again fix it.
      await rm(path.join(mount, 'lx9-logger'), { recursive: true });
      expect((await row(admin))?.problem).toMatch(/not on disk/);
      expect((await install(admin)).status).toBe(200);
      expect((await row(admin))?.problem).toBeNull();

      const removed = await send(admin, 'DELETE', '/api/pipelines/lx9-logger');
      expect(removed.status, await removed.clone().text()).toBe(200);
      expect(await row(admin)).toBeUndefined();
      expect(existsSync(path.join(mount, 'lx9-logger'))).toBe(false);
      expect(await stored()).toBe('[]');
      expect((await send(admin, 'DELETE', '/api/pipelines/lx9-logger')).status).toBe(200);
      expect((await send(admin, 'DELETE', '/api/pipelines/sheet')).status).toBe(400);
    });

    it('a curated box refuses the install and runs no own row; a box with no mount refuses it', async () => {
      expect((await install(admin)).status).toBe(200);
      process.env.MANTLE_PIPELINES = 'curated';
      try {
        const res = await install(admin);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe(
          'This box runs curated pipelines only.',
        );
        expect((await row(admin))?.problem).toBe('This box runs curated pipelines only.');
      } finally {
        delete process.env.MANTLE_PIPELINES;
      }
      process.env.MANTLE_PIPELINES_DIR = path.join(dir, 'no-such-mount');
      try {
        const res = await install(admin);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toMatch(/no pipelines folder/);
      } finally {
        process.env.MANTLE_PIPELINES_DIR = mount;
      }
      expect((await send(admin, 'DELETE', '/api/pipelines/lx9-logger')).status).toBe(200);
    });

    it('a login without the settings area is refused on the three routes, and nothing is stored', async () => {
      expect((await install(admin)).status).toBe(200);
      const before = await stored();
      for (const as of [outsider, member]) {
        expect((await install(as)).status).toBe(403);
        expect((await send(as, 'GET', '/api/pipelines/lx9-logger/package')).status).toBe(403);
        expect((await send(as, 'DELETE', '/api/pipelines/lx9-logger')).status).toBe(403);
      }
      expect(await stored()).toBe(before);
      expect(existsSync(folder())).toBe(true);
      expect((await send(admin, 'DELETE', '/api/pipelines/lx9-logger')).status).toBe(200);
    });

    it("the tools: the Admin user's own connection installs; a key acts as its login", async () => {
      const own = await connect({
        role: 'admin',
        anchorId: owner,
        loginId: admin,
        via: 'oauth',
        write: true,
      } as import('@mantle/mcp-core').McpCaller);
      try {
        const out = await own.call('pipeline_install', PKG);
        expect(out.isError ?? false, out.content[0]?.text).toBe(false);
        expect((JSON.parse(out.content[0]!.text!) as PipelineInstallAnswer).row?.source).toBe(
          'own',
        );
        const got = await own.call('pipeline_get', { id: 'lx9-logger' });
        expect(got.isError ?? false).toBe(false);
        const gone = await own.call('pipeline_remove', { id: 'lx9-logger' });
        expect(gone.isError ?? false, gone.content[0]?.text).toBe(false);
      } finally {
        await own.close();
      }
      const adminKey = await keyCaller(admin, null, ['pipeline_install']);
      const k = await connect(adminKey!);
      try {
        expect(k.names).toContain('pipeline_install');
        expect((await k.call('pipeline_install', PKG)).isError ?? false).toBe(false);
      } finally {
        await k.close();
      }
      const before = await stored();
      const memberKey = await keyCaller(member, null, ['pipeline_install', 'pipeline_remove']);
      const mk = await connect(memberKey!);
      try {
        expect(mk.names).not.toContain('pipeline_install');
        expect((await mk.call('pipeline_remove', { id: 'lx9-logger' })).isError).toBe(true);
      } finally {
        await mk.close();
      }
      expect(await stored()).toBe(before);
    });

    it('a read-only key of the Admin user and a peer are refused the writes; the peer every one', async () => {
      expect((await install(admin)).status).toBe(200);
      const before = await stored();
      const WRITES = ['pipeline_install', 'pipeline_remove'];
      const readKey = await keyCaller(admin, null, WRITES, 'read');
      const peer = {
        role: 'admin',
        anchorId: owner,
        loginId: owner,
        via: 'peer',
        write: true,
        peerId: randomUUID(),
      } as import('@mantle/mcp-core').McpCaller;
      for (const [who, caller, refused] of [
        ['read-only key', readKey!, WRITES],
        ['peer', peer, [...WRITES, 'pipeline_get']],
      ] as const) {
        const c = await connect(caller);
        try {
          for (const tool of refused) {
            expect(c.names, `${who} ${tool}`).not.toContain(tool);
            const args = tool === 'pipeline_install' ? PKG : { id: 'lx9-logger' };
            expect((await c.call(tool, args)).isError, `${who} ${tool}`).toBe(true);
          }
        } finally {
          await c.close();
        }
      }
      expect(await stored()).toBe(before);
      expect(existsSync(folder())).toBe(true);
      expect((await send(admin, 'DELETE', '/api/pipelines/lx9-logger')).status).toBe(200);
    });
  },
);
