/**
 * The /s app brokers after team links were retired (member logins Phase 6
 * stage 6), without a database. A link has no identified visitor any more:
 * the tool broker refuses every call (403, pointing members at their own
 * login), the db broker takes queries only, and a frame ticket needs only the
 * active share and carries no contact.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ queries: 0, execs: 0 }));

const SHARE = { id: 'share-1', ownerId: 'owner-1', nodeId: 'app-1', nodeType: 'app', settings: {} };

vi.mock('@/lib/shares', () => ({
  resolveActiveShareByToken: vi.fn(async (token: string) => (token === 'live' ? SHARE : null)),
  // The /s gate (contact shares, 0214) resolves through this one.
  resolveActiveShareRowByToken: vi.fn(async (token: string) => (token === 'live' ? SHARE : null)),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  getApp: vi.fn(async () => ({
    id: 'app-1',
    publishedBuild: { ok: true },
    manifest: { toolSlugs: ['search_chunks'] },
  })),
  recordAppAccess: vi.fn(),
}));

vi.mock('@mantle/content/app-broker', async (importOriginal) => ({
  AppSqlError: (await importOriginal<typeof import('@mantle/content/app-broker')>()).AppSqlError,
  AppSqlBusyError: (await importOriginal<typeof import('@mantle/content/app-broker')>())
    .AppSqlBusyError,
  appDbQuery: vi.fn(async () => {
    h.queries += 1;
    return { rows: [] };
  }),
  appDbExec: vi.fn(async () => {
    h.execs += 1;
    return { changes: 1 };
  }),
}));

beforeAll(() => {
  process.env.SESSION_SECRET = 'share-broker-test-secret-at-least-32-chars!!';
});
beforeEach(() => {
  h.queries = 0;
  h.execs = 0;
});

const post = (path: string, body: unknown) =>
  new Request(`https://brain.example.invalid${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.random()}` },
    body: JSON.stringify(body),
  });
const params = (token: string) => ({ params: Promise.resolve({ token }) });

describe('/s/:token/tool-broker', () => {
  it('refuses every tool on a live link, naming the member login', async () => {
    const { POST } = await import('./[token]/tool-broker/route');
    const res = await POST(post('/s/live/tool-broker', { slug: 'search_chunks' }), params('live'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/own login/);
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
