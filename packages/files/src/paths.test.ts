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
    expect(diskPathForLtree('files.lister_printer')).toBe(path.join(FAKE_ROOT, 'lister-printer'));
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

  it("returns null when the parent isn't under files", async () => {
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

describe('isSafeDiskBasename + the watcher round-trip', () => {
  it('PRESERVES case — the bug this exists to prevent', async () => {
    const { isSafeDiskBasename } = await freshPaths();
    // sanitizeFilename lowercases, which is right when we invent a name for
    // bytes we are about to write and WRONG for a file already on disk. A real
    // plan dropped into a watched folder as 30257_NATREF_260726.xml was recorded
    // as ..._natref_..., so diskPathForFile resolved to a path that does not
    // exist on a case-sensitive filesystem. loadFileBytes returned null and the
    // extractor indexed the FILENAME ALONE while reporting success.
    expect(isSafeDiskBasename('30257_NATREF_260726.xml')).toBe(true);
    expect(isSafeDiskBasename('Plan.XML')).toBe(true);
  });

  it('round-trips a disk path through ltreeForDiskPath and back, unchanged', async () => {
    const { ltreeForDiskPath, diskPathForFile } = await freshPaths();
    const abs = path.join(FAKE_ROOT, 'natref-project-plan', '30257_NATREF_260726.xml');
    const loc = ltreeForDiskPath(abs);
    expect(loc).not.toBeNull();
    // THE invariant: what the watcher reads off disk must rebuild the same path.
    expect(diskPathForFile(loc!.parentPath, loc!.filename)).toBe(abs);
  });

  it('rejects anything that is not a plain basename', async () => {
    const { isSafeDiskBasename, diskPathForFile } = await freshPaths();
    for (const bad of ['', '   ', '.', '..', 'a/b.txt', 'a\\b.txt', '../escape.txt']) {
      expect(isSafeDiskBasename(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(diskPathForFile('files.docs', '../escape.txt')).toBeNull();
  });

  it('tolerates the names operators actually use', async () => {
    const { isSafeDiskBasename } = await freshPaths();
    for (const ok of ['Report 2026 Q3.pdf', 'plan (final).xlsx', 'résumé.docx', 'a.b.c.xml']) {
      expect(isSafeDiskBasename(ok), ok).toBe(true);
    }
  });
});
