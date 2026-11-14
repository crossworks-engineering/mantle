/**
 * POST /api/pipelines/:id/test and `pipeline_test` on a migrated scratch
 * database, through the real app (createApp) and the real MCP surface
 * (prepareCallerTools). The test itself is proven in
 * packages/tools/src/pipeline-test.test.ts; here, the one check of rights.
 *
 *  - A user of Admin passes the policy: a file it cannot read is a 404, an
 *    unknown pipeline is a 404, a field the body does not take is a 400.
 *  - A login without the settings area (the admin role in Team only, a
 *    member) is refused by the policy: 403.
 *  - The tool is listed for the Admin user, and not for the two others.
 *
 * No owner session is made: the logins are rows of the scratch database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/app/api/pipelines/[id]/test/pipelines-test-route.db.test.ts
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
  'POST /api/pipelines/:id/test and pipeline_test: the settings area is the check',
  () => {
    type Ts = typeof import('@mantle/db/test-support');
    let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
    let m: typeof import('@mantle/db');
    let ls: typeof import('@mantle/mcp-core');
    let app: import('hono').Hono;
    let cookieOf: (id: string) => string;
    let dir = '';
    const owner = randomUUID();
    const admin = randomUUID();
    const outsider = randomUUID();
    const member = randomUUID();
    const tag = `pl2m4${randomUUID().slice(0, 6)}`;

    const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
      (await m.systemDb.execute(q)) as unknown as T[];
    const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
      (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

    const post = (as: string, id: string, body: unknown) =>
      app.request(`/api/pipelines/${id}/test`, {
        method: 'POST',
        headers: { cookie: cookieOf(as), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

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
      dir = await mkdtemp(path.join(tmpdir(), 'pipelines-test-route-'));
      process.env.DATABASE_URL = scratch.url;
      process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
      process.env.TABLE_DB_DIR = path.join(dir, 'tables');
      process.env.APP_DB_DIR = path.join(dir, 'apps');
      process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
      process.env.SESSION_SECRET = 'pipelines-test-route-secret-at-least-32-characters!';
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

    it('a user of Admin passes the policy: a file it cannot read and an unknown pipeline are 404s', async () => {
      const noFile = await post(admin, 'sheet', { fileId: randomUUID() });
      expect(noFile.status, await noFile.clone().text()).toBe(404);
      expect(await noFile.json()).toEqual({ error: 'no file has that id' });
      const noPipeline = await post(admin, 'no-such', { fileId: randomUUID() });
      expect(noPipeline.status).toBe(404);
      expect(await noPipeline.json()).toEqual({ error: 'no pipeline has that id' });
      const extra = await post(admin, 'sheet', { fileId: randomUUID(), apply: true });
      expect(extra.status).toBe(400);
    });

    it('a login without the settings area is refused by the policy: 403', async () => {
      for (const who of [outsider, member]) {
        const out = await post(who, 'sheet', { fileId: randomUUID() });
        expect(out.status, await out.clone().text()).toBe(403);
      }
    });

    it('the tool is listed for the Admin user only', async () => {
      expect(await listedTools(callerOf(admin, 'admin'))).toContain('pipeline_test');
      expect(await listedTools(callerOf(outsider, 'admin'))).not.toContain('pipeline_test');
      expect(await listedTools(callerOf(member, 'member'))).not.toContain('pipeline_test');
    });
  },
);
