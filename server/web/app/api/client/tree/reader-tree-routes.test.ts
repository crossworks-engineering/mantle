/**
 * The retired member and client tree routes without a database: the login
 * rows are stood in, the gate is the real one: each request runs through the
 * full pipeline (runRoute), since A4 hand batch A the gate answers a stub's
 * guard. The member tree routes
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
  loadLoginRow: async (id: string) => {
    const found =
      id === CLIENT
        ? row(CLIENT, 'client')
        : id === MEMBER
          ? row(MEMBER, 'member')
          : id === ADMIN
            ? row(ADMIN, 'admin')
            : null;
    // The login's scope, in no workspace (run-route-stand-ins.ts does the
    // same): the pipeline enters it with no database.
    if (found) (await import('@mantle/db')).seedLoginScope(id, [], []);
    return found;
  },
  loadAnchorId: async () => ANCHOR,
  loadPersonalSpaceId: async () => SPACE,
}));

const saved = process.env.SESSION_SECRET;
let runRoute: typeof import('@/server/run-route').runRoute;

beforeAll(async () => {
  process.env.SESSION_SECRET = 'reader-tree-routes-secret-at-least-32-chars';
  runRoute = (await import('@/server/run-route')).runRoute;
});
afterAll(() => {
  process.env.SESSION_SECRET = saved;
});

/** GET `url` as `login` (a cookie at the rows' epoch) through the pipeline. */
function call(login: string, url: string) {
  return runRoute({ id: login, epoch: 3 }, 'GET', url);
}

describe('the member tree routes, and the retired client tree', () => {
  it('answers a member 410 since W6b: its items are read through the normal tree', async () => {
    expect((await call(MEMBER, '/api/member/tree/notes')).status).toBe(410);
    expect((await call(MEMBER, '/api/member/tree/notes/search')).status).toBe(410);
  });

  it('the client tree is gone (W5c): 410 to any login, 401 to a row still marked client, no read', async () => {
    for (const login of [ADMIN, MEMBER]) {
      const res = await call(login, `/api/client/tree/notes`);
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ code: 'gone' });
      expect((await call(login, '/api/client/tree/notes/search?q=a')).status).toBe(410);
    }
    // A login row still marked client resolves to no login (W8a).
    expect((await call(CLIENT, '/api/client/tree/notes')).status).toBe(401);
    expect((await call(CLIENT, '/api/client/tree/notes/search?q=a')).status).toBe(401);
    expect((await call(CLIENT, '/api/member/tree/notes')).status).toBe(401);
  });
});
