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
