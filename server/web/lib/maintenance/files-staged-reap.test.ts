/**
 * The `files-staged-reap` sweep (W8b fix round 1) skips the app, table,
 * spaces and sandbox stores even when one is mounted inside the files root,
 * and removes an old staging file beside them.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const KEYS = [
  'MANTLE_FILES_ROOT',
  'APP_DB_DIR',
  'TABLE_DB_DIR',
  'MANTLE_SPACES_ROOT',
  'SANDBOXES_DIR',
] as const;

describe('files-staged-reap', () => {
  let base = '';
  const prev: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
  const staged = () => `.${randomUUID()}.staged.tmp`;
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    );
  const old = async (p: string) => {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, 'x');
    const t = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(p, t, t);
    return p;
  };

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'mantle-staged-reap-'));
    for (const k of KEYS) prev[k] = process.env[k];
    const root = path.join(base, 'files');
    process.env.MANTLE_FILES_ROOT = root;
    process.env.APP_DB_DIR = path.join(root, 'app-dbs');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.SANDBOXES_DIR = path.join(root, 'sandboxes');
  });
  afterAll(async () => {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await rm(base, { recursive: true, force: true });
  });

  it('names every store it must not walk', async () => {
    const { stagedReapExclusions } = await import('./files-staged-reap');
    const ex = stagedReapExclusions().map((p) => path.resolve(p));
    for (const k of ['APP_DB_DIR', 'TABLE_DB_DIR', 'MANTLE_SPACES_ROOT', 'SANDBOXES_DIR'] as const) {
      expect(ex, k).toContain(path.resolve(process.env[k]!));
    }
  });

  it('removes an old staging file and leaves the stores inside the files root be', async () => {
    const { runFilesStagedReap, summariseFilesStagedReap } = await import('./files-staged-reap');
    const root = process.env.MANTLE_FILES_ROOT!;
    const kept = [
      await old(path.join(process.env.APP_DB_DIR!, 'owner', staged())),
      await old(path.join(process.env.TABLE_DB_DIR!, 'owner', staged())),
      await old(path.join(process.env.MANTLE_SPACES_ROOT!, 'space', 'files', staged())),
      await old(path.join(process.env.SANDBOXES_DIR!, 'box', 'files', staged())),
    ];
    const gone = await old(path.join(root, 'work', staged()));

    const dry = await runFilesStagedReap({ dryRun: true });
    expect(dry).toEqual({ removed: 1, skipped: null });
    expect(summariseFilesStagedReap(dry, true)).toMatch(/DRY RUN/);
    expect(await exists(gone)).toBe(true);

    const r = await runFilesStagedReap();
    expect(r).toEqual({ removed: 1, skipped: null });
    expect(summariseFilesStagedReap(r)).toBe('removed 1 leftover staging file(s)');
    expect(await exists(gone)).toBe(false);
    for (const p of kept) expect(await exists(p), p).toBe(true);
    expect(summariseFilesStagedReap(await runFilesStagedReap())).toBe(
      'no leftover staging files',
    );
  });
});
