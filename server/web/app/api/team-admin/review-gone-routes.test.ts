/**
 * The admin side of review and Team admin, removed in workspaces W5c, without
 * a database: every removed route is a stub that answers an admin 410
 * `{ error, code: 'gone' }` and still answers 401 without a session. Since
 * A4 hand batch A the gate answers the stub's guard (its row is a gone row
 * of the stub's kind), so each request runs through the FULL pipeline
 * (runRoute, as reader-tree-routes.test.ts does): the gate, the row, the
 * caller the gate answered and the stub reading it. The login rows are
 * stood in (run-route-stand-ins.ts); nothing of the auth library is mocked.
 * The stubs stay routed so an old client gets the 410 instead of a vague
 * 404; the role sweeps drive them through the real app too.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { runRoute } from '@/server/run-route';
import { standInLogin } from '@/server/run-route-stand-ins';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const ID = '11111111-1111-4111-8111-111111111111';

vi.mock(
  '@/lib/auth/login-row',
  async () => (await import('@/server/run-route-stand-ins')).loginRowStandIn,
);
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  // On a write row an Admin user's answer reads the database (its write
  // scope, the create home): stood in, as in the guard sweep; the stub's
  // guard is the gate's either way.
  loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
  createHomeIntent: async () => ({ createWs: null, privateWs: null }),
}));
// The brain's owner holds every Admin area (no database to read them from).
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  requireArea: async () => true,
}));
// The api.write row an Admin user's write writes, kept off the database.
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  auditFireAndForget: vi.fn(),
}));

beforeAll(() => {
  standInLogin({ id: ANCHOR, role: 'admin', isOwner: true });
  standInLogin({ id: MEMBER, role: 'member' });
});

type Handler = () => Promise<Response>;
type RouteModule = Record<string, Handler>;

/** Every removed route: its path, the methods it had, and its module. */
const GONE: Array<[string, string[], () => Promise<RouteModule>]> = [
  ['/api/team-admin/submissions', ['GET'], () => import('./submissions/route')],
  ['/api/team-admin/submissions/:id', ['GET'], () => import('./submissions/[id]/route')],
  [
    '/api/team-admin/submissions/:id/accept',
    ['POST'],
    () => import('./submissions/[id]/accept/route'),
  ],
  [
    '/api/team-admin/submissions/:id/bundle',
    ['GET'],
    () => import('./submissions/[id]/bundle/route'),
  ],
  [
    '/api/team-admin/submissions/:id/bytes',
    ['GET'],
    () => import('./submissions/[id]/bytes/route'),
  ],
  [
    '/api/team-admin/submissions/:id/discard',
    ['POST'],
    () => import('./submissions/[id]/discard/route'),
  ],
  [
    '/api/team-admin/submissions/:id/return',
    ['POST'],
    () => import('./submissions/[id]/return/route'),
  ],
  ['/api/team-admin/submissions/:id/svg', ['GET'], () => import('./submissions/[id]/svg/route')],
  [
    '/api/team-admin/submissions/:id/take-over',
    ['POST'],
    () => import('./submissions/[id]/take-over/route'),
  ],
  // The email-code sign-in sender (workspaces W8a).
  [
    '/api/team-admin/clients/signin-sender',
    ['GET', 'PUT'],
    () => import('./clients/signin-sender/route'),
  ],
  [
    '/api/team-admin/clients/signin-sender/preview',
    ['GET'],
    () => import('./clients/signin-sender/preview/route'),
  ],
  ['/api/team-admin/member-items', ['GET'], () => import('./member-items/route')],
  ['/api/team-admin/member-items/:id', ['GET'], () => import('./member-items/[id]/route')],
  [
    '/api/team-admin/member-items/:id/bytes',
    ['GET'],
    () => import('./member-items/[id]/bytes/route'),
  ],
  ['/api/team-admin/member-items/:id/svg', ['GET'], () => import('./member-items/[id]/svg/route')],
  [
    '/api/team-admin/member-items/:id/unshare',
    ['POST'],
    () => import('./member-items/[id]/unshare/route'),
  ],
  ['/api/team-admin/needs-you', ['GET'], () => import('./needs-you/route')],
  ['/api/team-admin/requests', ['GET'], () => import('./requests/route')],
  ['/api/team-admin/notify', ['POST'], () => import('./notify/route')],
  ['/api/admin/space/:id/accept', ['POST'], () => import('../admin/space/[id]/accept/route')],
  ['/api/admin/space/:id/give-back', ['POST'], () => import('../admin/space/[id]/give-back/route')],
  ['/api/apps/members', ['GET'], () => import('../apps/members/route')],
  ['/api/apps/members/:id', ['GET'], () => import('../apps/members/[id]/route')],
  ['/api/apps/members/:id/accept', ['POST'], () => import('../apps/members/[id]/accept/route')],
  ['/api/apps/members/:id/activity', ['GET'], () => import('../apps/members/[id]/activity/route')],
  ['/api/apps/members/:id/delete', ['POST'], () => import('../apps/members/[id]/delete/route')],
  ['/api/apps/members/:id/history', ['GET'], () => import('../apps/members/[id]/history/route')],
  [
    '/api/apps/members/:id/send-back',
    ['POST'],
    () => import('../apps/members/[id]/send-back/route'),
  ],
  [
    '/api/apps/members/:id/test',
    ['POST', 'DELETE'],
    () => import('../apps/members/[id]/test/route'),
  ],
  [
    '/api/apps/members/:id/test/db-broker',
    ['POST'],
    () => import('../apps/members/[id]/test/db-broker/route'),
  ],
  [
    '/api/apps/members/:id/test/frame',
    ['GET'],
    () => import('../apps/members/[id]/test/frame/route'),
  ],
  [
    '/api/apps/members/:id/test/frame-ticket',
    ['POST'],
    () => import('../apps/members/[id]/test/frame-ticket/route'),
  ],
  [
    '/api/apps/members/:id/test/tool-broker',
    ['POST'],
    () => import('../apps/members/[id]/test/tool-broker/route'),
  ],
  ['/api/apps/members/:id/unshare', ['POST'], () => import('../apps/members/[id]/unshare/route')],
];

