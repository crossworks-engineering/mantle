/**
 * The bundle reader against what git makes (deltas by offset and by id,
 * the default `git bundle create`), and against hand-made hostile packs:
 * each refusal names its reason, and the limits stop bombs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitBundleWriter } from './git-bundle';
import {
  applyDelta,
  BUNDLE_READ_LIMITS,
  BundleReadError,
  readBundleHeader,
  readBundleTree,
} from './git-bundle-read';

const dir = mkdtempSync(path.join(tmpdir(), 'git-bundle-read-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env = {
  PATH: process.env.PATH,
  HOME: dir,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig'),
  GIT_AUTHOR_NAME: 'agent',
  GIT_AUTHOR_EMAIL: 'agent@example.invalid',
  GIT_COMMITTER_NAME: 'agent',
  GIT_COMMITTER_EMAIL: 'agent@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env });
const gitBuf = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', args, { cwd, env, ...(input !== undefined ? { input } : {}) });

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0) / 1000;
/** A long file, so later versions are stored as deltas. */
const big = (n: number) =>
  Array.from({ length: 400 }, (_, i) => `export const line${i} = ${i === 7 ? n : i};`).join('\n') +
  '\n';

let live = '';
let repo = '';
beforeAll(async () => {
  // The brain's export: two versions.
  const w = new GitBundleWriter(path.join(dir, 'x.work'));
  await w.add({ files: { 'App.tsx': big(1) }, author: 'owner', time: T0, message: 'v1 publish' });
  await w.add({
    files: { 'App.tsx': big(2), 'lib/fmt.ts': 'export const fmt = String;\n' },
    author: 'owner',
    time: T0 + 60,
    message: 'v2 publish',
  });
  live = (await w.finish(path.join(dir, 'export.bundle'))).head;
  // The outside agent clones, edits and commits twice.
  repo = path.join(dir, 'repo');
  git(dir, 'clone', '-q', path.join(dir, 'export.bundle'), repo);
  writeFileSync(path.join(repo, 'App.tsx'), big(3));
  git(repo, 'commit', '-qam', 'three');
  writeFileSync(path.join(repo, 'App.tsx'), big(4));
  writeFileSync(path.join(repo, 'lib', 'more.ts'), 'export const more = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'four');
});

const bundleOf = (cwd: string, name: string, ...revs: string[]) => {
  const file = path.join(dir, name);
  git(cwd, 'bundle', 'create', '-q', file, ...revs);
  return readFileSync(file);
};

describe('readBundleTree on what git makes', () => {
  it('reads the tip of a whole-branch bundle and finds the live commit in its history', async () => {
    const buf = bundleOf(repo, 'back.bundle', 'main');
    const r = await readBundleTree(buf, { base: live });
    expect(r.ref).toBe('refs/heads/main');
    expect(r.head).toBe(git(repo, 'rev-parse', 'main').trim());
    expect(r.hasBase).toBe(true);
    expect(r.files).toEqual({
      'App.tsx': big(4),
      'lib/fmt.ts': 'export const fmt = String;\n',
      'lib/more.ts': 'export const more = 1;\n',
    });
  });

  it('says so when the live commit is not in the history', async () => {
    const other = path.join(dir, 'other');
    mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(other, 'App.tsx'), big(9));
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'unrelated');
    const r = await readBundleTree(bundleOf(other, 'other.bundle', 'main'), { base: live });
    expect(r.hasBase).toBe(false);
  });

  it('rebuilds deltas by id (REF_DELTA) as well as by offset', async () => {
    const pack = gitBuf(
      repo,
      ['pack-objects', '--stdout', '--revs', '--window=10', '--depth=50'],
      'main\n',
    );
    const verify = path.join(dir, 'ref.pack');
    writeFileSync(verify, pack);
    gitBuf(repo, ['index-pack', verify]);
    expect(git(repo, 'verify-pack', '-v', verify)).toMatch(/chain length = 1/);
    const head = git(repo, 'rev-parse', 'main').trim();
    const buf = Buffer.concat([Buffer.from(`# v2 git bundle\n${head} refs/heads/main\n\n`), pack]);
    const r = await readBundleTree(buf, { base: live });
    expect(r.hasBase).toBe(true);
    expect(r.files['App.tsx']).toBe(big(4));
  });

  it('takes a named branch, and refuses one the bundle lacks', async () => {
    git(repo, 'branch', '-f', 'side', 'HEAD~1');
    const buf = bundleOf(repo, 'two.bundle', 'main', 'side');
    const r = await readBundleTree(buf, { base: live, branch: 'side' });
    expect(r.files['App.tsx']).toBe(big(3));
    await expect(readBundleTree(buf, { base: live, branch: 'nope' })).rejects.toThrow(
      /no ref 'nope'/,
    );
  });

  it('refuses a range bundle (it needs commits it does not hold)', async () => {
    const buf = bundleOf(repo, 'range.bundle', 'HEAD~1..main');
    await expect(readBundleTree(buf, { base: live })).rejects.toThrow(/does not hold/);
  });

  it('accepts an executable file, refuses a symlink and a submodule', async () => {
    const r2 = path.join(dir, 'modes');
    git(dir, 'clone', '-q', repo, r2);
    writeFileSync(path.join(r2, 'run.ts'), 'export {};\n');
    git(r2, 'add', 'run.ts');
    git(r2, 'update-index', '--chmod=+x', 'run.ts');
    git(r2, 'commit', '-qm', 'exec');
    const ok = await readBundleTree(bundleOf(r2, 'exec.bundle', 'main'), { base: live });
    expect(ok.files['run.ts']).toBe('export {};\n');

    symlinkSync('App.tsx', path.join(r2, 'link.tsx'));
    git(r2, 'add', 'link.tsx');
    git(r2, 'commit', '-qm', 'link');
    await expect(
      readBundleTree(bundleOf(r2, 'link.bundle', 'main'), { base: live }),
    ).rejects.toThrow(/link.tsx is a symlink/);
    git(r2, 'rm', '-q', 'link.tsx');
    git(r2, 'update-index', '--add', '--cacheinfo', `160000,${live},vendor`);
    git(r2, 'commit', '-qm', 'sub');
    await expect(
      readBundleTree(bundleOf(r2, 'sub.bundle', 'main'), { base: live }),
    ).rejects.toThrow(/vendor is a submodule/);
  });

  it('refuses a file that is not text, and more files than an app holds', async () => {
    const r3 = path.join(dir, 'bin');
    git(dir, 'clone', '-q', repo, r3);
    writeFileSync(path.join(r3, 'logo.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    git(r3, 'add', '-A');
    git(r3, 'commit', '-qm', 'bin');
    const buf = bundleOf(r3, 'bin.bundle', 'main');
    await expect(readBundleTree(buf, { base: live })).rejects.toThrow(/logo.bin is not UTF-8/);
    await expect(
      readBundleTree(bundleOf(repo, 'many.bundle', 'main'), {
        base: live,
        limits: { ...BUNDLE_READ_LIMITS, maxFiles: 2 },
      }),
    ).rejects.toThrow(/more than 2 files/);
  });

  it('stops at the delta depth and the work limit', async () => {
    const buf = bundleOf(repo, 'limits.bundle', 'main');
    await expect(
      readBundleTree(buf, { base: live, limits: { ...BUNDLE_READ_LIMITS, maxDeltaDepth: 0 } }),
    ).rejects.toThrow(/delta chain/);
    await expect(
      readBundleTree(buf, { base: live, limits: { ...BUNDLE_READ_LIMITS, maxWorkBytes: 20_000 } }),
    ).rejects.toThrow(/to unpack/);
  });

  it('refuses a damaged pack', async () => {
    const buf = Buffer.from(bundleOf(repo, 'bad.bundle', 'main'));
    buf[buf.length - 30] = buf[buf.length - 30]! ^ 0xff;
    await expect(readBundleTree(buf, { base: live })).rejects.toThrow(/checksum/);
  });
});

// ── Hand-made packs: what git would not make ────────────────────────────────

type Obj = { type: 'commit' | 'tree' | 'blob'; body: Buffer; size?: number; raw?: Buffer };
const CODE = { commit: 1, tree: 2, blob: 3 } as const;
const oid = (o: Obj) =>
  createHash('sha1').update(`${o.type} ${o.body.length}\0`).update(o.body).digest('hex');

function entryHead(type: number, size: number): Buffer {
  const out = [(type << 4) | (size & 0x0f)];
  let s = Math.floor(size / 16);
  while (s > 0) {
    out[out.length - 1] = out[out.length - 1]! | 0x80;
    out.push(s & 0x7f);
    s = Math.floor(s / 128);
  }
  return Buffer.from(out);
}

/** A bundle of whole objects; `size` lies about an object's size, `raw`
 *  replaces its zlib data. */
function handBundle(objs: Obj[], head: string): Buffer {
  const parts: Buffer[] = [];
  const h = Buffer.alloc(12);
  h.write('PACK', 0, 'latin1');
  h.writeUInt32BE(2, 4);
  h.writeUInt32BE(objs.length, 8);
  parts.push(h);
  for (const o of objs) {
    parts.push(entryHead(CODE[o.type], o.size ?? o.body.length), o.raw ?? deflateSync(o.body));
  }
  const pack = Buffer.concat(parts);
  const sum = createHash('sha1').update(pack).digest();
  return Buffer.concat([Buffer.from(`# v2 git bundle\n${head} refs/heads/main\n\n`), pack, sum]);
}

const blob = (text: string): Obj => ({ type: 'blob', body: Buffer.from(text) });
const tree = (entries: { mode: string; name: string; id: string }[]): Obj => ({
  type: 'tree',
  body: Buffer.concat(
    entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.id, 'hex')]),
  ),
});
const commit = (treeId: string): Obj => ({
  type: 'commit',
  body: Buffer.from(`tree ${treeId}\nauthor a <> 0 +0000\ncommitter a <> 0 +0000\n\nx\n`),
});

