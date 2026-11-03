/**
 * The launch options a render names to browserless. The viewport rides in
 * the launch as its default, or browserless's own puppeteer may give the
 * render's page 800x600 after the render set its size (browserless.ts).
 */
import { describe, expect, it } from 'vitest';
import { browserlessEndpoint, isBareDevtoolsEndpoint } from './browserless';

const VIEW = { width: 800, height: 1000, deviceScaleFactor: 2 };

const launchOf = (url: string) => JSON.parse(new URL(url).searchParams.get('launch')!) as unknown;

describe('browserlessEndpoint', () => {
  it('names the viewport as the launch default and keeps the token', () => {
    const url = browserlessEndpoint('ws://browser:3000?token=x', { defaultViewport: VIEW });
    expect(new URL(url).searchParams.get('token')).toBe('x');
    expect(launchOf(url)).toEqual({ defaultViewport: VIEW });
  });

  it('carries the flags when the render names them', () => {
    const url = browserlessEndpoint('ws://browser:3000?token=x', {
      args: ['--dns-prefetch-disable'],
      defaultViewport: VIEW,
    });
    expect(launchOf(url)).toEqual({ args: ['--dns-prefetch-disable'], defaultViewport: VIEW });
  });

  it('replaces a launch already in the URL', () => {
    const url = browserlessEndpoint('ws://browser:3000?token=x&launch=%7B%7D', {
      defaultViewport: VIEW,
    });
    expect(new URL(url).searchParams.getAll('launch')).toHaveLength(1);
    expect(launchOf(url)).toEqual({ defaultViewport: VIEW });
  });

  it('leaves a bare DevTools endpoint as it is', () => {
    const raw = 'ws://127.0.0.1:9222/devtools/browser/abc';
    expect(isBareDevtoolsEndpoint(raw)).toBe(true);
    expect(browserlessEndpoint(raw, { defaultViewport: VIEW })).toBe(raw);
  });
});
