import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { composeServices, serverImageCmd } from '../scripts/boot-smoke.mjs';

/**
 * scripts/run-service.sh starts web, api and the workers on Bun, which starts
 * the entry by itself in its package (no pnpm or tsx process above it).
 */
const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/run-service.sh');

/** Run the script with a stand-in for bun that prints its argv and working
 *  directory. */
function run(args = ['server/web', 'workers/runs.ts']) {
  const bin = mkdtempSync(join(tmpdir(), 'run-service-'));
  const stub = join(bin, 'bun');
  writeFileSync(stub, `#!/bin/sh\necho "bun $* @ $(pwd)"\n`);
  chmodSync(stub, 0o755);
  const r = spawnSync(SCRIPT, args, {
    cwd: ROOT,
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe('scripts/run-service.sh', () => {
  it('Bun starts the entry in its package, with no env file', () => {
    expect(run()).toEqual({
      code: 0,
      out: `bun --no-env-file workers/runs.ts @ ${join(ROOT, 'server/web')}`,
      err: '',
    });
  });

  it('the wrong arguments stop the service', () => {
    expect(run(['server/web']).code).toBe(2);
  });

  it('every service on the server image starts through it, except migrate and sandboxd', () => {
    const services = (
      composeServices(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')) as {
        name: string;
        command: string[] | null;
      }[]
    ).map((s) => ({
      ...s,
      command:
        s.command ?? (serverImageCmd(readFileSync(join(ROOT, 'Dockerfile'), 'utf8')) as string[]),
    }));
    const through = services.filter((s) => s.command[0] === 'scripts/run-service.sh');
    expect(
      services
        .filter((s) => !through.includes(s))
        .map((s) => s.name)
        .sort(),
    ).toEqual(['migrate', 'sandboxd']);
    for (const s of through) {
      expect(s.command, s.name).toHaveLength(3);
      expect(existsSync(join(ROOT, s.command[1]!, s.command[2]!)), s.name).toBe(true);
    }
  });
});
