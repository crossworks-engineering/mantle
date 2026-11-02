import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { composeServices, serverImageCmd } from '../scripts/boot-smoke.mjs';

/**
 * docker-compose.bun.yml moves every Node service of the server image to Bun.
 * It must name each one, and start the same file the Node command starts: a
 * service left out stays on Node with no word, and a wrong entry starts the
 * wrong program.
 */
const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The services of the Bun file: name, working_dir and command. */
function bunServices(text: string): Map<string, { dir: string; command: string[] }> {
  const out = new Map<string, { dir: string; command: string[] }>();
  let name = '';
  for (const line of text.split('\n')) {
    const svc = /^ {2}([a-z_]+):\s*$/.exec(line);
    if (svc) name = svc[1]!;
    const dir = /^ {4}working_dir:\s*(\S+)$/.exec(line);
    if (dir) out.set(name, { dir: dir[1]!, command: out.get(name)?.command ?? [] });
    const cmd = /^ {4}command:\s*\[(.*)\]$/.exec(line);
    if (cmd) {
      const command = [...cmd[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
      out.set(name, { dir: out.get(name)?.dir ?? '', command });
    }
  }
  return out;
}

/** The directory and file a Node command starts: `pnpm -C <dir> exec tsx
 *  <file>`, or `pnpm -C <dir> start` with that package's start script. */
function nodeEntry(command: string[]): { dir: string; file: string } {
  const [pnpm, flag, dir, ...rest] = command;
  expect([pnpm, flag]).toEqual(['pnpm', '-C']);
  if (rest[0] === 'exec' && rest[1] === 'tsx') return { dir: dir!, file: rest[2]! };
  expect(rest).toEqual(['start']);
  const start = JSON.parse(read(`${dir}/package.json`)).scripts.start as string;
  const m = /^tsx(?: --env-file-if-exists=\S+)? (\S+)$/.exec(start);
  if (!m) throw new Error(`${dir}: a start script of another shape: ${start}`);
  return { dir: dir!, file: m[1]! };
}

describe('docker-compose.bun.yml', () => {
  const node = (
    composeServices(read('docker-compose.yml')) as {
      name: string;
      command: string[] | null;
    }[]
  ).filter((s) => s.name !== 'migrate');
  const bun = bunServices(read('docker-compose.bun.yml'));

  it('moves every Node service of the server image, and no other', () => {
    expect([...bun.keys()].sort()).toEqual(node.map((s) => s.name).sort());
  });

  it.each(node.map((s) => [s.name, s.command] as const))(
    '%s starts the same file on Bun, with no env file',
    (name, command) => {
      const want = nodeEntry(command ?? (serverImageCmd(read('Dockerfile')) as string[]));
      expect(bun.get(name)).toEqual({
        dir: `/app/${want.dir}`,
        command: ['bun', '--no-env-file', want.file],
      });
    },
  );
});
