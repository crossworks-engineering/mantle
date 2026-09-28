/**
 * The deactivation purge refuses a read-only spaces root (member logins
 * Phase 4). The events worker mounts the spaces volume read-only: a purge
 * there would delete the rows and keep the bytes, leaving orphans nothing
 * counts. It must answer "skipped" before it touches the database at all,
 * so here any database use fails the test.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const refuse = () => {
    throw new Error('the purge reached the database');
  };
  return {
    ...actual,
    db: new Proxy({}, { get: refuse }),
  };
});

import { purgeDeactivatedSpaces } from './member-space-purge';

// Root ignores file modes, so a read-only directory proves nothing there.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe.skipIf(isRoot)('purgeDeactivatedSpaces on a read-only spaces root', () => {
  let dir: string;
  let spaces: string;
  const before = process.env.MANTLE_SPACES_ROOT;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mantle-purge-ro-'));
    spaces = path.join(dir, 'spaces');
    mkdirSync(spaces);
    process.env.MANTLE_SPACES_ROOT = spaces;
  });

  afterEach(() => {
    chmodSync(spaces, 0o755);
    rmSync(dir, { recursive: true, force: true });
    if (before === undefined) delete process.env.MANTLE_SPACES_ROOT;
    else process.env.MANTLE_SPACES_ROOT = before;
  });

  it('skips, and never reaches the database', async () => {
    chmodSync(spaces, 0o555);
    await expect(purgeDeactivatedSpaces()).resolves.toEqual({
      spaces: 0,
      items: 0,
      emptied: 0,
      skipped: 'the spaces root is read-only here',
    });
  });

  it('control: a writable root goes on to the database', async () => {
    await expect(purgeDeactivatedSpaces()).rejects.toThrow(/reached the database/);
  });
});
