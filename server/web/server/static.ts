import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static layer: serves public/ (fonts, Inter, app-runtime, share-runtime)
 * before the auth gate — these are library assets with no user data, and the
 * sandboxed app iframes + the /s share surface must load them cookie-less.
 *
 * Reproduces next.config's two header rules for the mini-app runtime:
 * content-hashed runtime modules are immutable + CORS-open (opaque-origin
 * iframe fetches send Origin: null), the manifest always revalidates.
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function mountStatic(app: Hono): void {
  // serveStatic resolves `root` relative to the process CWD (which differs
  // between `pnpm -C server/web dev` and a repo-root launch) — pin it.
  const root = relative(process.cwd(), join(webRoot, 'public')) || '.';

  app.use(
    '/app-runtime/*',
    serveStatic({
      root,
      onFound: (path, c) => {
        c.header('Access-Control-Allow-Origin', '*');
        c.header(
          'Cache-Control',
          path.endsWith('manifest.json') ? 'no-cache' : 'public, max-age=31536000, immutable',
        );
      },
    }),
  );
  // Explicit prefixes only — a catch-all serveStatic would stat the filesystem
  // on every API request. share-runtime/ is the /s island bundle (H2).
  for (const prefix of ['/share-runtime/*', '/fonts/*', '/Inter/*']) {
    app.use(prefix, serveStatic({ root }));
  }
  for (const file of ['/favicon.ico', '/apple-icon.png', '/icon.svg']) {
    app.use(file, serveStatic({ root }));
  }
}

/** Legacy screen renames — old bookmarks/deep-links keep working; query params
 *  pass through (ported from next.config redirects(), permanent = 308). */
const REDIRECTS: ReadonlyArray<readonly [string, string]> = [
  ['/lifelog', '/journal'],
  ['/memories', '/journal'],
  ['/todos', '/tasks'],
];

export function mountRedirects(app: Hono): void {
  for (const [source, destination] of REDIRECTS) {
    app.get(source, (c) => {
      const url = new URL(c.req.url);
      return c.redirect(destination + url.search, 308);
    });
  }
}
