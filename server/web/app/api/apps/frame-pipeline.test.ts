/**
 * The frame documents through the full pipeline (runRoute), the real route
 * files (A4 hand batch B fix round 1, L2): GET /api/apps/:id/frame and GET
 * /api/member/apps/:id/frame read the `?t=` frame ticket the gate verified
 * (frameTicketCaller), and answer each ticket as they did when they
 * verified it themselves: a valid ticket opens what it names, a ticket
 * for something else is the handler's 401, an invalid ticket or none is
 * the gate's 401 before the handler. The app's build and the frame
 * renderer are stood in; app-identity-owner and member-runner-routes call
 * the handlers with the reader stood in.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRoute } from '@/server/run-route';
import { standInLogin } from '@/server/run-route-stand-ins';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const APP = '11111111-1111-4111-8111-111111111111';
const OTHER_APP = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({ adminActive: true, rendered: [] as unknown[] }));

vi.mock(
  '@/lib/auth/login-row',
  async () => (await import('@/server/run-route-stand-ins')).loginRowStandIn,
);
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  adminLoginActive: vi.fn(async () => h.adminActive),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  getAppRuntime: vi.fn(async (_owner: string, id: string) =>
    id === APP
      ? { id, manifest: {}, draftBuild: { ok: true, storageKey: 'draft' }, publishedBuild: null }
      : null,
  ),
}));
vi.mock('@/lib/app-frame', () => ({
  renderAppFrame: vi.fn(async (_req: Request, build: unknown, opts?: { viewer?: unknown }) => {
    h.rendered.push({ build, viewer: opts?.viewer });
    return new Response('<!doctype html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }),
}));

let ticket: (o: { appId?: string; actorId?: string; loginId?: string }) => string;

beforeAll(async () => {
  process.env.SESSION_SECRET = 'frame-pipeline-test-secret-at-least-32-chars';
  standInLogin({ id: ANCHOR, role: 'admin', isOwner: true });
  standInLogin({ id: MEMBER, role: 'member' });
  const { buildAppFrameTicket } = await import('@/lib/auth/tokens');
  ticket = (o) =>
    `t=${encodeURIComponent(buildAppFrameTicket({ ownerId: ANCHOR, appId: o.appId ?? APP, ...o }))}`;
});

beforeEach(() => {
  h.adminActive = true;
  h.rendered.length = 0;
});

/** One request as the sandboxed iframe sends it: no cookie, the ticket. */
const frame = async (path: string, query: string | null, method = 'GET') => {
  const res = await runRoute(null, method, query ? `${path}?${query}` : path);
  return { status: res.status, body: await res.text() };
};

describe('GET /api/apps/:id/frame through the pipeline', () => {
  const path = `/api/apps/${APP}/frame`;

  it("a valid Admin user's ticket opens the draft, for the login it names", async () => {
    const res = await frame(path, ticket({ actorId: ANCHOR }));
    expect(res).toEqual({ status: 200, body: '<!doctype html>' });
    expect(h.rendered).toEqual([
      {
        build: { ok: true, storageKey: 'draft' },
        viewer: { ownerId: ANCHOR, appId: APP, subject: { kind: 'admin', loginId: ANCHOR } },
      },
    ]);
    // The gate takes a frame ticket on a GET only: a HEAD is its 401.
    const head = await frame(path, ticket({ actorId: ANCHOR }), 'HEAD');
    expect(head.status).toBe(401);
    expect(h.rendered).toHaveLength(1);
  });

  it("a valid ticket the handler refuses: another app's, an Admin user no longer active", async () => {
    expect(await frame(path, ticket({ appId: OTHER_APP, actorId: ANCHOR }))).toEqual({
      status: 401,
      body: 'frame ticket required',
    });
    h.adminActive = false;
    expect(await frame(path, ticket({ actorId: ANCHOR }))).toEqual({
      status: 401,
      body: 'admin session required',
    });
    expect(h.rendered).toEqual([]);
  });

  it("an invalid ticket, or none: the gate's 401, before the handler", async () => {
    for (const query of ['t=not-a-ticket', null, `at=${'x'.repeat(20)}`]) {
      const res = await frame(path, query);
      expect(res.status, String(query)).toBe(401);
      expect(JSON.parse(res.body), String(query)).toMatchObject({ error: 'unauthorized' });
    }
    expect(h.rendered).toEqual([]);
  });
});

describe('GET /api/member/apps/:id/frame through the pipeline', () => {
  const path = `/api/member/apps/${APP}/frame`;

  it("a valid member ticket: the route's 410, gone", async () => {
    const res = await frame(path, ticket({ loginId: MEMBER }));
    expect(res.status).toBe(410);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'gone' });
  });

  it("a valid ticket that is no member's for this app: the handler's 401", async () => {
    for (const t of [ticket({ actorId: ANCHOR }), ticket({ appId: OTHER_APP, loginId: MEMBER })]) {
      expect(await frame(path, t)).toEqual({ status: 401, body: 'frame ticket required' });
    }
  });

  it("an invalid ticket, or none: the gate's 401, before the handler", async () => {
    for (const query of ['t=not-a-ticket', null]) {
      const res = await frame(path, query);
      expect(res.status, String(query)).toBe(401);
      expect(JSON.parse(res.body), String(query)).toMatchObject({ error: 'unauthorized' });
    }
  });
});
