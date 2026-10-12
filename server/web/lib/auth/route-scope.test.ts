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
import { isMemberRoute } from './member-routes';
import {
  CREATE_ROUTES,
  MEMBER_OPEN_READS,
  MEMBER_OPEN_WRITES,
  READ_POSTS,
  isReadRequest,
  memberMayRead,
  memberMayWrite,
  routeClass,
  itemWriteTarget,
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
          !e.pattern.startsWith('/api/client/') &&
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

  it.skipIf(!hasManifest)(
    'every member write (W6b) is a served content write; creates are among them',
    async () => {
      const { routeManifest } = await import('../../server/route-manifest.gen');
      const served = new Set(
        routeManifest.flatMap((e) => e.methods.map((m) => `${m} ${e.pattern}`)),
      );
      for (const key of MEMBER_OPEN_WRITES) {
        const [method, pattern] = key.split(' ') as [string, string];
        expect(served.has(key), key).toBe(true);
        expect(routeClass(pattern), key).toEqual({ kind: 'content' });
        expect(isReadRequest(method, pattern), key).toBe(false);
        expect(memberMayWrite(method, pattern), key).toBe(true);
      }
      for (const key of CREATE_ROUTES) expect(MEMBER_OPEN_WRITES, key).toContain(key);
      expect(memberMayWrite('DELETE', '/api/files/files')).toBe(false);
      expect(memberMayWrite('DELETE', '/api/apps/deleted/:id')).toBe(false);
      expect(memberMayWrite('POST', '/api/contacts')).toBe(false);
      expect(memberMayWrite('GET', null)).toBe(false);
    },
  );

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

describe('itemWriteTarget (W6a, the item an Admin write touches)', () => {
  const id = '6f1c2a3b-0d4e-4f5a-8b6c-7d8e9f0a1b2c';
  it('names the item and what the write needs', () => {
    expect(itemWriteTarget('PATCH', '/api/pages/:id', `/api/pages/${id}`)).toEqual({
      id,
      need: 'edit',
      ref: 'node',
    });
    expect(itemWriteTarget('DELETE', '/api/notes/:id', `/api/notes/${id}`)).toEqual({
      id,
      need: 'manage',
      ref: 'node',
    });
    expect(itemWriteTarget('POST', '/api/pages/:id/move', `/api/pages/${id}/move`)).toEqual({
      id,
      need: 'manage',
      ref: 'node',
    });
    expect(itemWriteTarget('DELETE', '/api/apps/:id/draft', `/api/apps/${id}/draft`)).toEqual({
      id,
      need: 'edit',
      ref: 'node',
    });
    expect(itemWriteTarget('POST', '/api/apps/:id/opened', `/api/apps/${id}/opened`)).toEqual({
      id,
      need: 'read',
      ref: 'node',
    });
    expect(
      itemWriteTarget('PATCH', '/api/tree/:kind/folders/:id', `/api/tree/pages/folders/${id}`),
    ).toEqual({ id, need: 'edit', ref: 'node' });
    expect(
      itemWriteTarget('PATCH', '/api/v1/tables/:id/rows/:rowId', `/api/v1/tables/${id}/rows/r1`),
    ).toEqual({ id, need: 'edit', ref: 'node' });
  });
  it('names no item for a create, a list or another prefix', () => {
    expect(itemWriteTarget('POST', '/api/pages', '/api/pages')).toBeNull();
    expect(itemWriteTarget('POST', '/api/tree/:kind/move', '/api/tree/pages/move')).toBeNull();
    expect(itemWriteTarget('PATCH', '/api/contacts/:id', `/api/contacts/${id}`)).toBeNull();
    expect(itemWriteTarget('POST', '/api/shares/contacts', '/api/shares/contacts')).toBeNull();
  });
  it('fix round 1 (M1): the other workspace kinds, and items named through another row', () => {
    expect(itemWriteTarget('DELETE', '/api/tasks/:id', `/api/tasks/${id}`)).toEqual({
      id,
      need: 'manage',
      ref: 'node',
    });
    expect(itemWriteTarget('PATCH', '/api/v1/tasks/:id', `/api/v1/tasks/${id}`)).toEqual({
      id,
      need: 'edit',
      ref: 'node',
    });
    expect(itemWriteTarget('PATCH', '/api/events/:id', `/api/events/${id}`)?.need).toBe('edit');
    expect(itemWriteTarget('DELETE', '/api/formulas/:id', `/api/formulas/${id}`)?.need).toBe(
      'manage',
    );
    expect(
      itemWriteTarget(
        'POST',
        '/api/recall/maps/:id/cards/reorder',
        `/api/recall/maps/${id}/cards/reorder`,
      ),
    ).toEqual({ id, need: 'edit', ref: 'node' });
    expect(
      itemWriteTarget(
        'POST',
        '/api/recall/revisions/:id/restore',
        `/api/recall/revisions/${id}/restore`,
      ),
    ).toEqual({ id, need: 'edit', ref: 'recall-revision' });
    expect(itemWriteTarget('DELETE', '/api/shares/:id', `/api/shares/${id}`)).toEqual({
      id,
      need: 'manage',
      ref: 'share',
    });
    expect(itemWriteTarget('DELETE', '/api/apps/deleted/:id', `/api/apps/deleted/${id}`)).toEqual({
      id,
      need: 'manage',
      ref: 'deleted-app',
    });
    expect(
      itemWriteTarget('POST', '/api/apps/deleted/:id/restore', `/api/apps/deleted/${id}/restore`),
    ).toEqual({ id, need: 'manage', ref: 'deleted-app' });
  });
  it('fix round 1 (M2): the Apps sidebar reads in the login scope', () => {
    expect(routeClass('/api/app-nav')).toEqual({ kind: 'content' });
    expect(routeClass('/api/app-nav/pins')).toEqual({ kind: 'content' });
  });
});
