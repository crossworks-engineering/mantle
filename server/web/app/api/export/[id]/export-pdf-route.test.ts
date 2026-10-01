/**
 * GET /api/export/:id?format=pdf mints the credential the browser sidecar
 * carries (audit F01). It used to be a full session cookie for the ANCHOR,
 * whoever clicked Export; it must now be a render cookie (kind 'r') for the
 * ACTING admin and the node being printed, and never a session. The sidecar
 * itself is stood in: these pin what the route hands it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const PAGE = '44444444-4444-4444-8444-444444444444';
const DRAW = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  renders: [] as Array<{ url: string; token: string }>,
  fills: [] as Array<{ id: string; opts: unknown }>,
  drawSvg: null as string | null,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerForAsset: vi.fn(async () => ({
    id: ANCHOR,
    email: 'b@example.invalid',
    actor: { id: ADMIN, email: 'b@example.invalid', displayName: 'B', isOwner: false },
  })),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPage: vi.fn(async () => ({
    title: 'Quarterly notes',
    doc: { type: 'doc', content: [{ type: 'image', attrs: { drawId: DRAW } }] },
  })),
  getDraw: vi.fn(async () => ({ title: 'A drawing' })),
}));

vi.mock('@/lib/draw-snapshot', () => ({
  getDrawSvgOrRender: vi.fn(async (_owner: string, id: string, opts: unknown) => {
    h.fills.push({ id, opts });
    return id === DRAW && h.drawSvg !== null ? h.drawSvg : null;
  }),
  getDrawPngOrRender: vi.fn(async () => null),
}));

vi.mock('@/lib/files', () => ({ readFileById: vi.fn(async () => null) }));

vi.mock('@/lib/render-pdf', () => ({
  printOrigin: () => 'http://web:3000',
  PdfRendererUnavailableError: class extends Error {},
  renderUrlToPdf: vi.fn(async (url: string, token: string) => {
    h.renders.push({ url, token });
    return Buffer.from('%PDF-1.7');
  }),
}));

describe('PDF export: the sidecar credential', () => {
  let GET: typeof import('./route').GET;
  let auth: typeof import('@/lib/auth/tokens');

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'export-pdf-route-secret-at-least-32-chars';
    ({ GET } = await import('./route'));
    auth = await import('@/lib/auth/tokens');
  });

  beforeEach(() => {
    h.renders.length = 0;
    h.fills.length = 0;
    h.drawSvg = null;
  });

  const exportPdf = (id: string) =>
    GET(new Request(`http://brain.test/api/export/${id}?format=pdf`), {
      params: Promise.resolve({ id }),
    });

  it('prints a page with a render cookie for the acting admin, not the anchor', async () => {
    const res = await exportPdf(PAGE);
    expect(res.status).toBe(200);
    expect(h.renders).toHaveLength(1);
    const { url, token } = h.renders[0]!;
    expect(url).toBe(`http://web:3000/print/pages/${PAGE}`);
    expect(auth.verifyRenderToken(token)).toEqual({ uid: ANCHOR, act: ADMIN, n: PAGE });
    // Not a session, and not a Cookie header line either: a bare value the
    // sidecar sets as a cookie on the print origin.
    expect(auth.verifySessionCookie(token)).toBeNull();
    expect(token).not.toContain('=');
    // The embedded drawing's cache fill renders for the same admin.
    expect(h.fills).toContainEqual({ id: DRAW, opts: { actorId: ADMIN } });
  });

  it('prints a drawing with a render cookie naming that drawing and the acting admin', async () => {
    h.drawSvg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const res = await exportPdf(DRAW);
    expect(res.status).toBe(200);
    const { url, token } = h.renders[0]!;
    expect(url).toBe(`http://web:3000/print/draws/${DRAW}`);
    expect(auth.verifyRenderToken(token)).toEqual({ uid: ANCHOR, act: ADMIN, n: DRAW });
    expect(auth.verifySessionCookie(token)).toBeNull();
  });
});
