/**
 * The browser sidecar's render page (audit F01). A printed page with an image
 * whose src is another site used to fetch it carrying the anchor's session,
 * because the credential rode setExtraHTTPHeaders, which Chromium sends to
 * every host. Pinned here against a stand-in browser: the credential is a
 * cookie on the print origin, never an extra header, and every request to
 * another origin is aborted, for the PDF export and both draw renders.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (req: FakeRequest) => void;

type FakeRequest = {
  url: () => string;
  isInterceptResolutionHandled: () => boolean;
  continue: () => Promise<void>;
  abort: (reason?: string) => Promise<void>;
};

const h = vi.hoisted(() => ({
  pages: [] as FakePage[],
  /** URLs the stand-in page "loads" when navigated: the print page itself
   *  plus whatever it pulls in. */
  subresources: [] as string[],
}));

type FakePage = {
  interception: boolean;
  handlers: Handler[];
  cookies: Array<Record<string, unknown>>;
  extraHeaders: Record<string, string> | null;
  continued: string[];
  aborted: string[];
};

/** Drive one request through the page's handlers, as Chromium would. */
function fire(page: FakePage, url: string): void {
  let handled = false;
  const req: FakeRequest = {
    url: () => url,
    isInterceptResolutionHandled: () => handled,
    continue: async () => {
      handled = true;
      page.continued.push(url);
    },
    abort: async () => {
      handled = true;
      page.aborted.push(url);
    },
  };
  for (const fn of page.handlers) fn(req);
}

function fakeBrowser() {
  return {
    newPage: async () => {
      const page: FakePage = {
        interception: false,
        handlers: [],
        cookies: [],
        extraHeaders: null,
        continued: [],
        aborted: [],
      };
      h.pages.push(page);
      return {
        setRequestInterception: async (on: boolean) => {
          page.interception = on;
        },
        on: (event: string, fn: Handler) => {
          if (event === 'request') page.handlers.push(fn);
        },
        browserContext: () => ({
          setCookie: async (...cookies: Array<Record<string, unknown>>) => {
            page.cookies.push(...cookies);
          },
        }),
        setExtraHTTPHeaders: async (headers: Record<string, string>) => {
          page.extraHeaders = headers;
        },
        setViewport: async () => {},
        goto: async (url: string) => {
          fire(page, url);
          for (const sub of h.subresources) fire(page, sub);
          return { ok: () => true };
        },
        waitForFunction: async () => ({ jsonValue: async () => ({ width: 10, height: 10 }) }),
        evaluate: async () => ({ svg: '<svg/>', error: null, partial: false }),
        pdf: async () => new Uint8Array([37, 80, 68, 70]),
        $: async () => ({ screenshot: async () => new Uint8Array([1]) }),
      };
    },
    disconnect: async () => {},
  };
}

vi.mock('puppeteer-core', () => ({
  default: { connect: vi.fn(async () => fakeBrowser()) },
}));

const ORIGIN = 'http://web:3000';
const saved = { origin: process.env.MANTLE_PRINT_ORIGIN, ws: process.env.BROWSER_WS_ENDPOINT };

beforeAll(() => {
  process.env.MANTLE_PRINT_ORIGIN = ORIGIN;
  process.env.BROWSER_WS_ENDPOINT = 'ws://browser:3000?token=x';
});

