import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { composeServices, serverImageCmd } from '../scripts/boot-smoke.mjs';

/**
 * scripts/run-service.sh starts web, api and the workers on the runtime
 * MANTLE_RUNTIME names. Node and Bun each start the entry by themselves in
 * its package (no pnpm or tsx process above them), and any other word must
 * stop the service, never fall back to a guess.
 */
const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/run-service.sh');

/** Run the script with stand-ins for node, pnpm and bun that print their argv
 *  and working directory. */
function run(env: Record<string, string>, args = ['server/web', 'workers/runs.ts']) {
  const bin = mkdtempSync(join(tmpdir(), 'run-service-'));
  for (const tool of ['node', 'pnpm', 'bun']) {
    const stub = join(bin, tool);
    writeFileSync(stub, `#!/bin/sh\necho "${tool} $* @ $(pwd)"\n`);
    chmodSync(stub, 0o755);
  }
  const r = spawnSync(SCRIPT, args, {
    cwd: ROOT,
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe('scripts/run-service.sh', () => {
  it('node, the default: node itself with the tsx loader, in its package', () => {
    for (const env of [{}, { MANTLE_RUNTIME: 'node' }]) {
      expect(run(env)).toEqual({
        code: 0,
        out: `node --import tsx workers/runs.ts @ ${join(ROOT, 'server/web')}`,
        err: '',
      });
    }
  });

  it('bun: Bun starts the entry in its package, with no env file', () => {
    expect(run({ MANTLE_RUNTIME: 'bun' })).toEqual({
      code: 0,
      out: `bun --no-env-file workers/runs.ts @ ${join(ROOT, 'server/web')}`,
      err: '',
    });
  });

  it('any other word, or the wrong arguments, stops the service', () => {
    for (const env of [{ MANTLE_RUNTIME: 'Bun' }, { MANTLE_RUNTIME: 'deno' }]) {
      const r = run(env);
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toMatch(/MANTLE_RUNTIME must be node or bun/);
    }
    expect(run({}, ['server/web']).code).toBe(2);
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
