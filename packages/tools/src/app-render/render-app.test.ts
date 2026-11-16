/**
 * app_render's renderer (sidecar.ts) in a real browser, end to end: a small
 * app built by the mini-app bundler, drawn through the host page and the
 * frame document with the frame route's CSP, its `@host` calls answered by
 * the real door (host-calls.ts) with only the database read stubbed.
 *
 * Pinned: the app gets its rows through `host.db.query`, as its person;
 * `host.db.exec` and `host.tools.call` are refused and named; the app's
 * own fetch to the bridge path never reaches it; an image from this
 * server's routes is refused (no credential, no route), and reported; the
 * picture waits for the app's ready and is not blank; an app that crashes at
 * start reports its error.
 *
 * Needs a Chrome and the built runtimes (`pnpm -C server/web build`, or its
 * `canvas-runtime`, `app-runtime` and `share-runtime` scripts). Without
 * either it skips, and says so loudly.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'puppeteer-core';
import { buildApp } from '@mantle/app-build';
import { RENDER_LAUNCH_ARGS } from '../canvas-render/sidecar';
import { findChrome } from '../canvas-render/find-chrome';

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  reads: [] as unknown[][],
}));

vi.mock('@mantle/storage', () => ({
  getContent: async (key: string) => {
    const text = h.store.get(key);
    if (text === undefined) throw new Error(`no ${key}`);
    return { body: Readable.from([Buffer.from(text)]) };
  },
}));
vi.mock('@mantle/content', () => ({ loadProfilePreferences: async () => ({}) }));
vi.mock('@mantle/db', () => ({
  asSystem: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@mantle/content/app-broker', () => ({
  appDbReadQuery: async (...args: unknown[]) => {
    h.reads.push(args);
    return { rows: [{ what: 'first row' }], empty: false };
  },
}));

import { renderApp } from './sidecar';
import { answerRenderHostCall } from './host-calls';

const ROOT = path.resolve(__dirname, '../../../..');
const PUBLIC = path.join(ROOT, 'server/web/public');
const APP_MANIFEST = path.join(PUBLIC, 'app-runtime/manifest.json');
const built = [
  APP_MANIFEST,
  path.join(PUBLIC, 'canvas-runtime/manifest.json'),
  path.join(PUBLIC, 'share-runtime/styles.css'),
].every((p) => existsSync(p));
const chrome = findChrome(process.env.MANTLE_TEST_CHROME);
if (!chrome || !built) {
  const bar = '='.repeat(72);
  console.warn(
    [
      bar,
      `APP RENDER SKIPPED: ${!chrome ? 'no Chrome found (set MANTLE_TEST_CHROME)' : 'the app, canvas and share runtimes are not built (pnpm -C server/web build)'}.`,
      'app_render was not run in a browser.',
      bar,
    ].join('\n'),
  );
}

const APP = `
import { useEffect, useState } from 'react';
import { host } from '@host';
export default function App() {
  const [rows, setRows] = useState('loading');
  useEffect(() => {
    host.db.query('SELECT what FROM t WHERE who = :host_me_id').then((r) => setRows(r[0].what), (e) => setRows('error ' + e.message));
    host.db.exec('DELETE FROM t').catch(() => {});
    host.tools.call('file_sql', { file_id: 'x' }).catch(() => {});
    try {
      fetch('/host-call', { method: 'POST', body: JSON.stringify({ kind: 'db.query', sql: 'FORGED' }) }).catch(() => {});
    } catch {}
  }, []);
  return (
    <div className="p-8">
      <h1 className="text-4xl font-bold text-foreground">Review log</h1>
      <p className="text-2xl text-foreground">{rows}</p>
      <img src="/api/files/abc/content" alt="" />
    </div>
  );
}
`;

const CRASH = `
export default function App() {
  throw new Error('the app broke on purpose');
}
`;

describe.skipIf(!chrome || !built)('app_render in a real browser', () => {
  let browser: Browser;
  let runtimeExports: Record<string, string[]>;
  const saved = process.env.BROWSER_WS_ENDPOINT;

  beforeAll(async () => {
    runtimeExports = (
      JSON.parse(readFileSync(APP_MANIFEST, 'utf8')) as { exports: Record<string, string[]> }
    ).exports;
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({
      executablePath: chrome!,
      headless: true,
      args: [
        ...RENDER_LAUNCH_ARGS,
        '--no-first-run',
        '--use-angle=swiftshader',
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ],
    });
    // A bare DevTools endpoint: the render connects to this browser as to
    // the sidecar.
    process.env.BROWSER_WS_ENDPOINT = browser.wsEndpoint();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (saved === undefined) delete process.env.BROWSER_WS_ENDPOINT;
    else process.env.BROWSER_WS_ENDPOINT = saved;
  });

  beforeEach(() => {
    h.reads = [];
  });

  async function draw(source: string, key: string) {
    const out = await buildApp(
      { entry: 'App.tsx', files: { 'App.tsx': source } },
      { runtimeExports },
    );
    expect(out.errors).toEqual([]);
    h.store.set(key, out.code!);
    h.store.set(`${key}.css`, out.css ?? '');
    const viewer = { kind: 'member' as const, loginId: 'login-1' };
    return renderApp({
      ownerId: 'owner-1',
      build: { storageKey: key, css: { storageKey: `${key}.css` } },
      viewer: { id: 'u_1', name: 'Pat', kind: 'member' },
      width: 800,
      height: 500,
      theme: 'light',
      atSeconds: 0,
      hostCall: (m) =>
        answerRenderHostCall(
          { ownerId: 'owner-1', appId: 'app-1', viewer, callerKey: 'member:login-1' },
          m,
        ),
    });
  }

  it('draws the app with its rows, refuses its writes and tools, and reaches no route', async () => {
    const res = await draw(APP, 'b1');
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.ready).toBe(true);
    // The app's own fetch to the bridge path: refused by the frame's CSP.
    expect(res.consoleErrors.join(' ')).toContain("connect-src 'none'");
    expect([...res.refused].sort()).toEqual(['db.exec', 'tool.call file_sql']);
    expect(res.hostCalls).toBe(3);
    // The one read, as its person; the app's own fetch never got here.
    expect(h.reads).toEqual([
      [
        'owner-1',
        'app-1',
        'SELECT what FROM t WHERE who = :host_me_id',
        [],
        { viewer: { kind: 'member', loginId: 'login-1' }, callerKey: 'member:login-1' },
      ],
    ]);
    expect(res.blocked).toEqual(['/api/files/abc/content']);
    expect(res.mime).toBe('image/png');
    expect(res.png.length).toBeGreaterThan(2_000);
    expect([res.width, res.height]).toEqual([800, 500]);
  }, 60_000);

  it('an app that crashes at start is drawn and reports why', async () => {
    const res = await draw(CRASH, 'b2');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.consoleErrors.join(' ')).toContain('the app broke on purpose');
    expect(h.reads).toEqual([]);
  }, 60_000);
});
