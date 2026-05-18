/**
 * Path-resolver tests. These functions decide which on-disk locations
 * are inside the host-mirrored `files.*` subtree and which aren't. A
 * regression here would either:
 *
 *   - Let a malformed ltree escape the root via `..` traversal, or
 *   - Wrongly classify a real subpath as out-of-tree and refuse writes.
 *
 * We set MANTLE_FILES_ROOT to a deterministic absolute path for every
 * test so behaviour doesn't depend on the dev's checkout location.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const FAKE_ROOT = path.resolve('/tmp/mantle-files-test-root');

async function freshPaths() {
  vi.resetModules();
  return (await import('./paths')) as typeof import('./paths');
}

beforeEach(() => {
  process.env.MANTLE_FILES_ROOT = FAKE_ROOT;
});

afterEach(() => {
  delete process.env.MANTLE_FILES_ROOT;
});

describe('isFilesPath', () => {
  it('accepts the root label itself', async () => {
    const { isFilesPath } = await freshPaths();
    expect(isFilesPath('files')).toBe(true);
  });

  it('accepts descendants', async () => {
    const { isFilesPath } = await freshPaths();
    expect(isFilesPath('files.work')).toBe(true);
    expect(isFilesPath('files.work.lister_printer')).toBe(true);
  });

  it('rejects unrelated trees', async () => {
    const { isFilesPath } = await freshPaths();
    expect(isFilesPath('inbox.email')).toBe(false);
    expect(isFilesPath('secrets')).toBe(false);
    expect(isFilesPath('filesx')).toBe(false); // prefix-not-segment
  });
});

describe('diskPathForLtree', () => {
  it('returns the root for "files"', async () => {
    const { diskPathForLtree } = await freshPaths();
    expect(diskPathForLtree('files')).toBe(FAKE_ROOT);
  });

  it('converts underscores to dashes per segment', async () => {
    const { diskPathForLtree } = await freshPaths();
    expect(diskPathForLtree('files.lister_printer')).toBe(
      path.join(FAKE_ROOT, 'lister-printer'),
    );
  });

  it('handles nested ltree paths', async () => {
    const { diskPathForLtree } = await freshPaths();
    expect(diskPathForLtree('files.work.lister_printer.v2')).toBe(
      path.join(FAKE_ROOT, 'work', 'lister-printer', 'v2'),
    );
  });

  it('returns null for paths outside files.*', async () => {
    const { diskPathForLtree } = await freshPaths();
    expect(diskPathForLtree('inbox.work')).toBeNull();
  });
});

describe('diskPathForFile', () => {
  it('joins parent dir with filename', async () => {
    const { diskPathForFile } = await freshPaths();
    expect(diskPathForFile('files.work', 'notes.md')).toBe(
      path.join(FAKE_ROOT, 'work', 'notes.md'),
    );
  });

  it('refuses filenames that contain separators', async () => {
    const { diskPathForFile } = await freshPaths();
    expect(diskPathForFile('files.work', 'foo/bar.md')).toBeNull();
    expect(diskPathForFile('files.work', 'foo\\bar.md')).toBeNull();
  });

  it('returns null when the parent isn\'t under files', async () => {
    const { diskPathForFile } = await freshPaths();
    expect(diskPathForFile('inbox.work', 'notes.md')).toBeNull();
  });
});

describe('ltreeForDiskPath (reverse map)', () => {
  it('round-trips a typical disk path', async () => {
    const { ltreeForDiskPath } = await freshPaths();
    const disk = path.join(FAKE_ROOT, 'work', 'lister-printer', 'notes.md');
    expect(ltreeForDiskPath(disk)).toEqual({
      parentPath: 'files.work.lister_printer',
      filename: 'notes.md',
    });
  });

  it('handles a file at the root', async () => {
    const { ltreeForDiskPath } = await freshPaths();
    const disk = path.join(FAKE_ROOT, 'top-level.md');
    expect(ltreeForDiskPath(disk)).toEqual({
      parentPath: 'files',
      filename: 'top-level.md',
    });
  });

  it('refuses paths outside the root', async () => {
    const { ltreeForDiskPath } = await freshPaths();
    expect(ltreeForDiskPath('/etc/passwd')).toBeNull();
    expect(ltreeForDiskPath('/tmp/elsewhere/foo.md')).toBeNull();
  });

  it('refuses traversal attempts that would escape the root', async () => {
    const { ltreeForDiskPath } = await freshPaths();
    const escape = path.join(FAKE_ROOT, '..', 'outside.md');
    expect(ltreeForDiskPath(escape)).toBeNull();
  });

  it('reverses dashToLtree on segments containing dashes', async () => {
    const { ltreeForDiskPath } = await freshPaths();
    const disk = path.join(FAKE_ROOT, 'a-b-c', 'file.md');
    expect(ltreeForDiskPath(disk)).toEqual({
      parentPath: 'files.a_b_c',
      filename: 'file.md',
    });
  });

  it('round-trips diskPathForFile ∘ ltreeForDiskPath', async () => {
    const { diskPathForFile, ltreeForDiskPath } = await freshPaths();
    const original = { parentPath: 'files.work.x_y', filename: 'doc.md' };
    const disk = diskPathForFile(original.parentPath, original.filename);
    expect(disk).not.toBeNull();
    expect(ltreeForDiskPath(disk!)).toEqual(original);
  });
});
