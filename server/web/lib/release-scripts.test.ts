import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The operator scripts are release-owned, and FOUR places have to name the
 * same set: the Dockerfile (ships them at /app/release/scripts), the updater
 * (refreshes them onto the box), release.yml (puts them in the deploy bundle)
 * and install.sh (fetches them + seeds their baselines).
 *
 * A script in some lists and not others is exactly the failure this whole
 * change exists to close: before v0.232.137 NOTHING refreshed scripts/, so a
 * box ran the copies it was installed with forever. jason-prod's
 * compose-adopt.sh was three releases stale and applied a compose binding
 * infra/caddy/{shapes,conf.d} while knowing nothing about either — the next
 * `up -d` would have had Docker create both as root-owned strays with the
 * front door still on the old Caddyfile.
 *
 * These are plain text files with no type-checker over them, so drift between
 * the four lists can only be caught here.
 */
const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The canonical set. Adding a script means adding it in all four places. */
const SCRIPTS = [
  'db-dump.sh',
  'db-restore.sh',
  'install.sh',
  'sanity.sh',
  'compose-adopt.sh',
  'uninstall.sh',
];

describe('release-owned operator scripts', () => {
  it('the image ships every one at /app/release/scripts', () => {
    const dockerfile = read('Dockerfile');
    const missing = SCRIPTS.filter(
      (s) => !dockerfile.includes(`COPY scripts/${s} /app/release/scripts/${s}`),
    );
    expect(missing, `not COPYed into the image: ${missing.join(', ')}`).toEqual([]);
  });

  it('the updater refreshes exactly that set', () => {
    const updater = read('infra/updater/updater.sh');
    const line = updater.match(/^SCRIPT_NAMES='([^']+)'/m);
    expect(line, 'SCRIPT_NAMES not found in updater.sh').toBeTruthy();
    expect(line![1]!.split(/\s+/).filter(Boolean).sort()).toEqual([...SCRIPTS].sort());
  });

  it('the updater actually calls refresh_scripts during a roll', () => {
    const updater = read('infra/updater/updater.sh');
    expect(updater).toContain('refresh_scripts()');
    expect(updater).toMatch(/refresh_scripts "\$TARGET"/);
  });

  it('a missing baseline ADOPTS for scripts but never for the Caddyfile', () => {
    // The asymmetry is deliberate and load-bearing: a no-baseline Caddyfile may
    // carry box routes, so it is reported and left alone (conf.d exists for
    // those); a no-baseline script is just old tooling, and refusing would
    // leave the fleet stale forever behind a manual step that never happens.
    const updater = read('infra/updater/updater.sh');
    expect(updater).toContain('.pre-adopt.'); // the recoverable backup
    expect(updater).toContain('refresh_file "$CADDY_REL" /app/release/Caddyfile no');
  });

  it('the deploy bundle carries the same set', () => {
    const release = read('.github/workflows/release.yml');
    const missing = SCRIPTS.filter((s) => !release.includes(`scripts/${s}`));
    expect(missing, `absent from the deploy bundle: ${missing.join(', ')}`).toEqual([]);
  });

  it('install.sh fetches each one, marks it executable and seeds its baseline', () => {
    const install = read('install.sh');
    for (const s of SCRIPTS) {
      expect(install, `${s} not fetched`).toContain(`fetch scripts/${s}`);
      expect(install, `${s} not chmod +x`).toContain(`scripts/${s}`);
    }
    expect(install).toContain('cp "scripts/$s" "scripts/$s.release"');
    const seeded = install.match(/^for s in ([a-z0-9.\- ]+); do$/m);
    expect(seeded, 'baseline seeding loop not found').toBeTruthy();
    expect(seeded![1]!.split(/\s+/).filter(Boolean).sort()).toEqual([...SCRIPTS].sort());
  });

  it('reports script drift on the status surface', () => {
    const updater = read('infra/updater/updater.sh');
    expect(updater).toContain('"scripts_sha"');
    expect(updater).toContain('"scripts_refresh"');
  });
});
