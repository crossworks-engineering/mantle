/**
 * GET /api/pipelines through the real app (createApp) on a migrated scratch
 * database: the route's policy (the settings area) is the one check. That
 * `pipeline_list` gives the same list is proven in packages/tools
 * (pipelines.test.ts): both call listPipelines.
 *
 *  - A user of Admin gets the list: the built-ins, and the count of a file
 *    whose database was read by an older version.
 *  - The counts are the whole box's: a file in a workspace that user is not
 *    in counts too, and the answer still names no file. The route shows
 *    it; `pipeline_list` in that user's own Admin turn proves it, as that
 *    scope does not read the file's row (the rows are read on the system
 *    pool after the area check; the old read in the scope counted 1).
 *  - A login with the admin role taken out of Admin (a user of Team only)
 *    has no settings area: 403. So does a member.
 *
 * No owner session is made: the logins are rows of the scratch database.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/app/api/pipelines/pipelines-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineList } from '@mantle/client-types';
import { asSuperuser, teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('GET /api/pipelines: the settings area is the check', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor (no session made for it)
  const admin = randomUUID(); // a user of Admin
  const outsider = randomUUID(); // the admin role, a user of Team only
  const member = randomUUID();
  const csv = randomUUID();
  const sha = 'c'.repeat(64);
  const teamCsv = randomUUID(); // in Team, which the Admin user is not in
  let adminWs = '';
  const teamSha = 'd'.repeat(64);
  const tag = `pl1m4${randomUUID().slice(0, 6)}`;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const get = (as: string) => app.request('/api/pipelines', { headers: { cookie: cookieOf(as) } });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'pipelines-route-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'pipelines-route-secret-at-least-32-characters!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
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
    adminWs = ws.find((w) => w.key === 'admin')!.id;
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${admin}, false) on conflict do nothing`);
    await su(
      sql`delete from workspace_users where workspace_id = ${adminWs} and login_id = ${outsider}`,
    );
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${outsider}, false), (${teamWs}, ${member}, false)
      on conflict do nothing`);
    await su(
      sql`delete from workspace_users where workspace_id = ${teamWs} and login_id = ${admin}`,
    );
    // One CSV in Admin whose database was read by an older version.
    await x(sql`insert into nodes (id, owner_id, type, title, path, data)
      values (${csv}, ${owner}, 'file', 'pumps.csv', 'files',
              ${JSON.stringify({ filename: 'pumps.csv', sha256: sha })}::jsonb)`);
    await m.withHeads([csv], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${csv}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${csv}, ${adminWs}, true)`);
    });
    // One CSV in Team only, read by the version of today.
    await x(sql`insert into nodes (id, owner_id, type, title, path, data)
      values (${teamCsv}, ${owner}, 'file', 'valves.csv', 'files',
              ${JSON.stringify({ filename: 'valves.csv', sha256: teamSha })}::jsonb)`);
    await m.withHeads([teamCsv], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${teamCsv}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${teamCsv}, ${teamWs}, true)`);
    });
    const files = await import('@mantle/files');
    const { writeDocFile } = await import('@mantle/tabledb/write');
    mkdirSync(files.fileDbsDir(), { recursive: true });
    const database = (id: string, at: string, version: string, tag: string) =>
      writeDocFile(
        files.fileDbPaths(id, at)!.sqlite,
        {
          columns: [{ id: 'c1', name: 'Tag', type: 'text' }],
          rows: [{ id: 'r1', cells: { c1: tag } }],
        },
        {
          nodeId: id,
          ownerId: owner,
          extraMeta: {
            pipeline_id: 'sheet',
            pipeline_version: version,
            pipeline_api: '1',
            shapes: '',
          },
        },
      );
    database(csv, sha, '0.9.0', 'P-101');
    database(teamCsv, teamSha, '1.0.0', 'V-201');
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

  it('a user of Admin gets the list, with the counts of the whole box', async () => {
    // The Admin user is in no workspace that holds the Team file, so its own
    // scope does not read that row; the count still holds it.
    const shared = await su<{ n: number }>(sql`select count(*)::int as n from item_grants g
      join workspace_users wu on wu.workspace_id = g.workspace_id
      where g.node_id = ${teamCsv} and wu.login_id = ${admin}`);
    expect(shared[0]!.n).toBe(0);
    const own = await app.request(`/api/files/files/${teamCsv}`, {
      headers: { cookie: cookieOf(admin) },
    });
    expect(own.status, await own.clone().text()).toBe(404);
    const res = await get(admin);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const body = JSON.parse(text) as PipelineList;
    expect(body.api).toBe(1);
    expect(body.countsPartial).toBe(false);
    expect(body.pipelines.map((p) => p.id)).toEqual([
      'sheet',
      'plan-mspdi',
      'drawing-pdf',
      'plot-dwf',
      'drawing-cad',
    ]);
    const sheet = body.pipelines.find((p) => p.id === 'sheet')!;
    expect({ files: sheet.files, older: sheet.older }).toEqual({ files: 2, older: 1 });
    // Numbers only: no file name, no id, no cell.
    for (const word of [csv, teamCsv, 'pumps', 'valves', 'P-101', 'V-201']) {
      expect(text).not.toContain(word);
    }
    console.log(`[pipelines-route] GET /api/pipelines answer: ${text}`);
  });

  it("pipeline_list in the Admin user's turn counts a file its scope does not read", async () => {
    const p = await import('../../../../../packages/tools/src/pipelines');
    const scope = { kind: 'assistant' as const, loginId: admin, ws: [adminWs], modWs: [] };
    const { rows, out } = await m.withTurnScope(scope, async () => ({
      rows: await m.db.select({ id: m.nodes.id }).from(m.nodes).where(eq(m.nodes.id, teamCsv)),
      out: await p.pipeline_list.handler({}, { ownerId: owner } as never),
    }));
    // The scope does not read the Team file's row; the count holds it.
    expect(rows).toEqual([]);
    expect(out.ok).toBe(true);
    const list = (out as { output: PipelineList }).output;
    const sheet = list.pipelines.find((x) => x.id === 'sheet')!;
    expect({ files: sheet.files, older: sheet.older }).toEqual({ files: 2, older: 1 });
    const text = JSON.stringify(list);
    for (const word of [csv, teamCsv, 'pumps', 'valves', 'P-101', 'V-201']) {
      expect(text).not.toContain(word);
    }
  });

  it('a login without the settings area is refused by the policy: 403', async () => {
    const out = await get(outsider);
    expect(out.status, await out.clone().text()).toBe(403);
    const mem = await get(member);
    expect(mem.status, await mem.clone().text()).toBe(403);
  });
});