afterAll(() => {
  for (const [k, v] of [
    ['MANTLE_PRINT_ORIGIN', saved.origin],
    ['BROWSER_WS_ENDPOINT', saved.ws],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  h.pages.length = 0;
  h.subresources.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('isRenderRequestAllowed', () => {
  it('allows the print origin and inline data:/blob: URLs, nothing else', async () => {
    const { isRenderRequestAllowed } = await import('./render-sandbox');
    expect(isRenderRequestAllowed(`${ORIGIN}/print/pages/p1`, ORIGIN)).toBe(true);
    expect(isRenderRequestAllowed(`${ORIGIN}/api/files/files/f1?raw=1`, ORIGIN)).toBe(true);
    expect(isRenderRequestAllowed('data:image/png;base64,AAAA', ORIGIN)).toBe(true);
    expect(isRenderRequestAllowed('blob:http://web:3000/1234', ORIGIN)).toBe(true);
    for (const url of [
      'https://attacker.example/x.png',
      'http://web:3001/x.png', // another port
      'https://web:3000/x.png', // another scheme
      'http://web.attacker.example/x.png',
      'http://attacker.example/?u=http://web:3000',
      '//attacker.example/x.png', // does not parse without a base
      'ftp://web:3000/x',
    ]) {
      expect(isRenderRequestAllowed(url, ORIGIN), url).toBe(false);
    }
  });
});

describe('openRenderPage', () => {
  it('sets the render cookie on the print origin only, never as a header', async () => {
    const { openRenderPage } = await import('./render-sandbox');
    const browser = fakeBrowser();
    await openRenderPage(browser as never, 'tok.sig');
    const page = h.pages[0]!;
    expect(page.extraHeaders).toBeNull();
    expect(page.cookies).toEqual([
      {
        name: 'mantle_render',
        value: 'tok.sig',
        domain: 'web',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Strict',
      },
    ]);
  });

  it('aborts every request to another origin and lets the print origin through', async () => {
    const { openRenderPage } = await import('./render-sandbox');
    await openRenderPage(fakeBrowser() as never, 'tok.sig');
    const page = h.pages[0]!;
    expect(page.interception).toBe(true);
    fire(page, `${ORIGIN}/print/pages/p1`);
    fire(page, `${ORIGIN}/api/files/files/f1?raw=1`);
    fire(page, 'data:image/svg+xml;base64,PHN2Zy8+');
    fire(page, 'https://attacker.example/pixel.png?c=1');
    expect(page.continued).toEqual([
      `${ORIGIN}/print/pages/p1`,
      `${ORIGIN}/api/files/files/f1?raw=1`,
      'data:image/svg+xml;base64,PHN2Zy8+',
    ]);
    expect(page.aborted).toEqual(['https://attacker.example/pixel.png?c=1']);
  });

  it('leaves a request another handler already resolved alone', async () => {
    const { openRenderPage } = await import('./render-sandbox');
    await openRenderPage(fakeBrowser() as never, 'tok.sig');
    const page = h.pages[0]!;
    // A second handler that answers first: ours must not answer again.
    page.handlers.unshift((req) => void req.continue());
    fire(page, 'https://attacker.example/x.png');
    expect(page.aborted).toEqual([]);
    expect(page.continued).toEqual(['https://attacker.example/x.png']);
  });
});

describe('every sidecar render goes through the sandbox', () => {
  const outside = 'https://attacker.example/steal.png';

  it('the PDF export aborts an outside image the printed page loads', async () => {
    h.subresources.push(`${ORIGIN}/api/files/files/f1?raw=1`, outside);
    const { renderUrlToPdf } = await import('./render-pdf');
    await renderUrlToPdf(`${ORIGIN}/print/pages/p1`, 'tok.sig');
    const page = h.pages[0]!;
    expect(page.extraHeaders).toBeNull();
    expect(page.cookies.map((c) => c.name)).toEqual(['mantle_render']);
    expect(page.aborted).toEqual([outside]);
    expect(page.continued).toEqual([`${ORIGIN}/print/pages/p1`, `${ORIGIN}/api/files/files/f1?raw=1`]);
  });

  it('the draw SVG render aborts an outside request', async () => {
    h.subresources.push(outside);
    const { renderDrawSvg } = await import('./render-draw-svg');
    await renderDrawSvg('d1', 'tok.sig');
    const page = h.pages[0]!;
    expect(page.extraHeaders).toBeNull();
    expect(page.aborted).toEqual([outside]);
    expect(page.continued).toEqual([`${ORIGIN}/render/draws/d1`]);
  });

  it('the draw PNG raster aborts an outside request', async () => {
    h.subresources.push(outside);
    const { renderDrawPng } = await import('./render-draw-png');
    await renderDrawPng('d1', 'tok.sig');
    const page = h.pages[0]!;
    expect(page.extraHeaders).toBeNull();
    expect(page.aborted).toEqual([outside]);
    expect(page.continued).toEqual([`${ORIGIN}/print/draws/d1`]);
  });
});
