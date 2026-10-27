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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

// /bin/bash, not the first bash on PATH: on a Mac that is 3.2, the oldest bash
// these scripts must run under (see shell-portability.test.ts). No bash at all
// (an Alpine box): skip with a note rather than fail on ENOENT.
function findBash(): string | null {
  for (const b of ['/bin/bash', 'bash']) {
    if (b.startsWith('/') && !existsSync(b)) continue;
    try {
      execFileSync(b, ['-c', 'true'], { stdio: 'ignore' });
      return b;
    } catch {
      // not runnable here: try the next one
    }
  }
  return null;
}
const BASH = findBash();
if (!BASH) console.warn('deploy-scripts: no bash found, the harness is skipped');

describe('deploy scripts harness', () => {
  (BASH ? it : it.skip)(
    'passes every check (installer baselines, env ownership, compose env gate, caddy ordering, pre-roll backup, image prune, roll.sh guards)',
    () => {
      let out: string;
      try {
        out = execFileSync(BASH ?? 'bash', [join(ROOT, 'scripts', 'test-deploy-scripts.sh')], {
          cwd: ROOT,
          encoding: 'utf8',
          // Without GIT_*: pre-push runs this with GIT_DIR set to the real repo.
          env: Object.fromEntries(
            Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
          ),
          stdio: ['ignore', 'pipe', 'pipe'],
          // About 70 s alone on a laptop (600 checks, each roll.sh case a
          // whole roll against stubs); under the full suite's load twice that.
          timeout: 240_000,
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        throw new Error(`harness failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}`, {
          cause: err,
        });
      }
      expect(out).toMatch(/\n\d+ passed, 0 failed/);
    },
    270_000,
  );
});
