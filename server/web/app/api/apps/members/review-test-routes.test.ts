/**
 * An admin's test run of a member's app (workspace review pattern,
 * 2026-10-09), route by route, without a database: the content layer is a
 * stand-in. Pins that the test frame takes only a review test ticket of an
 * active admin, that the owner frame refuses that ticket, that the db broker
 * reaches only the test copy (and says when it is gone), and that the tool
 * broker runs at team rules with no outside tool and no write.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN_LOGIN = '22222222-2222-4222-8222-222222222222';
const APP = '33333333-3333-4333-8333-333333333333';
const SPACE = '44444444-4444-4444-8444-444444444444';
const HIDDEN = '55555555-5555-4555-8555-555555555555';

const h = vi.hoisted(() => ({
  adminActive: true,
  testGone: false,
  sql: [] as unknown[][],
  verdict: null as unknown,
  dispatched: [] as unknown[],
  logged: [] as unknown[],
  rendered: [] as unknown[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getOwnerOr401: vi.fn(async () => ({
    id: OWNER,
    email: 'admin@example.invalid',
    actor: { id: ADMIN_LOGIN, email: 'admin@example.invalid', displayName: 'Robin' },
  })),
  adminLoginActive: vi.fn(async () => h.adminActive),
}));

const reviewApp = {
  id: APP,
  spaceId: SPACE,
  title: 'Shared',
  runnable: true,
  dataReadOnly: false,
  declaredTools: ['search', 'outside'],
  manifest: {},
  publishedBuild: { ok: true, storageKey: 'published-key' },
};

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  getMemberAppForReview: vi.fn(async (id: string) => (id === APP ? reviewApp : null)),
  getAppRuntime: vi.fn(async () => ({
    id: APP,
    manifest: {},
    draftBuild: { ok: true, storageKey: 'draft-key' },
    publishedBuild: null,
  })),
  recordAppAccess: vi.fn((e: unknown) => h.logged.push(e)),
}));

vi.mock('@mantle/content/app-review-test', async () => {
  class ReviewTestGoneError extends Error {}
  class ReviewTestReadOnlyError extends Error {}
  return {
    ReviewTestGoneError,
    ReviewTestReadOnlyError,
    startReviewTest: vi.fn(async () => ({ idleMs: 1 })),
    endReviewTest: vi.fn(async () => {}),
    requireReviewTest: vi.fn(async () => {
      if (h.testGone) throw new ReviewTestGoneError('The test run ended. Start the test again.');
    }),
    reviewTestViewer: vi.fn(async () => ({ id: 'u_x', name: 'Robin', kind: 'admin' })),
    reviewTestSql: vi.fn(async (...args: unknown[]) => {
      if (h.testGone) throw new ReviewTestGoneError('The test run ended. Start the test again.');
      h.sql.push(args);
      return [];
    }),
  };
});

vi.mock('@mantle/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/tools')>()),
  appToolVerdict: vi.fn(async (...args: unknown[]) => {
    h.dispatched.push({ verdictLevel: args[0] });
    return h.verdict;
  }),
  dispatchTool: vi.fn(async (_tool: unknown, _input: unknown, ctx: unknown) => {
    h.dispatched.push(ctx);
    return { ok: true, output: 'done' };
  }),
}));

vi.mock('@/lib/app-frame', () => ({
  renderAppFrame: vi.fn(async (_req: Request, build: unknown, opts?: unknown) => {
    h.rendered.push({ build, opts });
    return new Response('<!doctype html>', { status: 200 });
  }),
}));

beforeAll(() => {
  process.env.SESSION_SECRET = 'review-test-routes-secret-at-least-32-chars!!';
});

beforeEach(() => {
  h.adminActive = true;
  h.testGone = false;
  h.sql = [];
  h.dispatched = [];
  h.logged = [];
  h.rendered = [];
  h.verdict = { ok: true, tool: { slug: 'search', handler: { kind: 'builtin', ref: 'search' } } };
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) =>
  new Request('http://x/', { method: 'POST', body: JSON.stringify(body) });

async function ticket(opts: { reviewTest?: boolean; loginId?: string } = {}) {
  const { buildAppFrameTicket } = await import('@/lib/auth');
  return buildAppFrameTicket({ ownerId: OWNER, appId: APP, actorId: ADMIN_LOGIN, ...opts });
}

describe('the review test frame', () => {
  it('renders the PUBLISHED build for a review test ticket of an active admin', async () => {
    const { GET } = await import('./[id]/test/frame/route');
    const t = await ticket({ reviewTest: true });
    const res = await GET(new Request(`http://x/f?t=${t}`), params(APP));
    expect(res.status).toBe(200);
    expect(h.rendered[0]).toMatchObject({
      build: { storageKey: 'published-key' },
      opts: { resolvedViewer: { kind: 'admin' } },
    });
  });

  it('refuses an owner ticket, a member ticket, an inactive admin and an app out of reach', async () => {
    const { GET } = await import('./[id]/test/frame/route');
    expect((await GET(new Request(`http://x/f?t=${await ticket()}`), params(APP))).status).toBe(
      401,
    );
    const { buildAppFrameTicket } = await import('@/lib/auth');
    const member = buildAppFrameTicket({ ownerId: OWNER, appId: APP, loginId: ADMIN_LOGIN });
    expect((await GET(new Request(`http://x/f?t=${member}`), params(APP))).status).toBe(401);
    h.adminActive = false;
    const t = await ticket({ reviewTest: true });
    expect((await GET(new Request(`http://x/f?t=${t}`), params(APP))).status).toBe(401);
    h.adminActive = true;
    const other = buildAppFrameTicket({
      ownerId: OWNER,
      appId: HIDDEN,
      actorId: ADMIN_LOGIN,
      reviewTest: true,
    });
    expect((await GET(new Request(`http://x/f?t=${other}`), params(HIDDEN))).status).toBe(404);
    expect(h.rendered).toHaveLength(0);
  });

  it('the owner frame refuses a review test ticket (it serves drafts)', async () => {
    const { GET } = await import('../[id]/frame/route');
    const t = await ticket({ reviewTest: true });
    expect((await GET(new Request(`http://x/f?t=${t}`), params(APP))).status).toBe(401);
    expect(h.rendered).toHaveLength(0);
  });

  it('the ticket route mints a review test ticket only for a reachable app', async () => {
    const { POST } = await import('./[id]/test/frame-ticket/route');
    const { verifyAppFrameTicket } = await import('@/lib/auth');
    const res = await POST(new Request('http://x/', { method: 'POST' }), params(APP));
    const body = (await res.json()) as { ticket: string };
    expect(verifyAppFrameTicket(body.ticket)).toMatchObject({
      appId: APP,
      actorId: ADMIN_LOGIN,
      reviewTest: true,
    });
    expect((await POST(new Request('http://x/', { method: 'POST' }), params(HIDDEN))).status).toBe(
      404,
    );
  });
});

describe('the review test db broker', () => {
  it('runs on the test copy, and says when the test ended', async () => {
    const { POST } = await import('./[id]/test/db-broker/route');
    const res = await POST(post({ op: 'exec', sql: 'DELETE FROM t', params: [] }), params(APP));
    expect(res.status).toBe(200);
    expect(h.sql[0]?.[2]).toBe('exec');
    h.testGone = true;
    const gone = await POST(post({ op: 'query', sql: 'SELECT 1', params: [] }), params(APP));
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ reason: 'test-ended' });
    expect(
      (await POST(post({ op: 'query', sql: 'SELECT 1', params: [] }), params(HIDDEN))).status,
    ).toBe(404);
  });
});

describe('the review test tool broker', () => {
  it('asks the TEAM rules and dispatches a built-in on the team surface', async () => {
    const { POST } = await import('./[id]/test/tool-broker/route');
    const res = await POST(post({ slug: 'search', input: {} }), params(APP));
    expect(res.status).toBe(200);
    expect(h.dispatched[0]).toEqual({ verdictLevel: 'team' });
    expect(h.dispatched[1]).toMatchObject({
      ownerId: OWNER,
      surface: { kind: 'team', loginId: ADMIN_LOGIN, privateReads: false },
    });
    expect(h.logged[0]).toMatchObject({ ownerId: SPACE, detail: { via: 'review-test' } });
  });

  it('refuses an outside tool and a write, even one team apps may use', async () => {
    const { POST } = await import('./[id]/test/tool-broker/route');
    h.verdict = { ok: true, tool: { slug: 'outside', handler: { kind: 'mcp' } } };
    const outside = await POST(post({ slug: 'outside', input: {} }), params(APP));
    expect(outside.status).toBe(403);
    // Its own reason, so the screen says test mode blocked it (not "undeclared").
    expect(await outside.json()).toMatchObject({
      reason: 'review-test-read-only',
      error: 'Test mode blocks tools that change data.',
    });
    h.verdict = {
      ok: true,
      write: true,
      tool: { slug: 'search', handler: { kind: 'builtin', ref: 'x' } },
    };
    expect((await POST(post({ slug: 'search', input: {} }), params(APP))).status).toBe(403);
    // Neither was dispatched; both were logged as refused.
    expect(h.dispatched.filter((d) => 'ownerId' in (d as object))).toHaveLength(0);
    expect(h.logged).toHaveLength(2);
    expect(h.logged.every((l) => 'refused' in ((l as { detail: object }).detail ?? {}))).toBe(true);
  });
});

describe('the review test tool broker without a running test', () => {
  it('runs nothing and says the test ended', async () => {
    const { POST } = await import('./[id]/test/tool-broker/route');
    h.testGone = true;
    const res = await POST(post({ slug: 'search', input: {} }), params(APP));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'test-ended' });
    expect(h.dispatched).toHaveLength(0);
    expect(h.logged).toHaveLength(0);
  });
});
