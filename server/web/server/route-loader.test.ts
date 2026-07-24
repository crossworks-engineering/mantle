import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerRoutes, type RouteEntry } from './route-loader';

type Params = Record<string, string | string[]>;

/** A handler that echoes its resolved params + method, for assertion. */
function echo(method: string) {
  return async (_req: Request, ctx: { params: Promise<Params> }) =>
    Response.json({ method, params: await ctx.params });
}

function entry(partial: Partial<RouteEntry> & Pick<RouteEntry, 'pattern' | 'load'>): RouteEntry {
  return { methods: ['GET'], catchAll: null, catchAllOptional: false, ...partial };
}

describe('route loader', () => {
  it('maps [id] params (decoded) and passes them as a Promise', async () => {
    const app = new Hono();
    registerRoutes(app, [
      entry({
        pattern: '/api/tables/:id/export',
        load: async () => ({ GET: echo('GET') }),
      }),
    ]);
    const res = await app.request('/api/tables/ab%20c/export');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: 'GET', params: { id: 'ab c' } });
  });

  it('registers multiple methods on one pattern', async () => {
    const app = new Hono();
    registerRoutes(app, [
      entry({
        pattern: '/api/notes',
        methods: ['GET', 'POST'],
        load: async () => ({ GET: echo('GET'), POST: echo('POST') }),
      }),
    ]);
    expect((await (await app.request('/api/notes')).json()).method).toBe('GET');
    expect((await (await app.request('/api/notes', { method: 'POST' })).json()).method).toBe(
      'POST',
    );
  });

  it('static beats :param when registered in manifest order (Next precedence)', async () => {
    const app = new Hono();
    registerRoutes(app, [
      entry({ pattern: '/api/files/files', load: async () => ({ GET: echo('list') }) }),
      entry({ pattern: '/api/files/:id', load: async () => ({ GET: echo('byId') }) }),
    ]);
    expect((await (await app.request('/api/files/files')).json()).method).toBe('list');
    expect((await (await app.request('/api/files/abc')).json()).method).toBe('byId');
  });

  it('catch-all [...rest] yields decoded string[] segments', async () => {
    const app = new Hono();
    registerRoutes(app, [
      entry({
        pattern: '/team/*',
        catchAll: 'rest',
        load: async () => ({ GET: echo('GET') }),
      }),
    ]);
    const res = await app.request('/team/forum/topic%201/x');
    expect((await res.json()).params).toEqual({ rest: ['forum', 'topic 1', 'x'] });
  });

  it('optional catch-all [[...rest]] also matches the bare prefix', async () => {
    const app = new Hono();
    registerRoutes(app, [
      entry({
        pattern: '/team/*',
        catchAll: 'rest',
        catchAllOptional: true,
        load: async () => ({ GET: echo('GET') }),
      }),
    ]);
    expect((await (await app.request('/team')).json()).params).toEqual({});
    expect((await (await app.request('/team/a/b')).json()).params).toEqual({ rest: ['a', 'b'] });
  });

  it('required catch-all [...rest] does NOT match the bare prefix (Next parity)', async () => {
    const app = new Hono();
    registerRoutes(app, [
      entry({
        pattern: '/files/*',
        catchAll: 'rest',
        load: async () => ({ GET: echo('GET') }),
      }),
    ]);
    expect((await app.request('/files')).status).toBe(404);
    expect((await app.request('/files/a')).status).toBe(200);
  });

  it('answers 405 when the module lacks the method export', async () => {
    const app = new Hono();
    registerRoutes(app, [
      entry({
        pattern: '/api/only-get',
        methods: ['GET', 'POST'], // manifest overclaims; module has GET only
        load: async () => ({ GET: echo('GET') }),
      }),
    ]);
    expect((await app.request('/api/only-get', { method: 'POST' })).status).toBe(405);
  });

  it('memoizes the module load and retries after a rejection', async () => {
    const load = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ GET: echo('GET') });
    const app = new Hono();
    app.onError((err) => Response.json({ error: err.message }, { status: 500 }));
    registerRoutes(app, [entry({ pattern: '/api/x', load })]);

    expect((await app.request('/api/x')).status).toBe(500);
    expect((await app.request('/api/x')).status).toBe(200);
    expect((await app.request('/api/x')).status).toBe(200);
    expect(load).toHaveBeenCalledTimes(2); // 1 failure + 1 success, then cached
  });

  it('passes the raw Request through untouched (body, headers, url)', async () => {
    const app = new Hono();
    registerRoutes(app, [
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
    ]);
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
});
