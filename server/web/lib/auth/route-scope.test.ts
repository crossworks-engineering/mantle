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
  ADMIN_ACT_WRITES,
  CREATE_ROUTES,
  adminActWrite,
  MEMBER_OPEN_READS,
  MEMBER_OPEN_WRITES,
  READ_POSTS,
  WRITE_GETS,
  auditsAsWrite,
  isReadRequest,
  memberMayRead,
  memberMayWrite,
  routeClass,
  itemWriteTarget,
  WORKSPACE_ITEM_PREFIXES,
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

  it('opens to every login only reads of brain items the manifest serves', async () => {
    const { routeManifest } = await import('../../server/route-manifest.gen');
    const served = new Set(routeManifest.flatMap((e) => e.methods.map((m) => `${m} ${e.pattern}`)));
    for (const key of MEMBER_OPEN_READS) {
      const [method, pattern] = key.split(' ') as [string, string];
      // A GET, or a POST that only reads (READ_POSTS: a formula's calculator).
      expect(method === 'GET' || READ_POSTS.has(key), key).toBe(true);
      expect(isReadRequest(method, pattern), key).toBe(true);
      expect(served.has(key), key).toBe(true);
      expect(routeClass(pattern), key).toEqual({ kind: 'content' });
      expect(memberMayRead(method === 'GET' ? 'HEAD' : method, pattern), key).toBe(true);
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

  it.skipIf(!hasManifest)(
    'every Admin act (F4 fix round 1) is a served content write no member reaches',
    async () => {
      const { routeManifest } = await import('../../server/route-manifest.gen');
      const served = new Set(
        routeManifest.flatMap((e) => e.methods.map((m) => `${m} ${e.pattern}`)),
      );
      for (const key of ADMIN_ACT_WRITES) {
        const [method, pattern] = key.split(' ') as [string, string];
        expect(served.has(key), key).toBe(true);
        expect(routeClass(pattern), key).toEqual({ kind: 'content' });
        expect(isReadRequest(method, pattern), key).toBe(false);
        expect(memberMayWrite(method, pattern), key).toBe(false);
        expect(adminActWrite(method.toLowerCase(), pattern), key).toBe(true);
      }
      expect([...ADMIN_ACT_WRITES].sort()).toEqual([
        'DELETE /api/contacts/:id/shares',
        'POST /api/contacts/:id/sharing',
        'POST /api/entities/merge',
        'POST /api/shares/contacts',
      ]);
      expect(adminActWrite('PATCH', '/api/contacts/:id')).toBe(false);
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
    // A connector's OAuth callback writes (it stores the tokens), on its
    // GET and the HEAD the GET handler answers (A4 step 3b must-do).
    expect([...WRITE_GETS].sort()).toEqual([
      'GET /api/mcp-connectors/oauth/callback',
      'GET /api/microsoft/oauth/callback',
    ]);
    for (const key of WRITE_GETS) {
      const pattern = key.split(' ')[1]!;
      expect(isReadRequest('GET', pattern), key).toBe(false);
      expect(isReadRequest('HEAD', pattern), key).toBe(false);
      expect(routeClass(pattern), key).toEqual({ kind: 'area', area: 'connectors' });
    }
  });

  it('audits a write by its method or its row (A4 step 3b part 4 fix round)', () => {
    // The api.write audit row: a mutating method, or a row whose effect is
    // a write (an OAuth callback's GET and HEAD). A READ_POSTS row keeps
    // the row its method always wrote; outside a routed request, the method.
    const effect = (m: string, p: string) => (isReadRequest(m, p) ? 'read' : 'write');
    for (const key of WRITE_GETS) {
      const pattern = key.split(' ')[1]!;
      expect(auditsAsWrite('GET', effect('GET', pattern)), key).toBe(true);
      expect(auditsAsWrite('HEAD', effect('HEAD', pattern)), key).toBe(true);
      expect(auditsAsWrite('GET', null), key).toBe(false);
    }
    for (const key of READ_POSTS) {
      const [method, pattern] = key.split(' ') as [string, string];
      expect(auditsAsWrite(method, effect(method, pattern)), key).toBe(true);
    }
    expect(auditsAsWrite('GET', effect('GET', '/api/pages'))).toBe(false);
    expect(auditsAsWrite('OPTIONS', null)).toBe(false);
    expect(auditsAsWrite('patch', null)).toBe(true);
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
    // A link needs edit of its item (A0; an app's link: manage, which the
    // session gate asks once it knows the item's type).
    for (const method of ['DELETE', 'PATCH']) {
      expect(itemWriteTarget(method, '/api/shares/:id', `/api/shares/${id}`)).toEqual({
        id,
        need: 'edit',
        ref: 'share',
      });
    }
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

/**
 * The member route lists are generated from the kind registry since A1
 * (workspaces arch plan v2, section 9): pinned here as sets, so a registry
 * change that opens a route to non-Admin logins is a reviewed edit of this
 * test. The D1 rows (tasks, events, formulas, Recall maps) are marked.
 */
describe('member route lists (A1: generated from the kind registry)', () => {
  const set = (xs: Iterable<string>) => [...xs].sort();

  it('the workspace kinds with an item route', () => {
    expect(set(WORKSPACE_ITEM_PREFIXES)).toEqual(
      set([
        '/api/files/folders',
        '/api/files/files',
        '/api/notes',
        '/api/pages',
        '/api/tables',
        '/api/apps',
        '/api/formulas',
        '/api/draws',
        // D1
        '/api/tasks',
        '/api/events',
        '/api/recall/maps',
      ]),
    );
  });

  it('MEMBER_OPEN_READS', () => {
    expect(set(MEMBER_OPEN_READS)).toEqual(
      set([
        'GET /api/pages',
        'GET /api/pages/:id',
        'GET /api/pages/:id/backlinks',
        'GET /api/pages/:id/descendant-count',
        'GET /api/notes',
        'GET /api/notes/:id',
        'GET /api/draws',
        'GET /api/draws/:id',
        'GET /api/tables',
        'GET /api/tables/:id',
        'GET /api/tables/:id/rows',
        'GET /api/tree/:kind',
        'GET /api/tree/:kind/search',
        'GET /api/tree/:kind/tags',
        'GET /api/apps',
        'GET /api/apps/:id',
        'GET /api/nodes/:id',
        'GET /api/search',
        'GET /api/mentions/search',
        'GET /api/home',
        'GET /api/formulas',
        'GET /api/formulas/:id',
        'GET /api/files/files',
        'GET /api/files/files/:id',
        'GET /api/files/folders',
        'GET /api/files/folders/:id',
        'GET /api/tree/:kind/marks',
        'GET /api/draws/:id/svg',
        // D1
        'GET /api/tasks',
        'GET /api/tasks/:id',
        'GET /api/events',
        'GET /api/events/:id',
        'GET /api/recall/maps',
        'GET /api/recall/maps/:id',
        'GET /api/recall/maps/:id/cards/:card',
        'GET /api/recall/maps/:id/revisions',
        'POST /api/formulas/:id/evaluate',
      ]),
    );
  });

  it('MEMBER_OPEN_WRITES', () => {
    expect(set(MEMBER_OPEN_WRITES)).toEqual(
      set([
        'POST /api/pages',
        'PATCH /api/pages/:id',
        'DELETE /api/pages/:id',
        'PUT /api/pages/:id/draft',
        'POST /api/pages/:id/commit',
        'POST /api/pages/:id/discard-draft',
        'POST /api/pages/:id/move',
        'POST /api/notes',
        'PATCH /api/notes/:id',
        'DELETE /api/notes/:id',
        'POST /api/draws',
        'PATCH /api/draws/:id',
        'DELETE /api/draws/:id',
        'PUT /api/draws/:id/draft',
        'POST /api/draws/:id/commit',
        'POST /api/draws/:id/discard-draft',
        'POST /api/tables',
        'PATCH /api/tables/:id',
        'DELETE /api/tables/:id',
        'PUT /api/tables/:id/draft',
        'POST /api/tables/:id/draft-ops',
        'POST /api/tables/:id/commit',
        'POST /api/tables/:id/discard-draft',
        'POST /api/files/files',
        'PATCH /api/files/files/:id',
        'DELETE /api/files/files/:id',
        'POST /api/files/folders',
        'PATCH /api/files/folders/:id',
        'DELETE /api/files/folders/:id',
        'POST /api/apps',
        'PATCH /api/apps/:id',
        'DELETE /api/apps/:id',
        'PUT /api/apps/:id/draft',
        'DELETE /api/apps/:id/draft',
        'POST /api/apps/:id/build',
        'POST /api/apps/:id/format',
        'POST /api/apps/:id/publish',
        'POST /api/tree/:kind/folders',
        'PATCH /api/tree/:kind/folders/:id',
        'DELETE /api/tree/:kind/folders/:id',
        'POST /api/tree/:kind/move',
        'POST /api/tree/items/:id/opened',
        'PUT /api/tree/items/:id/pin',
        'POST /api/apps/:id/frame-ticket',
        'POST /api/apps/:id/db-broker',
        'POST /api/apps/:id/tool-broker',
        // D1
        'POST /api/tasks',
        'PATCH /api/tasks/:id',
        'DELETE /api/tasks/:id',
        'POST /api/events',
        'PATCH /api/events/:id',
        'DELETE /api/events/:id',
        'POST /api/formulas',
        'PATCH /api/formulas/:id',
        'DELETE /api/formulas/:id',
        'POST /api/recall/maps',
        'PATCH /api/recall/maps/:id',
        'DELETE /api/recall/maps/:id',
        'POST /api/recall/maps/:id/cards',
        'PUT /api/recall/maps/:id/cards/:card',
        'DELETE /api/recall/maps/:id/cards/:card',
        'POST /api/recall/maps/:id/cards/reorder',
        'POST /api/recall/maps/:id/cards/:card/prompt',
        'POST /api/recall/revisions/:id/restore',
      ]),
    );
  });

  it('CREATE_ROUTES', () => {
    expect(set(CREATE_ROUTES)).toEqual(
      set([
        'POST /api/pages',
        'POST /api/notes',
        'POST /api/draws',
        'POST /api/tables',
        'POST /api/files/files',
        'POST /api/files/folders',
        'POST /api/apps',
        'POST /api/tree/:kind/folders',
        // D1
        'POST /api/tasks',
        'POST /api/events',
        'POST /api/formulas',
        'POST /api/recall/maps',
      ]),
    );
  });

  it('every D1 item write names its item, with edit, or manage for a delete', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const at = (p: string) => p.replace(':id', id).replace(':card', 'c1');
    for (const key of MEMBER_OPEN_WRITES) {
      const [method, pattern] = key.split(' ') as [string, string];
      if (!/^\/api\/(tasks|events|formulas|recall)\//.test(pattern)) continue;
      if (CREATE_ROUTES.has(key)) continue;
      const t = itemWriteTarget(method, pattern, at(pattern));
      expect(t, key).not.toBeNull();
      expect(t!.id, key).toBe(id);
      const head = pattern.split('/').slice(0, 5).join('/');
      const isDeleteOfItem = method === 'DELETE' && /\/:id$/.test(pattern) && head === pattern;
      expect(t!.need, key).toBe(isDeleteOfItem ? 'manage' : 'edit');
    }
  });
});
