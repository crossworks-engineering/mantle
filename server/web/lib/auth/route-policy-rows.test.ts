/**
 * Every row of the route policy table, one line each: its class, its scope,
 * the caller the gate answers and whether it is a retired route's stub. A
 * change to any row's answer shows as a changed line here, so a cleanup that
 * claims no answer moved is held to it. Update the file only with a change
 * that means to move a row (`vitest run -u`), and name the moved rows.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRoutePolicy, type RouteManifestEntry } from './route-policy';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hasManifest = existsSync(join(webRoot, 'server/route-manifest.gen.ts'));

describe.skipIf(!hasManifest)('the route policy rows', () => {
  it('answer as the snapshot says', async () => {
    const { routeManifest } = await import('../../server/route-manifest.gen');
    const rows = [...buildRoutePolicy(routeManifest as readonly RouteManifestEntry[]).values()];
    const lines = rows
      .map((r) => {
        const scope = r.scope
          ? r.scope.kind === 'area'
            ? `area:${r.scope.area}`
            : r.scope.kind
          : '-';
        return `${r.key} class=${r.class} scope=${scope} caller=${r.caller ?? '-'} gone=${r.gone}`;
      })
      .sort();
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(
      './__snapshots__/route-policy-rows.txt',
    );
  });
});