/** A one-file commit with the given tree entry. */
function oneEntry(mode: string, name: string): Buffer {
  const b = blob('x\n');
  const t = tree([{ mode, name, id: oid(b) }]);
  const c = commit(oid(t));
  return handBundle([b, t, c], oid(c));
}

describe('readBundleTree on hand-made packs', () => {
  it('reads a plain hand-made pack', async () => {
    const r = await readBundleTree(oneEntry('100644', 'App.tsx'), { base: 'f'.repeat(40) });
    expect(r.files).toEqual({ 'App.tsx': 'x\n' });
    expect(r.hasBase).toBe(false);
  });

  it.each([
    ['100664', 'odd.ts', /file mode 100664/],
    ['100644', '..', /may not be imported/],
    ['100644', '.git', /'.git' part/],
    ['100644', '.gitmodules', /'.gitmodules'/],
    ['100644', 'GIT~1', /'.git' part/],
    ['100644', 'a:b', /':' in a name/],
    ['40000', '.', /may not be imported/],
  ])('refuses mode %s name %s', async (mode, name, why) => {
    await expect(readBundleTree(oneEntry(mode, name), { base: live })).rejects.toThrow(why);
  });

  it('refuses a name or a path past its length before it reads it', async () => {
    await expect(
      readBundleTree(oneEntry('100644', 'a'.repeat(256)), { base: live }),
    ).rejects.toThrow(/too long/);
    const b = blob('x');
    const deep = tree([{ mode: '100644', name: 'b'.repeat(200), id: oid(b) }]);
    const top = tree([{ mode: '40000', name: 'a'.repeat(100), id: oid(deep) }]);
    const c = commit(oid(top));
    await expect(
      readBundleTree(handBundle([b, deep, top, c], oid(c)), { base: live }),
    ).rejects.toThrow(/at most 256 bytes/);
  });

  it('refuses a name twice in one folder', async () => {
    const b = blob('x\n');
    const t = tree([
      { mode: '100644', name: 'a.ts', id: oid(b) },
      { mode: '100644', name: 'a.ts', id: oid(b) },
    ]);
    const c = commit(oid(t));
    await expect(readBundleTree(handBundle([b, t, c], oid(c)), { base: live })).rejects.toThrow(
      /twice/,
    );
  });

  it('refuses a zlib bomb: an object that inflates past the size it says', async () => {
    const b: Obj = { ...blob('x'.repeat(1_000_000)), size: 10 };
    const t = tree([{ mode: '100644', name: 'a.ts', id: oid(b) }]);
    const c = commit(oid(t));
    await expect(readBundleTree(handBundle([b, t, c], oid(c)), { base: live })).rejects.toThrow(
      /does not inflate to the size/,
    );
  });

  it('refuses an object past the size limit before it inflates', async () => {
    const b: Obj = { ...blob('x'), size: 1 << 30 };
    await expect(readBundleTree(handBundle([b], 'a'.repeat(40)), { base: live })).rejects.toThrow(
      /object past 1 MB/,
    );
  });

  it('refuses a ref to a commit the pack lacks, and a tree as the tip', async () => {
    const b = blob('x');
    await expect(readBundleTree(handBundle([b], 'a'.repeat(40)), { base: live })).rejects.toThrow(
      /does not hold/,
    );
    await expect(readBundleTree(handBundle([b], oid(b)), { base: live })).rejects.toThrow(
      /is a blob/,
    );
  });

  it('refuses a header that is not a bundle, a v3 filter, or a bad ref line', () => {
    expect(() => readBundleHeader(Buffer.from('PK\x03\x04 zip'))).toThrow(BundleReadError);
    expect(() =>
      readBundleHeader(
        Buffer.from(`# v3 git bundle\n@filter=blob:none\n${'a'.repeat(40)} HEAD\n\n`),
      ),
    ).toThrow(/@filter/);
    expect(() => readBundleHeader(Buffer.from('# v2 git bundle\nnot a ref\n\n'))).toThrow(
      /not a ref/,
    );
    const id = 'a'.repeat(40);
    expect(() =>
      readBundleHeader(Buffer.from(`# v2 git bundle\n${id} refs/heads/${'x'.repeat(300)}\n\n`)),
    ).toThrow(/ref name/);
    expect(() =>
      readBundleHeader(Buffer.from(`# v2 git bundle\n${id} refs/heads/a\tb\n\n`)),
    ).toThrow(/ref name/);
  });
});

describe('applyDelta', () => {
  const base = Buffer.from('hello world');
  const sz = (n: number) => [n];
  it('copies and inserts', () => {
    const d = Buffer.from([...sz(11), ...sz(8), 0x91, 6, 5, 3, 0x41, 0x42, 0x43]);
    expect(applyDelta(base, d, 100).toString()).toBe('worldABC');
  });
  it('refuses a copy outside the base, an insert past the end, a wrong base size', () => {
    expect(() => applyDelta(base, Buffer.from([11, 5, 0x91, 9, 5]), 100)).toThrow(
      /outside its base/,
    );
    expect(() => applyDelta(base, Buffer.from([11, 2, 3, 0x41, 0x42, 0x43]), 100)).toThrow(
      /inserts past/,
    );
    expect(() => applyDelta(base, Buffer.from([10, 1, 1, 0x41]), 100)).toThrow(/another base/);
    expect(() => applyDelta(base, Buffer.from([11, 1, 0]), 100)).toThrow(/reserved/);
    expect(() => applyDelta(base, Buffer.from([11, 0x80, 0x80, 0x40]), 100)).toThrow(/past/);
  });
});
