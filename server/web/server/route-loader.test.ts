import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { buildRouteRow } from '../lib/auth/route-policy';
import { registerPages, registerRoutes, type RouteEntry } from './route-loader';

type Params = Record<string, string | string[]>;

/** A handler that echoes its resolved params + method, for assertion. */
function echo(method: string) {
  return async (_req: Request, ctx: { params: Promise<Params> }) =>
    Response.json({ method, params: await ctx.params });
}

/** These routes are the loader's, not the app's: no ROUTE_POLICY rows (the
 *  table and the gate are pinned by route-policy.test.ts and the sweeps). */
const NO_POLICY = new Map();

function entry(partial: Partial<RouteEntry> & Pick<RouteEntry, 'pattern' | 'load'>): RouteEntry {
  return { methods: ['GET'], catchAll: null, catchAllOptional: false, ...partial };
}

describe('route loader', () => {
  it('maps [id] params (decoded) and passes them as a Promise', async () => {
    const app = new Hono();
    registerRoutes(
      app,
      [
        entry({
          pattern: '/api/tables/:id/export',
          load: async () => ({ GET: echo('GET') }),
        }),
      ],
      NO_POLICY,
    );
    const res = await app.request('/api/tables/ab%20c/export');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: 'GET', params: { id: 'ab c' } });
  });

  it('registers multiple methods on one pattern', async () => {
    const app = new Hono();
    registerRoutes(
      app,
      [
        entry({
          pattern: '/api/notes',
          methods: ['GET', 'POST'],
          load: async () => ({ GET: echo('GET'), POST: echo('POST') }),
        }),
      ],
      NO_POLICY,
    );
    expect((await (await app.request('/api/notes')).json()).method).toBe('GET');
    expect((await (await app.request('/api/notes', { method: 'POST' })).json()).method).toBe(
      'POST',
    );
  });

  it('static beats :param when registered in manifest order (Next precedence)', async () => {
    const app = new Hono();
    registerRoutes(
      app,
      [
        entry({ pattern: '/api/files/files', load: async () => ({ GET: echo('list') }) }),
        entry({ pattern: '/api/files/:id', load: async () => ({ GET: echo('byId') }) }),
      ],
      NO_POLICY,
    );
    expect((await (await app.request('/api/files/files')).json()).method).toBe('list');
    expect((await (await app.request('/api/files/abc')).json()).method).toBe('byId');
  });

  it('catch-all [...rest] yields decoded string[] segments', async () => {
    const app = new Hono();
    registerRoutes(
      app,
      [
        entry({
          pattern: '/wiki/*',
          catchAll: 'rest',
          load: async () => ({ GET: echo('GET') }),
        }),
      ],
      NO_POLICY,
    );
    const res = await app.request('/wiki/forum/topic%201/x');
    expect((await res.json()).params).toEqual({ rest: ['forum', 'topic 1', 'x'] });
  });

  it('optional catch-all [[...rest]] also matches the bare prefix', async () => {
    const app = new Hono();
    registerRoutes(
      app,
      [
        entry({
          pattern: '/wiki/*',
          catchAll: 'rest',
          catchAllOptional: true,
          load: async () => ({ GET: echo('GET') }),
        }),
      ],
      NO_POLICY,
    );
    expect((await (await app.request('/wiki')).json()).params).toEqual({});
    expect((await (await app.request('/wiki/a/b')).json()).params).toEqual({ rest: ['a', 'b'] });
  });

  it('required catch-all [...rest] does NOT match the bare prefix (Next parity)', async () => {
    const app = new Hono();
    registerRoutes(
      app,
      [
        entry({
          pattern: '/files/*',
          catchAll: 'rest',
          load: async () => ({ GET: echo('GET') }),
        }),
      ],
      NO_POLICY,
    );
    expect((await app.request('/files')).status).toBe(404);
    expect((await app.request('/files/a')).status).toBe(200);
  });

  it('unexported methods get 405 + Allow; bare OPTIONS gets 204 + Allow (Next parity)', async () => {
    const app = new Hono();
    registerRoutes(
      app,
      [
        entry({
          pattern: '/api/notes',
          methods: ['GET', 'POST'],
          load: async () => ({ GET: echo('GET'), POST: echo('POST') }),
        }),
      ],
      NO_POLICY,
    );
    const res = await app.request('/api/notes', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST, HEAD, OPTIONS');
    const opt = await app.request('/api/notes', { method: 'OPTIONS' });
    expect(opt.status).toBe(204);
    expect(opt.headers.get('allow')).toBe('GET, POST, HEAD, OPTIONS');
    // Registered methods still win over the fallback.
    expect((await app.request('/api/notes')).status).toBe(200);
  });

  it('the 405 fallback does not shadow overlapping dynamic patterns', async () => {
    const app = new Hono();
    registerRoutes(
      app,
      [
        entry({ pattern: '/api/agents/options', load: async () => ({ GET: echo('options') }) }),
        entry({
          pattern: '/api/agents/:id',
          methods: ['PATCH', 'DELETE'],
          load: async () => ({ PATCH: echo('patch'), DELETE: echo('del') }),
        }),
      ],
      NO_POLICY,
    );
    // Dynamic route's own methods work…
    expect((await app.request('/api/agents/xyz', { method: 'DELETE' })).status).toBe(200);
    // …the static path 405s methods it doesn't export (Next would too — the
    // options route file wins the path match)…
    expect((await app.request('/api/agents/options', { method: 'DELETE' })).status).toBe(405);
    // …and unmatched methods on the dynamic path 405 with its Allow set.
    const res = await app.request('/api/agents/xyz', { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('PATCH, DELETE, OPTIONS');
  });

  it('answers 405 when the module lacks the method export', async () => {
    const app = new Hono();
    registerRoutes(
      app,
      [
        entry({
          pattern: '/api/only-get',
          methods: ['GET', 'POST'], // manifest overclaims; module has GET only
          load: async () => ({ GET: echo('GET') }),
        }),
      ],
      NO_POLICY,
    );
    expect((await app.request('/api/only-get', { method: 'POST' })).status).toBe(405);
  });

  it('memoizes the module load and retries after a rejection', async () => {
    const load = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ GET: echo('GET') });
    const app = new Hono();
    app.onError((err) => Response.json({ error: err.message }, { status: 500 }));
    registerRoutes(app, [entry({ pattern: '/api/x', load })], NO_POLICY);

    expect((await app.request('/api/x')).status).toBe(500);
    expect((await app.request('/api/x')).status).toBe(200);
    expect((await app.request('/api/x')).status).toBe(200);
    expect(load).toHaveBeenCalledTimes(2); // 1 failure + 1 success, then cached
  });

  it('passes the raw Request through untouched (body, headers, url)', async () => {
    const app = new Hono();
    registerRoutes(
      app,
      [
        entry({
          pattern: '/api/echo',
          methods: ['POST'],
          load: async () => ({
            POST: async (req: Request) =>
              Response.json({
                url: req.url,
                body: await req.json(),
                ua: req.headers.get('user-agent'),
              }),
          }),
        }),
      ],
      NO_POLICY,
    );
    const res = await app.request('/api/echo?q=1', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
    });
    const out = await res.json();
    expect(out.url).toContain('/api/echo?q=1');
    expect(out.body).toEqual({ a: 1 });
    expect(out.ua).toBe('vitest');
  });

  // The gate's spelling test (spellsPattern) cannot spell an optional
  // param. Each pattern's matcher is compiled when its rows are built and
  // when the loader registers it, so such a pattern fails at boot, never as
  // a 500 on each request (A4 step 2 audit L5).
  it('a pattern the spelling test cannot spell fails at registration, not per request', async () => {
    const optional = '/api/notes/:id?';
    expect(() => buildRouteRow('GET', optional)).toThrow(/optional param/);
    // No rows handed in (NO_POLICY): the loader's own compile refuses it.
    expect(() =>
      registerRoutes(
        new Hono(),
        [entry({ pattern: optional, load: async () => ({ GET: echo('GET') }) })],
        NO_POLICY,
      ),
    ).toThrow(/optional param/);
    expect(() =>
      registerPages(
        new Hono(),
        [{ pattern: '/s/:token?', methods: ['GET'], handle: () => new Response(null) }],
        'link',
        NO_POLICY,
      ),
    ).toThrow(/optional param/);
    // A pattern it spells registers, and its requests run as before.
    const app = new Hono();
    registerRoutes(
      app,
      [entry({ pattern: '/api/notes/:id', load: async () => ({ GET: echo('GET') }) })],
      NO_POLICY,
    );
    expect((await app.request('/api/notes/n1')).status).toBe(200);
  });
});
