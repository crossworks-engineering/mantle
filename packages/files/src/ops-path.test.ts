import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { renamedFolderPath } from './ops';

/**
 * The pure path math behind folder rename. The DB cascade then rewrites every
 * descendant's prefix from oldPath → this newPath, so getting the last-label
 * swap right is load-bearing.
 */
describe('renamedFolderPath', () => {
  it('swaps the last label, keeping the parent prefix', () => {
    expect(renamedFolderPath('files.work', 'archive')).toBe('files.archive');
    expect(renamedFolderPath('files.work.acme', 'beta')).toBe('files.work.beta');
    expect(renamedFolderPath('files.a.b.c', 'd')).toBe('files.a.b.d');
  });

  it('handles a single-label path (no dot) by returning just the new label', () => {
    // Callers reject renaming the `files` root, but the helper stays total.
    expect(renamedFolderPath('files', 'x')).toBe('x');
  });
});

/**
 * Drift tripwire for an asymmetry that is easy to "tidy up" into a bug.
 *
 * `upsertFile` INVENTS a name and then writes the bytes under it, so sanitising
 * (which lowercases) is correct — DB and disk agree because we chose both.
 * `syncFileFromDisk` is handed a file that already exists under a name the
 * operator chose, so sanitising records a name the filesystem does not have.
 * `data.filename` is what `diskPathForFile` rebuilds the path from, so on a
 * case-sensitive filesystem `loadFileBytes` then returns null and the extractor
 * indexes the FILENAME ALONE — while reporting success. A 1094-task Project
 * plan ingested as 23 characters that way.
 *
 * Asserted against the source because `syncFileFromDisk` needs a database and
 * this package's tests are pure by design.
 */
describe('filename handling: sanitise on write, preserve on sync', () => {
  // These three live in ops/files.ts since the ops.ts split; ops.ts is now a barrel.
  const SRC = readFileSync(new URL('./ops/files.ts', import.meta.url), 'utf8');
  const bodyOf = (fn: string) => {
    const start = SRC.indexOf(`export async function ${fn}(`);
    expect(start, `${fn} not found`).toBeGreaterThan(-1);
    const next = SRC.indexOf('\nexport ', start + 1);
    return SRC.slice(start, next > 0 ? next : SRC.length);
  };

  it('upsertFile sanitises — it names the file it is about to write', () => {
    expect(bodyOf('upsertFile')).toContain('sanitizeFilename(');
  });

  it('syncFileFromDisk does NOT sanitise — the file already has a name', () => {
    const body = bodyOf('syncFileFromDisk');
    expect(body).not.toContain('sanitizeFilename(');
    expect(body).toContain('isSafeDiskBasename(');
  });

  it('both disk-side lookups match case-insensitively, so old rows self-heal', () => {
    // Without this the fix would leave every previously-broken file with a
    // stale lowercase row beside a correctly-cased new one.
    for (const fn of ['syncFileFromDisk', 'deleteFileByPath']) {
      expect(bodyOf(fn), fn).toContain("lower(${nodes.data}->>'filename')");
    }
  });
});
