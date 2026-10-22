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
import {
  LOGIN_SELF_ENTRIES,
  NARROW_SWEEP_ENTRIES,
  READ_SWEEP_SKIP,
  selfWriteRows,
  sweepReadRows,
  writingAreaRows,
} from './narrow-area-sweep.entries';

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

  // Round 14b, item 9: the login's own rows come from the table too.
  it('has a login-self entry for every writing self row, and no other', () => {
    const policy = buildRoutePolicy(routeManifest);
    const keys = selfWriteRows(policy)
      .map((r) => r.key)
      .sort();
    expect(Object.keys(LOGIN_SELF_ENTRIES).sort()).toEqual(keys);
    expect(keys).toEqual(
      expect.arrayContaining([
        'PUT /api/profile/fonts',
        'PUT /api/push/preferences',
        'PUT /api/member/push/preferences',
        'DELETE /api/member/mcp/clients/:id',
      ]),
    );
  });

  it('sends every login-self PUT a body that names a field, and says why for a row not sent', () => {
    const empty = Object.entries(LOGIN_SELF_ENTRIES)
      .filter(([key, e]) => /^(PATCH|PUT) /.test(key) && !('skip' in e))
      .filter(([, e]) => {
        const b = 'body' in e ? e.body : undefined;
        return b == null || (typeof b === 'object' && Object.keys(b).length === 0);
      })
      .map(([key]) => key);
    expect(empty).toEqual([]);
    for (const [key, e] of Object.entries(LOGIN_SELF_ENTRIES)) {
      if ('skip' in e) expect(e.skip.length, key).toBeGreaterThan(20);
      else if (e.answers !== undefined) expect(e.answers.length, key).toBeGreaterThan(20);
    }
  });

  // Round 14b, item 0: every GET of an area or self row is sent, but the
  // streams, each named with why.
  it('sends every read row of an area or self but the named streams', () => {
    const reads = sweepReadRows(buildRoutePolicy(routeManifest)).map((r) => r.key);
    expect(reads).toContain('GET /api/agents');
    expect(reads.length).toBeGreaterThan(100);
    for (const [key, why] of Object.entries(READ_SWEEP_SKIP)) {
      expect(reads, key).toContain(key);
      expect(why.length, key).toBeGreaterThan(20);
    }
  });

  it('a new writing area row without an entry is caught', () => {
    const extra = { key: 'POST /api/new-area-thing', area: 'settings' };
    const keys = [...rows.map((r) => r.key), extra.key];
    expect(keys.filter((k) => !(k in NARROW_SWEEP_ENTRIES))).toEqual([extra.key]);
  });
});
