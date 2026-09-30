import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RECALL_V2, shellFeatures } from './features';
import { routeManifest } from '../server/route-manifest.gen';

/**
 * The capability flags the owner client reads from `GET /api/shell`.
 *
 * The flags exist because jackdaw releases on its own cadence: a client that
 * ships the v2 Recall screen must not use it against a brain that cannot serve
 * it. So the flag means "this brain can do it", and the test below is where
 * its value is stated out loud rather than left to a reader of the constant.
 *
 * It is true from R2, and the last test here is what makes that claim safe:
 * a flag saying "this brain can serve the v2 screen" while the write routes do
 * not exist is worse than no flag, because the client renders a screen whose
 * saves 404. So the flag and the routes are pinned together.
 */
describe('shell features', () => {
  it('reports recallV2 true from R2, so a client may build the v2 screen', () => {
    expect(RECALL_V2).toBe(true);
    expect(shellFeatures()).toEqual({ recallV2: true });
  });

  it('is reached through one function, so a flag is one line', () => {
    expect(typeof shellFeatures).toBe('function');
    expect(Object.keys(shellFeatures())).toEqual(['recallV2']);
  });

  it('is actually served by the owner shell route', () => {
    // The flag is useless if the route forgets it, and nothing else would
    // catch that: the route's own tests do not assert every key.
    const route = readFileSync(
      join(import.meta.dirname, '..', 'app', 'api', 'shell', 'route.ts'),
      'utf8',
    );
    expect(route).toContain("from '@/lib/features'");
    expect(route).toMatch(/features:\s*shellFeatures\(\)/);
  });

  it('does not claim recallV2 without the routes that serve it', () => {
    // The pairing. A v2 screen needs somewhere to create a map, write a card,
    // reorder, confirm a prompt, and read and restore revisions. If the flag
    // is true, every one of these has to be in the manifest the server loads.
    const NEEDED: [string, string][] = [
      ['/api/recall/maps', 'POST'],
      ['/api/recall/maps/:id', 'PATCH'],
      ['/api/recall/maps/:id', 'DELETE'],
      ['/api/recall/maps/:id/cards', 'POST'],
      ['/api/recall/maps/:id/cards/:card', 'GET'],
      ['/api/recall/maps/:id/cards/:card', 'PUT'],
      ['/api/recall/maps/:id/cards/:card', 'DELETE'],
      ['/api/recall/maps/:id/cards/reorder', 'POST'],
      ['/api/recall/maps/:id/cards/:card/prompt', 'POST'],
      ['/api/recall/maps/:id/revisions', 'GET'],
      ['/api/recall/revisions/:id/restore', 'POST'],
    ];
    const missing = NEEDED.filter(
      ([pattern, method]) =>
        !routeManifest.some((r) => r.pattern === pattern && r.methods.includes(method)),
    ).map(([pattern, method]) => `${method} ${pattern}`);
    if (RECALL_V2) {
      expect(
        missing,
        'features.recallV2 is true but these routes are not served: a client would render the v2 screen and 400/404 on save',
      ).toEqual([]);
    }
  });
});
