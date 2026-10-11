/**
 * The W6a route table (lib/auth/route-scope.ts): every owner route the
 * manifest serves is classified (content, the login's own, or one Admin
 * area), so the session guard never meets a route nobody decided on; the
 * routes opened to every login are reads of brain items that exist.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAnyLoginRoute } from './any-login-routes';
import { isClientRoute } from './client-routes';
import { isMemberRoute } from './member-routes';
import {
  MEMBER_OPEN_READS,
  READ_POSTS,
  isReadRequest,
  memberMayRead,
  routeClass,
} from './route-scope';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, '../../server/route-manifest.gen.ts'));

/** Routes with their own gate (none of the session guards' owner paths). */
const OWN_GATE = /^\/api\/(mcp|oauth)(\/|$)/;

describe.skipIf(!hasManifest)('route scope table (W6a)', () => {
  it('classifies every owner route of the manifest', async () => {
    const { routeManifest } = await import('../../server/route-manifest.gen');
    const missing: string[] = [];
    for (const e of routeManifest) {
      if (!e.pattern.startsWith('/api/') || OWN_GATE.test(e.pattern)) continue;
      const owner = e.methods.filter(
        (m) =>
          !isMemberRoute(m, e.pattern) &&
          !isClientRoute(m, e.pattern) &&
          !isAnyLoginRoute(m, e.pattern),
      );
      if (owner.length && !routeClass(e.pattern)) missing.push(e.pattern);
    }
    expect(missing).toEqual([]);
  });

  it('opens to every login only GET reads of brain items the manifest serves', async () => {
    const { routeManifest } = await import('../../server/route-manifest.gen');
    const served = new Set(routeManifest.flatMap((e) => e.methods.map((m) => `${m} ${e.pattern}`)));
    for (const key of MEMBER_OPEN_READS) {
      const [method, pattern] = key.split(' ') as [string, string];
      expect(method, key).toBe('GET');
      expect(served.has(key), key).toBe(true);
      expect(routeClass(pattern), key).toEqual({ kind: 'content' });
      expect(memberMayRead('HEAD', pattern), key).toBe(true);
    }
    expect(memberMayRead('POST', '/api/pages')).toBe(false);
    expect(memberMayRead('GET', '/api/settings')).toBe(false);
    expect(memberMayRead('GET', null)).toBe(false);
  });

  it('takes the longest prefix and knows reads', () => {
    expect(routeClass('/api/apps/:id')).toEqual({ kind: 'content' });
    expect(routeClass('/api/apps/:id/access-log')).toEqual({ kind: 'area', area: 'users' });
    expect(routeClass('/api/docs/reader')).toEqual({ kind: 'content' });
    expect(routeClass('/api/docs/collections/:id')).toEqual({ kind: 'area', area: 'settings' });
    expect(routeClass('/api/pagesx')).toBeNull();
    expect(isReadRequest('GET', '/api/pages')).toBe(true);
    expect(isReadRequest('PATCH', '/api/pages/:id')).toBe(false);
    for (const key of READ_POSTS) {
      const [method, pattern] = key.split(' ') as [string, string];
      expect(isReadRequest(method, pattern)).toBe(true);
      expect(routeClass(pattern)).toEqual({ kind: 'content' });
    }
  });
});
