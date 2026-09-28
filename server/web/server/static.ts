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

export function mountStatic(app: Hono, publicDir: string = join(webRoot, 'public')): void {
  // serveStatic resolves `root` relative to the process CWD (which differs
  // between `pnpm -C server/web dev` and a repo-root launch) — pin it.
  const root = relative(process.cwd(), publicDir) || '.';

  // The headers go on AFTER serveStatic answers, not in its onFound hook.
  // onFound runs once the response is already built, so a c.header() there
  // only reached the wire while @hono/node-server's own Response class (which
  // kept the headers by reference) was the global. serve() stopped swapping
  // it in v0.232.263 (overrideGlobalObjects: false, a security fix), and from
  // then the runtime shipped with no ACAO:* and no Cache-Control, so a
  // sandboxed app frame (Origin: null) could not import it. Only a file that
  // was found gets them: a miss falls through to the 404, which must not be
  // marked immutable.
  app.use('/app-runtime/*', async (c, next) => {
    await next();
    if (!c.res.ok) return;
    c.header('Access-Control-Allow-Origin', '*');
    c.header(
      'Cache-Control',
      c.req.path.endsWith('manifest.json') ? 'no-cache' : 'public, max-age=31536000, immutable',
    );
  });
  app.use('/app-runtime/*', serveStatic({ root }));
  // Explicit prefixes only — a catch-all serveStatic would stat the filesystem
  // on every API request. share-runtime/ is the /s island bundle (H2).
  // excalidraw-assets/ is the drawing fonts the draw render surface
  // (/render/draws) inlines into a snapshot; `generate` copies them in. Never
  // mounted before, so every render fell back to the Excalidraw CDN, which the
  // render surface's CSP and the sidecar's request interception now refuse
  // (audit F01): without this a snapshot's text lost its font.
  for (const prefix of ['/share-runtime/*', '/fonts/*', '/Inter/*', '/excalidraw-assets/*']) {
    app.use(prefix, serveStatic({ root }));
  }
  for (const file of ['/favicon.ico', '/apple-icon.png', '/icon.svg']) {
    app.use(file, serveStatic({ root }));
  }
}

/** Next (trailingSlash:false) 308-redirected `/api/x/` → `/api/x`; Hono has no
 *  such normalization, so without this external callers with trailing slashes
 *  would 404 (parity fix from the v0.202.0 audit). Mounted before everything. */
export function trailingSlashRedirect() {
  return async (
    c: { req: { url: string; method: string }; redirect: (to: string, s: 308) => Response },
    next: () => Promise<void>,
  ) => {
    const url = new URL(c.req.url);
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      return c.redirect(url.pathname.replace(/\/+$/, '') + url.search, 308);
    }
    await next();
  };
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
