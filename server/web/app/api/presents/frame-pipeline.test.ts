/**
 * A Present canvas's frame document through the full pipeline (runRoute),
 * the real route file, as app frames are tested (apps/frame-pipeline.test.ts):
 * GET /api/presents/:id/frame reads the `?t=` ticket the gate verified,
 * as a CANVAS ticket. An app's ticket never opens a canvas, a canvas's never
 * opens an app. The reader and the renderer are stood in.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRoute } from '@/server/run-route';
import { standInLogin } from '@/server/run-route-stand-ins';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const CANVAS = '11111111-1111-4111-8111-111111111111';
const OTHER = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  adminActive: true,
  memberActive: true,
  rendered: [] as unknown[],
}));

vi.mock(
  '@/lib/auth/login-row',
  async () => (await import('@/server/run-route-stand-ins')).loginRowStandIn,
);
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  adminLoginActive: vi.fn(async () => h.adminActive),
  memberLoginActive: vi.fn(async () => h.memberActive),
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  withViewer: vi.fn(async (_who: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/presents', () => ({
  getPresentFrame: vi.fn(async (_owner: string, id: string) =>
    id === CANVAS
      ? { source: '<html></html>', css: '', meta: { size: 'fill', theme: 'follow' }, rev: 1 }
      : null,
  ),
}));
vi.mock('@/lib/canvas-frame', () => ({
  renderCanvasFrame: vi.fn(async (_req: Request, owner: string, canvas: unknown) => {
    h.rendered.push({ owner, canvas });
    return new Response('<!doctype html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }),
}));

let canvasTicket: (o: { presentId?: string; actorId?: string; loginId?: string }) => string;
let appTicket: (o: { appId?: string; actorId?: string }) => string;

beforeAll(async () => {
  process.env.SESSION_SECRET = 'canvas-frame-pipeline-secret-at-least-32-chars';
  standInLogin({ id: ANCHOR, role: 'admin', adminMember: true, isOwner: true });
  standInLogin({ id: MEMBER, role: 'member' });
  const { buildAppFrameTicket, buildCanvasFrameTicket } = await import('@/lib/auth/tokens');
  canvasTicket = (o) =>
    `t=${encodeURIComponent(
      buildCanvasFrameTicket({ ownerId: ANCHOR, presentId: o.presentId ?? CANVAS, ...o }),
    )}`;
  appTicket = (o) =>
    `t=${encodeURIComponent(buildAppFrameTicket({ ownerId: ANCHOR, appId: o.appId ?? CANVAS, ...o }))}`;
});

beforeEach(() => {
  h.adminActive = true;
  h.memberActive = true;
  h.rendered.length = 0;
});

const frame = async (path: string, query: string | null, method = 'GET') => {
  const res = await runRoute(null, method, query ? `${path}?${query}` : path);
  return { status: res.status, body: await res.text() };
};

describe('GET /api/presents/:id/frame through the pipeline', () => {
  const path = `/api/presents/${CANVAS}/frame`;

  it("an Admin user's canvas ticket opens the latest save", async () => {
    expect(await frame(path, canvasTicket({ actorId: ANCHOR }))).toEqual({
      status: 200,
      body: '<!doctype html>',
    });
    expect(h.rendered).toHaveLength(1);
    // A frame ticket on a GET only: a HEAD is the gate's 401.
    expect((await frame(path, canvasTicket({ actorId: ANCHOR }), 'HEAD')).status).toBe(401);
  });

  it("a member's canvas ticket opens it while the login is an active member", async () => {
    expect((await frame(path, canvasTicket({ loginId: MEMBER }))).status).toBe(200);
    h.memberActive = false;
    expect(await frame(path, canvasTicket({ loginId: MEMBER }))).toEqual({
      status: 401,
      body: 'member session required',
    });
  });

  it("refuses another canvas's ticket, an inactive admin, and an app's ticket", async () => {
    expect(await frame(path, canvasTicket({ presentId: OTHER, actorId: ANCHOR }))).toEqual({
      status: 401,
      body: 'frame ticket required',
    });
    h.adminActive = false;
    expect(await frame(path, canvasTicket({ actorId: ANCHOR }))).toEqual({
      status: 401,
      body: 'admin session required',
    });
    h.adminActive = true;
    // An app's ticket for the same id is no canvas ticket: the caller is null.
    expect(await frame(path, appTicket({ actorId: ANCHOR }))).toEqual({
      status: 401,
      body: 'frame ticket required',
    });
    expect(h.rendered).toEqual([]);
  });

  it("a canvas's ticket never opens an app frame", async () => {
    const res = await frame(`/api/apps/${CANVAS}/frame`, canvasTicket({ actorId: ANCHOR }));
    expect(res).toEqual({ status: 401, body: 'frame ticket required' });
  });

  it('a canvas ticket lives 30 seconds (it sits in a URL the canvas can read)', async () => {
    const query = canvasTicket({ actorId: ANCHOR });
    vi.useFakeTimers({ now: Date.now() + 31_000, toFake: ['Date'] });
    try {
      const res = await frame(path, query);
      expect(res.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
    expect(h.rendered).toEqual([]);
  });

  it("an invalid ticket, or none: the gate's 401, before the handler", async () => {
    for (const query of ['t=not-a-ticket', null]) {
      const res = await frame(path, query);
      expect(res.status, String(query)).toBe(401);
      expect(JSON.parse(res.body), String(query)).toMatchObject({ error: 'unauthorized' });
    }
    expect(h.rendered).toEqual([]);
  });
});
