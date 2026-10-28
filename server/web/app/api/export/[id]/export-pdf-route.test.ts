/**
 * GET /api/export/:id?format=pdf hands the render to renderNodeToPdf (the
 * documents engine, or the browser sidecar) as the ACTING admin, whoever
 * clicked Export, for the node being printed (audit F01: the render cookie
 * both engines carry is minted for that admin and that node, never a
 * session; the engines are stood in here). The print options are query
 * parameters, validated with safe defaults; a bad one is a 400.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const PAGE = '44444444-4444-4444-8444-444444444444';
const DRAW = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  renders: [] as Array<{ kind: string; id: string; who: unknown; options: unknown }>,
  fills: [] as Array<{ id: string; opts: unknown }>,
  drawSvg: null as string | null,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The asset owner the pipeline answers (A4 hand batch B).
  ownerAssetCaller: vi.fn(() => ({
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
  PdfRendererUnavailableError: class extends Error {},
  renderNodeToPdf: vi.fn(async (kind: string, id: string, who: unknown, options: unknown) => {
    h.renders.push({ kind, id, who, options });
    return Buffer.from('%PDF-1.7');
  }),
}));

describe('PDF export: the render as the acting admin', () => {
  let GET: typeof import('./route').GET;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'export-pdf-route-secret-at-least-32-chars';
    ({ GET } = await import('./route'));
  });

  beforeEach(() => {
    h.renders.length = 0;
    h.fills.length = 0;
    h.drawSvg = null;
  });

  const exportPdf = (id: string, query = '') =>
    GET(new Request(`http://brain.test/api/export/${id}?format=pdf${query}`), {
      params: Promise.resolve({ id }),
    });

  it('prints a page as the acting admin, not the anchor, with the default options', async () => {
    const res = await exportPdf(PAGE);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(h.renders).toHaveLength(1);
    expect(h.renders[0]).toEqual({
      kind: 'page',
      id: PAGE,
      who: { ownerId: ANCHOR, actorId: ADMIN },
      options: {
        paper: 'a4',
        landscape: false,
        margins: { top: 18, right: 16, bottom: 18, left: 16 },
        header: null,
        footer: null,
        pageNumbers: false,
      },
    });
    // The embedded drawing's cache fill renders for the same admin.
    expect(h.fills).toContainEqual({ id: DRAW, opts: { actorId: ADMIN } });
  });

  it('prints a drawing as the acting admin', async () => {
    h.drawSvg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const res = await exportPdf(DRAW);
    expect(res.status).toBe(200);
    expect(h.renders[0]).toMatchObject({
      kind: 'draw',
      id: DRAW,
      who: { ownerId: ANCHOR, actorId: ADMIN },
    });
  });

  it('takes the print options from the query, and refuses a bad one with 400', async () => {
    const res = await exportPdf(
      PAGE,
      '&paper=letter&landscape=1&margin=10&footer=Q3%20pack&page_numbers=1',
    );
    expect(res.status).toBe(200);
    expect(h.renders[0]!.options).toEqual({
      paper: 'letter',
      landscape: true,
      // The footer line needs room: the bottom margin grows to 14 mm.
      margins: { top: 10, right: 10, bottom: 14, left: 10 },
      header: null,
      footer: 'Q3 pack',
      pageNumbers: true,
    });
    const bad = await exportPdf(PAGE, '&paper=tabloid');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: expect.stringMatching(/print option paper/) });
    expect(h.renders).toHaveLength(1);
  });
});
