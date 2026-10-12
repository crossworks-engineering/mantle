/**
 * A member's run of an app on the shared runner, /api/apps/:id (member logins
 * Phase 4b, plan v3.1 section 4a; every login since workspaces W7e, the
 * member's own /api/member/apps routes 410 since W8d), without a database:
 * the lookups and the tool rules are stood in, so these pin what the ROUTES
 * must do with them. The tool broker dispatches in the app's scope for the
 * login (withViewer) on a team surface that names the login; the db broker
 * checks the app before it touches SQLite; the frame opens a member ticket
 * only on the published build. The rules themselves are proven on Postgres in
 * packages/{content,tools}/src/member-app*.viewer.db.test.ts. Also: the
 * removed member app, file and drawing routes answer 410, and the member
 * home (kept) reads in the member's scope.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const LOGIN = '22222222-2222-4222-8222-222222222222';
const APP = '77777777-7777-4777-8777-777777777777';
const OTHER_APP = '88888888-8888-4888-8888-888888888888';
const PUBLISHED = { storageKey: 'apps/published.js', ok: true };
// The scope a member's app tool runs in: the app, for this login (AppRunFor).
const APP_SCOPE = { login: LOGIN, app: { id: APP } };

const h = vi.hoisted(() => ({
  runnable: true,
  // The grant's Write switch of the member's workspace (workspaces W5b2).
  writable: true,
  dataReadOnly: false,
  displayName: 'Pat' as string | null,
  lookups: [] as string[],
  // `ranAs`: 'system' when the read ran as is, else the actsFor of the
  // withViewer it ran inside.
  reads: [] as Array<{ fn: string; ranAs: unknown }>,
  launcherReads: [] as Array<{ ranAs: unknown; reader: string; loginId: string }>,
  homeAppId: undefined as string | undefined,
  loginActive: true,
  verdict: { ok: true } as { ok: boolean; status?: number; reason?: string },
  // The handler kind of the tool an allowed verdict hands back: 'mcp' stands
  // for an outside tool an admin opened to team apps.
  toolKind: 'builtin' as 'builtin' | 'mcp',
  toolSlugs: ['note_list'] as string[],
  levels: [] as string[],
  dispatched: [] as Array<{ ranAs: unknown; ctx: Record<string, unknown> }>,
  logged: [] as Array<Record<string, unknown>>,
  dbCalls: [] as string[],
  dbError: null as Error | null,
  callers: [] as unknown[],
  synced: 0,
  rendered: [] as string[],
  frameViewers: [] as unknown[],
  // Who each withViewer call acted for.
  viewers: [] as unknown[],
  // The actsFor of the withViewer the code runs inside now (null: system).
  current: null as unknown,
}));

// No database: the workspace scope withViewer enters is read on Postgres
// (packages/db/src/viewer-shim.db.test.ts). Here withViewer records who the
// route acts for and marks what runs inside it, and asSystem clears the mark,
// so the stand-ins below see whether a read ran in the scope or as system.
vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  const marked = async <T>(actsFor: unknown, fn: () => Promise<T>): Promise<T> => {
    const outer = h.current;
    h.current = actsFor;
    try {
      return await fn();
    } finally {
      h.current = outer;
    }
  };
  return {
    ...real,
    withViewer: vi.fn(async (actsFor: unknown, fn: () => Promise<unknown>) => {
      h.viewers.push(actsFor);
      return marked(actsFor, fn);
    }),
    asSystem: vi.fn((fn: () => Promise<unknown>, reason?: never) =>
      real.asSystem(() => marked(null, fn), reason),
    ),
  };
});

vi.mock('@/lib/auth', async (importOriginal) => {
  const member = () => ({
    role: 'member',
    loginId: LOGIN,
    anchorId: ANCHOR,
    email: 'pat@example.invalid',
    displayName: h.displayName,
    contactId: null,
  });
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    // The shared runner's guard: this caller is a member login.
    getOwnerOr401WithLogin: vi.fn(async () => ({
      kind: 'member',
      user: { id: ANCHOR, email: 'pat@example.invalid', actor: { id: LOGIN } },
      source: 'web',
      member: member(),
    })),
    getMemberOr401: vi.fn(async () => member()),
    getMemberForAsset: vi.fn(async () => member()),
    memberLoginActive: vi.fn(async () => h.loginActive),
  };
});
vi.mock('@mantle/content', async (importOriginal) => {
  const read = <T>(fn: string, value: T) => {
    h.reads.push({ fn, ranAs: h.current ?? 'system' });
    return value;
  };
  const card = (id: string, title: string) => ({
    id,
    title,
    icon: null,
    color: null,
    description: null,
    updatedAt: '2026-09-27T00:00:00.000Z',
  });
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    getMemberRunnableApp: vi.fn(async (_anchor: string, id: string) => {
      h.lookups.push(id);
      return h.runnable
        ? {
            id,
            title: 'Polls',
            icon: null,
            color: null,
            writable: h.writable,
            manifest: { toolSlugs: h.toolSlugs },
            publishedBuild: PUBLISHED,
            dataReadOnly: h.dataReadOnly,
          }
        : null;
    }),
    loadProfilePreferences: vi.fn(async () => ({ siteName: 'Brain', teamHubAppId: h.homeAppId })),
    resolveMemberHomeApp: vi.fn(async (_anchor: string, id: string | undefined) =>
      read(
        'resolveMemberHomeApp',
        id === APP && h.runnable ? { appId: APP, title: 'Polls', icon: null, color: null } : null,
      ),
    ),
    listMemberApps: vi.fn(async () =>
      read('listMemberApps', [card(APP, 'Polls'), card(OTHER_APP, 'Budget')]),
    ),
    appLauncher: vi.fn(async (_anchor: string, reader: string, loginId: string) => {
      h.launcherReads.push({ ranAs: h.current ?? 'system', reader, loginId });
      return {
        apps: [card(APP, 'Polls'), card(OTHER_APP, 'Budget')],
        folders: [
          { id: 'f1', name: 'Tools', icon: null, color: 'teal', parentId: null, appIds: [APP] },
        ],
      };
    }),
    listLibrary: vi.fn(async () =>
      read('listLibrary', {
        items: [
          {
            id: 'p1',
            type: 'page',
            title: 'Plan',
            icon: null,
            summary: 'S',
            updatedAt: 'u',
          },
        ],
        total: 1,
      }),
    ),
    libraryCounts: vi.fn(async () =>
      read('libraryCounts', { page: 1, note: 0, draw: 0, table: 0, file: 0 }),
    ),
    getApp: vi.fn(async () => {
      throw new Error('the owner frame must refuse before it loads the app');
    }),
    recordAppAccess: vi.fn((e: Record<string, unknown>) => h.logged.push(e)),
  };
});
vi.mock('@mantle/tools', async (importOriginal) => {
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    // The rule (appToolLevel, appToolScope) is the real one; the verdict
    // records the rules it was asked at. At none the REAL rules answer: they
    // refuse before any lookup.
    appToolVerdict: vi.fn(
      async (level: string, owner: string, declared: string[], slug: string) => {
        h.levels.push(level);
        if (level === 'none') {
          const real = await importOriginal<typeof import('@mantle/tools')>();
          return real.appToolVerdict(level, owner, declared, slug);
        }
        const handler =
          h.toolKind === 'builtin'
            ? { kind: 'builtin', ref: slug }
            : { kind: 'mcp', group: 'mcp-site', toolName: 'query' };
        return h.verdict.ok ? { ok: true, tool: { slug, handler } } : h.verdict;
      },
    ),
    dispatchTool: vi.fn(async (_tool: unknown, _input: unknown, ctx: Record<string, unknown>) => {
      h.dispatched.push({ ranAs: h.current ?? 'system', ctx });
      return { ok: true, output: [] };
    }),
  };
});
vi.mock('@mantle/content/app-broker', async (importOriginal) => {
  const { AppSqlError, AppSqlBusyError, AppDbMissingError } =
    await importOriginal<typeof import('@mantle/content/app-broker')>();
  // The SQLite work must run as system work: it writes registry rows.
  const call = (op: string, owner: string, app: string) =>
    h.dbCalls.push(`${op}:${owner}:${app}:${h.current === null ? 'system' : 'scoped'}`);
  return {
    AppSqlError,
    AppSqlBusyError,
    AppDbMissingError,
    appDbQuery: vi.fn(async (owner: string, app: string, ...rest: unknown[]) => {
      h.callers.push(rest[3]);
      if (h.dbError) throw h.dbError;
      return (call('query', owner, app), []);
    }),
    appDbExec: vi.fn(async (owner: string, app: string, ...rest: unknown[]) => {
      h.callers.push(rest[3]);
      if (h.dbError) throw h.dbError;
      return (call('exec', owner, app), { changes: 1 });
    }),
  };
});
vi.mock('@mantle/content/app-table-exports', () => ({
  scheduleAppTableExportSync: vi.fn(() => (h.synced += 1)),
}));
vi.mock('@/lib/app-frame', () => ({
  renderAppFrame: vi.fn(
    async (_req: Request, build: { storageKey: string }, opts?: { viewer?: unknown }) => {
      h.rendered.push(build.storageKey);
      h.frameViewers.push(opts?.viewer);
      return new Response('<!doctype html>', { status: 200 });
    },
  ),
}));

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let toolBroker: Handler;
let dbBroker: Handler;
let ticketRoute: Handler;
let frame: Handler;
let ownerFrame: Handler;
let homeRoute: () => Promise<Response>;
let verdictMock: ReturnType<typeof vi.fn>;
let tokens: typeof import('@/lib/auth/tokens');

const params = (id = APP) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) =>
  new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });

beforeAll(async () => {
  process.env.SESSION_SECRET = 'member-app-routes-secret-at-least-32-chars';
  toolBroker = (await import('./[id]/tool-broker/route')).POST;
  dbBroker = (await import('./[id]/db-broker/route')).POST;
  ticketRoute = (await import('./[id]/frame-ticket/route')).POST;
  frame = (await import('./[id]/frame/route')).GET;
  ownerFrame = frame;
  homeRoute = (await import('../member/home/route')).GET;
  verdictMock = vi.mocked((await import('@mantle/tools')).appToolVerdict) as never;
  tokens = await import('@/lib/auth/tokens');
}, 60_000);

beforeEach(() => {
  h.runnable = true;
  h.writable = true;
  h.dataReadOnly = false;
  h.displayName = 'Pat';
  h.lookups.length = 0;
  h.reads.length = 0;
  h.launcherReads.length = 0;
  h.homeAppId = undefined;
  verdictMock?.mockClear();
  h.loginActive = true;
  h.verdict = { ok: true };
  h.toolKind = 'builtin';
  h.toolSlugs = ['note_list'];
  h.levels.length = 0;
  h.dispatched.length = 0;
  h.logged.length = 0;
  h.dbCalls.length = 0;
  h.dbError = null;
  h.callers.length = 0;
  h.synced = 0;
  h.rendered.length = 0;
  h.frameViewers.length = 0;
  h.viewers.length = 0;
});

describe('member tool broker', () => {
  it("an outside tool an admin opened to team apps runs in the app's scope, and the log names the member and the kind", async () => {
    h.toolKind = 'mcp';
    h.toolSlugs = ['site_query'];
    const res = await toolBroker(post({ slug: 'site_query', input: { q: 'x' } }), params());
    expect(res.status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]!.ranAs).toEqual(APP_SCOPE);
    expect(h.dispatched[0]!.ctx).toMatchObject({
      surface: { kind: 'team', loginId: LOGIN, privateReads: false },
    });
    expect(h.logged[0]).toMatchObject({
      actorId: LOGIN,
      kind: 'tool',
      detail: { via: 'member', slug: 'site_query', handler: 'mcp' },
    });
  });

  it('a refused outside tool is logged with the member and the reason, and never dispatched', async () => {
    h.toolSlugs = ['site_query'];
    h.verdict = {
      ok: false,
      status: 403,
      reason: "The tool 'site_query' can't be used from a team app",
    };
    const res = await toolBroker(post({ slug: 'site_query', input: {} }), params());
    expect(res.status).toBe(403);
    expect(h.dispatched).toHaveLength(0);
    expect(h.logged[0]).toMatchObject({
      actorId: LOGIN,
      detail: { via: 'member', slug: 'site_query', refused: expect.stringMatching(/team app/) },
    });
  });

  it("dispatches in the app's scope for the login with a team surface that names the login", async () => {
    const res = await toolBroker(post({ slug: 'note_list', input: {} }), params());
    expect(res.status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]!.ranAs).toEqual(APP_SCOPE);
    expect(h.dispatched[0]!.ctx).toMatchObject({
      ownerId: ANCHOR,
      surface: { kind: 'team', loginId: LOGIN, privateReads: false },
    });
    expect(h.logged[0]).toMatchObject({
      actorId: LOGIN,
      appNodeId: APP,
      kind: 'tool',
      detail: { via: 'member', slug: 'note_list' },
    });
    // The rule is asked about THIS app's declared tools, for this brain,
    // for this login (its connector rule, W4b fix round 2), and this app (every
    // workspace that holds it must hold the connector, plan R2).
    expect(verdictMock).toHaveBeenCalledWith('team', ANCHOR, ['note_list'], 'note_list', LOGIN, {
      appId: APP,
    });
    expect(h.dispatched[0]!.ctx).toMatchObject({ surface: { contactName: 'Pat' } });
  });

  // Workspaces W5b2 (plan R2): an app a member runs is held by a workspace
  // of theirs, so it runs the member rules; no client rules for it.
  it('runs every app a member may run on the member rules, Write on or off', async () => {
    for (const writable of [true, false]) {
      h.writable = writable;
      h.levels.length = 0;
      const res = await toolBroker(post({ slug: 'note_list', input: {} }), params());
      expect(res.status).toBe(200);
      expect(h.levels).toEqual(['team']);
    }
    expect(h.dispatched.map((d) => d.ranAs)).toEqual([APP_SCOPE, APP_SCOPE]);
  });

  it('passes a refusal through, dispatches nothing, and logs the refusal', async () => {
    h.verdict = { ok: false, status: 403, reason: 'not in a team-level tool group' };
    const res = await toolBroker(post({ slug: 'admin_only' }), params());
    expect(res.status).toBe(403);
    expect(h.dispatched).toHaveLength(0);
    expect(h.logged[0]).toMatchObject({
      kind: 'tool',
      detail: { via: 'member', slug: 'admin_only', refused: 'not in a team-level tool group' },
    });
  });

  it('names a member without a display name by the email before the @', async () => {
    h.displayName = '  ';
    await toolBroker(post({ slug: 'note_list' }), params());
    expect(h.dispatched[0]!.ctx).toMatchObject({ surface: { contactName: 'pat' } });
  });

  it('looks up a well-formed id in lower case and never a malformed one', async () => {
    const lettered = 'abcdef12-3456-4789-8abc-def012345678';
    await toolBroker(post({ slug: 'note_list' }), params(lettered.toUpperCase()));
    expect(h.lookups).toEqual([lettered]);
    h.lookups.length = 0;
    const res = await toolBroker(post({ slug: 'note_list' }), params('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(h.lookups).toEqual([]);
  });

  it('answers 404 for an app the member may not run', async () => {
    h.runnable = false;
    const res = await toolBroker(post({ slug: 'note_list' }), params());
    expect(res.status).toBe(404);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe('a member-built app (team apps Phase 3)', () => {
  // Since W6b such an app is a brain item in its author's private workspace,
  // found by the one lookup in the login's scope; the space-app lookup on the
  // system pool went with W7e, its code in W8d.
  it('is not looked up on the system pool: what the scope misses is a 404', async () => {
    h.runnable = false;
    const res = await dbBroker(post({ op: 'exec', sql: 'insert into t values (1)' }), params());
    expect(res.status).toBe(404);
    expect(h.dbCalls).toEqual([]);
    const tool = await toolBroker(post({ slug: 'note_list' }), params());
    expect(tool.status).toBe(404);
    expect(h.levels).toEqual([]);
  });
});

describe('member db broker', () => {
  it('runs under the login as its caller key and hides a server error (audit I1, L4)', async () => {
    await dbBroker(post({ op: 'query', sql: 'select 1' }), params());
    // App identity: the member fills the :host_me_* parameters.
    expect(h.callers).toEqual([
      {
        callerKey: `member:${LOGIN}`,
        viewer: { kind: 'member', loginId: LOGIN, name: 'Pat' },
        // Rows only below admin (access matrix audit, M1).
        dataOnly: true,
      },
    ]);
    const err = console.error;
    console.error = () => {};
    let res: Response;
    try {
      h.dbError = new Error(`EACCES: mkdir '/data/app-dbs/${ANCHOR}'`);
      res = await dbBroker(post({ op: 'query', sql: 'select 1' }), params());
    } finally {
      console.error = err;
    }
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('/data/app-dbs');
  });

  it('checks the app before it touches SQLite', async () => {
    h.runnable = false;
    const res = await dbBroker(post({ op: 'exec', sql: 'delete from t' }), params());
    expect(res.status).toBe(404);
    expect(h.dbCalls).toEqual([]);
    expect(h.synced).toBe(0);
  });

  it("writes to the brain's app database and schedules the export sync", async () => {
    const res = await dbBroker(post({ op: 'exec', sql: 'insert into t values (1)' }), params());
    expect(res.status).toBe(200);
    expect(h.dbCalls).toEqual([`exec:${ANCHOR}:${APP}:system`]);
    expect(h.synced).toBe(1);
    expect(h.logged[0]).toMatchObject({ actorId: LOGIN, kind: 'db' });
  });

  // Workspaces W5b2: the grant's Write switch decides (Informational is
  // Write off).
  it("refuses a write where the grant's Write is off, and still reads", async () => {
    h.writable = false;
    const res = await dbBroker(post({ op: 'exec', sql: 'insert into t values (1)' }), params());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'read-only' });
    expect(h.logged[0]).toMatchObject({ detail: { op: 'exec', refused: 'read-only' } });
    expect(h.dbCalls).toEqual([]);
    expect(h.synced).toBe(0);
    await dbBroker(post({ op: 'query', sql: 'select 1' }), params());
    expect(h.dbCalls).toEqual([`query:${ANCHOR}:${APP}:system`]);
  });

  it('reads without scheduling a sync', async () => {
    await dbBroker(post({ op: 'query', sql: 'select 1' }), params());
    expect(h.dbCalls).toEqual([`query:${ANCHOR}:${APP}:system`]);
    expect(h.synced).toBe(0);
  });
});

describe('member frame', () => {
  const frameReq = (ticket: string, id = APP) =>
    new Request(`http://x/api/apps/${id}/frame?t=${encodeURIComponent(ticket)}`);

  it('mints a ticket that names the login', async () => {
    const res = await ticketRoute(post({}), params());
    const { ticket } = (await res.json()) as { ticket: string };
    expect(tokens.verifyAppFrameTicket(ticket)).toMatchObject({
      ownerId: ANCHOR,
      appId: APP,
      loginId: LOGIN,
    });
  });

  it('logs the ticket and mints none for an app the member may not run', async () => {
    await ticketRoute(post({}), params());
    expect(h.logged[0]).toMatchObject({ kind: 'auth', actorId: LOGIN, detail: { via: 'member' } });
    h.logged.length = 0;
    h.runnable = false;
    const res = await ticketRoute(post({}), params());
    expect(res.status).toBe(404);
    expect(await res.json()).not.toHaveProperty('ticket');
    expect(h.logged).toEqual([]);
  });

  it('opens the frame when the URL carries the app id in upper case', async () => {
    const lettered = 'abcdef12-3456-4789-8abc-def012345678';
    const t = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: lettered, loginId: LOGIN });
    const upper = lettered.toUpperCase();
    const res = await frame(frameReq(t, upper), params(upper));
    expect(res.status).toBe(200);
  });

  it('serves the PUBLISHED build for a member ticket', async () => {
    const t = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP, loginId: LOGIN });
    const res = await frame(frameReq(t), params());
    expect(res.status).toBe(200);
    expect(h.rendered).toEqual([PUBLISHED.storageKey]);
    // host.me(): the member the ticket names (app identity).
    expect(h.frameViewers).toEqual([
      { ownerId: ANCHOR, appId: APP, subject: { kind: 'member', loginId: LOGIN } },
    ]);
  });

  it('refuses an owner ticket, a share ticket and a ticket for another app', async () => {
    const owner = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP });
    const share = tokens.buildAppFrameTicket({
      ownerId: ANCHOR,
      appId: APP,
      shareId: '99999999-9999-4999-8999-999999999999',
      loginId: LOGIN,
    });
    const elsewhere = tokens.buildAppFrameTicket({
      ownerId: ANCHOR,
      appId: OTHER_APP,
      loginId: LOGIN,
    });
    for (const t of [owner, share, elsewhere]) {
      expect((await frame(frameReq(t), params())).status).toBe(401);
    }
    expect(h.rendered).toEqual([]);
  });

  it('refuses once the login is no longer an active member', async () => {
    h.loginActive = false;
    const t = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP, loginId: LOGIN });
    expect((await frame(frameReq(t), params())).status).toBe(401);
    expect(h.rendered).toEqual([]);
  });

  it('opens an app whose grant has Write off, read only', async () => {
    h.writable = false;
    const res = await ticketRoute(post({}), params());
    expect(res.status).toBe(200);
    const { ticket } = (await res.json()) as { ticket: string };
    expect((await frame(frameReq(ticket), params())).status).toBe(200);
    expect(h.rendered).toEqual([PUBLISHED.storageKey]);
    const write = await dbBroker(post({ op: 'exec', sql: 'insert into t values (1)' }), params());
    expect(write.status).toBe(403);
  });

  it('answers 404 once the app is no longer one the member may run', async () => {
    h.runnable = false;
    const t = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP, loginId: LOGIN });
    expect((await frame(frameReq(t), params())).status).toBe(404);
  });

  it("refuses a client's ticket (client logins C6), whatever its login", async () => {
    const t = tokens.buildAppFrameTicket({
      ownerId: ANCHOR,
      appId: APP,
      loginId: LOGIN,
      clientEpoch: 0,
    });
    expect((await frame(frameReq(t), params())).status).toBe(401);
    expect(h.rendered).toEqual([]);
  });

  it('the owner frame refuses a client ticket and serves a member ticket the PUBLISHED build (W7e)', async () => {
    const client = tokens.buildAppFrameTicket({
      ownerId: ANCHOR,
      appId: APP,
      loginId: LOGIN,
      clientEpoch: 0,
    });
    const refused = await ownerFrame(
      new Request(`http://x/api/apps/${APP}/frame?t=${encodeURIComponent(client)}`),
      params(),
    );
    expect(refused.status).toBe(401);
    expect(h.rendered).toEqual([]);
    const t = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP, loginId: LOGIN });
    const res = await ownerFrame(
      new Request(`http://x/api/apps/${APP}/frame?t=${encodeURIComponent(t)}`),
      params(),
    );
    expect(res.status).toBe(200);
    expect(h.rendered).toEqual([PUBLISHED.storageKey]);
  });
});

describe('the removed member routes (W8d)', () => {
  it('the member app, file and drawing routes answer 410 gone to a member', async () => {
    const gone = [
      await (await import('../member/apps/route')).GET(),
      await (await import('../member/apps/[id]/tool-broker/route')).POST(),
      await (await import('../member/apps/[id]/db-broker/route')).POST(),
      await (await import('../member/apps/[id]/frame-ticket/route')).POST(),
      await (await import('../member/files/[id]/route')).GET(new Request('http://x/f')),
      await (await import('../member/draws/[id]/svg/route')).GET(new Request('http://x/d')),
    ];
    for (const res of gone) {
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ code: 'gone' });
    }
    // Nothing ran: no lookup, no tool, no SQLite.
    expect(h.lookups).toEqual([]);
    expect(h.dispatched).toEqual([]);
    expect(h.dbCalls).toEqual([]);
  });

  it('the member frame keeps its ticket guard, then answers 410 and renders nothing', async () => {
    const memberFrame = (await import('../member/apps/[id]/frame/route')).GET;
    const req = (t: string) =>
      new Request(`http://x/api/member/apps/${APP}/frame?t=${encodeURIComponent(t)}`);
    expect((await memberFrame(new Request('http://x/f'), params())).status).toBe(401);
    const t = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP, loginId: LOGIN });
    expect((await memberFrame(req(t), params())).status).toBe(410);
    expect(h.rendered).toEqual([]);
  });
});

describe('member home', () => {
  it('gives no hub data when nothing is pinned, and skips the hub reads', async () => {
    const body = await (await homeRoute()).json();
    expect(body).toEqual({ homeApp: null, hub: null });
    expect(h.reads.map((r) => r.fn)).toEqual(['resolveMemberHomeApp']);
  });

  it("answers hub.get for a pinned app, read in the member's scope, without the app itself", async () => {
    h.homeAppId = APP;
    const body = (await (await homeRoute()).json()) as {
      homeApp: { appId: string };
      hub: {
        memberName: string;
        siteName: string;
        sections: Array<{ token: string; parentToken: unknown }>;
        counts: Record<string, number>;
        apps: Array<{ token: string }>;
      };
    };
    expect(body.homeApp.appId).toBe(APP);
    expect(body.hub).toMatchObject({ memberName: 'Pat', siteName: 'Brain' });
    expect(body.hub.sections).toEqual([
      expect.objectContaining({ token: 'p1', parentToken: null }),
    ]);
    expect(Object.keys(body.hub.counts).sort()).toEqual(['draw', 'file', 'note', 'page', 'table']);
    expect(body.hub.apps.map((a) => a.token)).toEqual([OTHER_APP]);
    expect(h.reads.length).toBe(4);
    expect(h.reads.map((r) => r.ranAs)).toEqual(Array(4).fill({ login: LOGIN }));
  });
});
