/**
 * The canvas frame document's headers (renderCanvasFrame) and a frame
 * route's refusal: neither is ever kept by a cache. The /api no-store
 * default does not reach an open link's frame (/s/:token/canvas/frame), so a
 * closed link must leave no cached copy of the canvas behind. Who may frame
 * it (frame-ancestors): only origins named, the desktop app's always. The
 * document itself is stood in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/tools/canvas-frame-document', () => ({
  canvasFrameDocument: vi.fn(async () => '<!doctype html><p>canvas</p>'),
  loadCanvasImportMap: vi.fn(async () => '{"imports":{}}'),
}));

describe('the canvas frame answers', () => {
  it('the document: private, no-store, with the sandbox CSP and no referrer', async () => {
    const { renderCanvasFrame } = await import('./canvas-frame');
    const res = await renderCanvasFrame(
      new Request('http://brain.test/s/tok/canvas/frame?t=x'),
      'owner-1',
      { source: '<p>canvas</p>', css: '', meta: { size: 'fill', theme: 'follow' } as never },
      'nonce',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('a refusal: plain text, no-store', async () => {
    const { canvasFrameRefusal } = await import('./canvas-frame');
    const res = canvasFrameRefusal(401, 'frame ticket required');
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('frame ticket required');
  });
});

describe('who may frame a canvas', () => {
  const saved = {
    client: process.env.MANTLE_CLIENT_ORIGIN,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
  };
  beforeEach(() => {
    delete process.env.MANTLE_CLIENT_ORIGIN;
    delete process.env.MANTLE_API_CORS_ORIGINS;
  });
  afterEach(() => {
    for (const [k, v] of [
      ['MANTLE_CLIENT_ORIGIN', saved.client],
      ['MANTLE_API_CORS_ORIGINS', saved.cors],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** frame-ancestors after the brain's own origin, which always leads. */
  const ancestors = async (): Promise<string[]> => {
    const { renderCanvasFrame } = await import('./canvas-frame');
    const res = await renderCanvasFrame(
      new Request('http://brain.test/api/presents/p1/frame?t=x'),
      'owner-1',
      { source: '<p>canvas</p>', css: '', meta: { size: 'fill', theme: 'follow' } as never },
      'nonce',
    );
    const csp = res.headers.get('content-security-policy') ?? '';
    const directive = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('frame-ancestors '));
    return (directive ?? '').split(' ').slice(2);
  };

  it('the desktop app and the local UIs with nothing set', async () => {
    expect(await ancestors()).toEqual([
      'mantle-ui://localhost',
      'http://127.0.0.1:*',
      'http://localhost:*',
    ]);
  });

  it('adds the client origin and the named http(s) origins; never a wildcard', async () => {
    process.env.MANTLE_CLIENT_ORIGIN = 'https://app.example.invalid/';
    process.env.MANTLE_API_CORS_ORIGINS =
      '*, https://other.example.invalid, capacitor://localhost, mantle-ui://evil';
    const list = await ancestors();
    expect(list).toEqual([
      'https://app.example.invalid',
      'https://other.example.invalid',
      'mantle-ui://localhost',
      'http://127.0.0.1:*',
      'http://localhost:*',
    ]);
    expect(list).not.toContain('*');
  });
});
