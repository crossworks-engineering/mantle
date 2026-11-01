/**
 * The bundle writer against the real `git`: clone the bundle, then log -p,
 * blame, bisect's rev-list and a strict fsck on what it gives. What an
 * outside agent does with app_export's git mode.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitBundleWriter } from './git-bundle';

const dir = mkdtempSync(path.join(tmpdir(), 'git-bundle-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** git with no user config: the test reads only what the bundle says. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig'),
    },
  });

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0) / 1000;
const LOGIN = '3f2a1b4c-0000-4000-8000-00000000abcd';

function sample() {
  const w = new GitBundleWriter();
  w.add({
    files: { 'App.tsx': 'export default function App() {\n  return null;\n}\n' },
    author: 'owner',
    time: T0,
    message: 'v1 publish: first cut',
  });
  w.add({
    files: {
      'App.tsx':
        "import { fmt } from './lib/fmt';\nexport default function App() {\n  return fmt(1);\n}\n",
      'lib/fmt.ts': 'export const fmt = (n: number) => `#${n}`;\n',
      'lib/z.ts': 'export {};\n',
      'lib-a.ts': 'export {};\n',
      './old.ts': 'export {};\n',
      '.git/config': '[core]\n',
      'lib/.GIT./x': 'x',
    },
    author: `member ${LOGIN}`,
    time: T0 + 3600,
    message: 'v3 publish: add fmt',
  });
  w.add({
    files: {
      'App.tsx':
        "import { fmt } from './lib/fmt';\nexport default function App() {\n  return fmt(2);\n}\n",
      'lib/fmt.ts': 'export const fmt = (n: number) => `#${n}`;\n',
    },
    author: 'agent',
    time: T0 + 7200,
    message: 'v4 publish',
  });
  return w.finish();
}

describe('GitBundleWriter', () => {
  const res = sample();
  const bundle = path.join(dir, 'app.bundle');
  writeFileSync(bundle, res.bytes);
  const repo = path.join(dir, 'clone');

  it('is a bundle git verifies and clones', () => {
    git(dir, 'clone', '-q', bundle, repo);
    expect(git(repo, 'bundle', 'verify', bundle)).toContain('refs/heads/main');
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(res.head);
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main');
    expect(readFileSync(path.join(repo, 'App.tsx'), 'utf8')).toContain('fmt(2)');
  });

  it('passes a strict fsck', () => {
    git(repo, 'fsck', '--strict', '--no-dangling');
  });

  it('keeps one commit per version, in order, with the time and the author', () => {
    const log = git(repo, 'log', '--reverse', '--format=%an|%ae|%at|%s').trim().split('\n');
    expect(log).toEqual([
      `owner||${T0}|v1 publish: first cut`,
      `member ${LOGIN}||${T0 + 3600}|v3 publish: add fmt`,
      `agent||${T0 + 7200}|v4 publish`,
    ]);
    expect(res.commits).toBe(3);
  });

  it('shows each change with log -p', () => {
    const p = git(repo, 'log', '-p', '--format=%s', '--', 'App.tsx');
    expect(p).toContain('-  return fmt(1);');
    expect(p).toContain('+  return fmt(2);');
  });

  it('blames each line on the version that wrote it', () => {
    const blame = git(repo, 'blame', '--line-porcelain', 'App.tsx');
    const summaries = [...blame.matchAll(/^summary (.*)$/gm)].map((m) => m[1]);
    expect(summaries).toEqual([
      'v3 publish: add fmt',
      'v1 publish: first cut',
      'v4 publish',
      'v1 publish: first cut',
    ]);
  });

  it('nests folders, plain-names old keys, and leaves out what git may not hold', () => {
    const v3 = git(repo, 'ls-tree', '-r', '--name-only', 'HEAD~1').trim().split('\n');
    expect(v3).toEqual(['App.tsx', 'lib-a.ts', 'lib/fmt.ts', 'lib/z.ts', 'old.ts']);
    expect(res.skipped.map((s) => s.path).sort()).toEqual(['.git/config', 'lib/.GIT./x']);
    expect(git(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('3');
  });

  it('writes a blob two versions share once', () => {
    const w = new GitBundleWriter();
    const files = { 'a.ts': 'same\n' };
    w.add({ files, author: 'owner', time: T0, message: 'v1' });
    const one = w.packedBytes;
    w.add({ files, author: 'owner', time: T0 + 1, message: 'v2' });
    // Only a commit is new: the tree and the blob are the same objects.
    expect(w.packedBytes - one).toBeLessThan(200);
  });

  it('keeps no control character or <> in an author', () => {
    const w = new GitBundleWriter();
    w.add({ files: { 'a.ts': 'x\n' }, author: 'a <b@c>\nd', time: T0, message: 'v1' });
    const b = path.join(dir, 'author.bundle');
    writeFileSync(b, w.finish().bytes);
    const r = path.join(dir, 'author');
    git(dir, 'clone', '-q', b, r);
    git(r, 'fsck', '--strict', '--no-dangling');
    expect(git(r, 'log', '--format=%an|%ae').trim()).toBe('a  b@c  d|');
  });
});
