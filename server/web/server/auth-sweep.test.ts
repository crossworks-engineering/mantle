/**
 * Auth sweep over the WHOLE route manifest (2026-09-02 audit, gap D1: 345
 * handlers, zero tests). The gate is the first line: an /api/** request with
 * no credential must get a 401 JSON status, a page navigation a 307 to
 * /login, and only the paths listed in PUBLIC_PATHS may pass through. This
 * test drives every manifest entry, every method, credential-less, through
 * the real app (static layer + gate + route registration) and asserts that.
 *
 * It needs no database: a non-public request is answered by the gate before
 * the route module is even imported (the manifest holds lazy import thunks).
 * Public paths are NOT requested here — their handlers may touch the DB —
 * the test only records that they are public on purpose.
 *
 * Route-level auth (getOwnerOr401 & co.) is defence in depth behind this
 * gate; this sweep pins the gate, so a route added under a new prefix cannot
 * be reachable anonymously by accident.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_PATHS } from '../lib/auth-constants';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, 'route-manifest.gen.ts');
const hasManifest = existsSync(manifestPath);

if (!hasManifest) {
  console.warn(
    '[auth-sweep] server/web/server/route-manifest.gen.ts is missing — run `pnpm -C server/web route-manifest` (typecheck does it) to enable this sweep',
  );
}

const IMAGE_EXT_RE = /\.(?:svg|png|jpg|jpeg|gif|webp)$/;

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

/** Turn a manifest pattern into one concrete request path. */
function concretePath(pattern: string): string {
  return pattern
    .replace(/:[A-Za-z0-9_]+\??/g, '11111111-1111-4111-8111-111111111111')
    .replace(/\*$/, 'a/b');
}

describe.skipIf(!hasManifest)('route manifest auth sweep', () => {
  const savedSecret = process.env.SESSION_SECRET;
  const savedCors = process.env.MANTLE_API_CORS_ORIGINS;
  const savedDetached = process.env.MANTLE_DETACHED_DEV;
  let app: import('hono').Hono;
  let manifest: Array<{ pattern: string; methods: string[]; catchAll: string | null }>;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'auth-sweep-secret-that-is-at-least-32-chars-long';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const { createApp } = await import('./app');
    app = await createApp();
    manifest = (await import('./route-manifest.gen')).routeManifest;
  }, 60_000);

  afterAll(() => {
    if (savedSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = savedSecret;
    if (savedCors !== undefined) process.env.MANTLE_API_CORS_ORIGINS = savedCors;
    if (savedDetached !== undefined) process.env.MANTLE_DETACHED_DEV = savedDetached;
  });

  it('has a manifest worth sweeping', () => {
    expect(manifest.length).toBeGreaterThan(200);
  });

  it('every non-public route refuses a credential-less request (401 for /api, 307 for pages)', async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const entry of manifest) {
      const path = concretePath(entry.pattern);
      if (isPublic(path) || IMAGE_EXT_RE.test(path)) continue;
      const isApi = path === '/api' || path.startsWith('/api/');
      for (const method of entry.methods) {
        if (method === 'OPTIONS') continue;
        checked += 1;
        const res = await app.request(path, { method });
        if (isApi) {
          const body = res.status === 401 ? await res.json().catch(() => null) : null;
          if (
            res.status !== 401 ||
            !body ||
            (body as { error?: string }).error !== 'unauthorized'
          ) {
            failures.push(`${method} ${entry.pattern} → ${res.status}`);
          }
        } else if (res.status !== 307) {
          failures.push(`${method} ${entry.pattern} → ${res.status} (expected 307 → /login)`);
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(failures).toEqual([]);
  }, 120_000);

  it('lists which manifest routes are public, so a new public prefix is a visible diff', () => {
    const publicPatterns = manifest
      .filter((e) => isPublic(concretePath(e.pattern)))
      .map((e) => e.pattern)
      .sort();
    // Every public route must sit under a PUBLIC_PATHS prefix that is
    // documented in lib/auth-constants.ts — this pins the SET of prefixes in
    // use, not the individual routes (which come and go).
    const prefixesInUse = new Set(
      publicPatterns.map((p) => PUBLIC_PATHS.find((pp) => p === pp || p.startsWith(pp + '/'))),
    );
    expect([...prefixesInUse].sort()).toEqual(
      [
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-protected-resource',
        '/api/appearance',
        '/api/auth',
        '/api/federation',
        '/api/mcp',
        '/api/oauth',
        '/api/team',
        '/api/version',
        '/s',
      ].sort(),
    );
  });
});
