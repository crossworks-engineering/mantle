/**
 * The history trees go into a backup by hard links (apps audit 2026-10-02,
 * item 5): same inode, no copy; files still being written are left out.
 */
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linkHistoryTree } from './history-files';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('linkHistoryTree', () => {
  it('links every finished file, keeps the layout, skips partial ones', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'history-files-'));
    const src = path.join(dir, '_snapshots');
    await mkdir(path.join(src, 'owner', 'app'), { recursive: true });
    await writeFile(path.join(src, 'owner', 'app', 'a.sqlite'), 'a');
    await writeFile(path.join(src, 'owner', 'app', 'b.sqlite'), 'b');
    await writeFile(path.join(src, 'owner', 'app', 'c.sqlite.tmp-1-2'), 'partial');
    const dest = path.join(dir, 'backup', '_snapshots');

    expect(await linkHistoryTree(src, dest)).toEqual({ files: 2, copied: 0 });
    expect((await readdir(path.join(dest, 'owner', 'app'))).sort()).toEqual([
      'a.sqlite',
      'b.sqlite',
    ]);
    const [s, d] = await Promise.all([
      stat(path.join(src, 'owner', 'app', 'a.sqlite')),
      stat(path.join(dest, 'owner', 'app', 'a.sqlite')),
    ]);
    expect(d.ino).toBe(s.ino);
    // A second run over the same backup is fine.
    expect(await linkHistoryTree(src, dest)).toEqual({ files: 2, copied: 0 });
  });

  it('a missing tree is nothing to do', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'history-files-'));
    expect(await linkHistoryTree(path.join(dir, 'none'), path.join(dir, 'out'))).toEqual({
      files: 0,
      copied: 0,
    });
  });
});

describe('sweepCrashLeftovers', () => {
  it('removes old work files only, never a live file, and nothing young', async () => {
    const { sweepCrashLeftovers } = await import('./history-files');
    const { utimes } = await import('node:fs/promises');
    dir = await mkdtemp(path.join(tmpdir(), 'history-files-'));
    const owner = path.join(dir, 'owner');
    await mkdir(path.join(dir, '_tmp'), { recursive: true });
    await mkdir(owner, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const names = [
      'app.sqlite',
      'app.sqlite-wal',
      'app.draft.sqlite',
      '.schema-check-app-1-2.sqlite',
      'app.sqlite.restore-1-2',
      'snap.sqlite.tmp-1-2',
      'app.sqlite.restoring',
    ];
    for (const n of names) {
      await writeFile(path.join(owner, n), 'x');
      await utimes(path.join(owner, n), old, old);
    }
    await writeFile(path.join(owner, '.schema-check-young.sqlite'), 'x');
    await writeFile(path.join(dir, '_tmp', 'pkg.mantleapp'), 'x');
    await utimes(path.join(dir, '_tmp', 'pkg.mantleapp'), old, old);

    expect(await sweepCrashLeftovers([dir], { dryRun: true })).toBe(5);
    expect(await sweepCrashLeftovers([dir])).toBe(5);
    expect((await readdir(owner)).sort()).toEqual([
      '.schema-check-young.sqlite',
      'app.draft.sqlite',
      'app.sqlite',
      'app.sqlite-wal',
    ]);
    expect(await readdir(path.join(dir, '_tmp'))).toEqual([]);
  });
});
