/**
 * The member tree routes without a database: the login rows and the tree
 * reads are stood in, the gate is the real one. These pin what the ROUTES
 * do: a member reads through its space and workspaces, and a kind the
 * Library does not hold is a 404 before any read. The client tree routes
 * were removed in workspaces W5c: they answer 410 code gone to any login,
 * and a row still marked client is no login at all since W8a (401). Every
 * login reads the normal tree (GET /api/tree/:kind) in its own scope; its
 * counts are proven on Postgres in server/web/server/folder-count-cells.db.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const SPACE = '66666666-6666-4666-8666-666666666666';
const FOLDER = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  hidden: false,
}));

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

const folder = {
  id: FOLDER,
  path: 'notes.acme',
  name: 'Acme',
  icon: null,
  color: null,
  depth: 1,
  parentId: null,
  share: 'client',
  inherited: null,
  system: false,
  folderCount: 0,
  itemCount: 1,
};
const item = {
  id: 'i1',
  title: 'Scope',
  icon: null,
  color: null,
  subtype: null,
  level: 'client',
  inherited: 'client',
  state: null,
  updatedAt: '2026-09-30T00:00:00.000Z',
};

vi.mock('@mantle/content/tree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadReaderTreeFolder: async (...args: unknown[]) => {
    h.calls.push({ fn: 'load', args });
    if (h.hidden) return null;
    return {
      kind: 'notes',
      folder,
      crumbs: [],
      folders: [folder],
      items: [item],
      sort: 'updated',
      nextCursor: null,
    };
  },
  searchReaderTree: async (...args: unknown[]) => {
    h.calls.push({ fn: 'search', args });
    return {
      kind: 'notes',
      folders: [{ ...folder, crumbs: [] }],
      items: [{ ...item, crumbs: [] }],
      nextCursor: null,
    };
  },
  // A member's tree merges its own folders and drafts (phase 5).
  loadMemberTreeFolder: async (...args: unknown[]) => {
    h.calls.push({ fn: 'member-load', args });
    if (h.hidden) return null;
    return {
      kind: 'notes',
      folder,
      crumbs: [],
      folders: [folder],
      items: [item],
      sort: 'updated',
      nextCursor: null,
    };
  },
  searchMemberTree: async (...args: unknown[]) => {
    h.calls.push({ fn: 'member-search', args });
    return { kind: 'notes', folders: [], items: [], nextCursor: null };
  },
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
beforeEach(() => {
  h.calls.length = 0;
  h.hidden = false;
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
    expect(h.calls).toEqual([]);
  });

  it('the client tree is gone (W5c): 410 to any login, 401 to a row still marked client, no read', async () => {
    const client = (await import('./[kind]/route')).GET as unknown as Handler;
    const search = (await import('./[kind]/search/route')).GET as unknown as Handler;
    for (const login of [ADMIN, MEMBER]) {
      const res = await call(login, `/api/client/tree/notes?folder=${FOLDER}`, client, 'notes');
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
    expect(h.calls).toEqual([]);
  });
});
