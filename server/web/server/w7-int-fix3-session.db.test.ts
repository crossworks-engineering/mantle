/**
 * The W7 integration fix 3, L1, through the real app (createApp) on a
 * migrated scratch database: under MANTLE_ADMIN_READS=system an owner
 * route's read goes to the system pool only for a login that holds the
 * Admin workspace now. A login with the admin role that was taken out of
 * Admin (a user of Team only) reads in its own scope, as every other user.
 * No owner session is made: the two logins are not the brain owner.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7-int-fix3-session.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('W7 integration fix 3, L1: the rollback switch asks for Admin', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor (no session made for it)
  const admin = randomUUID(); // a user of Admin
  const outsider = randomUUID(); // the admin role, a user of Team only
  const tag = `w7s3${randomUUID().slice(0, 6)}`;
  const pages = { admin: randomUUID(), team: randomUUID() };
  let adminWs = '';
  let teamWs = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const listed = async (as: string): Promise<string> => {
    const res = await app.request('/api/pages', { headers: { cookie: cookieOf(as) } });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    return text;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7-int-fix3-s-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'w7-int-fix3-session-secret-at-least-32-chars!';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${admin}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin', 'Admin user'),
      (${outsider}, ${`${tag}-x@example.invalid`}, 'x', false, 'admin', 'Outsider')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces where owner_id = ${owner}`);
    teamWs = ws.find((w) => w.key === 'team')!.id;
    adminWs = ws.find((w) => w.key === 'admin')!.id;
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${admin}, false) on conflict do nothing`);
    await x(
      sql`delete from workspace_users where workspace_id = ${adminWs} and login_id = ${outsider}`,
    );
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${outsider}, false) on conflict do nothing`);
    for (const [key, id] of Object.entries(pages)) {
      await x(sql`insert into nodes (id, owner_id, type, title, path)
                  values (${id}, ${owner}, 'page', ${`${tag} ${key} page`}, 'pages')`);
      const home = key === 'admin' ? adminWs : teamWs;
      await m.withHeads([id], 'update', async (tx) => {
        await tx.execute(sql`delete from item_grants where node_id = ${id}`);
        await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                             values (${id}, ${home}, true)`);
      });
    }
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    delete process.env.MANTLE_ADMIN_READS;
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the scoped default: each reads what its workspaces hold', async () => {
    const o = await listed(outsider);
    expect(o).toContain(pages.team);
    expect(o).not.toContain(pages.admin);
    expect(await listed(admin)).toContain(pages.admin);
  });

  it('under the switch an Admin user reads on the system pool; the admin role alone does not', async () => {
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      const a = await listed(admin);
      expect(a).toContain(pages.admin);
      expect(a).toContain(pages.team);
      const o = await listed(outsider);
      expect(o).toContain(pages.team);
      expect(o).not.toContain(pages.admin);
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
  });
});
