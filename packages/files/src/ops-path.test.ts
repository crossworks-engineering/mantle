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
