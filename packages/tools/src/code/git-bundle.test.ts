/**
 * The bundle writer against the real `git`: clone the bundle, then log -p,
 * blame, bisect's rev-list and a strict fsck on what it gives. What an
 * outside agent does with app_export's git mode.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitBundleWriter, type BundleCommit, type BundleResult } from './git-bundle';

const dir = mkdtempSync(path.join(tmpdir(), 'git-bundle-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** git with no user config: the test reads only what the bundle says. A
 *  clone checks every object as it comes (transfer.fsckObjects). */
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'transfer.fsckObjects=true', ...args], {
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

let n = 0;
/** Write commits to a bundle file; its result and path. */
async function bundle(commits: BundleCommit[]): Promise<BundleResult & { file: string }> {
  const file = path.join(dir, `b${++n}.bundle`);
  const w = new GitBundleWriter(path.join(dir, `b${n}.work`));
  for (const c of commits) await w.add(c);
  return { ...(await w.finish(file)), file };
}

/** Clone a bundle and check it as strictly as git can. */
function clone(file: string): string {
  const repo = path.join(dir, `clone-${path.basename(file, '.bundle')}`);
  git(dir, 'clone', '-q', file, repo);
  git(repo, 'fsck', '--strict', '--no-dangling');
  return repo;
}

const SAMPLE: BundleCommit[] = [
  {
    files: { 'App.tsx': 'export default function App() {\n  return null;\n}\n' },
    author: 'owner',
    time: T0,
    message: 'v1 publish: first cut',
  },
  {
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
    gitNote: `add fmt\n\nlogin: ${LOGIN}`,
  },
  {
    files: {
      'App.tsx':
        "import { fmt } from './lib/fmt';\nexport default function App() {\n  return fmt(2);\n}\n",
      'lib/fmt.ts': 'export const fmt = (n: number) => `#${n}`;\n',
    },
    author: 'agent',
    time: T0 + 7200,
    message: 'v4 publish',
  },
];

describe('GitBundleWriter', () => {
  let res: BundleResult & { file: string };
  let repo = '';
  beforeAll(async () => {
    res = await bundle(SAMPLE);
    repo = clone(res.file);
  });

  it('is a bundle git verifies, clones and fscks strictly', () => {
    expect(git(repo, 'bundle', 'verify', res.file)).toContain('refs/heads/main');
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(res.head);
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main');
    expect(readFileSync(path.join(repo, 'App.tsx'), 'utf8')).toContain('fmt(2)');
    expect(existsSync(path.join(dir, 'b1.work'))).toBe(false);
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

  it('carries notes on their own ref, which git log shows once fetched', () => {
    expect(git(repo, 'ls-remote', res.file)).toMatch(/refs\/notes\/commits/);
    git(repo, 'fetch', '-q', 'origin', 'refs/notes/commits:refs/notes/commits');
    const notes = git(repo, 'log', '--format=%s|%N').trim().split('\n').filter(Boolean);
    expect(notes).toEqual([
      'v4 publish|',
      'v3 publish: add fmt|add fmt',
      `login: ${LOGIN}`,
      'v1 publish: first cut|',
    ]);
    git(repo, 'fsck', '--strict', '--no-dangling');
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

  it('gives the same commit ids for the same versions, every time', async () => {
    const again = await bundle(SAMPLE);
    expect(again.head).toBe(res.head);
    expect(readFileSync(again.file).equals(readFileSync(res.file))).toBe(true);
    // Key order in the stored tree does not matter.
    const a = await bundle([
      { files: { 'b.ts': '2\n', 'a.ts': '1\n' }, author: 'owner', time: T0, message: 'v1' },
    ]);
    const b = await bundle([
      { files: { 'a.ts': '1\n', 'b.ts': '2\n' }, author: 'owner', time: T0, message: 'v1' },
    ]);
    expect(a.head).toBe(b.head);
  });

  it('leaves out every name git refuses on a checkout or an fsck, so the bundle clones', async () => {
    const bad = [
      'GIT~1/config',
      '.g\u200cit/config',
      '.git::$INDEX_ALLOCATION/config',
      '.git /x',
      'a/.gitmodules',
      '.GITMODULES.',
      'gitmod~1',
      'gi7eba~1',
      '.gitattributes',
      'GI7D29~1',
      'g~123456',
      'gi~12345',
      'gi7eb~12',
      '~1234567',
      'x:y.ts',
    ];
    const res2 = await bundle([
      {
        files: { 'ok.ts': '1\n', ...Object.fromEntries(bad.map((p) => [p, '[core]\n'])) },
        author: 'owner',
        time: T0,
        message: 'v1',
      },
    ]);
    expect(res2.skipped.map((s) => s.path).sort()).toEqual([...bad].sort());
    const r = clone(res2.file);
    expect(git(r, 'ls-tree', '-r', '--name-only', 'HEAD').trim()).toBe('ok.ts');
  });

  it('keeps the plain key when two keys name one path, and says why', async () => {
    const res3 = await bundle([
      {
        files: { './a.ts': 'old key\n', 'a.ts': 'plain key\n', 'b/': 'x', 'b/c.ts': 'c\n' },
        author: 'owner',
        time: T0,
        message: 'v1',
      },
    ]);
    expect(res3.skipped).toEqual([
      { commit: 1, path: './a.ts', why: 'two keys name one path' },
      expect.objectContaining({ commit: 1, path: 'b/' }),
    ]);
    const r = clone(res3.file);
    expect(readFileSync(path.join(r, 'a.ts'), 'utf8')).toBe('plain key\n');
    expect(readFileSync(path.join(r, 'b/c.ts'), 'utf8')).toBe('c\n');
  });

  it('writes a blob two versions share once', async () => {
    const files = { 'a.ts': 'same\n' };
    const w = new GitBundleWriter(path.join(dir, 'share.work'));
    await w.add({ files, author: 'owner', time: T0, message: 'v1' });
    const one = w.packedBytes;
    await w.add({ files, author: 'owner', time: T0 + 1, message: 'v2' });
    // Only a commit is new: the tree and the blob are the same objects.
    expect(w.packedBytes - one).toBeLessThan(200);
    await w.discard();
    expect(existsSync(path.join(dir, 'share.work'))).toBe(false);
  });

  it('keeps no control character or <> in an author', async () => {
    const res4 = await bundle([
      { files: { 'a.ts': 'x\n' }, author: 'a <b@c>\nd', time: T0, message: 'v1' },
    ]);
    const r = clone(res4.file);
    expect(git(r, 'log', '--format=%an|%ae').trim()).toBe('a  b@c  d|');
  });
});
