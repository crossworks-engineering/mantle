/**
 * A Chrome for the real-browser tests (the canvas and the mini-app library
 * examples): the caller's override (a test passes MANTLE_TEST_CHROME), a
 * usual install path, or puppeteer's own cache. Null when there is none; the
 * tests then skip and say so.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function findChrome(override?: string): string | null {
  const fixed = [
    override,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((p): p is string => !!p);
  const hit = fixed.find((p) => existsSync(p));
  if (hit) return hit;
  // puppeteer's own downloads: ~/.cache/puppeteer/<kind>/<version>/<platform>/<binary>
  const cache = path.join(homedir(), '.cache/puppeteer');
  for (const [kind, bin] of [
    ['chrome-headless-shell', 'chrome-headless-shell'],
    ['chrome', 'chrome'],
  ] as const) {
    const dir = path.join(cache, kind);
    if (!existsSync(dir)) continue;
    // Only directories: a download's leftover (a .zip) sits beside them.
    const subdirs = (d: string) =>
      readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    for (const version of subdirs(dir).sort().reverse()) {
      for (const platform of subdirs(path.join(dir, version))) {
        const p = path.join(dir, version, platform, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}
