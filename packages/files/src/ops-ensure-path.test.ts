import { describe, it, expect } from 'vitest';
import { ensureFolderPath } from './ops';

/**
 * The guards on agent-driven folder creation. `file_create` now brings a
 * missing folder chain into existence rather than refusing the write, so these
 * two refusals are what keeps that from becoming "any string makes folders":
 * both throw before the function touches the database, which is why they are
 * testable without one.
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

  it('refuses a chain deeper than the cap', async () => {
    const deep = ['files', 'a', 'b', 'c', 'd', 'e', 'f'].join('.');
    await expect(ensureFolderPath({ ownerId, path: deep })).rejects.toThrow(/deeper than/);
  });

  it('names folder_create in the depth refusal, so the caller has a way forward', async () => {
    const deep = 'files.a.b.c.d.e.f.g';
    await expect(ensureFolderPath({ ownerId, path: deep })).rejects.toThrow(/folder_create/);
  });
});
