/**
 * The drawing PNG names its viewport to browserless as the launch default,
 * the same one it sets on the page. Without it browserless's own puppeteer
 * may give the page 800x600 at 1x after the render set 800x1000 at 2x, and
 * the picture comes out at half its sharpness (@mantle/tools/browserless).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  endpoints: [] as string[],
  viewports: [] as unknown[],
}));

vi.mock('puppeteer-core', () => ({
  default: {
    connect: vi.fn(async ({ browserWSEndpoint }: { browserWSEndpoint: string }) => {
      h.endpoints.push(browserWSEndpoint);
      return { disconnect: async () => {} };
    }),
  },
}));

vi.mock('./render-sandbox', () => ({
  printOrigin: () => 'http://web:3000',
  openRenderPage: async () => ({
    setViewport: async (v: unknown) => {
      h.viewports.push(v);
    },
    // No committed snapshot: the print route answers 404, so no picture.
    goto: async () => null,
  }),
}));

const saved = process.env.BROWSER_WS_ENDPOINT;
beforeAll(() => {
  process.env.BROWSER_WS_ENDPOINT = 'ws://browser:3000?token=x';
});
afterAll(() => {
  if (saved === undefined) delete process.env.BROWSER_WS_ENDPOINT;
  else process.env.BROWSER_WS_ENDPOINT = saved;
});

describe('renderDrawPng', () => {
  it('starts the sidecar browser with the viewport it sets on the page', async () => {
    const { renderDrawPng } = await import('./render-draw-png');
    expect(await renderDrawPng('00000000-0000-4000-8000-000000000001', 'tok.sig')).toBeNull();
    const want = { width: 800, height: 1000, deviceScaleFactor: 2 };
    const url = new URL(h.endpoints[0]!);
    expect(url.searchParams.get('token')).toBe('x');
    expect(JSON.parse(url.searchParams.get('launch')!)).toEqual({ defaultViewport: want });
    expect(h.viewports).toEqual([want]);
  });
});
