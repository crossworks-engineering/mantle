/**
 * The narrow area-route sweep's table holds exactly the writing area rows
 * of the route table: a new writing area route with no entry fails here,
 * and so does an entry for a row that is gone. No database.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRoutePolicy } from '../lib/auth/route-policy';
import { routeManifest } from './route-manifest.gen';
import { NARROW_SWEEP_ENTRIES, writingAreaRows } from './narrow-area-sweep.entries';

describe('the narrow area-route sweep table', () => {
  const rows = writingAreaRows(buildRoutePolicy(routeManifest));

  it('has an entry for every writing area row, and no other', () => {
    const keys = rows.map((r) => r.key).sort();
    expect(Object.keys(NARROW_SWEEP_ENTRIES).sort()).toEqual(keys);
  });

  it('says why for every row it does not send', () => {
    for (const [key, e] of Object.entries(NARROW_SWEEP_ENTRIES)) {
      if ('skip' in e) expect(e.skip.length, key).toBeGreaterThan(20);
    }
  });

  it('sends every PATCH and PUT row a body that names a column, never an empty one', () => {
    // An empty body reaches no write: the sweep would never meet a column
    // the narrow login may not write (the app re-audit's G: 8 such rows).
    const bodies = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          '__snapshots__',
          'a10-body-sweep.bodies.json',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const empty = Object.entries(NARROW_SWEEP_ENTRIES)
      .filter(([key, e]) => /^(PATCH|PUT) /.test(key) && !('skip' in e))
      .filter(([key, e]) => {
        const b = 'body' in e ? e.body : bodies[key];
        return b == null || (typeof b === 'object' && Object.keys(b).length === 0);
      })
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it('a new writing area row without an entry is caught', () => {
    const extra = { key: 'POST /api/new-area-thing', area: 'settings' };
    const keys = [...rows.map((r) => r.key), extra.key];
    expect(keys.filter((k) => !(k in NARROW_SWEEP_ENTRIES))).toEqual([extra.key]);
  });
});
