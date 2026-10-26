/**
 * The Present routes through the full pipeline (runRoute), the real route
 * files and the real frame renderer, as the final audit asked:
 *
 *  - POST /api/presents/:id/frame-ticket mints a canvas ticket and the nonce
 *    that proves the frame (canvas-sandbox.tsx), for an owner login; a
 *    canvas that is not there is a 404; no login is the gate's 401.
 *  - GET /api/presents/:id/frame answers with the frame CSP as a header (the
 *    sandbox, no network), Allow-CSP-From, nosniff, DNS prefetch off, and the
 *    ticket's nonce inside the prelude, never in the canvas's own text.
 *  - A share's ticket or a client login's ticket for a canvas is refused.
 *  - The DELETE handler deletes, and answers 404 for none.
 *  - The create and update handlers hand the posted source to the content
 *    layer, whose save stores a pid canvas honest (forged marks unchecked,
 *    its own count) and a genuine traced one byte for byte.
 *
 * The content layer is stood in; the frame document is built by the real
 * share-ui builder over a stand-in import map and fonts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRoute } from '@/server/run-route';
import { standInLogin } from '@/server/run-route-stand-ins';
import {
  buildCanvas,
  markSealBody,
  provenanceSealBody,
  readCanvasData,
} from '@mantle/diagram-templates';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const CANVAS = '11111111-1111-4111-8111-111111111111';
const MISSING = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({ deleted: [] as string[], saved: [] as string[] }));

vi.mock(
  '@/lib/auth/login-row',
  async () => (await import('@/server/run-route-stand-ins')).loginRowStandIn,
);
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  adminLoginActive: vi.fn(async () => true),
  memberLoginActive: vi.fn(async () => true),
  // The DELETE handler is called directly below: the owner the gate would
  // have answered for its row.
  ownerCaller: vi.fn(() => ({ id: ANCHOR })),
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  withViewer: vi.fn(async (_who: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/presents', () => ({
  getPresent: vi.fn(async (_owner: string, id: string) =>
    id === CANVAS ? { id: CANVAS, rev: 3 } : null,
  ),
  getPresentFrame: vi.fn(async (_owner: string, id: string) =>
    id === CANVAS
      ? {
          source: '<html><head><title>T</title></head><body>THE CANVAS</body></html>',
          css: '',
          meta: { size: 'fill', theme: 'follow' },
          rev: 3,
        }
      : null,
  ),
  deletePresent: vi.fn(async (_owner: string, id: string) => {
    if (id !== CANVAS) return false;
    h.deleted.push(id);
    return true;
  }),
  getPresentPoster: vi.fn(async (_owner: string, id: string) =>
    id === CANVAS ? { png: Buffer.from('PNGBYTES'), current: false, posterRev: 2 } : null,
  ),
  getPresentEmbedFacts: vi.fn(async (_owner: string, id: string) =>
    id === CANVAS ? { title: 'Pump deck', rev: 3, posterRev: 2 } : null,
  ),
  compileCanvasCss: vi.fn(async () => ''),
  // The store is stubbed; what the content layer runs on every saved
  // source first (honestCanvasSource) is the real one.
  savePresentSource: vi.fn(async (_o: string, _id: string, input: { source: string }) => {
    const { honestCanvasSource } = await import('@mantle/content/drawing-seal');
    h.saved.push(honestCanvasSource(input.source));
    return { ok: true, present: { id: CANVAS, rev: 4 } };
  }),
  createPresent: vi.fn(async (_o: string, input: { source?: string }) => {
    const { honestCanvasSource } = await import('@mantle/content/drawing-seal');
    h.saved.push(honestCanvasSource(input.source ?? ''));
    return { id: CANVAS, rev: 1 };
  }),
  updatePresent: vi.fn(),
}));
vi.mock('@mantle/tools/canvas-frame-document', async () => {
  const { buildCanvasFrameHtml } = await import('@mantle/share-ui/canvas-frame-html');
  return {
    loadCanvasImportMap: vi.fn(async () => '{"imports":{}}'),
    canvasFrameDocument: vi.fn(
      async (
        _owner: string,
        canvas: { source: string; css: string; meta: { size: 'fill'; theme: 'follow' } },
        theme: { cls: string; colorTheme: string | null },
        nonce?: string,
      ) =>
        buildCanvasFrameHtml({
          source: canvas.source,
          css: canvas.css,
          importMapJson: '{"imports":{}}',
          cls: theme.cls,
          colorTheme: theme.colorTheme,
          size: canvas.meta.size,
          theme: canvas.meta.theme,
          fontCss: '',
          ...(nonce ? { nonce } : {}),
        }),
    ),
  };
});

let tokens: typeof import('@/lib/auth/tokens');

beforeAll(async () => {
  process.env.SESSION_SECRET = 'present-routes-pipeline-secret-at-least-32-chars';
  standInLogin({ id: ANCHOR, role: 'admin', adminMember: true, isOwner: true });
  tokens = await import('@/lib/auth/tokens');
});

beforeEach(() => {
  h.deleted.length = 0;
  h.saved.length = 0;
});

describe('POST /api/presents/:id/frame-ticket', () => {
  it("mints a canvas ticket and the frame's nonce for the owner", async () => {
    const res = await runRoute(ANCHOR, 'POST', `/api/presents/${CANVAS}/frame-ticket`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; nonce: string; rev: number };
    expect(body.rev).toBe(3);
    expect(tokens.verifyCanvasFrameTicket(body.ticket)?.appId).toBe(CANVAS);
    expect(body.nonce).toBe(tokens.canvasFrameNonce(body.ticket));
    expect(body.nonce).not.toContain(body.ticket.slice(0, 10));
  });

  it('answers 404 for a canvas that is not there, and 401 with no login', async () => {
    expect(
      (await runRoute(ANCHOR, 'POST', `/api/presents/${MISSING}/frame-ticket`, {})).status,
    ).toBe(404);
    expect((await runRoute(null, 'POST', `/api/presents/${CANVAS}/frame-ticket`, {})).status).toBe(
      401,
    );
  });
});

describe('GET /api/presents/:id/poster, the snapshot a page embeds', () => {
  it('answers the PNG with its rev as the tag, and a 304 for the same tag', async () => {
    const res = await runRoute(ANCHOR, 'GET', `/api/presents/${CANVAS}/poster`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    const etag = res.headers.get('etag')!;
    expect(etag).toBe(`"${CANVAS}.2"`);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PNGBYTES');
    const again = await runRoute(ANCHOR, 'GET', `/api/presents/${CANVAS}/poster`, undefined, {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
  });

  it('?meta=1 says the title and that the picture is behind the canvas', async () => {
    const res = await runRoute(ANCHOR, 'GET', `/api/presents/${CANVAS}/poster?meta=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: 'Pump deck', rev: 3, posterRev: 2, current: false });
  });

  it('a canvas the caller cannot read is a 404 in both shapes; no login is a 401', async () => {
    for (const q of ['', '?meta=1']) {
      const res = await runRoute(ANCHOR, 'GET', `/api/presents/${MISSING}/poster${q}`);
      expect(res.status, q).toBe(404);
      expect(await res.text()).not.toContain('Pump');
    }
    expect((await runRoute(null, 'GET', `/api/presents/${CANVAS}/poster`)).status).toBe(401);
  });
});

describe('GET /api/presents/:id/frame, the real frame document', () => {
  it('sends the sandbox CSP as a header, allows the embedder CSP, and carries the nonce in the prelude only', async () => {
    const ticket = tokens.buildCanvasFrameTicket({
      ownerId: ANCHOR,
      presentId: CANVAS,
      actorId: ANCHOR,
    });
    const res = await runRoute(
      null,
      'GET',
      `/api/presents/${CANVAS}/frame?t=${encodeURIComponent(ticket)}`,
    );
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain('frame-ancestors');
    expect(res.headers.get('allow-csp-from')).toBe('*');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-dns-prefetch-control')).toBe('off');
    const html = await res.text();
    const nonce = tokens.canvasFrameNonce(ticket);
    const at = html.indexOf('<html>');
    expect(html.slice(0, at)).toContain(`"n":"${nonce}"`);
    expect(html.slice(at)).toContain('THE CANVAS');
    expect(html.slice(at)).not.toContain(nonce);
  });

  it("refuses a share's ticket and a client login's ticket for a canvas", async () => {
    for (const extra of [{ shareId: 'share-1' }, { loginId: ANCHOR, clientEpoch: 1 }]) {
      const ticket = tokens.buildAppFrameTicket({
        ownerId: ANCHOR,
        appId: CANVAS,
        canvas: true,
        ...extra,
      });
      const res = await runRoute(
        null,
        'GET',
        `/api/presents/${CANVAS}/frame?t=${encodeURIComponent(ticket)}`,
      );
      expect(res.status, JSON.stringify(extra)).toBe(401);
    }
  });
});

describe('DELETE /api/presents/:id (the handler; a write through the pipeline needs a database)', () => {
  it('deletes a canvas, and answers 404 for none', async () => {
    const { DELETE } = await import('./[id]/route');
    const call = (id: string) =>
      DELETE(new Request(`http://brain.test/api/presents/${id}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id }),
      });
    const ok = await call(CANVAS);
    expect(ok.status).toBe(200);
    expect(h.deleted).toEqual([CANVAS]);
    expect((await call(MISSING)).status).toBe(404);
  });
});

describe('POST and PATCH /api/presents (the handlers): a pid canvas is saved honest', () => {
  // Two guesses drawn: a hand-typed "checked" with made-up evidence, and an
  // unchecked one, under a count that says both are checked. No sealed
  // provenance: a hand-written drawing.
  const forged = buildCanvas({
    template: 'pid',
    mode: 'import',
    data: {
      title: 'Marked',
      equipment: [{ id: 'V-101', type: 'vertical-vessel' }],
      offpage: [
        {
          id: 'OPC-1',
          direction: 'in',
          sheet: 'S1',
          check: { key: 'k1', kind: 'link', state: 'unchecked' },
        },
        {
          id: 'OPC-2',
          direction: 'out',
          sheet: 'S2',
          check: {
            key: 'k2',
            kind: 'link',
            state: 'checked',
            answer: 'yes',
            crops: ['fake-crop'],
          },
        },
      ],
      lines: [
        { from: 'OPC-1', to: 'V-101' },
        { from: 'V-101', to: 'OPC-2' },
      ],
      checks: { guesses: 2, unchecked: 0, checked: 2, unsure: 0, contradicted: 0, corrected: 0 },
    },
  });
  const own = { guesses: 2, unchecked: 2, checked: 0, unsure: 0, contradicted: 0, corrected: 0 };
  /** A traced drawing as circuit_trace seals it: one checked guess with its
   *  evidence, one unchecked, a third the provenance lists with no mark. */
  async function genuine(): Promise<string> {
    const { drawingSeal } = await import('@mantle/content/drawing-seal');
    const id = '0123456789abcdef';
    const keys = ['g1', 'g2', 'g3'];
    const sealed = (c: Record<string, unknown>) => ({
      ...c,
      sig: drawingSeal(markSealBody(id, c)),
    });
    return buildCanvas({
      template: 'pid',
      mode: 'import',
      data: {
        title: 'Traced',
        equipment: [{ id: 'V-101', type: 'vertical-vessel' }],
        offpage: [
          {
            id: 'OPC-1',
            direction: 'in',
            sheet: 'S1',
            check: sealed({ key: 'g1', kind: 'end', state: 'unchecked', guess: 'near V-9' }),
          },
          {
            id: 'OPC-2',
            direction: 'out',
            sheet: 'S2',
            check: sealed({
              key: 'g2',
              kind: 'link',
              state: 'checked',
              guess: 'on S2',
              question: 'Does it go on S2?',
              answer: 'yes',
              crops: ['crop1'],
            }),
          },
        ],
        lines: [
          { from: 'OPC-1', to: 'V-101' },
          { from: 'V-101', to: 'OPC-2' },
        ],
        checks: { guesses: 3, unchecked: 2, checked: 1, unsure: 0, contradicted: 0, corrected: 0 },
        provenance: { id, keys, sig: drawingSeal(provenanceSealBody({ id, keys })) },
      },
    });
  }
  const body = (b: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });
  const patch = async (source: string) => {
    const { PATCH } = await import('./[id]/route');
    return PATCH(
      new Request(`http://brain.test/api/presents/${CANVAS}`, {
        ...body({ source }),
        method: 'PATCH',
      }),
      { params: Promise.resolve({ id: CANVAS }) },
    );
  };
  beforeAll(() => {
    vi.stubEnv('MANTLE_MASTER_KEY', 'routes-pipeline-test-key');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('the create stores a forged mark unchecked, its evidence stripped, and the recount', async () => {
    const { POST } = await import('./route');
    const res = await POST(new Request('http://brain.test/api/presents', body({ source: forged })));
    expect(res.status).toBe(201);
    const data = readCanvasData(h.saved.at(-1)!) as {
      checks: unknown;
      offpage: { check: Record<string, unknown> }[];
    };
    expect(data.checks).toEqual(own);
    expect(data.offpage[1]!.check).toEqual({ key: 'k2', kind: 'link', state: 'unchecked' });
  });

  it('the update does the same', async () => {
    expect((await patch(forged)).status).toBe(200);
    expect(readCanvasData(h.saved.at(-1)!).checks).toEqual(own);
  });

  it('a genuine traced drawing round-trips through both, byte for byte', async () => {
    const source = await genuine();
    const { POST } = await import('./route');
    expect(
      (await POST(new Request('http://brain.test/api/presents', body({ source })))).status,
    ).toBe(201);
    expect(h.saved.at(-1)).toBe(source);
    expect((await patch(source)).status).toBe(200);
    expect(h.saved.at(-1)).toBe(source);
  });
});
