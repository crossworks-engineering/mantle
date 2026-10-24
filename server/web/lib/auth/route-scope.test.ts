/**
 * The route scope rules (lib/auth/route-scope.ts) over the rows the route
 * files' declarations build (plan v3.2 S9 part 3: the prefix table and the
 * member lists are gone): the audit rule by effect, and the kind registry's
 * item routes, each open to a login outside Admin in its scope (A1), with
 * its create reading ?ws=.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ITEM_KINDS, ITEM_KIND_NAMES } from '@mantle/client-types/kinds';
import { methodEffect } from './route-declaration';
import { auditsAsWrite } from './route-scope';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, '../../server/route-manifest.gen.ts'));

/** The content prefixes of the workspace kinds (the kind registry). */
const WORKSPACE_ITEM_PREFIXES: readonly string[] = ITEM_KIND_NAMES.flatMap((t) => {
  const spec = ITEM_KINDS[t];
  return spec.class === 'workspace' && spec.route.content ? [spec.route.content] : [];
});

async function rows() {
  const { routeManifest } = await import('../../server/route-manifest.gen');
  const { buildRoutePolicy } = await import('./route-policy');
  return buildRoutePolicy(routeManifest);
}

describe.skipIf(!hasManifest)('route scope (W6a), over the rows', () => {
  it('audits a write by its method or its row (A4 step 3b part 4 fix round)', async () => {
    // The api.write audit row: a mutating method, or a row whose effect is
    // a write (an OAuth callback's GET and HEAD). A POST that reads keeps
    // the row its method always wrote; outside a routed request, the method.
    let writeGets = 0;
    let readPosts = 0;
    for (const row of (await rows()).values()) {
      if (row.effect === methodEffect(row.method)) continue;
      if (row.effect === 'write') {
        writeGets += 1;
        expect(auditsAsWrite(row.method, row.effect), row.key).toBe(true);
        expect(auditsAsWrite(row.method, null), row.key).toBe(false);
      } else {
        readPosts += 1;
        expect(auditsAsWrite(row.method, row.effect), row.key).toBe(true);
      }
    }
    // The two OAuth callbacks (GET and HEAD each) and the formula calculator.
    expect([writeGets, readPosts]).toEqual([4, 1]);
    expect(auditsAsWrite('GET', 'read')).toBe(false);
    expect(auditsAsWrite('OPTIONS', null)).toBe(false);
    expect(auditsAsWrite('patch', null)).toBe(true);
  });

  it('the workspace kinds with an item route', () => {
    const set = (xs: Iterable<string>) => [...xs].sort();
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
        // Present (P1)
        '/api/presents',
      ]),
    );
  });

  it("each workspace kind's item routes open to a login outside Admin, its create reads ?ws= (A1)", async () => {
    const table = await rows();
    const checked: string[] = [];
    for (const p of WORKSPACE_ITEM_PREFIXES) {
      const routes: ReadonlyArray<readonly [string, 'read' | 'write', boolean]> = [
        [`GET ${p}`, 'read', false],
        [`GET ${p}/:id`, 'read', false],
        [`POST ${p}`, 'write', true],
        [`PATCH ${p}/:id`, 'write', false],
        [`DELETE ${p}/:id`, 'write', false],
      ];
      for (const [key, effect, creates] of routes) {
        const row = table.get(key);
        if (!row) continue;
        checked.push(key);
        expect([row.class, row.logins, row.effect], key).toEqual(['content', 'owner', effect]);
        if (creates) expect(row.creates, key).toBe(true);
      }
    }
    expect(checked.length).toBeGreaterThan(40);
  });
});
