/**
 * A Present canvas on an open link (docs/proposals/canvas-files.md 7.2),
 * the two route files called directly, without a database:
 *
 *  - POST /s/:token/canvas/frame-ticket mints a canvas ticket that names
 *    the link and its canvas and no login, for an open link of a canvas only;
 *  - GET /s/:token/canvas/frame opens only with that ticket, and resolves the
 *    link on every load: a closed link or a deleted canvas stops it at once;
 *  - a login's canvas ticket, an app's ticket, another link's ticket and a
 *    ticket of another canvas are each refused.
 *
 * The link gate, the canvas reader and the renderer are stood in.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '33333333-3333-4333-8333-333333333333';
const CANVAS = '11111111-1111-4111-8111-111111111111';
const OTHER = '44444444-4444-4444-8444-444444444444';
const LOGIN = '22222222-2222-4222-8222-222222222222';

const LINK = {
  id: 'share-1',
  ownerId: OWNER,
  nodeId: CANVAS,
  nodeType: 'present',
  contactId: null,
};
const h = vi.hoisted(() => ({
  byToken: {} as Record<string, unknown>,
  canvasGone: false,
  rendered: [] as Array<{ owner: string; nonce: string }>,
}));

vi.mock('@/lib/contact-share-gate', () => {
  const gate = async (token: string) => {
    const share = h.byToken[token] as { contactId: string | null } | undefined;
    if (!share) return { kind: 'missing' };
    // A contact share without its cookie: the code prompt.
    if (share.contactId) return { kind: 'code', share };
    return { kind: 'ok', share, contact: null };
  };
  return {
    gateShare: vi.fn(async (_req: Request, token: string) => gate(token)),
    gateShareCookie: vi.fn(async (_cookie: string | null, token: string) => gate(token)),
  };
});
vi.mock('@/lib/presents', () => ({
  getPresentFrame: vi.fn(async (_owner: string, id: string) =>
    id === CANVAS && !h.canvasGone
      ? { source: '<html></html>', css: '', meta: { size: 'fill', theme: 'follow' }, rev: 3 }
      : null,
  ),
}));
vi.mock('@/lib/canvas-frame', () => ({
  canvasFrameRefusal: (status: number, text: string) =>
    new Response(text, { status, headers: { 'cache-control': 'no-store' } }),
  renderCanvasFrame: vi.fn(
    async (_req: Request, owner: string, _canvas: unknown, nonce: string) => {
      h.rendered.push({ owner, nonce });
      return new Response('<!doctype html>', { status: 200 });
    },
  ),
}));

type Tokens = typeof import('@/lib/auth/tokens');
let tokens: Tokens;
let ticketRoute: typeof import('./frame-ticket/route');
let frameRoute: typeof import('./frame/route');

beforeAll(async () => {
  process.env.SESSION_SECRET = 'canvas-share-test-secret-at-least-32-chars';
  tokens = await import('@/lib/auth/tokens');
  ticketRoute = await import('./frame-ticket/route');
  frameRoute = await import('./frame/route');
});

beforeEach(() => {
  h.byToken = {
    live: LINK,
    other: { ...LINK, id: 'share-2' },
    app: { ...LINK, id: 'share-3', nodeType: 'app' },
    contact: { ...LINK, id: 'share-4', contactId: 'contact-1' },
  };
  h.canvasGone = false;
  h.rendered.length = 0;
});

const params = (token: string) => ({ params: Promise.resolve({ token }) });
const mint = async (token: string) => {
  const res = await ticketRoute.POST(
    new Request(`http://brain.test/s/${token}/canvas/frame-ticket`, { method: 'POST' }),
    params(token),
  );
  return {
    status: res.status,
    body: res.ok ? ((await res.json()) as Record<string, string>) : null,
  };
};
/** The iframe navigation of the link's own page (Fetch Metadata). */
const FRAMED = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' };
const open = async (
  token: string,
  ticket: string | null,
  headers: Record<string, string> = FRAMED,
) => {
  const q = ticket === null ? '' : `?t=${encodeURIComponent(ticket)}`;
  const res = await frameRoute.GET(
    new Request(`http://brain.test/s/${token}/canvas/frame${q}`, { headers }),
    params(token),
  );
  return { status: res.status, body: await res.text() };
};

describe('POST /s/:token/canvas/frame-ticket', () => {
  it('mints a canvas ticket for the link and its canvas, with no login, and its nonce', async () => {
    const r = await mint('live');
    expect(r.status).toBe(200);
    const t = tokens.verifyCanvasFrameTicket(r.body!.ticket!);
    expect(t).toEqual({ ownerId: OWNER, appId: CANVAS, canvas: true, shareId: 'share-1' });
    expect(r.body!.nonce).toBe(tokens.canvasFrameNonce(r.body!.ticket!));
    // Never an app's ticket.
    expect(tokens.verifyAppFrameTicket(r.body!.ticket!)).toBeNull();
  });

  it('is a 404 for a closed link, a link of another kind, a contact share and a deleted canvas', async () => {
    expect((await mint('gone')).status).toBe(404);
    expect((await mint('app')).status).toBe(404);
    expect((await mint('contact')).status).toBe(404);
    h.canvasGone = true;
    expect((await mint('live')).status).toBe(404);
  });
});

