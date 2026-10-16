/**
 * The params gateway (A10 lows, part 2 #1; lib/route-params.ts): a route
 * file's `routeParams` holds its path segments, read by the route loader,
 * which answers the one 404 before the handler for a segment the schema
 * refuses. And every /api/v1 alias of a base route that declares one
 * re-exports it (an alias that dropped it would send a bad id on to the
 * handler again).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerRoutes, type RouteEntry } from '../server/route-loader';
import { routeParamsRefusal } from './route-params';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('routeParamsRefusal', () => {
  it('passes a route that declares nothing, and a segment of its kind', () => {
    expect(routeParamsRefusal(undefined, '/api/x/:id', { id: 'anything' })).toBeNull();
    expect(routeParamsRefusal({ id: 'uuid' }, '/api/x/:id', { id: UUID })).toBeNull();
    expect(
      routeParamsRefusal({ id: 'uuid' }, '/api/x/:id/y/:sid', { id: UUID, sid: 'not-held' }),
    ).toBeNull();
  });

  it('answers the one 404 for a segment that is not its kind', async () => {
    for (const id of ['not-a-uuid', `${UUID}x`, '', 'NULL']) {
      const res = routeParamsRefusal({ id: 'uuid' }, '/api/x/:id', { id });
      expect(res?.status, id).toBe(404);
      expect(await res!.json()).toEqual({ error: 'not found' });
      expect(res!.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('throws for a declaration that cannot hold', () => {
    expect(() => routeParamsRefusal({ sid: 'uuid' }, '/api/x/:id', { id: UUID })).toThrow(
      /names sid/,
    );
    expect(() => routeParamsRefusal({ id: 'slug' }, '/api/x/:id', { id: UUID })).toThrow(/no kind/);
    expect(() => routeParamsRefusal('uuid', '/api/x/:id', { id: UUID })).toThrow(/not an object/);
  });
});

describe('the route loader holds a route to its params', () => {
  const app = (calls: string[]) => {
    const hono = new Hono();
    const entry: RouteEntry = {
      pattern: '/api/things/:id',
      methods: ['GET', 'PATCH'],
      catchAll: null,
      catchAllOptional: false,
      load: async () => ({
        routeParams: { id: 'uuid' },
        GET: async () => {
          calls.push('GET');
          return Response.json({ ok: true });
        },
        PATCH: async (req: Request) => {
          calls.push(`PATCH ${await req.text()}`);
          return Response.json({ ok: true });
        },
      }),
    };
    registerRoutes(hono, [entry], new Map());
    return hono;
  };

  it('a segment the schema refuses is the 404, and the handler never runs', async () => {
    const calls: string[] = [];
    const hono = app(calls);
    for (const method of ['GET', 'PATCH']) {
      const res = await hono.request('/api/things/not-a-uuid', {
        method,
        ...(method === 'PATCH' ? { body: '{}' } : {}),
      });
      expect(res.status, method).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
    expect(calls).toEqual([]);
  });

  it('a segment of its kind reaches the handler', async () => {
    const calls: string[] = [];
    const hono = app(calls);
    expect((await hono.request(`/api/things/${UUID}`)).status).toBe(200);
    expect((await hono.request(`/api/things/${UUID}`, { method: 'PATCH', body: 'b' })).status).toBe(
      200,
    );
    expect(calls).toEqual(['GET', 'PATCH b']);
  });
});

describe('an /api/v1 alias re-exports its base route’s params', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const v1 = resolve(here, '../app/api/v1');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : n === 'route.ts' ? [p] : [];
    });

  it('every alias of a base that declares routeParams exports it too', () => {
    const checked: string[] = [];
    for (const file of files(v1)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
        const base = readFileSync(`${resolve(dirname(file), m[2]!)}.ts`, 'utf8');
        if (!/export const routeParams\b/.test(base)) continue;
        const names = m[1]!.split(',').map((x) => x.trim());
        expect(names, file).toContain('routeParams');
        checked.push(file);
      }
    }
    // The aliases of the A10 lows routes (contacts, tables, commit, rows).
    expect(checked.length).toBeGreaterThanOrEqual(4);
  });
});
