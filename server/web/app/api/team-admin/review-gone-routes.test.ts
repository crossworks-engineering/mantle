/**
 * The admin side of review and Team admin, removed in workspaces W5c, without
 * a database: every removed route is a stub that answers an admin 410
 * `{ error, code: 'gone' }` and still answers 401 without a session (the
 * gate answers the owner guard first, so nothing leaks; since A4 hand batch
 * A the gate, so a stub called with no answer throws). The stubs stay routed so an old
 * client gets the 410 instead of a vague 404; the role sweeps drive them
 * through the real app.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ signedIn: true }));

vi.mock('@/lib/auth', () => {
  const owner = async () =>
    h.signedIn
      ? { id: OWNER }
      : new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  // The readers a stub reads (lib/gone.ts, A4 hand batch A): the gate
  // answered the stub's guard before the handler; with no session it
  // refused, so a stub called anyway finds no answer and throws.
  const read = () => {
    if (!h.signedIn) throw new Error('ownerCaller(): the pipeline answered no owner');
    return { id: OWNER };
  };
  return {
    getOwnerOr401: vi.fn(owner),
    getMemberOr401: vi.fn(owner),
    getLoginOr401: vi.fn(owner),
    ownerCaller: vi.fn(read),
    memberCaller: vi.fn(read),
    loginCaller: vi.fn(read),
  };
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

beforeEach(() => {
  h.signedIn = true;
});

describe('the admin review and Team admin routes are gone (W5c)', () => {
  it('each route exports exactly its old methods, nothing more', async () => {
    for (const [path, methods, load] of GONE) {
      const mod = await load();
      expect(Object.keys(mod).sort(), path).toEqual([...methods].sort());
    }
  });

  it("answers an admin 410 with code 'gone'", async () => {
    for (const [path, methods, load] of GONE) {
      const mod = await load();
      for (const method of methods) {
        const res = await mod[method]!();
        expect(res.status, `${method} ${path}`).toBe(410);
        const body = (await res.json()) as { error?: unknown; code?: unknown };
        expect(body.code, `${method} ${path}`).toBe('gone');
        expect(typeof body.error, `${method} ${path}`).toBe('string');
      }
    }
  });

  it("never answers 410 without the gate's answer (no session: the gate's 401)", async () => {
    h.signedIn = false;
    for (const [path, methods, load] of GONE) {
      const mod = await load();
      for (const method of methods) {
        await expect(mod[method]!(), `${method} ${path}`).rejects.toThrow(/answered no/);
      }
    }
  });
});
