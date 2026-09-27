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
    displayName: 'Pat',
    contactId: null,
  })),
  memberLoginActive: vi.fn(async () => h.loginActive),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMemberRunnableApp: vi.fn(async (_anchor: string, id: string) =>
    h.runnable
      ? {
          id,
          title: 'Polls',
          audience: 'team',
          manifest: { toolSlugs: ['note_list'] },
          publishedBuild: PUBLISHED,
        }
      : null,
  ),
  getApp: vi.fn(async () => {
    throw new Error('the owner frame must refuse before it loads the app');
  }),
  recordAppAccess: vi.fn((e: Record<string, unknown>) => h.logged.push(e)),
}));
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
vi.mock('@mantle/content/app-broker', () => ({
  appDbQuery: vi.fn(async (owner: string) => (h.dbCalls.push(`query:${owner}`), [])),
  appDbExec: vi.fn(async (owner: string) => (h.dbCalls.push(`exec:${owner}`), { changes: 1 })),
}));
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
  tokens = await import('@/lib/auth/tokens');
}, 60_000);

beforeEach(() => {
  h.runnable = true;
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
    expect(h.logged[0]).toMatchObject({ actorId: LOGIN, appNodeId: APP, kind: 'tool' });
  });

  it('passes a refusal through and dispatches nothing', async () => {
    h.verdict = { ok: false, status: 403, reason: 'not in a team-level tool group' };
    const res = await toolBroker(post({ slug: 'admin_only' }), params());
    expect(res.status).toBe(403);
    expect(h.dispatched).toHaveLength(0);
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
    expect(h.dbCalls).toEqual([`exec:${ANCHOR}`]);
    expect(h.synced).toBe(1);
    expect(h.logged[0]).toMatchObject({ actorId: LOGIN, kind: 'db' });
  });

  it('reads without scheduling a sync', async () => {
    await dbBroker(post({ op: 'query', sql: 'select 1' }), params());
    expect(h.dbCalls).toEqual([`query:${ANCHOR}`]);
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
