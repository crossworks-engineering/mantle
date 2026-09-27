/**
 * The member app routes (member logins Phase 4b, plan v3.1 section 4a),
 * without a database: the lookups and the tool rules are stood in, so these
 * pin what the ROUTES must do with them. The tool broker dispatches on the
 * team role and a team surface that names the login; the db broker checks the
 * app before it touches SQLite; the frame opens only for a member ticket and
 * only the published build; the owner frame (drafts) refuses a member ticket.
 * The rules themselves are proven on Postgres in
 * packages/{content,tools}/src/member-app*.viewer.db.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const LOGIN = '22222222-2222-4222-8222-222222222222';
const APP = '77777777-7777-4777-8777-777777777777';
const OTHER_APP = '88888888-8888-4888-8888-888888888888';
const PUBLISHED = { storageKey: 'apps/published.js', ok: true };

const h = vi.hoisted(() => ({
  runnable: true,
  audience: 'team',
  displayName: 'Pat' as string | null,
  lookups: [] as string[],
  reads: [] as Array<{ fn: string; level: string }>,
  homeAppId: undefined as string | undefined,
  loginActive: true,
  verdict: { ok: true } as { ok: boolean; status?: number; reason?: string },
  dispatched: [] as Array<{ level: string; ctx: Record<string, unknown> }>,
  logged: [] as Array<Record<string, unknown>>,
  dbCalls: [] as string[],
  synced: 0,
  rendered: [] as string[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMemberOr401: vi.fn(async () => ({
    role: 'member',
    loginId: LOGIN,
    anchorId: ANCHOR,
    spaceId: '66666666-6666-4666-8666-666666666666',
    email: 'pat@example.invalid',
    displayName: h.displayName,
    contactId: null,
  })),
  memberLoginActive: vi.fn(async () => h.loginActive),
}));
vi.mock('@mantle/content', async (importOriginal) => {
  const { currentViewerLevel } = await import('@mantle/db');
  const read = <T>(fn: string, value: T) => {
    h.reads.push({ fn, level: currentViewerLevel() });
    return value;
  };
  const card = (id: string, title: string) => ({
    id,
    title,
    icon: null,
    color: null,
    description: null,
    audience: 'team',
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
            audience: h.audience,
            manifest: { toolSlugs: ['note_list'] },
            publishedBuild: PUBLISHED,
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
    listLibrary: vi.fn(async () =>
      read('listLibrary', {
        items: [
          {
            id: 'p1',
            type: 'page',
            title: 'Plan',
            icon: null,
            summary: 'S',
            audience: 'team',
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
  const { currentViewerLevel } = await import('@mantle/db');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    memberAppToolVerdict: vi.fn(async () =>
      h.verdict.ok ? { ok: true, tool: { slug: 'note_list' } } : h.verdict,
    ),
    dispatchTool: vi.fn(async (_tool: unknown, _input: unknown, ctx: Record<string, unknown>) => {
      h.dispatched.push({ level: currentViewerLevel(), ctx });
      return { ok: true, output: [] };
    }),
  };
});
vi.mock('@mantle/content/app-broker', async () => {
  const { currentViewerLevel } = await import('@mantle/db');
  // The SQLite work must run on the admin pool: it writes registry rows.
  const call = (op: string, owner: string, app: string) =>
    h.dbCalls.push(`${op}:${owner}:${app}:${currentViewerLevel()}`);
  return {
    appDbQuery: vi.fn(async (owner: string, app: string) => (call('query', owner, app), [])),
    appDbExec: vi.fn(
      async (owner: string, app: string) => (call('exec', owner, app), { changes: 1 }),
    ),
  };
});
vi.mock('@mantle/content/app-table-exports', () => ({
  scheduleAppTableExportSync: vi.fn(() => (h.synced += 1)),
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
let ownerFrame: Handler;
let listRoute: () => Promise<Response>;
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
  ownerFrame = (await import('../../apps/[id]/frame/route')).GET;
  listRoute = (await import('./route')).GET;
  homeRoute = (await import('../home/route')).GET;
  verdictMock = vi.mocked((await import('@mantle/tools')).memberAppToolVerdict) as never;
  tokens = await import('@/lib/auth/tokens');
}, 60_000);

beforeEach(() => {
  h.runnable = true;
  h.audience = 'team';
  h.displayName = 'Pat';
  h.lookups.length = 0;
  h.reads.length = 0;
  h.homeAppId = undefined;
  verdictMock?.mockClear();
  h.loginActive = true;
  h.verdict = { ok: true };
  h.dispatched.length = 0;
  h.logged.length = 0;
  h.dbCalls.length = 0;
  h.synced = 0;
  h.rendered.length = 0;
});

describe('member tool broker', () => {
  it('dispatches on the team role with a team surface that names the login', async () => {
    const res = await toolBroker(post({ slug: 'note_list', input: {} }), params());
    expect(res.status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]!.level).toBe('team');
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
    // The rule is asked about THIS app's declared tools, for this brain.
    expect(verdictMock).toHaveBeenCalledWith(ANCHOR, ['note_list'], 'note_list');
    expect(h.dispatched[0]!.ctx).toMatchObject({ surface: { contactName: 'Pat' } });
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
    await toolBroker(post({ slug: 'note_list' }), params(APP.toUpperCase()));
    expect(h.lookups).toEqual([APP]);
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

describe('member db broker', () => {
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
    expect(h.dbCalls).toEqual([`exec:${ANCHOR}:${APP}:admin`]);
    expect(h.synced).toBe(1);
    expect(h.logged[0]).toMatchObject({ actorId: LOGIN, kind: 'db' });
  });

  it('refuses a write to a client- or public-level app, and logs it', async () => {
    for (const level of ['client', 'public']) {
      h.audience = level;
      h.logged.length = 0;
      const res = await dbBroker(post({ op: 'exec', sql: 'insert into t values (1)' }), params());
      expect(res.status, level).toBe(403);
      expect(h.logged[0]).toMatchObject({ detail: { op: 'exec', refused: 'read-only' } });
    }
    expect(h.dbCalls).toEqual([]);
    expect(h.synced).toBe(0);
    // Reads still work there.
    await dbBroker(post({ op: 'query', sql: 'select 1' }), params());
    expect(h.dbCalls).toEqual([`query:${ANCHOR}:${APP}:admin`]);
  });

  it('reads without scheduling a sync', async () => {
    await dbBroker(post({ op: 'query', sql: 'select 1' }), params());
    expect(h.dbCalls).toEqual([`query:${ANCHOR}:${APP}:admin`]);
    expect(h.synced).toBe(0);
  });
});

describe('member frame', () => {
  const frameReq = (ticket: string, id = APP) =>
    new Request(`http://x/api/member/apps/${id}/frame?t=${encodeURIComponent(ticket)}`);

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
    const t = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP, loginId: LOGIN });
    const res = await frame(frameReq(t, APP.toUpperCase()), params(APP.toUpperCase()));
    expect(res.status).toBe(200);
  });

  it('serves the PUBLISHED build for a member ticket', async () => {
    const t = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP, loginId: LOGIN });
    const res = await frame(frameReq(t), params());
    expect(res.status).toBe(200);
    expect(h.rendered).toEqual([PUBLISHED.storageKey]);
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

  it('answers 404 once the app is no longer one the member may run', async () => {
    h.runnable = false;
    const t = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP, loginId: LOGIN });
    expect((await frame(frameReq(t), params())).status).toBe(404);
  });

  it('the owner frame, which serves drafts, refuses a member ticket', async () => {
    const t = tokens.buildAppFrameTicket({ ownerId: ANCHOR, appId: APP, loginId: LOGIN });
    const res = await ownerFrame(
      new Request(`http://x/api/apps/${APP}/frame?t=${encodeURIComponent(t)}`),
      params(),
    );
    expect(res.status).toBe(401);
    expect(h.rendered).toEqual([]);
  });
});

describe('member app list and home', () => {
  it('lists the apps on the team role, with the home app id only while runnable', async () => {
    h.homeAppId = APP;
    const body = (await (await listRoute()).json()) as { apps: unknown[]; homeAppId: string };
    expect(body.apps).toHaveLength(2);
    expect(body.homeAppId).toBe(APP);
    expect(h.reads.every((r) => r.level === 'team')).toBe(true);
    h.runnable = false;
    expect(((await (await listRoute()).json()) as { homeAppId: unknown }).homeAppId).toBeNull();
  });

  it('gives no hub data when nothing is pinned, and skips the hub reads', async () => {
    const body = await (await homeRoute()).json();
    expect(body).toEqual({ homeApp: null, hub: null });
    expect(h.reads.map((r) => r.fn)).toEqual(['resolveMemberHomeApp']);
  });

  it('answers hub.get for a pinned app, read on the team role, without the app itself', async () => {
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
    expect(h.reads.every((r) => r.level === 'team')).toBe(true);
  });
});
