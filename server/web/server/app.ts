import { Hono } from 'hono';
import { RedirectError } from './http-compat/redirect-error';
import { gate } from './middleware/gate';
import { registerRoutes } from './route-loader';
import { mountRedirects, mountStatic } from './static';

/**
 * The server/web HTTP app. Layering (first match wins):
 *   legacy redirects → static assets → auth/CORS gate → app/** route handlers
 *   → render surfaces (/s, /print, stubs — mounted by server/pages, H2).
 */
export async function createApp(): Promise<Hono> {
  const app = new Hono();

  mountRedirects(app);
  mountStatic(app);
  app.use('*', gate());

  // The generated manifest is imported lazily so `createApp` stays importable
  // in unit tests without a generation step having run.
  const { routeManifest } = await import('./route-manifest.gen');
  registerRoutes(app, routeManifest);

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
    console.error(`[server] unhandled error on ${c.req.method} ${path}:`, err);
    if (path === '/api' || path.startsWith('/api/')) {
      // Body matches Next's opaque route-handler failure: no error details leak.
      return Response.json({ error: 'internal error' }, { status: 500 });
    }
    return c.text('Internal server error', 500);
  });

  return app;
}
