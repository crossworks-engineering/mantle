/**
 * The narrow area-route sweep's table holds exactly the writing area rows
 * of the route table: a new writing area route with no entry fails here,
 * and so does an entry for a row that is gone. No database.
 */
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

  it('a new writing area row without an entry is caught', () => {
    const extra = { key: 'POST /api/new-area-thing', area: 'settings' };
    const keys = [...rows.map((r) => r.key), extra.key];
    expect(keys.filter((k) => !(k in NARROW_SWEEP_ENTRIES))).toEqual([extra.key]);
  });
});
