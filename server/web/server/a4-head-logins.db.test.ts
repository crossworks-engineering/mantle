/**
 * The owner's decision of 2026-10-14, 2a (A4 hand batch A, docs/actors.md):
 * a HEAD row has its GET row's logins. The 17 GET rows of the any-login,
 * chat and Telegram lists ran their HEAD on the system pool (login-self)
 * for every login; they run under the login's own rule now, as the GET
 * does. A GET row added to those lists since is held here the same way (19
 * rows with GET /api/workspaces/:id/connector-options, 0315, and GET
 * /api/profile/home-desk, desk saving v2; the messenger and people rows). The guard sweep records the
 * actor and outcome it notes; this test
 * runs the REAL handler bodies through the real app (createApp) on a
 * migrated scratch database and holds each HEAD to its GET: the same
 * status and the same headers, with no body, for every login kind (the
 * brain's owner, another Admin user, a member, no login). No owner session
 * is minted on a real brain: the logins are rows of the scratch database.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a4-head-logins.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSuperuser, teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)("2a: a HEAD answers as its GET on the login lists' rows", () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor, an Admin user
  const admin = randomUUID(); // another user of Admin
  const member = randomUUID(); // a member of Team
  const page = randomUUID(); // an item homed in Team
  const thread = randomUUID(); // a thread id no login holds
  const tag = `a4hl${randomUUID().slice(0, 6)}`;
  let teamWs = '';
  let rows: string[] = [];

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A fixture write to the workspace tables, as the superuser: the app
   *  pools only read them. */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

  /** A concrete path for a row's pattern: its params name real rows. */
  const pathOf = (pattern: string) =>
    pattern
      .replace(/^\/api\/workspaces\/:id/, `/api/workspaces/${teamWs}`)
      .replace(/^\/api\/grants\/:nodeId/, `/api/grants/${page}`)
      .replace(/^\/api\/assistant\/threads\/:id/, `/api/assistant/threads/${thread}`)
      .replace(/\/api\/workspaces\/user-search$/, '/api/workspaces/user-search?q=a')
      // A conversation nobody is in: every login hears not found, GET and HEAD.
      .replace(/^\/api\/messenger\/c\/:id/, `/api/messenger/c/${randomUUID()}`)
      // The owner's photo: it has none, so every signed-in login hears the one 404.
      .replace(/^\/api\/messenger\/photo\/:loginId/, `/api/messenger/photo/${owner}`)
      // The owner's card and photo (no photo: the one 404 for its photo).
      .replace(/^\/api\/people\/:id/, `/api/people/${owner}`);

  /** One request: its status, every header, its body. A stream is read no
   *  further than its headers and closed (the abort runs the handler's
   *  cleanup, as a client hanging up does). */
  const drive = async (method: 'GET' | 'HEAD', p: string, login: string | null) => {
    const ac = new AbortController();
    const res = await app.request(p, {
      method,
      headers: login ? { cookie: cookieOf(login) } : {},
      signal: ac.signal,
    });
    const headers = Object.fromEntries(
      [...res.headers.entries()].filter(([k]) => k !== 'date').sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    let body = '';
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      await res.body?.cancel().catch(() => undefined);
    } else {
      body = await res.text();
    }
    ac.abort();
    return { status: res.status, headers, body };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a4-head-logins-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a4-head-logins-secret-at-least-32-chars!';
    delete process.env.MANTLE_DETACHED_DEV;
    // No network from a handler body (a provider, a release check).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the 2a HEAD test', { status: 503 })),
    );
    m = await import('@mantle/db');
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${admin}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin', 'Admin user'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    await su(sql.raw(teamWorkspaceSql(owner)));
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key
      from workspaces where owner_id = ${owner}`);
    teamWs = ws.find((w) => w.key === 'team')!.id;
    const adminWs = ws.find((w) => w.key === 'admin')!.id;
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${admin}, false), (${teamWs}, ${member}, false)
      on conflict do nothing`);
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${page}, ${owner}, 'page', ${`${tag} page`}, 'pages')`);
    await m.withHeads([page], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${page}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${page}, ${teamWs}, true)`);
    });
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    // The any-login, chat and Telegram rows' GETs, read off the rows (S9
    // part 3: the lists are gone).
    const { routeManifest } = await import('./route-manifest.gen');
    const answers = (await import('./test-support')).rowAnswers(routeManifest);
    rows = routeManifest
      .filter((e) => e.methods.includes('GET') && answers.isAnyLoginRoute('GET', e.pattern))
      .map((e) => e.pattern);
    const { createApp } = await import('./app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    // The realtime bridge the event streams opened (its own LISTEN
    // connection), closed before the scratch database goes.
    const bridge = (globalThis as { __mantleRealtime?: { stop?: (() => Promise<void>) | null } })
      .__mantleRealtime;
    await bridge?.stop?.();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the 17 rows 2a changed, and the ones added since: HEAD has the status and the headers of GET, and no body', async () => {
    // 19, the six messenger GET rows of Messenger V1 Phase 1, the
    // messenger photo of the messenger avatars, and the four people rows.
    expect(rows).toHaveLength(30);
    const logins: Array<[string, string | null]> = [
      ['owner', owner],
      ['admin', admin],
      ['member', member],
      ['none', null],
    ];
    const ok = new Map<string, number>();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const pattern of rows) {
        const p = pathOf(pattern);
        expect(p, pattern).not.toContain(':');
        for (const [name, login] of logins) {
          const label = `${pattern} ${name}`;
          const get = await drive('GET', p, login);
          const head = await drive('HEAD', p, login);
          expect({ status: head.status, headers: head.headers }, label).toEqual({
            status: get.status,
            headers: get.headers,
          });
          expect(head.body, label).toBe('');
          if (get.status === 200) ok.set(name, (ok.get(name) ?? 0) + 1);
        }
      }
    } finally {
      quiet.mockRestore();
    }
    // Every login kind reached the handler bodies to a 200 on its rows (the
    // shell, its workspaces, its keys, its chats); no login none.
    for (const name of ['owner', 'admin', 'member']) {
      expect(ok.get(name) ?? 0, name).toBeGreaterThanOrEqual(5);
    }
    expect(ok.get('none')).toBeUndefined();
  }, 240_000);
});