describe('the admin review and Team admin routes are gone (W5c)', () => {
  it('each route exports exactly its old methods, nothing more', async () => {
    for (const [path, methods, load] of GONE) {
      const mod = await load();
      expect(Object.keys(mod).sort(), path).toEqual([...methods].sort());
    }
  });

  /** Each removed route and method, as a request: its path with real ids,
   *  and whether its row is a write (the gate reads the database there). */
  let writeRows: ReadonlySet<string> = new Set();
  beforeAll(async () => {
    const { routeManifest } = await import('@/server/route-manifest.gen');
    const { buildRoutePolicy } = await import('@/lib/auth/route-policy');
    writeRows = new Set(
      [...buildRoutePolicy(routeManifest).values()]
        .filter((r) => r.effect === 'write' || r.item !== null)
        .map((r) => r.key),
    );
  });
  const requests = () =>
    GONE.flatMap(([pattern, methods]) =>
      methods.map((method) => [method, pattern.replace(/:[A-Za-z]+/g, ID), pattern] as const),
    );
  /** One request as `login`. */
  const call = async (login: string | null, method: string, path: string, _pattern: string) =>
    runRoute(login, method, path, method === 'GET' ? undefined : {});

  it("answers an admin 410 with code 'gone', through the pipeline", async () => {
    expect(writeRows.size).toBeGreaterThan(0);
    for (const [method, path, pattern] of requests()) {
      const res = await call(ANCHOR, method, path, pattern);
      expect(res.status, `${method} ${path}`).toBe(410);
      const body = (await res.json()) as { error?: unknown; code?: unknown };
      expect(body.code, `${method} ${path}`).toBe('gone');
      expect(typeof body.error, `${method} ${path}`).toBe('string');
    }
  });

  it("never answers 410 without the gate's answer: no session 401, a member the gate's refusal", async () => {
    for (const [method, path, pattern] of requests()) {
      const none = await call(null, method, path, pattern);
      expect(none.status, `${method} ${path}`).toBe(401);
      const member = await call(MEMBER, method, path, pattern);
      expect(member.status, `${method} ${path}`).toBe(403);
      expect(await member.json(), `${method} ${path}`).not.toMatchObject({ code: 'gone' });
    }
  });
});