describe('GET /s/:token/canvas/frame', () => {
  it("opens the latest save with the link's own ticket, the nonce its ticket gives", async () => {
    const { body } = await mint('live');
    expect(await open('live', body!.ticket!)).toEqual({ status: 200, body: '<!doctype html>' });
    expect(h.rendered).toEqual([{ owner: OWNER, nonce: body!.nonce }]);
  });

  it('stops at once when the link is closed or the canvas deleted, ticket or not', async () => {
    const { body } = await mint('live');
    delete h.byToken.live;
    const closed = await frameRoute.GET(
      new Request(`http://brain.test/s/live/canvas/frame?t=${encodeURIComponent(body!.ticket!)}`, {
        headers: FRAMED,
      }),
      params('live'),
    );
    expect(closed.status).toBe(404);
    // A refusal is never cached.
    expect(closed.headers.get('cache-control')).toBe('no-store');
    h.byToken.live = LINK;
    h.canvasGone = true;
    expect((await open('live', body!.ticket!)).status).toBe(404);
    expect(h.rendered).toEqual([]);
  });

  it("refuses no ticket, another link's, a login's, an app's and another canvas's", async () => {
    const refused = { status: 401, body: 'frame ticket required' };
    expect(await open('live', null)).toEqual(refused);
    expect(await open('live', 'not-a-ticket')).toEqual(refused);
    // Another link of the same canvas.
    expect(await open('live', (await mint('other')).body!.ticket!)).toEqual(refused);
    // An Admin user's and a member's canvas tickets open the owner frame only.
    const own = (o: { actorId?: string; loginId?: string }) =>
      tokens.buildCanvasFrameTicket({ ownerId: OWNER, presentId: CANVAS, ...o });
    expect(await open('live', own({ actorId: LOGIN }))).toEqual(refused);
    expect(await open('live', own({ loginId: LOGIN }))).toEqual(refused);
    // An app's share ticket for the same id is no canvas ticket.
    const app = tokens.buildAppFrameTicket({ ownerId: OWNER, appId: CANVAS, shareId: 'share-1' });
    expect(await open('live', app)).toEqual(refused);
    // A link ticket of another canvas, or of another brain.
    const elsewhere = (o: { ownerId?: string; presentId?: string }) =>
      tokens.buildCanvasFrameTicket({
        ownerId: o.ownerId ?? OWNER,
        presentId: o.presentId ?? CANVAS,
        shareId: 'share-1',
      });
    expect(await open('live', elsewhere({ presentId: OTHER }))).toEqual(refused);
    expect(await open('live', elsewhere({ ownerId: LOGIN }))).toEqual(refused);
    expect(h.rendered).toEqual([]);
  });

  it("opens only as the frame of the link's own page, never as a page of its own", async () => {
    const ticket = async () => (await mint('live')).body!.ticket!;
    const refused = { status: 403, body: 'open this canvas from its shared link' };
    // A visitor sent to the frame URL: a top-level document.
    expect(
      await open('live', await ticket(), {
        'sec-fetch-dest': 'document',
        'sec-fetch-site': 'none',
      }),
    ).toEqual(refused);
    // Framed by another site, or by a canvas's own (opaque) frame.
    expect(
      await open('live', await ticket(), {
        'sec-fetch-dest': 'iframe',
        'sec-fetch-site': 'cross-site',
      }),
    ).toEqual(refused);
    // No Fetch Metadata at all.
    expect(await open('live', await ticket(), {})).toEqual(refused);
    expect(h.rendered).toEqual([]);
    expect((await open('live', await ticket())).status).toBe(200);
  });

  it('is a 404 on a link of another kind and on a contact share', async () => {
    const { body } = await mint('live');
    expect((await open('app', body!.ticket!)).status).toBe(404);
    expect((await open('contact', body!.ticket!)).status).toBe(404);
  });
});

describe('buildCanvasFrameTicket', () => {
  it("a link's ticket names the link alone, never a login beside it", () => {
    const t = tokens.verifyCanvasFrameTicket(
      tokens.buildCanvasFrameTicket({
        ownerId: OWNER,
        presentId: CANVAS,
        shareId: 'share-1',
        actorId: LOGIN,
        loginId: LOGIN,
      }),
    );
    expect(t).toEqual({ ownerId: OWNER, appId: CANVAS, canvas: true, shareId: 'share-1' });
  });
});
