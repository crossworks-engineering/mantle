/**
 * PATCH /api/pipelines/:id and `pipeline_set` on a migrated scratch
 * database, through the real app (createApp) and the real MCP surface
 * (prepareCallerTools). The built-ins gain one made-up `after` pipeline with
 * an option of each type: no built-in of this branch has an option yet.
 *
 *  - A user of Admin sets an option and an attach list, and reads both back
 *    in GET /api/pipelines; `[]` switches the pipeline off.
 *  - A bad option is a 400 with the sentence of checkOptions; a reader
 *    refuses `workspaces`; a field the body does not take is a 400; an
 *    unknown id is a 404. Nothing is stored by a refusal.
 *  - A login without the settings area (the admin role in Team only, a
 *    member) is refused by the policy: 403, and the row is as it was.
 *  - The tool gives the same row as the route.
 *  - A key acts as its login as the login is now: a key of the Admin user
 *    with every area and the tool named on it passes; the same key without
 *    the tool named, a key with some areas only, and a key of a member are
 *    refused, and store nothing.
 *
 * No owner session is made: the logins are rows of the scratch database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/app/api/pipelines/pipelines-set-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PipelineList, PipelineRow } from '@mantle/client-types';
import type { PipelineManifest } from '@mantle/files';
import { asSuperuser, teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const TEST_AFTER = {
  id: 'test-after',
  name: 'Test tags',
  version: '1.0.0',
  api: 1,
  source: 'builtin',
  start: 'upload',
  match: { ext: ['dxf'], after: 'drawing-v1' },
  produces: { tabs: ['Test tags'] },
  needs: { weight: 'light' },
  options: {
    min_len: { type: 'number', label: 'Shortest tag', default: 3, min: 1, max: 20 },
    keep_notes: { type: 'bool', label: 'Keep notes', default: false },
    not_tags: { type: 'words', label: 'Never a tag', default: [], maxItems: 10, maxChars: 8 },
  },
} as unknown as PipelineManifest;

vi.mock('@mantle/files', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/files')>();
  return { ...real, BUILTIN_PIPELINES: [...real.BUILTIN_PIPELINES, TEST_AFTER] };
});

type Json = Record<string, unknown>;

describe.skipIf(!URL)(
  'PATCH /api/pipelines/:id and pipeline_set: the settings area is the check',
  () => {
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
    const tag = `pl2m2${randomUUID().slice(0, 6)}`;

    const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
      (await m.systemDb.execute(q)) as unknown as T[];
    const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
      (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

    const patch = (as: string, id: string, body: unknown) =>
      app.request(`/api/pipelines/${id}`, {
        method: 'PATCH',
        headers: { cookie: cookieOf(as), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const listed = async (as: string, id = 'test-after'): Promise<PipelineRow> => {
      const res = await app.request('/api/pipelines', { headers: { cookie: cookieOf(as) } });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      return (JSON.parse(text) as PipelineList).pipelines.find((p) => p.id === id)!;
    };
    const stored = async () =>
      JSON.stringify(
        await su(sql`select pipeline_id, options, workspaces, updated_by from pipeline_state
                    where owner_id = ${owner} order by pipeline_id`),
      );
    const valueOf = (row: PipelineRow, name: string) =>
      row.options.find((o) => o.name === name)?.value;

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
      const call = async (args: Json) =>
        (await c.callTool({ name: 'pipeline_set', arguments: args }).catch((err: unknown) => ({
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
    ) => {
      const keys = await import('@/lib/access-keys');
      const auth = await import('@/lib/mcp-auth');
      const minted = await keys.mintAccessKey({
        name: `${tag} key ${randomUUID().slice(0, 4)}`,
        loginId,
        access: 'read_write',
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
      dir = await mkdtemp(path.join(tmpdir(), 'pipelines-set-route-'));
      process.env.DATABASE_URL = scratch.url;
      process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
      process.env.TABLE_DB_DIR = path.join(dir, 'tables');
      process.env.APP_DB_DIR = path.join(dir, 'apps');
      process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
      process.env.SESSION_SECRET = 'pipelines-set-route-secret-at-least-32-characters!';
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

    it('a user of Admin sets an option and an attach list, and reads them back in the list', async () => {
      expect(await listed(admin)).toMatchObject({
        kind: 'after',
        after: 'drawing-v1',
        workspaces: [],
      });

      const res = await patch(admin, 'test-after', {
        options: { min_len: 5, not_tags: ['rev', 'NOTE'] },
      });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      const row = JSON.parse(text) as PipelineRow;
      expect([valueOf(row, 'min_len'), valueOf(row, 'not_tags')]).toEqual([5, ['NOTE', 'REV']]);
      expect([row.files, row.older]).toEqual([null, null]);
      console.log(`[pipelines-set-route] PATCH /api/pipelines/test-after answer: ${text}`);

      // The next list has it, inside the 30 seconds the counts are kept.
      const back = await listed(admin);
      expect(back.options).toEqual(row.options);

      // The attach list, in upper case too: kept lower case.
      const attach = await patch(admin, 'test-after', { workspaces: [teamWs.toUpperCase()] });
      expect(attach.status, await attach.clone().text()).toBe(200);
      expect((await listed(admin)).workspaces).toEqual([teamWs]);
      // One option changed; the others kept.
      const one = await patch(admin, 'test-after', { options: { keep_notes: true } });
      expect(one.status).toBe(200);
      const after = await listed(admin);
      expect([valueOf(after, 'min_len'), valueOf(after, 'keep_notes')]).toEqual([5, true]);
      const res2 = await app.request('/api/pipelines', { headers: { cookie: cookieOf(admin) } });
      console.log(`[pipelines-set-route] GET /api/pipelines answer: ${await res2.text()}`);
      // [] switches it off.
      expect((await patch(admin, 'test-after', { workspaces: [] })).status).toBe(200);
      expect((await listed(admin)).workspaces).toEqual([]);
      const rows = await su<{ updated_by: string }>(
        sql`select updated_by::text from pipeline_state where owner_id = ${owner}`,
      );
      expect(rows).toEqual([{ updated_by: admin }]);
    });

    it('a refusal is a 400 with its sentence, or a 404, and stores nothing', async () => {
      const before = await stored();
      const bad = await patch(admin, 'test-after', { options: { min_len: 99 } });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({
        error: 'Option "min_len" must be a number from 1 to 20.',
      });
      const reader = await patch(admin, 'sheet', { workspaces: [adminWs] });
      expect(reader.status).toBe(400);
      expect(await reader.json()).toEqual({ error: 'A reader is used in every workspace.' });
      const unknownWs = await patch(admin, 'test-after', { workspaces: [randomUUID()] });
      expect(unknownWs.status).toBe(400);
      // No On switch: a field the body does not take.
      const on = await patch(admin, 'test-after', { on: false });
      expect(on.status).toBe(400);
      const missing = await patch(admin, 'no-such', { options: {} });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: 'no pipeline has that id' });
      expect(await stored()).toBe(before);
    });

    it('a login without the settings area is refused by the policy: 403', async () => {
      const before = await stored();
      for (const who of [outsider, member]) {
        const out = await patch(who, 'test-after', { options: { min_len: 2 } });
        expect(out.status, await out.clone().text()).toBe(403);
      }
      expect(await stored()).toBe(before);
    });

    it("the tool in the Admin user's own connection gives the route's row", async () => {
      const c = await connect({
        role: 'admin',
        anchorId: owner,
        loginId: admin,
        via: 'oauth',
        write: true,
      } as import('@mantle/mcp-core').McpCaller);
      try {
        const out = await c.call({ id: 'test-after', options: { min_len: 8 } });
        expect(out.isError ?? false, out.content[0]?.text).toBe(false);
        const viaTool = JSON.parse(out.content[0]!.text!) as PipelineRow;
        const viaRoute = (await (
          await patch(admin, 'test-after', { options: { min_len: 8 } })
        ).json()) as PipelineRow;
        expect(viaTool).toEqual(viaRoute);
        expect(valueOf(await listed(admin), 'min_len')).toBe(8);
        const bad = await c.call({ id: 'test-after', options: { min_len: 0 } });
        expect(bad.isError).toBe(true);
        expect(bad.content[0]?.text).toContain('Option "min_len" must be a number from 1 to 20.');
      } finally {
        await c.close();
      }
    });

    it('a key acts as its login: an Admin key with every area and the tool named passes; the rest are refused', async () => {
      const set = async (caller: import('@mantle/mcp-core').McpCaller | null, value: number) => {
        expect(caller).not.toBeNull();
        const c = await connect(caller!);
        try {
          const out = await c.call({ id: 'test-after', options: { min_len: value } });
          return { listed: c.names.includes('pipeline_set'), ok: !out.isError };
        } finally {
          await c.close();
        }
      };
      const adminKey = await keyCaller(admin, null, ['pipeline_set']);
      expect(adminKey).toMatchObject({ role: 'admin', loginId: admin, via: 'key' });
      expect(await set(adminKey, 11)).toEqual({ listed: true, ok: true });
      expect(valueOf(await listed(admin), 'min_len')).toBe(11);

      const before = await stored();
      // The tool not named on the key (peerRisky).
      expect(await set(await keyCaller(admin, null, []), 12)).toEqual({ listed: false, ok: false });
      // Some areas only: a key's areas only narrow it.
      expect(await set(await keyCaller(admin, ['pages'], ['pipeline_set']), 13)).toEqual({
        listed: false,
        ok: false,
      });
      // A member's key: the member has no settings area.
      const memberKey = await keyCaller(member, null, ['pipeline_set']);
      expect(memberKey).toMatchObject({ role: 'member', loginId: member, via: 'key' });
      expect(await set(memberKey, 14)).toEqual({ listed: false, ok: false });
      expect(await stored()).toBe(before);
    });
  },
);
