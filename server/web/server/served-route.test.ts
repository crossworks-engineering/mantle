/**
 * servedRoute (route-loader.ts, arch A4 step 1 fix round 1, L7): over the
 * real route manifest, the row the gate middleware finds for a request is
 * the row of the handler Hono then runs, for every route, every method it
 * is called with (HEAD included) and concrete paths whose params are the
 * values a static sibling route also uses (files, options, new, search, and
 * more): a param route must never lend its row to the static route that
 * answers, or the reverse. A method no handler exports (the 405 answer) and
 * a path no route answers find no row. No database: each route's module is
 * a stub that reports which pattern answered.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerRoutes, servedRoute, type RouteEntry } from './route-loader';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));

/** Param values a static sibling route also uses, and two plain ones. */
const PARAM_VALUES = [
  'x1',
  '11111111-1111-4111-8111-111111111111',
  'files',
  'options',
  'new',
  'search',
  'deleted',
  'export',
];

const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

describe.skipIf(!hasManifest)('servedRoute finds the row of the handler Hono runs', () => {
  let manifest: RouteEntry[];
  let app: Hono;
  /** The row the middleware found, by the raw request the handler gets. */
  const found = new WeakMap<Request, string>();

  beforeAll(async () => {
    const real = (await import('./route-manifest.gen')).routeManifest as RouteEntry[];
    manifest = real.map((e) => ({
      ...e,
      load: async () =>
        Object.fromEntries(
          e.methods.map((m) => [
            m,
            async (req: Request) =>
              new Response(null, {
                headers: { 'x-own': e.pattern, 'x-row': found.get(req) ?? 'none' },
              }),
          ]),
        ),
    }));
    app = new Hono();
    app.use('*', async (c, next) => {
      const row = servedRoute(c)?.rows.get(c.req.raw.method.toUpperCase()) ?? null;
      found.set(c.req.raw, row ? row.key : 'none');
      await next();
      c.res.headers.set('x-found', row ? row.key : 'none');
    });
    // The real rows: registerRoutes builds ROUTE_POLICY from the manifest.
    registerRoutes(app, manifest);
  });

  it('for every route, method and tricky param value', async () => {
    const mismatches: string[] = [];
    let ran = 0;
    let unanswered = 0;
    for (const e of manifest) {
      const served = [...e.methods, ...(e.methods.includes('GET') ? ['HEAD'] : [])];
      const other = ALL_METHODS.find((m) => !served.includes(m) && m !== 'OPTIONS');
      const methods = [...served, 'OPTIONS', ...(other ? [other] : [])];
      const values = e.pattern.includes(':') || e.pattern.endsWith('*') ? PARAM_VALUES : ['-'];
      for (const v of values) {
        const path = e.pattern.replace(/:[A-Za-z0-9_]+\??/g, v).replace(/\*$/, 'a/b');
        for (const m of methods) {
          const res = await app.request(path, { method: m });
          const own = res.headers.get('x-own');
          const seen = res.headers.get('x-found') ?? 'none';
          if (own) {
            ran += 1;
            const want = `${m} ${own}`;
            if (res.headers.get('x-row') !== want || seen !== want) {
              mismatches.push(`${m} ${path}: ran ${want}, row ${seen}`);
            }
          } else {
            // A 405 or OPTIONS answer of the loader, or no route: no row.
            unanswered += 1;
            if (seen !== 'none') mismatches.push(`${m} ${path}: no handler ran, row ${seen}`);
          }
        }
      }
    }
    expect(mismatches.slice(0, 30)).toEqual([]);
    expect(ran).toBeGreaterThan(2000);
    expect(unanswered).toBeGreaterThan(500);
  }, 120_000);

  it('a path no route answers finds no row', async () => {
    const res = await app.request('/api/no-such-route/at-all');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-found')).toBe('none');
  });
});
