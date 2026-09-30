import { describe, it, expect } from 'vitest';
import { ensureFolderPath } from './ops';
import { assertFilesFolderDepth, clampFilesFolderPath, filesFolderDepth } from './paths';

/**
 * The guards on agent-driven folder creation. `file_create` brings a missing
 * folder chain into existence rather than refusing the write; the root check
 * keeps that from becoming "any string makes a root", and the depth clamp
 * keeps a long chain to three folders. Both run before the database is
 * touched, which is why they are testable without one.
 */
describe('ensureFolderPath — refuses before it creates', () => {
  const ownerId = '00000000-0000-4000-8000-000000000000';

  it('refuses a path outside the files root', async () => {
    // Creating a new TOP-LEVEL root is a different act from filing something,
    // and no skill should reach it by naming a folder.
    for (const path of ['pages.diagrams', 'secrets.keys', 'notes', 'diagrams']) {
      await expect(ensureFolderPath({ ownerId, path })).rejects.toThrow(/not under 'files'/);
    }
  });
});

describe('folder depth: three levels below files', () => {
  it('clamps a deeper chain into its third folder', () => {
    expect(clampFilesFolderPath('files.a.b.c.d.e.f')).toBe('files.a.b.c');
    expect(clampFilesFolderPath('files.a')).toBe('files.a');
  });

  it('measures and refuses depth', () => {
    expect(filesFolderDepth('files')).toBe(0);
    expect(filesFolderDepth('files.a.b.c')).toBe(3);
    expect(() => assertFilesFolderDepth('files.a.b.c', 'op')).not.toThrow();
    expect(() => assertFilesFolderDepth('files.a.b.c.d', 'op')).toThrow(/deeper than 3/);
  });
});
