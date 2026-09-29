import { Hono } from 'hono';
import { BodyTooLargeError, bodyTooLargeResponse } from '../lib/body-limit';
import { RedirectError } from './http-compat/redirect-error';
import { levelConflictResponse } from './level-conflict';
import { gate } from './middleware/gate';
import { registerRoutes } from './route-loader';
import { mountRedirects, mountStatic, trailingSlashRedirect } from './static';
import { mountRetiredTeamPages } from './pages/stubs';

/**
 * The server/web HTTP app. Layering (first match wins):
 *   legacy + retired-page redirects → static assets → auth/CORS gate →
 *   app/** route handlers
 *   → render surfaces (/s, /print, stubs — mounted by server/pages, H2).
 */
export async function createApp(): Promise<Hono> {
  const app = new Hono();

  app.use('*', trailingSlashRedirect());
  mountRedirects(app);
  // The retired team-code pages (/team, /hub) redirect to /login, gate or not.
  mountRetiredTeamPages(app);
  mountStatic(app);
  app.use('*', gate());

  // The generated manifest is imported lazily so `createApp` stays importable
  // in unit tests without a generation step having run.
  const { routeManifest } = await import('./route-manifest.gen');
  registerRoutes(app, routeManifest);

  // Render surfaces (after the API routes: /s/:token must not shadow the
  // /s/:token/* brokers registered from the manifest).
  const [{ mountShare }, { mountPrint }, { mountStubs }] = await Promise.all([
    import('./pages/share'),
    import('./pages/print'),
    import('./pages/stubs'),
  ]);
  mountShare(app);
  mountPrint(app);
  mountStubs(app);

  // NOTE: notFound + onError run OUTSIDE the gate's ALS frame (Hono's compose
  // catches thrown errors after store.run unwinds) — never call the ambient
  // cookies()/headers() shims from these two handlers; they would throw
  // "outside a request scope". Use c.req.raw directly if request data is
  // ever needed here.
  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    if (path === '/api' || path.startsWith('/api/')) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    return c.text('Not found', 404);
  });

  app.onError((err, c) => {
    if (err instanceof RedirectError) {
      return c.redirect(err.location, err.status);
    }
    const path = new URL(c.req.url).pathname;
    // A client scope meeting public-level work (or the reverse): a refusal,
    // not a crash (client logins, audit A5).
    const refused = levelConflictResponse(err, path);
    if (refused) return refused;
    // A JSON body over its route's ceiling, found while reading (I4).
    if (err instanceof BodyTooLargeError) return bodyTooLargeResponse(err.maxBytes);
    console.error(`[server] unhandled error on ${c.req.method} ${path}:`, err);
    if (path === '/api' || path.startsWith('/api/')) {
      // Body matches Next's opaque route-handler failure: no error details leak.
      return Response.json({ error: 'internal error' }, { status: 500 });
    }
    return c.text('Internal server error', 500);
  });

  return app;
}
