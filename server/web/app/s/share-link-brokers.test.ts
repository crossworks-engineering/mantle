/**
 * The /s app brokers after team links were retired (member logins Phase 6
 * stage 6), without a database. A link has no identified visitor any more:
 * the tool broker refuses every call (403, pointing members at their own
 * login), the db broker takes queries only, and a frame ticket needs only the
 * active share and carries no contact.
 *
 * A CONTACT share (migration 0214) without the contact's cookie gets 401 on
 * every broker and the frame ticket; with it, the tool broker still refuses
 * every call, the db broker writes only with Can write, and the frame
 * ticket names the contact and its code epoch. (On Postgres:
 * contact-share-gate.db.test.ts.)
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queries: 0,
  execs: 0,
  callers: [] as unknown[],
  frameViewers: [] as unknown[],
}));

const SHARE = { id: 'share-1', ownerId: 'owner-1', nodeId: 'app-1', nodeType: 'app', settings: {} };
const CONTACT = 'contact-7';
const CONTACT_SHARE = { ...SHARE, id: 'share-2', contactId: CONTACT, canWrite: false };
const WRITER_SHARE = { ...SHARE, id: 'share-3', contactId: CONTACT, canWrite: true };
const byToken: Record<string, unknown> = {
  live: SHARE,
  contact: CONTACT_SHARE,
  writer: WRITER_SHARE,
};

vi.mock('@/lib/shares', () => ({
  resolveActiveShareByToken: vi.fn(async (token: string) => (token === 'live' ? SHARE : null)),
  // The /s gate (contact shares, 0214) resolves through this one.
  resolveActiveShareRowByToken: vi.fn(async (token: string) => byToken[token] ?? null),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  getApp: vi.fn(async () => ({
    id: 'app-1',
    publishedBuild: { ok: true },
    manifest: { toolSlugs: ['search_chunks'] },
  })),
  recordAppAccess: vi.fn(),
  recordShareAccess: vi.fn(),
  contactShareGateRow: vi.fn(async (contactId: string) =>
    contactId === CONTACT ? { ownerId: 'owner-1', codeEpoch: 3, open: true } : null,
  ),
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
    // App identity: an open link fills :host_me_* with the anonymous value.
    expect(h.callers).toEqual([{ callerKey: 'share:share-1', viewer: { kind: 'public' } }]);
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

describe('a contact share (0214)', () => {
  const cookieFor = async (codeEpoch: number) => {
    const { buildContactVisitorValue, CONTACT_VISITOR_COOKIE } = await import('@/lib/auth');
    const { value } = buildContactVisitorValue({
      contactId: CONTACT,
      ownerId: 'owner-1',
      codeEpoch,
    });
    return `${CONTACT_VISITOR_COOKIE}=${value}`;
  };
  const withCookie = (path: string, body: unknown, cookie: string) => {
    const r = post(path, body);
    r.headers.set('cookie', cookie);
    return r;
  };

  it('answers 401 on every broker and the ticket without the contact cookie, or with a stale one', async () => {
    const tool = (await import('./[token]/tool-broker/route')).POST;
    const db = (await import('./[token]/db-broker/route')).POST;
    const ticket = (await import('./[token]/frame-ticket/route')).POST;
    const stale = await cookieFor(2);
    for (const cookie of ['', stale]) {
      const at = (path: string, body: unknown) =>
        cookie ? withCookie(path, body, cookie) : post(path, body);
      expect(
        (await tool(at('/s/contact/tool-broker', { slug: 'x' }), params('contact'))).status,
      ).toBe(401);
      expect(
        (await db(at('/s/contact/db-broker', { op: 'query', sql: 'select 1' }), params('contact')))
          .status,
      ).toBe(401);
      expect((await ticket(at('/s/contact/frame-ticket', {}), params('contact'))).status).toBe(401);
    }
    expect(h.queries + h.execs).toBe(0);
  });

  it('with the cookie: no tools ever; a write only with Can write; a ticket that names the contact', async () => {
    const cookie = await cookieFor(3);
    const tool = (await import('./[token]/tool-broker/route')).POST;
    const db = (await import('./[token]/db-broker/route')).POST;
    const ticket = (await import('./[token]/frame-ticket/route')).POST;
    for (const token of ['contact', 'writer']) {
      const res = await tool(
        withCookie(`/s/${token}/tool-broker`, { slug: 'x' }, cookie),
        params(token),
      );
      expect(res.status, token).toBe(403);
    }
    const ro = await db(
      withCookie('/s/contact/db-broker', { op: 'exec', sql: 'delete from t' }, cookie),
      params('contact'),
    );
    expect(ro.status).toBe(403);
    expect(await ro.json()).toMatchObject({ reason: 'read-only' });
    const rw = await db(
      withCookie('/s/writer/db-broker', { op: 'exec', sql: 'delete from t' }, cookie),
      params('writer'),
    );
    expect(rw.status).toBe(200);
    expect(h.execs).toBe(1);
    // App identity: the share's contact fills :host_me_* (never the body).
    expect(h.callers).toEqual([
      { callerKey: 'share:share-3', viewer: { kind: 'contact', contactId: CONTACT } },
    ]);
    const t = await ticket(withCookie('/s/contact/frame-ticket', {}, cookie), params('contact'));
    const { verifyAppFrameTicket } = await import('@/lib/auth');
    expect(verifyAppFrameTicket(((await t.json()) as { ticket: string }).ticket)).toMatchObject({
      shareId: 'share-2',
      contactId: CONTACT,
      codeEpoch: 3,
    });
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

  it("a contact share bakes the share's contact, whatever the request says", async () => {
    const { GET } = await import('./[token]/frame/route');
    const { buildAppFrameTicket } = await import('@/lib/auth');
    const t = buildAppFrameTicket({
      ownerId: 'owner-1',
      appId: 'app-1',
      shareId: 'share-2',
      contact: { contactId: CONTACT, codeEpoch: 3 },
    });
    expect((await GET(frameReq('contact', t), params('contact'))).status).toBe(200);
    expect(h.frameViewers).toEqual([
      { ownerId: 'owner-1', appId: 'app-1', subject: { kind: 'contact', contactId: CONTACT } },
    ]);
  });
});
