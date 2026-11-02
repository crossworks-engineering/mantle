/**
 * The canvas frame document's headers (renderCanvasFrame) and a frame
 * route's refusal: neither is ever kept by a cache. The /api no-store
 * default does not reach an open link's frame (/s/:token/canvas/frame), so a
 * closed link must leave no cached copy of the canvas behind. The document
 * itself is stood in.
 */
import { describe, expect, it, vi } from 'vitest';

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
