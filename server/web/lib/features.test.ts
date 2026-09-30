import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RECALL_V2, shellFeatures } from './features';

/**
 * The capability flags the owner client reads from `GET /api/shell`.
 *
 * The flags exist because jackdaw releases on its own cadence: a client that
 * ships the v2 Recall screen must not use it against a brain whose write path
 * does not exist. So the flag has to mean "this brain can do it", and R1 —
 * schema and contract only — must report false. A flag flipped early is worse
 * than no flag: the client would render a screen whose routes 404.
 */
describe('shell features', () => {
  it('reports recallV2 false while R1 is schema only', () => {
    // Flip this (and the expectation) in R2, in the same release that lands
    // the native write path and the owner routes.
    expect(RECALL_V2).toBe(false);
    expect(shellFeatures()).toEqual({ recallV2: false });
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
});
