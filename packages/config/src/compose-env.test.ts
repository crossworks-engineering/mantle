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
const BOX_FLAGS = [
  'MANTLE_RUNS',
  'MANTLE_MCP_TERMINAL',
  'MANTLE_DB_RUNTIME_ROLE',
  'MANTLE_NARROW_SYSTEM',
  // Calls (plan page 886126b4): the agent worker's flag, the calls host and
  // the key pair the brain signs tokens with (the profile decides what runs).
  'MANTLE_CALLS_AGENT',
  'MANTLE_CALLS_HOST',
  'MANTLE_LIVEKIT_API_KEY',
  'MANTLE_LIVEKIT_API_SECRET',
];

describe('compose passes the box flags to the app services', () => {
  for (const name of BOX_FLAGS) {
    it(name, () => {
      expect(anchor).toMatch(new RegExp(`^\\s+${name}: \\$\\{${name}:-\\}$`, 'm'));
    });
  }
  // The checks' floor at migrate (0301): raise unless the box says keep,
  // with its reason (docs/update-prod.md, "Keep one box below on").
  it('MANTLE_CHECK_FLOOR', () => {
    expect(anchor).toMatch(/^\s+MANTLE_CHECK_FLOOR: \$\{MANTLE_CHECK_FLOOR:-raise\}$/m);
    expect(anchor).toMatch(/^\s+MANTLE_CHECK_FLOOR_REASON: \$\{MANTLE_CHECK_FLOOR_REASON:-\}$/m);
  });
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

/**
 * A stop waits for the process's own exit deadline (@mantle/std/shutdown,
 * A10 #15 fix round 1 L3): Docker sends SIGKILL after stop_grace_period
 * (10 s when unset), so a service whose teardown may take longer names a
 * grace period past its deadline. The API drains pg-boss and DBOS (45 s),
 * the workers' runner allows 15 s, the web server 5 s.
 */
describe('a stop waits for the exit deadline', () => {
  const services = compose.slice(compose.indexOf('\nservices:\n'));
  const blocks = services.split(/\n(?= {2}[a-z_]+:\n)/).slice(1);
  const name = (b: string) => b.slice(2, b.indexOf(':'));
  const graceMs = (b: string) => {
    const m = /^ {4}stop_grace_period: (\d+)s$/m.exec(b);
    return m ? Number(m[1]) * 1000 : 10_000;
  };
  const deadline = (file: string, constName: string) => {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    const m = new RegExp(`const ${constName} = ([\\d_]+);`).exec(text);
    if (!m) throw new Error(`${constName} not found in ${file}`);
    return Number(m[1]!.replace(/_/g, ''));
  };
  const api = deadline('server/api/src/main.ts', 'API_EXIT_DEADLINE_MS');
  const worker = deadline('server/web/workers/_runner.ts', 'EXIT_DEADLINE_MS');

  it('the API', () => {
    const b = blocks.find((x) => name(x) === 'api')!;
    expect(graceMs(b)).toBeGreaterThan(api);
  });

  it('every worker', () => {
    const workers = blocks.filter((b) => name(b).startsWith('worker_'));
    expect(workers.length).toBeGreaterThanOrEqual(10);
    for (const b of workers) expect([name(b), graceMs(b) > worker]).toEqual([name(b), true]);
  });

  it('the web server (5 s, inside the default)', () => {
    const b = blocks.find((x) => name(x) === 'web')!;
    expect(graceMs(b)).toBeGreaterThan(5_000);
  });
});
