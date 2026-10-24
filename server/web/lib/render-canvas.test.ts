/**
 * The canvas render (render-canvas.ts) against a stand-in browser. What is
 * pinned: the sidecar's browser starts with no name resolution, a dead
 * proxy and no direct WebRTC UDP; WebRTC is removed in every frame before a
 * canvas script runs; the frame answer carries the CSP and DNS prefetch off;
 * only files under the served public prefixes answer, anything else is
 * refused and reported; what the canvas prints is capped while it is
 * gathered; the page is always closed; a full queue refuses at once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Responded = { url: string; status: number; headers: Record<string, string> };
type Req = {
  url: () => string;
  isInterceptResolutionHandled: () => boolean;
  continue: () => Promise<void>;
  abort: (r?: string) => Promise<void>;
  respond: (o: { status: number; headers?: Record<string, string> }) => Promise<void>;
};

const h = vi.hoisted(() => ({
  endpoints: [] as string[],
  initScripts: [] as string[],
  responded: [] as Responded[],
  aborted: [] as string[],
  closed: 0,
  /** URLs the page asks for after the frame. */
  subresources: [] as string[],
  /** console.error lines the canvas prints. */
  consoleLines: 0,
  /** Hold every goto until released (to fill the queue). */
  hold: null as Promise<void> | null,
  /** What `window.diagram` hands back (the page's evaluate). */
  report: null as unknown,
}));

function fire(handlers: Array<(r: Req) => void>, url: string): Promise<void> {
  return new Promise((resolve) => {
    let handled = false;
    const req: Req = {
      url: () => url,
      isInterceptResolutionHandled: () => handled,
      continue: async () => {
        handled = true;
        resolve();
      },
      abort: async () => {
        handled = true;
        h.aborted.push(url);
        resolve();
      },
      respond: async (o) => {
        handled = true;
        h.responded.push({ url, status: o.status, headers: o.headers ?? {} });
        resolve();
      },
    };
    for (const fn of handlers) fn(req);
  });
}

vi.mock('puppeteer-core', () => ({
  default: {
    connect: vi.fn(async ({ browserWSEndpoint }: { browserWSEndpoint: string }) => {
      h.endpoints.push(browserWSEndpoint);
      return {
        newPage: async () => {
          const handlers: Array<(r: Req) => void> = [];
          const consoleFns: Array<(m: { type: () => string; text: () => string }) => void> = [];
          return {
            evaluateOnNewDocument: async (src: string) => {
              h.initScripts.push(src);
            },
            setViewport: async () => {},
            setRequestInterception: async () => {},
            on: (event: string, fn: never) => {
              if (event === 'request') handlers.push(fn);
              if (event === 'console') consoleFns.push(fn);
            },
            goto: async (url: string) => {
              if (h.hold) await h.hold;
              await fire(handlers, url);
              for (const sub of h.subresources) await fire(handlers, sub);
              for (let i = 0; i < h.consoleLines; i++) {
                for (const fn of consoleFns)
                  fn({ type: () => 'error', text: () => 'x'.repeat(900) });
              }
            },
            focus: async () => {},
            keyboard: { press: async () => {} },
            evaluate: async () => (h.report === null ? null : JSON.stringify(h.report)),
            screenshot: async () => new Uint8Array([137, 80, 78, 71]),
            createCDPSession: async () => ({ send: async () => ({}) }),
            close: async () => {
              h.closed++;
            },
          };
        },
        disconnect: async () => {},
      };
    }),
  },
}));

vi.mock('./canvas-frame', () => ({
  canvasFrameDocument: async () => '<!doctype html><title>x</title>',
}));

const saved = process.env.BROWSER_WS_ENDPOINT;
beforeAll(() => {
  process.env.BROWSER_WS_ENDPOINT = 'ws://browser:3000?token=x';
});
afterAll(() => {
  if (saved === undefined) delete process.env.BROWSER_WS_ENDPOINT;
  else process.env.BROWSER_WS_ENDPOINT = saved;
});

beforeEach(() => {
  h.endpoints.length = 0;
  h.initScripts.length = 0;
  h.responded.length = 0;
  h.aborted.length = 0;
  h.subresources.length = 0;
  h.closed = 0;
  h.consoleLines = 0;
  h.hold = null;
  h.report = null;
});

const REQ = {
  ownerId: 'anchor',
  canvas: {
    source: '<!doctype html><title>x</title>',
    css: '',
    meta: {
      size: { w: 800, h: 600 },
      theme: 'follow' as const,
      libs: [],
      scripts: [],
      posterAt: null,
    },
  },
  atSeconds: 0,
};

