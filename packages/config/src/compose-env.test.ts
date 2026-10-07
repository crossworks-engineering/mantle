/**
 * The box-level feature flags reach the containers. Compose passes the app
 * services an explicit list of names (the `x-app-env` anchor), so a flag an
 * operator sets in the host `.env` does nothing unless it is on that list.
 * A member-logins flag once shipped without its line (v0.232.259 to .261):
 * setting it in `.env` changed nothing. That flag is gone (members are always
 * on), but the rule holds for every flag still listed here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
const anchor = compose.slice(
  compose.indexOf('x-app-env: &app-env'),
  compose.indexOf('\n\n', compose.indexOf('x-app-env: &app-env')),
);

/** Flags a box turns on in its `.env`; each must pass through the anchor. */
const BOX_FLAGS = ['MANTLE_RUNS', 'MANTLE_MCP_TERMINAL'];

describe('compose passes the box flags to the app services', () => {
  for (const name of BOX_FLAGS) {
    it(name, () => {
      expect(anchor).toMatch(new RegExp(`^\\s+${name}: \\$\\{${name}:-\\}$`, 'm'));
    });
  }
});

/**
 * Optional services (@mantle/config services): a dashboard switch starts or
 * stops ONE container, so the app containers' env does not change with it.
 * Each one learns the live state from the updater's services.json, which it
 * can only read when the signal dir is mounted. Web mounts it read-write (it
 * writes update requests); every other app service read-only.
 */
describe('every app service can read the live optional-service state', () => {
  const services = compose.slice(compose.indexOf('\nservices:\n'));
  const blocks = services.split(/\n(?= {2}[a-z_]+:\n)/).slice(1);
  const appServices = blocks.filter((b) => b.includes('<<: *app-env'));
  const name = (b: string) => b.slice(2, b.indexOf(':'));

  it('the anchor passes the box profiles', () => {
    expect(anchor).toMatch(/^\s+MANTLE_COMPOSE_PROFILES: \$\{COMPOSE_PROFILES:-\}$/m);
  });

  it('finds the app services', () => {
    expect(appServices.map(name)).toEqual(expect.arrayContaining(['web', 'api', 'worker_files']));
  });

  for (const b of appServices) {
    const n = name(b);
    if (n === 'migrate') continue; // a one-shot gate: it calls no optional service
    it(n, () => {
      const mount = n === 'web' ? /update-signal:\/signal$/m : /update-signal:\/signal:ro$/m;
      expect(b).toMatch(mount);
    });
  }
});
