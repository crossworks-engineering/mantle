/**
 * The member and client tree routes without a database: the login rows and
 * the tree reads are stood in, the gate is the real one. These pin what the
 * ROUTES do: each reads as its own role (a member as team, a client as
 * client), a kind the Library does not hold is a 404 before any read, a folder
 * the reader cannot see is a 404, and a client's answer carries no level,
 * share or system flag. The rules themselves are proven on Postgres in
 * packages/content/src/tree/tree-reader.viewer.db.test.ts.
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

describe('the member and client tree routes', () => {
  it('reads as each role: a member at team, a client at client', async () => {
    const member = (await import('../../member/tree/[kind]/route')).GET;
    const client = (await import('./[kind]/route')).GET;
    expect(
      (await call(MEMBER, `/api/member/tree/notes?folder=${FOLDER}`, member, 'notes')).status,
    ).toBe(200);
    expect(
      (await call(CLIENT, `/api/client/tree/notes?folder=${FOLDER}`, client, 'notes')).status,
    ).toBe(200);
    expect(h.calls.map((c) => [c.fn, c.args[0], c.args[1], c.args[2]])).toEqual([
      ['load', ANCHOR, 'team', 'notes'],
      ['load', ANCHOR, 'client', 'notes'],
    ]);
  });

  it('gives a member levels and a client none', async () => {
    const member = (await import('../../member/tree/[kind]/route')).GET;
    const client = (await import('./[kind]/route')).GET;
    const m = await (await call(MEMBER, '/api/member/tree/notes', member, 'notes')).json();
    expect(m.items[0]).toMatchObject({ level: 'client' });
    const c = await (await call(CLIENT, '/api/client/tree/notes', client, 'notes')).json();
    for (const k of ['level', 'inherited', 'state']) expect(c.items[0]).not.toHaveProperty(k);
    for (const k of ['share', 'inherited', 'system']) {
      expect(c.folder).not.toHaveProperty(k);
      expect(c.folders[0]).not.toHaveProperty(k);
    }
    const search = (await import('./[kind]/search/route')).GET;
    const s = await (
      await call(CLIENT, '/api/client/tree/notes/search?q=a', search, 'notes')
    ).json();
    expect(s.items[0]).not.toHaveProperty('level');
    expect(s.folders[0]).not.toHaveProperty('share');
    expect(h.calls.at(-1)!.args.slice(0, 4)).toEqual([ANCHOR, 'client', 'notes', 'a']);
  });

  it('refuses a kind the Library does not hold before any read', async () => {
    const client = (await import('./[kind]/route')).GET;
    const member = (await import('../../member/tree/[kind]/search/route')).GET;
    for (const kind of ['secrets', 'tasks', 'contacts', 'nope']) {
      expect((await call(CLIENT, `/api/client/tree/${kind}`, client, kind)).status).toBe(404);
      expect((await call(MEMBER, `/api/member/tree/${kind}/search`, member, kind)).status).toBe(
        404,
      );
    }
    expect(h.calls).toEqual([]);
  });

  it('answers 404 for a folder the reader cannot see, 400 for a bad id, 403 for an admin', async () => {
    const client = (await import('./[kind]/route')).GET;
    h.hidden = true;
    expect(
      (await call(CLIENT, `/api/client/tree/notes?folder=${FOLDER}`, client, 'notes')).status,
    ).toBe(404);
    expect((await call(CLIENT, '/api/client/tree/notes?folder=nope', client, 'notes')).status).toBe(
      400,
    );
    expect((await call(ADMIN, '/api/client/tree/notes', client, 'notes')).status).toBe(403);
    const member = (await import('../../member/tree/[kind]/route')).GET;
    expect((await call(CLIENT, '/api/member/tree/notes', member, 'notes')).status).toBe(403);
  });
});
