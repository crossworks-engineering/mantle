/**
 * The /s app brokers after team links were retired (member logins Phase 6
 * stage 6), without a database. A link has no identified visitor any more:
 * the tool broker refuses every call (403, pointing members at their own
 * login), the db broker takes queries only, and a frame ticket needs only the
 * active share and carries no contact. (Contact shares are gone since
 * migration 0378: every live share is an open link.)
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queries: 0,
  execs: 0,
  callers: [] as unknown[],
  frameViewers: [] as unknown[],
  appLog: [] as Array<Record<string, unknown>>,
}));

const SHARE = { id: 'share-1', ownerId: 'owner-1', nodeId: 'app-1', nodeType: 'app', settings: {} };
vi.mock('@/lib/shares', () => ({
  // The /s gate (lib/share-gate.ts openShareLink) resolves through this one.
  resolveActiveShareByToken: vi.fn(async (token: string) => (token === 'live' ? SHARE : null)),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  getAppRuntime: vi.fn(async () => ({
    id: 'app-1',
    publishedBuild: { ok: true },
    manifest: { toolSlugs: ['search_chunks', 'site_query'] },
  })),
  recordAppAccess: vi.fn((e: Record<string, unknown>) => h.appLog.push(e)),
}));
vi.mock('@mantle/content/app-table-exports', () => ({ scheduleAppTableExportSync: vi.fn() }));

vi.mock('@mantle/content/app-broker', async (importOriginal) => ({
  AppSqlError: (await importOriginal<typeof import('@mantle/content/app-broker')>()).AppSqlError,
  AppSqlBusyError: (await importOriginal<typeof import('@mantle/content/app-broker')>())
    .AppSqlBusyError,
  AppDbMissingError: (await importOriginal<typeof import('@mantle/content/app-broker')>())
    .AppDbMissingError,
  appDbQuery: vi.fn(async (...args: unknown[]) => {
    h.callers.push(args[5]);
    h.queries += 1;
    return { rows: [] };
  }),
  appDbExec: vi.fn(async (...args: unknown[]) => {
    h.callers.push(args[5]);
    h.execs += 1;
    return { changes: 1 };
  }),
  markAppClientWritten: vi.fn(async () => {}),
}));
vi.mock('@/lib/app-frame', () => ({
  renderAppFrame: vi.fn(async (_req: Request, _build: unknown, opts?: { viewer?: unknown }) => {
    h.frameViewers.push(opts?.viewer);
    return new Response('<!doctype html>', { status: 200 });
  }),
}));

beforeAll(() => {
  process.env.SESSION_SECRET = 'share-broker-test-secret-at-least-32-chars!!';
});
beforeEach(() => {
  h.queries = 0;
  h.execs = 0;
  h.callers.length = 0;
  h.frameViewers.length = 0;
  h.appLog.length = 0;
});

const post = (path: string, body: unknown) =>
  new Request(`https://brain.example.invalid${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.random()}` },
    body: JSON.stringify(body),
  });
const params = (token: string) => ({ params: Promise.resolve({ token }) });

describe('/s/:token/tool-broker', () => {
  it('refuses every tool on an open link, even an External access tool', async () => {
    const { POST } = await import('./[token]/tool-broker/route');
    for (const slug of ['search_chunks', 'site_query']) {
      const res = await POST(post('/s/live/tool-broker', { slug }), params('live'));
      expect(res.status, slug).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/own login/);
    }
    expect(h.queries + h.execs).toBe(0);
  });

  it('is a 404 for a dead token', async () => {
    const { POST } = await import('./[token]/tool-broker/route');
    const res = await POST(post('/s/gone/tool-broker', { slug: 'search_chunks' }), params('gone'));
    expect(res.status).toBe(404);
  });
});

describe('/s/:token/db-broker', () => {
  it('runs a query and refuses a write', async () => {
    const { POST } = await import('./[token]/db-broker/route');
    const q = await POST(
      post('/s/live/db-broker', { op: 'query', sql: 'select 1' }),
      params('live'),
    );
    expect(q.status).toBe(200);
    expect(h.queries).toBe(1);
    // App identity: an open link fills :host_me_* with the anonymous value.
    // Rows only below admin (access matrix audit, M1).
    expect(h.callers).toEqual([
      { callerKey: 'share:share-1', viewer: { kind: 'public' }, dataOnly: true },
    ]);
    const w = await POST(
      post('/s/live/db-broker', { op: 'exec', sql: 'delete from t' }),
      params('live'),
    );
    expect(w.status).toBe(403);
    expect(h.execs).toBe(0);
  });
});

describe('/s/:token/frame-ticket', () => {
  it('mints a ticket for the share with no cookie, and no contact in it', async () => {
    const { POST } = await import('./[token]/frame-ticket/route');
    const res = await POST(post('/s/live/frame-ticket', {}), params('live'));
    expect(res.status).toBe(200);
    const { ticket } = (await res.json()) as { ticket: string };
    const { verifyAppFrameTicket } = await import('@/lib/auth');
    expect(verifyAppFrameTicket(ticket)).toEqual({
      ownerId: 'owner-1',
      appId: 'app-1',
      shareId: 'share-1',
    });
    const claims = JSON.parse(
      Buffer.from(ticket.slice(0, ticket.lastIndexOf('.')), 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(claims.cid).toBeUndefined();
  });
});

describe('/s/:token/frame: host.me() (app identity)', () => {
  const frameReq = (token: string, ticket: string) =>
    new Request(`https://brain.example.invalid/s/${token}/frame?t=${encodeURIComponent(ticket)}`);

  it('an open link bakes the anonymous viewer', async () => {
    const { GET } = await import('./[token]/frame/route');
    const { buildAppFrameTicket } = await import('@/lib/auth');
    const t = buildAppFrameTicket({ ownerId: 'owner-1', appId: 'app-1', shareId: 'share-1' });
    expect((await GET(frameReq('live', t), params('live'))).status).toBe(200);
    expect(h.frameViewers).toEqual([
      { ownerId: 'owner-1', appId: 'app-1', subject: { kind: 'public' } },
    ]);
  });
});