describe('renderCanvas', () => {
  it('starts the sidecar browser locked: no DNS, a dead proxy, no direct WebRTC UDP', async () => {
    const { renderCanvas, RENDER_LAUNCH_ARGS } = await import('./render-canvas');
    const out = await renderCanvas(REQ);
    expect(out.ok).toBe(true);
    const url = new URL(h.endpoints[0]!);
    expect(url.searchParams.get('token')).toBe('x');
    const launch = JSON.parse(url.searchParams.get('launch')!) as { args: string[] };
    expect(launch.args).toEqual([...RENDER_LAUNCH_ARGS]);
    expect(launch.args.join(' ')).toMatch(/host-resolver-rules=MAP \* ~NOTFOUND/);
    expect(launch.args.join(' ')).toMatch(/proxy-bypass-list=<-loopback>/);
    expect(launch.args.join(' ')).toMatch(/disable_non_proxied_udp/);
  });

  it('leaves a bare DevTools endpoint as it is', async () => {
    const { lockedEndpoint } = await import('./render-canvas');
    const raw = 'ws://127.0.0.1:9222/devtools/browser/abc';
    expect(lockedEndpoint(raw)).toBe(raw);
  });

  it('removes WebRTC in every frame before any canvas script', async () => {
    const { renderCanvas } = await import('./render-canvas');
    await renderCanvas(REQ);
    expect(h.initScripts).toHaveLength(1);
    expect(h.initScripts[0]).toContain('RTCPeerConnection');
    expect(h.initScripts[0]).toContain('__mantleProbe');
  });

  it('answers the frame with the CSP and DNS prefetch off; serves public files only', async () => {
    const { renderCanvas, RENDER_ORIGIN } = await import('./render-canvas');
    h.subresources.push(
      `${RENDER_ORIGIN}/canvas-runtime/manifest.json`,
      `${RENDER_ORIGIN}/canvas-runtime/%2e%2e/%2e%2e/package.json`,
      `${RENDER_ORIGIN}/api/presents`,
      'http://169.254.169.254/latest/meta-data',
    );
    const out = await renderCanvas(REQ);
    const frame = h.responded.find((r) => r.url.endsWith('/frame'))!;
    expect(frame.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(frame.headers['x-dns-prefetch-control']).toBe('off');
    // The runtime manifest is a public file only when it was built.
    expect(h.aborted).toContain(`${RENDER_ORIGIN}/api/presents`);
    expect(h.aborted).toContain('http://169.254.169.254/latest/meta-data');
    expect(h.aborted).toContain(`${RENDER_ORIGIN}/canvas-runtime/%2e%2e/%2e%2e/package.json`);
    expect(out.ok && out.blocked).toEqual(
      expect.arrayContaining(['/api/presents', 'http://169.254.169.254']),
    );
    expect(h.closed).toBe(1);
  });

  it('caps what the canvas prints while it is gathered', async () => {
    const { renderCanvas } = await import('./render-canvas');
    h.consoleLines = 5000;
    const out = await renderCanvas(REQ);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.consoleErrors.length).toBeLessThanOrEqual(20);
    expect(out.consoleErrors.every((l) => l.length <= 300)).toBe(true);
  });

  it('caps what the canvas says about itself on this side, whatever its page did', async () => {
    const { renderCanvas } = await import('./render-canvas');
    const stats: Record<string, unknown> = { ok: 1, bad: 'x' };
    for (let i = 0; i < 500; i++) stats[`k${i}${'y'.repeat(100)}`] = i;
    h.report = {
      ok: true,
      errors: Array.from({ length: 10_000 }, () => 'e'.repeat(5000)),
      warnings: [{ toString: () => 'w' }, 'fine'],
      stats,
      svg: 'x'.repeat(4_000_000),
    };
    const out = await renderCanvas(REQ);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const d = out.diagram!;
    expect(d.errors).toHaveLength(50);
    expect(d.errors.every((e) => e.length <= 300)).toBe(true);
    expect(d.warnings).toEqual(['', 'fine']);
    expect(Object.keys(d.stats).length).toBeLessThanOrEqual(50);
    expect(Object.keys(d.stats).every((k) => k.length <= 40)).toBe(true);
    expect(d.stats.bad).toBeUndefined();
    expect(d.svg).toBeUndefined();
  });

  it('the diagram probe is plain JavaScript a page runs as it is, on the kept built-ins', async () => {
    const { runInNewContext, createContext } = await import('node:vm');
    const { diagramProbe, RENDER_INIT } = await import('./render-canvas');
    const src = diagramProbe(true, 2, 5, 100);
    // No TypeScript helper a runner might add (the page has none).
    expect(src).not.toContain('__name');
    expect(RENDER_INIT).not.toContain('__name');
    const window: Record<string, unknown> = {};
    const ctx = createContext({
      window,
      console: { error() {}, warn() {}, log() {}, info() {}, debug() {} },
      addEventListener() {},
    });
    runInNewContext(RENDER_INIT, ctx);
    // The canvas replaces the built-ins after the init ran: the probe holds.
    runInNewContext(
      "Array.prototype.slice = () => { throw new Error('x') }; String.prototype.slice = () => 'y'.repeat(1e6); JSON.stringify = () => 'z';",
      ctx,
    );
    window.diagram = {
      ready: Promise.resolve({ ok: true, warnings: ['abcdefgh', 'b', 'c'], stats: { n: 3 } }),
      exportSvg: () => '<svg/>',
    };
    const text = await runInNewContext(src, ctx);
    expect(JSON.parse(text as string)).toEqual({
      ok: true,
      errors: [],
      warnings: ['abcde', 'b'],
      stats: { n: 3 },
      svg: '<svg/>',
    });
    window.diagram = undefined;
    expect(await runInNewContext(src, ctx)).toBeNull();
  });

  it('refuses at once when the queue is full, and the slots come back', async () => {
    const { renderCanvas } = await import('./render-canvas');
    let release!: () => void;
    h.hold = new Promise<void>((r) => (release = r));
    const running = Array.from({ length: 8 }, () => renderCanvas(REQ));
    await new Promise((r) => setTimeout(r, 20));
    const refused = await renderCanvas(REQ);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatch(/busy/);
    release();
    const all = await Promise.all(running);
    expect(all.every((r) => r.ok)).toBe(true);
    h.hold = null;
    expect((await renderCanvas(REQ)).ok).toBe(true);
  });
});
