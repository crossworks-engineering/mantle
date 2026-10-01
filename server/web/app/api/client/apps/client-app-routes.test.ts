/**
 * The client app routes (client logins C6, docs/client-logins.md section
 * 10), without a database: the lookups and the tool rules are stood in, so
 * these pin what the ROUTES must do with them. Every read runs on the client
 * role; the tool broker dispatches on a client surface that names the login;
 * the db broker checks the app before it touches SQLite, refuses a write to
 * an informational app and schedules the export sync after a write; the
 * frame opens only for a client ticket at the login's current session epoch,
 * and only the published build; every call is logged with the client login.
 * The rules themselves are proven on Postgres in
 * packages/{content,tools}/src/client-app*.viewer.db.test.ts and end to end
 * in client-apps.db.test.ts next to this file.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const LOGIN = '12121212-1212-4212-8212-121212121212';
const APP = '77777777-7777-4777-8777-777777777777';
const OTHER_APP = '88888888-8888-4888-8888-888888888888';
const PUBLISHED = { storageKey: 'apps/published.js', ok: true };
const EPOCH = 3;

const h = vi.hoisted(() => ({
  runnable: true,
  dataReadOnly: false,
  displayName: 'Casey' as string | null,
  lookups: [] as Array<{ id: string; level: string }>,
  reads: [] as Array<{ fn: string; level: string }>,
  folderReads: [] as Array<{ level: string; places: unknown }>,
  active: [] as Array<{ loginId: string; epoch: number }>,
  loginActive: true,
  verdict: { ok: true } as { ok: boolean; status?: number; reason?: string },
  dispatched: [] as Array<{ level: string; ctx: Record<string, unknown> }>,
  logged: [] as Array<Record<string, unknown>>,
  dbCalls: [] as string[],
  dbError: null as Error | null,
  callers: [] as unknown[],
  marked: [] as string[],
  synced: [] as string[],
  rendered: [] as string[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getClientOr401: vi.fn(async () => ({
    role: 'client',
    loginId: LOGIN,
    anchorId: ANCHOR,
    spaceId: '66666666-6666-4666-8666-666666666666',
    email: 'casey@example.invalid',
    displayName: h.displayName,
    sessionEpoch: EPOCH,
  })),
  clientLoginActive: vi.fn(async (loginId: string, epoch: number) => {
    h.active.push({ loginId, epoch });
    return h.loginActive;
  }),
}));
vi.mock('@mantle/content', async (importOriginal) => {
  const { currentViewerLevel } = await import('@mantle/db');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    getClientRunnableApp: vi.fn(async (_anchor: string, id: string) => {
      h.lookups.push({ id, level: currentViewerLevel() });
      return h.runnable
        ? {
            id,
            title: 'Orders',
            icon: null,
            color: null,
            manifest: { toolSlugs: ['client_shared_list'] },
            publishedBuild: PUBLISHED,
            dataReadOnly: h.dataReadOnly,
          }
        : null;
    }),
    listClientAppsPlaced: vi.fn(async () => {
      h.reads.push({ fn: 'listClientAppsPlaced', level: currentViewerLevel() });
      return {
        apps: [
          {
            id: APP,
            title: 'Orders',
            icon: null,
            color: null,
            description: null,
            updatedAt: '2026-09-30T00:00:00.000Z',
            dataReadOnly: false,
          },
        ],
        places: [{ id: APP, path: 'apps.orders' }],
      };
    }),
    appLauncherFolders: vi.fn(async (_anchor: string, places: unknown) => {
      h.folderReads.push({ level: currentViewerLevel(), places });
      return [{ id: 'f1', name: 'Orders', icon: null, color: null, parentId: null, appIds: [APP] }];
    }),
    recordAppAccess: vi.fn((e: Record<string, unknown>) => h.logged.push(e)),
  };
});
vi.mock('@mantle/tools', async (importOriginal) => {
  const { currentViewerLevel } = await import('@mantle/db');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    appToolVerdict: vi.fn(async () =>
      h.verdict.ok ? { ok: true, tool: { slug: 'client_shared_list' } } : h.verdict,
    ),
    dispatchTool: vi.fn(async (_tool: unknown, _input: unknown, ctx: Record<string, unknown>) => {
      h.dispatched.push({ level: currentViewerLevel(), ctx });
      return { ok: true, output: [] };
    }),
  };
});
vi.mock('@mantle/content/app-broker', async (importOriginal) => {
  const { AppSqlError, AppSqlBusyError } =
    await importOriginal<typeof import('@mantle/content/app-broker')>();
  const { currentViewerLevel } = await import('@mantle/db');
  // The SQLite work runs on the admin pool: it writes registry rows.
  const call = (op: string, owner: string, app: string) =>
    h.dbCalls.push(`${op}:${owner}:${app}:${currentViewerLevel()}`);
  return {
    AppSqlError,
    AppSqlBusyError,
    markAppClientWritten: vi.fn(async (owner: string, app: string) => {
      h.marked.push(`${owner}:${app}`);
    }),
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
  scheduleAppTableExportSync: vi.fn((owner: string, app: string) =>
    h.synced.push(`${owner}:${app}`),
  ),
}));
vi.mock('@/lib/app-frame', () => ({
  renderAppFrame: vi.fn(async (_req: Request, build: { storageKey: string }) => {
    h.rendered.push(build.storageKey);
    return new Response('<!doctype html>', { status: 200 });
  }),
}));

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let toolBroker: Handler;
let dbBroker: Handler;
let ticketRoute: Handler;
let frame: Handler;
let memberFrame: Handler;
let ownerFrame: Handler;
let listRoute: () => Promise<Response>;
let verdictMock: ReturnType<typeof vi.fn>;
let tokens: typeof import('@/lib/auth/tokens');

const params = (id = APP) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) =>
  new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const clientTicket = (epoch = EPOCH, appId = APP) =>
  tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId, loginId: LOGIN, clientEpoch: epoch });
const frameReq = (ticket: string, id = APP) =>
  new Request(`http://x/api/client/apps/${id}/frame?t=${encodeURIComponent(ticket)}`);

beforeAll(async () => {
  process.env.SESSION_SECRET = 'client-app-routes-secret-at-least-32-chars';
  toolBroker = (await import('./[id]/tool-broker/route')).POST;
  dbBroker = (await import('./[id]/db-broker/route')).POST;
  ticketRoute = (await import('./[id]/frame-ticket/route')).POST;
  frame = (await import('./[id]/frame/route')).GET;
  memberFrame = (await import('../../member/apps/[id]/frame/route')).GET;
  ownerFrame = (await import('../../apps/[id]/frame/route')).GET;
  listRoute = (await import('./route')).GET;
  verdictMock = vi.mocked((await import('@mantle/tools')).appToolVerdict) as never;
  tokens = await import('@/lib/auth/tokens');
}, 60_000);

beforeEach(() => {
  h.runnable = true;
  h.dataReadOnly = false;
  h.displayName = 'Casey';
  h.lookups.length = 0;
  h.reads.length = 0;
  h.folderReads.length = 0;
  h.active.length = 0;
  h.loginActive = true;
  h.verdict = { ok: true };
  h.dispatched.length = 0;
  h.logged.length = 0;
  h.dbCalls.length = 0;
  h.dbError = null;
  h.callers.length = 0;
  h.marked.length = 0;
  h.synced.length = 0;
  h.rendered.length = 0;
  verdictMock?.mockClear();
});

describe('client app list', () => {
  it('lists on the client role', async () => {
    const body = (await (await listRoute()).json()) as { apps: Array<{ id: string }> };
    expect(body.apps.map((a) => a.id)).toEqual([APP]);
    expect(h.reads).toEqual([{ fn: 'listClientAppsPlaced', level: 'client' }]);
  });

  it('adds the folders of those apps, read as the brain from the apps it listed', async () => {
    const body = (await (await listRoute()).json()) as Record<string, unknown>;
    // The field an older client reads is still there, unchanged.
    expect(Object.keys(body).sort()).toEqual(['apps', 'folders']);
    expect(body.folders).toEqual([
      { id: 'f1', name: 'Orders', icon: null, color: null, parentId: null, appIds: [APP] },
    ]);
    // A card never carries its path: the places stay on the brain.
    expect(JSON.stringify(body.apps)).not.toContain('apps.orders');
    expect(h.folderReads).toEqual([{ level: 'admin', places: [{ id: APP, path: 'apps.orders' }] }]);
  });
});

describe('the app lookup', () => {
  it('runs on the client role, in lower case, and never for a malformed id', async () => {
    const lettered = 'abcdef12-3456-4789-8abc-def012345678';
    await dbBroker(post({ op: 'query', sql: 'select 1' }), params(lettered.toUpperCase()));
    expect(h.lookups).toEqual([{ id: lettered, level: 'client' }]);
    h.lookups.length = 0;
    const res = await dbBroker(post({ op: 'query', sql: 'select 1' }), params('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(h.lookups).toEqual([]);
  });

  it('answers every route the same 404 for an app the client may not run', async () => {
    const bodies: unknown[] = [];
    h.runnable = false;
    for (const [route, body] of [
      [ticketRoute, {}],
      [toolBroker, { slug: 'client_shared_list' }],
      [dbBroker, { op: 'query', sql: 'select 1' }],
    ] as const) {
      const res = await route(post(body), params());
      expect(res.status).toBe(404);
      bodies.push(await res.json());
    }
    // A malformed id (no lookup at all) answers exactly the same.
    h.runnable = true;
    const malformed = await dbBroker(post({ op: 'query', sql: 'select 1' }), params('x'));
    bodies.push(await malformed.json());
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(h.dispatched).toEqual([]);
    expect(h.dbCalls).toEqual([]);
    expect(h.logged).toEqual([]);
  });
});

describe('client tool broker', () => {
  it('dispatches on the client role with a client surface that names the login', async () => {
    const res = await toolBroker(post({ slug: 'client_shared_list', input: {} }), params());
    expect(res.status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]!.level).toBe('client');
    expect(h.dispatched[0]!.ctx).toMatchObject({
      ownerId: ANCHOR,
      surface: { kind: 'client', loginId: LOGIN, contactName: 'Casey' },
    });
    // The rule is asked about THIS app's declared tools, for this brain.
    expect(verdictMock).toHaveBeenCalledWith(
      'client',
      ANCHOR,
      ['client_shared_list'],
      'client_shared_list',
    );
    expect(h.logged[0]).toMatchObject({
      ownerId: ANCHOR,
      actorId: LOGIN,
      appNodeId: APP,
      kind: 'tool',
      detail: { via: 'client', slug: 'client_shared_list' },
    });
  });

  it('passes a refusal through, dispatches nothing, and logs the refusal', async () => {
    h.verdict = { ok: false, status: 403, reason: 'not available in client apps' };
    const res = await toolBroker(post({ slug: 'search_chunks' }), params());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'not available in client apps' });
    expect(h.dispatched).toHaveLength(0);
    expect(h.logged[0]).toMatchObject({
      actorId: LOGIN,
      kind: 'tool',
      detail: { via: 'client', slug: 'search_chunks', refused: 'not available in client apps' },
    });
  });

  it('names a client without a display name by the email before the @', async () => {
    h.displayName = null;
    await toolBroker(post({ slug: 'client_shared_list' }), params());
    expect(h.dispatched[0]!.ctx).toMatchObject({ surface: { contactName: 'casey' } });
  });
});

describe('client db broker', () => {
  it('runs every statement under the login as its caller key (audit I1)', async () => {
    await dbBroker(post({ op: 'query', sql: 'select 1' }), params());
    // A read marks nothing (audit I3: only a client's write does).
    expect(h.marked).toEqual([]);
    await dbBroker(post({ op: 'exec', sql: 'insert into t values (1)' }), params());
    expect(h.callers).toEqual([{ callerKey: `client:${LOGIN}` }, { callerKey: `client:${LOGIN}` }]);
  });

  it("shows the app's own SQL error, but never a server error's text (audit L4)", async () => {
    const { AppSqlError, AppSqlBusyError } = await import('@mantle/content/app-broker');
    h.dbError = new AppSqlError('no such table: nope');
    let res = await dbBroker(post({ op: 'query', sql: 'select * from nope' }), params());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'no such table: nope' });

    h.dbError = new AppSqlBusyError('app SQL is busy: try again');
    res = await dbBroker(post({ op: 'query', sql: 'select 1' }), params());
    expect(res.status).toBe(429);

    const err = console.error;
    console.error = () => {};
    try {
      h.dbError = new Error(`EACCES: permission denied, mkdir '/data/app-dbs/${ANCHOR}'`);
      res = await dbBroker(post({ op: 'exec', sql: 'insert into t values (1)' }), params());
    } finally {
      console.error = err;
    }
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('/data/app-dbs');
    expect(text).not.toContain(ANCHOR);
    expect(h.synced).toEqual([]);
  });

  it('writes the app database, schedules the export sync, and logs the login', async () => {
    const res = await dbBroker(post({ op: 'exec', sql: 'insert into t values (1)' }), params());
    expect(res.status).toBe(200);
    expect(h.dbCalls).toEqual([`exec:${ANCHOR}:${APP}:admin`]);
    expect(h.synced).toEqual([`${ANCHOR}:${APP}`]);
    // Remembered for good: the app's exports stay client-sourced (audit I3).
    expect(h.marked).toEqual([`${ANCHOR}:${APP}`]);
    expect(h.logged).toEqual([
      expect.objectContaining({
        ownerId: ANCHOR,
        appNodeId: APP,
        actorId: LOGIN,
        kind: 'db',
        detail: { via: 'client', op: 'exec' },
      }),
    ]);
  });

  it('reads without scheduling a sync', async () => {
    await dbBroker(post({ op: 'query', sql: 'select 1' }), params());
    expect(h.dbCalls).toEqual([`query:${ANCHOR}:${APP}:admin`]);
    expect(h.synced).toEqual([]);
    expect(h.logged[0]).toMatchObject({ actorId: LOGIN, detail: { via: 'client', op: 'query' } });
  });

  it('refuses a write to an informational app, logs it, and still reads', async () => {
    h.dataReadOnly = true;
    const res = await dbBroker(post({ op: 'exec', sql: 'insert into t values (1)' }), params());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'read-only' });
    expect(h.dbCalls).toEqual([]);
    expect(h.synced).toEqual([]);
    expect(h.logged[0]).toMatchObject({
      actorId: LOGIN,
      detail: { via: 'client', op: 'exec', refused: 'read-only' },
    });
    const read = await dbBroker(post({ op: 'query', sql: 'select 1' }), params());
    expect(read.status).toBe(200);
    expect(h.dbCalls).toEqual([`query:${ANCHOR}:${APP}:admin`]);
  });

  it('checks the app before it touches SQLite', async () => {
    h.runnable = false;
    const res = await dbBroker(post({ op: 'exec', sql: 'delete from t' }), params());
    expect(res.status).toBe(404);
    expect(h.dbCalls).toEqual([]);
    expect(h.synced).toEqual([]);
  });
});

describe('client frame', () => {
  it('mints a ticket that names the login and its session epoch, and logs it', async () => {
    const res = await ticketRoute(post({}), params());
    const { ticket } = (await res.json()) as { ticket: string };
    expect(tokens.verifyAppFrameTicket(ticket)).toEqual({
      ownerId: ANCHOR,
      appId: APP,
      loginId: LOGIN,
      clientEpoch: EPOCH,
    });
    expect(h.logged[0]).toMatchObject({ kind: 'auth', actorId: LOGIN, detail: { via: 'client' } });
  });

  it('serves the PUBLISHED build for a client ticket, checked at its epoch', async () => {
    const res = await frame(frameReq(clientTicket()), params());
    expect(res.status).toBe(200);
    expect(h.rendered).toEqual([PUBLISHED.storageKey]);
    expect(h.active).toEqual([{ loginId: LOGIN, epoch: EPOCH }]);
  });

  it('refuses once the client signed out, its sessions were ended or it was disabled', async () => {
    h.loginActive = false;
    expect((await frame(frameReq(clientTicket()), params())).status).toBe(401);
    expect(h.rendered).toEqual([]);
  });

  it('refuses an owner, a member, a share ticket and a ticket for another app', async () => {
    const owner = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP });
    const member = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP, loginId: LOGIN });
    const share = tokens.buildAppFrameTicket({
      ownerId: ANCHOR,
      appId: APP,
      shareId: '99999999-9999-4999-8999-999999999999',
      loginId: LOGIN,
      clientEpoch: EPOCH,
    });
    for (const t of [owner, member, share, clientTicket(EPOCH, OTHER_APP)]) {
      expect((await frame(frameReq(t), params())).status).toBe(401);
    }
    expect(h.rendered).toEqual([]);
    expect(h.active).toEqual([]);
  });

  it('answers 404 once the app is no longer one clients may run', async () => {
    h.runnable = false;
    expect((await frame(frameReq(clientTicket()), params())).status).toBe(404);
    expect(h.rendered).toEqual([]);
  });

  it('a client ticket opens neither the member frame nor the owner frame', async () => {
    const t = clientTicket();
    expect(
      (await memberFrame(new Request(`http://x/api/member/apps/${APP}/frame?t=${t}`), params()))
        .status,
    ).toBe(401);
    expect(
      (await ownerFrame(new Request(`http://x/api/apps/${APP}/frame?t=${t}`), params())).status,
    ).toBe(401);
    expect(h.rendered).toEqual([]);
  });
});
