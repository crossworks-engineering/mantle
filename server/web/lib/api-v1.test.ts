/**
 * The public API v1 (lib/api-v1.ts): every /api/v1 route file method
 * declares the key area a key needs (plan v3.2 S9 part 3: the key table is
 * gone, the declarations are its one source), and the scope rule an API
 * key is held to. No database.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCESS_KEY_AREAS as CONTRACT_AREAS } from '@mantle/client-types/dto/access-keys';
import { ACCESS_KEY_AREAS } from './access-keys';
import { keyMayCall } from './api-v1';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', 'server', 'route-manifest.gen.ts');
const hasManifest = existsSync(manifestPath);

async function v1Rows() {
  const { routeManifest } = await import('../server/route-manifest.gen');
  const { buildRoutePolicy } = await import('./auth/route-policy');
  return buildRoutePolicy(routeManifest);
}

describe('public API v1', () => {
  it.skipIf(!hasManifest)(
    'every /api/v1 route file method declares its key area, and no other row does',
    async () => {
      const rows = [...(await v1Rows()).values()];
      const v1 = rows.filter((r) => r.pattern === '/api/v1' || r.pattern.startsWith('/api/v1/'));
      expect(v1.filter((r) => r.keyArea === undefined).map((r) => r.key)).toEqual([]);
      expect(v1.length).toBeGreaterThan(30);
      expect(rows.filter((r) => !v1.includes(r) && r.keyArea !== undefined)).toEqual([]);
    },
  );

  it('the contract package lists the same areas as the brain', () => {
    expect([...CONTRACT_AREAS]).toEqual([...ACCESS_KEY_AREAS]);
  });

  /** The v1 POSTs that read (their declaration says the read they are):
   *  the two documents routes that answer JSON about the PDFs they are
   *  handed and write nothing, so a read-only key may call them. */
  const READ_POSTS = new Set([
    'POST /api/v1/documents/pdfengines/metadata/read',
    'POST /api/v1/documents/pdfengines/bookmarks/read',
  ]);

  it.skipIf(!hasManifest)('names only known areas, and a read for every GET', async () => {
    for (const r of (await v1Rows()).values()) {
      if (r.keyArea === undefined) continue;
      if (r.keyArea !== null) expect(ACCESS_KEY_AREAS).toContain(r.keyArea);
      const read = r.method === 'GET' || r.method === 'HEAD' || READ_POSTS.has(r.key);
      expect(r.effect, r.key).toBe(read ? 'read' : 'write');
    }
  });

  it.skipIf(!hasManifest)('matches a request to its row', async () => {
    const { requestKeyRoute } = await import('./auth/route-policy');
    const rows = await v1Rows();
    const id = '11111111-1111-4111-8111-111111111111';
    const at = (key: string, path: string) => requestKeyRoute(rows.get(key) ?? null, path);
    expect(at('GET /api/v1/pages/:id', `/api/v1/pages/${id}`)?.access).toBe('read');
    expect(at('HEAD /api/v1/pages/:id', `/api/v1/pages/${id}`)?.area).toBe('pages');
    expect(at('PATCH /api/v1/pages/:id', `/api/v1/pages/${id}`)?.access).toBe('write');
    expect(rows.get('DELETE /api/v1/pages/:id')).toBeUndefined();
    expect(at('GET /api/v1/pages/:id', `/api/v1/pages/${id}/extra`)).toBeNull();
    expect(at('PATCH /api/v1/tables/:id/rows/:rowId', `/api/v1/tables/${id}/rows/r1`)?.area).toBe(
      'tables',
    );
  });

  it.skipIf(!hasManifest)('holds a key to its areas and its access', async () => {
    const { rowKeyRoute } = await import('./auth/route-policy');
    const rows = await v1Rows();
    const of = (key: string) => rowKeyRoute(rows.get(key) ?? null);
    const pages = of('GET /api/v1/pages');
    const newPage = of('POST /api/v1/pages');
    const node = of('GET /api/v1/nodes/:id');
    const whoami = of('GET /api/v1/whoami');
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
