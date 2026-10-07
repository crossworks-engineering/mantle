/**
 * The public API v1 table (lib/api-v1.ts) against the route files, and the
 * scope rule an API key is held to. No database.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCESS_KEY_AREAS } from './access-keys';
import { API_V1_ROUTES, keyMayCall, matchApiV1Route } from './api-v1';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', 'server', 'route-manifest.gen.ts');

describe('public API v1 table', () => {
  it.skipIf(!existsSync(manifestPath))(
    'lists every /api/v1 route file method once, and nothing else',
    async () => {
      const { routeManifest } = await import('../server/route-manifest.gen');
      const files = routeManifest
        .filter((e) => e.pattern === '/api/v1' || e.pattern.startsWith('/api/v1/'))
        .flatMap((e) => e.methods.map((m) => `${m} ${e.pattern}`))
        .sort();
      const table = API_V1_ROUTES.map((r) => `${r.method} ${r.pattern}`).sort();
      expect(new Set(table).size).toBe(table.length);
      expect(table).toEqual(files);
    },
  );

  it('names only known areas, and a read for every GET', () => {
    for (const r of API_V1_ROUTES) {
      if (r.area !== null) expect(ACCESS_KEY_AREAS).toContain(r.area);
      if (r.method === 'GET') expect(r.access, `${r.method} ${r.pattern}`).toBe('read');
      else expect(r.access, `${r.method} ${r.pattern}`).toBe('write');
    }
  });

  it('matches a request to its route', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(matchApiV1Route('GET', `/api/v1/pages/${id}`)?.pattern).toBe('/api/v1/pages/:id');
    expect(matchApiV1Route('HEAD', `/api/v1/pages/${id}`)?.pattern).toBe('/api/v1/pages/:id');
    expect(matchApiV1Route('PATCH', `/api/v1/pages/${id}`)?.access).toBe('write');
    expect(matchApiV1Route('DELETE', `/api/v1/pages/${id}`)).toBeNull();
    expect(matchApiV1Route('GET', `/api/v1/pages/${id}/extra`)).toBeNull();
    expect(matchApiV1Route('GET', '/api/v1/settings')).toBeNull();
    expect(matchApiV1Route('PATCH', `/api/v1/tables/${id}/rows/r1`)?.area).toBe('tables');
  });

  it('holds a key to its areas and its access', () => {
    const pages = matchApiV1Route('GET', '/api/v1/pages');
    const newPage = matchApiV1Route('POST', '/api/v1/pages');
    const node = matchApiV1Route('GET', '/api/v1/nodes/x');
    const whoami = matchApiV1Route('GET', '/api/v1/whoami');
    const all = { access: 'read_write' as const, areas: null };
    const readTasks = { access: 'read' as const, areas: ['tasks' as const] };

    expect(keyMayCall(all, pages)).toEqual({ ok: true });
    expect(keyMayCall(all, newPage)).toEqual({ ok: true });
    expect(keyMayCall(all, node)).toEqual({ ok: true });
    expect(keyMayCall(readTasks, whoami)).toEqual({ ok: true });
    expect(keyMayCall(readTasks, pages)).toEqual({ ok: false, reason: 'key-area' });
    expect(keyMayCall(readTasks, node)).toEqual({ ok: false, reason: 'key-area' });
    expect(keyMayCall({ access: 'read', areas: null }, newPage)).toEqual({
      ok: false,
      reason: 'key-read-only',
    });
    expect(keyMayCall(all, null)).toEqual({ ok: false, reason: 'not-in-api' });
  });
});
