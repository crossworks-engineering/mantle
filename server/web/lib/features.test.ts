import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RECALL_V2, shellFeatures } from './features';

/**
 * The capability flags the owner client reads from `GET /api/shell`.
 *
 * The flags exist because jackdaw releases on its own cadence: a client that
 * ships the v2 Recall screen must not use it against a brain that cannot serve
 * it. So the flag means "this brain can do it", and the test below is where
 * its value is stated out loud rather than left to a reader of the constant.
 *
 * It is true from R2. The owner write routes arrive later in R2, so until then
 * the flag is deliberately ahead of the brain and this branch must not be
 * released — see the warning in features.ts.
 */
describe('shell features', () => {
  it('reports recallV2 true from R2, so a client may build the v2 screen', () => {
    // The serving tools understand native maps and the contract carries the
    // v2 fields. The owner WRITE routes land later in R2: until they do this
    // flag is deliberately ahead of the brain, and this branch must not be
    // released. See the warning in features.ts.
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
});
