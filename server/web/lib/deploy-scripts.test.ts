/**
 * Runs scripts/test-deploy-scripts.sh, the fake-stack harness for the root
 * installer, the updater and compose-adopt. The harness stubs `docker` with a
 * shell function and sources the updater in library mode, so it needs no
 * daemon and no network: installs run against a file:// release tree.
 *
 * It is wired in here, next to the tests that pin literal text in the same
 * scripts, so a change to install.sh or updater.sh cannot pass `pnpm verify`
 * while breaking a first roll. Two of the bugs it covers (a bundle install
 * seeding no baselines; the :? compose swapped in before the env was checked)
 * shipped precisely because nothing executed these scripts in CI.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

describe('deploy scripts harness', () => {
  it('passes every check (installer baselines, env ownership, compose env gate, caddy ordering)', () => {
    let out: string;
    try {
      out = execFileSync('bash', [join(ROOT, 'scripts', 'test-deploy-scripts.sh')], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      throw new Error(`harness failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}`, {
        cause: err,
      });
    }
    expect(out).toMatch(/\n\d+ passed, 0 failed/);
  }, 150_000);
});
