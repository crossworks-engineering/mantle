/**
 * The member tree's write routes without a database (folder plan phase 5):
 * the login rows and the tree writes are stood in, the gate is the real one.
 * These pin what the ROUTES do: a member's own scope (brain, space, login)
 * reaches the tree, a client or an admin is refused, a bad body or id is a
 * 400 before any write, and a kind a member has no tree for is a 404. The
 * rules themselves are proven on Postgres in
 * packages/content/src/tree/member-tree.viewer.db.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const SPACE = '66666666-6666-4666-8666-666666666666';
const FOLDER = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; args: unknown[] }> }));

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

vi.mock('@mantle/content/tree', async (importOriginal) => {
  const record =
    (fn: string, answer: unknown) =>
    async (...args: unknown[]) => {
      h.calls.push({ fn, args });
      return answer;
    };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createMemberFolder: record('create', { id: FOLDER, own: true }),
    updateMemberFolder: record('update', { id: FOLDER, own: true }),
    deleteMemberFolder: record('delete', undefined),
    moveMemberItems: record('move', { moved: 1, failed: [] }),
  };
});

type Tokens = typeof import('@/lib/auth/tokens');
let tokens: Tokens;
let runWith: typeof import('@/server/request-context').runWithRequestContext;
const saved = process.env.SESSION_SECRET;

beforeAll(async () => {
  process.env.SESSION_SECRET = 'member-tree-write-routes-secret-32-chars!';
  tokens = await import('@/lib/auth/tokens');
  runWith = (await import('@/server/request-context')).runWithRequestContext;
});
afterAll(() => {
  process.env.SESSION_SECRET = saved;
});
beforeEach(() => {
  h.calls.length = 0;
});

type Params = { kind: string; id?: string };
type Handler = (r: Request, c: { params: Promise<Params> }) => Promise<Response>;

async function call(
  login: string,
  method: string,
  url: string,
  handler: Handler,
  params: Params,
  body?: unknown,
) {
  const { value } = tokens.buildSessionCookie(login, { epoch: 3, ttlSeconds: 3600 });
  const headers = new Headers({
    cookie: `${tokens.SESSION_COOKIE_NAME}=${value}`,
    'content-type': 'application/json',
    origin: 'http://x',
  });
  const req = new Request(`http://x${url}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return runWith({ req, path: new URL(req.url).pathname, method }, () =>
    handler(req, { params: Promise.resolve(params) }),
  );
}

const scope = { anchorId: ANCHOR, spaceId: SPACE, loginId: MEMBER };

describe('the member tree write routes', () => {
  it('pass the member’s own scope to the tree', async () => {
    const folders = (await import('./[kind]/folders/route')).POST as Handler;
    const one = await import('./[kind]/folders/[id]/route');
    const move = (await import('./[kind]/move/route')).POST as Handler;
    const base = '/api/member/tree/notes';
    expect(
      (
        await call(
          MEMBER,
          'POST',
          `${base}/folders`,
          folders,
          { kind: 'notes' },
          {
            parentId: null,
            name: 'Mine',
          },
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await call(
          MEMBER,
          'PATCH',
          `${base}/folders/${FOLDER}`,
          one.PATCH as Handler,
          {
            kind: 'notes',
            id: FOLDER,
          },
          { name: 'Ours' },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(MEMBER, 'DELETE', `${base}/folders/${FOLDER}`, one.DELETE as Handler, {
          kind: 'notes',
          id: FOLDER,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          MEMBER,
          'POST',
          `${base}/move`,
          move,
          { kind: 'notes' },
          {
            ids: [FOLDER],
            folderId: null,
          },
        )
      ).status,
    ).toBe(200);
    expect(h.calls.map((c) => [c.fn, c.args[0], c.args[1]])).toEqual([
      ['create', scope, 'notes'],
      ['update', scope, 'notes'],
      ['delete', scope, 'notes'],
      ['move', scope, 'notes'],
    ]);
  });

  it('carry a folder’s look into the create, and refuse a bad tint or icon first', async () => {
    const folders = (await import('./[kind]/folders/route')).POST as Handler;
    const url = '/api/member/tree/notes/folders';
    const kind = { kind: 'notes' };
    const res = await call(MEMBER, 'POST', url, folders, kind, {
      parentId: null,
      name: 'Mine',
      icon: 'lucide:briefcase',
      color: 'cyan',
    });
    expect(res.status).toBe(201);
    expect(h.calls).toEqual([
      {
        fn: 'create',
        args: [
          scope,
          'notes',
          { parentId: null, name: 'Mine', icon: 'lucide:briefcase', color: 'cyan' },
        ],
      },
    ]);
    h.calls.length = 0;
    const emoji = await call(MEMBER, 'POST', url, folders, kind, {
      parentId: null,
      name: 'A',
      icon: '🗂️',
    });
    expect(emoji.status).toBe(201);
    h.calls.length = 0;
    for (const body of [
      { parentId: null, name: 'A', color: 'magenta' },
      { parentId: null, name: 'A', icon: 'briefcase' },
      { parentId: null, name: 'A', icon: 'lucide:Not A Name' },
    ]) {
      expect((await call(MEMBER, 'POST', url, folders, kind, body)).status).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });

  it('refuse a client and an admin, a bad body, and a kind with no member tree', async () => {
    const folders = (await import('./[kind]/folders/route')).POST as Handler;
    const one = await import('./[kind]/folders/[id]/route');
    const body = { parentId: null, name: 'Mine' };
    for (const login of [CLIENT, ADMIN]) {
      expect(
        (
          await call(
            login,
            'POST',
            '/api/member/tree/notes/folders',
            folders,
            { kind: 'notes' },
            body,
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await call(
          MEMBER,
          'POST',
          '/api/member/tree/notes/folders',
          folders,
          { kind: 'notes' },
          {
            parentId: 'nope',
            name: 'x',
          },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          MEMBER,
          'PATCH',
          '/api/member/tree/notes/folders/nope',
          one.PATCH as Handler,
          {
            kind: 'notes',
            id: 'nope',
          },
          { name: 'x' },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          MEMBER,
          'POST',
          '/api/member/tree/secrets/folders',
          folders,
          { kind: 'secrets' },
          body,
        )
      ).status,
    ).toBe(404);
    expect(h.calls).toEqual([]);
  });
});
