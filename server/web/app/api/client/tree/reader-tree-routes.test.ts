/**
 * The retired member and client tree routes without a database: the login
 * rows are stood in, the gate is the real one. The member tree routes
 * answer 410 since W6b. The client tree routes
 * were removed in workspaces W5c: they answer 410 code gone to any login,
 * and a row still marked client is no login at all since W8a (401). Every
 * login reads the normal tree (GET /api/tree/:kind) in its own scope; its
 * counts are proven on Postgres in server/web/server/folder-count-cells.db.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const SPACE = '66666666-6666-4666-8666-666666666666';

const row = (id: string, role: string) => ({
  id,
  email: `${role}@example.invalid`,
  isOwner: false,
  displayName: null,
  role,
  contactId: null,
  disabledAt: null,
  sessionEpoch: 3,
});

vi.mock('@/lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === CLIENT
      ? row(CLIENT, 'client')
      : id === MEMBER
        ? row(MEMBER, 'member')
        : id === ADMIN
          ? row(ADMIN, 'admin')
          : null,
  loadAnchorId: async () => ANCHOR,
  loadPersonalSpaceId: async () => SPACE,
}));

type Tokens = typeof import('@/lib/auth/tokens');
let tokens: Tokens;
let runWith: typeof import('@/server/request-context').runWithRequestContext;
const saved = process.env.SESSION_SECRET;

beforeAll(async () => {
  process.env.SESSION_SECRET = 'reader-tree-routes-secret-at-least-32-chars';
  tokens = await import('@/lib/auth/tokens');
  runWith = (await import('@/server/request-context')).runWithRequestContext;
});
afterAll(() => {
  process.env.SESSION_SECRET = saved;
});

type Handler = (r: Request, c: { params: Promise<{ kind: string }> }) => Promise<Response>;

async function call(login: string, url: string, handler: Handler, kind: string) {
  const { value } = tokens.buildSessionCookie(login, { epoch: 3, ttlSeconds: 3600 });
  const headers = new Headers({ cookie: `${tokens.SESSION_COOKIE_NAME}=${value}` });
  const req = new Request(`http://x${url}`, { headers });
  return runWith({ req, path: new URL(req.url).pathname, method: 'GET' }, () =>
    handler(req, { params: Promise.resolve({ kind }) }),
  );
}

describe('the member tree routes, and the retired client tree', () => {
  it('answers a member 410 since W6b: its items are read through the normal tree', async () => {
    const tree = (await import('../../member/tree/[kind]/route')).GET;
    const search = (await import('../../member/tree/[kind]/search/route')).GET;
    expect((await call(MEMBER, '/api/member/tree/notes', tree, 'notes')).status).toBe(410);
    expect((await call(MEMBER, '/api/member/tree/notes/search', search, 'notes')).status).toBe(410);
  });

  it('the client tree is gone (W5c): 410 to any login, 401 to a row still marked client, no read', async () => {
    const client = (await import('./[kind]/route')).GET as unknown as Handler;
    const search = (await import('./[kind]/search/route')).GET as unknown as Handler;
    for (const login of [ADMIN, MEMBER]) {
      const res = await call(login, `/api/client/tree/notes`, client, 'notes');
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ code: 'gone' });
      expect((await call(login, '/api/client/tree/notes/search?q=a', search, 'notes')).status).toBe(
        410,
      );
    }
    // A login row still marked client resolves to no login (W8a).
    expect((await call(CLIENT, '/api/client/tree/notes', client, 'notes')).status).toBe(401);
    expect((await call(CLIENT, '/api/client/tree/notes/search?q=a', search, 'notes')).status).toBe(
      401,
    );
    const member = (await import('../../member/tree/[kind]/route')).GET;
    expect((await call(CLIENT, '/api/member/tree/notes', member, 'notes')).status).toBe(401);
  });
});
