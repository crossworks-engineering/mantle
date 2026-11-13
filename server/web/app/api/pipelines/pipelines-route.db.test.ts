/**
 * GET /api/pipelines through the real app (createApp) on a migrated scratch
 * database: the route's policy (the settings area) is the one check. That
 * `pipeline_list` gives the same list is proven in packages/tools
 * (pipelines.test.ts): both call listPipelines.
 *
 *  - A user of Admin gets the list: the built-ins, and the count of a file
 *    whose database was read by an older version.
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
import { sql } from 'drizzle-orm';
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
    const adminWs = ws.find((w) => w.key === 'admin')!.id;
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${admin}, false) on conflict do nothing`);
    await su(
      sql`delete from workspace_users where workspace_id = ${adminWs} and login_id = ${outsider}`,
    );
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${outsider}, false), (${teamWs}, ${member}, false)
      on conflict do nothing`);
    // One CSV in Admin whose database was read by an older version.
    await x(sql`insert into nodes (id, owner_id, type, title, path, data)
      values (${csv}, ${owner}, 'file', 'pumps.csv', 'files',
              ${JSON.stringify({ filename: 'pumps.csv', sha256: sha })}::jsonb)`);
    await m.withHeads([csv], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${csv}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${csv}, ${adminWs}, true)`);
    });
    const files = await import('@mantle/files');
    const { writeDocFile } = await import('@mantle/tabledb/write');
    mkdirSync(files.fileDbsDir(), { recursive: true });
    writeDocFile(
      files.fileDbPaths(csv, sha)!.sqlite,
      {
        columns: [{ id: 'c1', name: 'Tag', type: 'text' }],
        rows: [{ id: 'r1', cells: { c1: 'P-101' } }],
      },
      {
        nodeId: csv,
        ownerId: owner,
        extraMeta: {
          pipeline_id: 'sheet',
          pipeline_version: '0.9.0',
          pipeline_api: '1',
          shapes: '',
        },
      },
    );
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

  it('a user of Admin gets the list, with the count of a file read by an older version', async () => {
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
    expect({ files: sheet.files, older: sheet.older }).toEqual({ files: 1, older: 1 });
    // Numbers only: no file name, no id, no cell.
    expect(text).not.toContain(csv);
    expect(text).not.toContain('pumps');
    expect(text).not.toContain('P-101');
    console.log(`[pipelines-route] GET /api/pipelines answer: ${text}`);
  });

  it('a login without the settings area is refused by the policy: 403', async () => {
    const out = await get(outsider);
    expect(out.status, await out.clone().text()).toBe(403);
    const mem = await get(member);
    expect(mem.status, await mem.clone().text()).toBe(403);
  });
});
