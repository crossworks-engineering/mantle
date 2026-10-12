/**
 * The staging files a crash left beside a file create (W8b fix round 1):
 * `sweepStagedLeftovers` unlinks only `.<uuid>.staged.tmp` regular files an
 * hour old or more under the files root. It never follows a symlink, never
 * enters a dot folder or an excluded store, and walks nothing when the files
 * root itself sits inside an excluded store.
 */
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STAGED_LEFTOVER_NAME, sweepStagedLeftovers } from './disk';

let base: string;
let root: string;
let outside: string;

const HOUR = 60 * 60 * 1000;
const staged = () => `.${randomUUID()}.staged.tmp`;
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
/** Write `p` with its mtime `ageMs` in the past. */
async function put(p: string, ageMs: number, body = 'x'): Promise<string> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, body);
  const t = new Date(Date.now() - ageMs);
  await utimes(p, t, t);
  return p;
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'mantle-staged-sweep-'));
  root = path.join(base, 'files');
  outside = path.join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('STAGED_LEFTOVER_NAME', () => {
  it('matches the name a create stages under, and nothing near it', () => {
    expect(STAGED_LEFTOVER_NAME.test(staged())).toBe(true);
    for (const name of [
      `${randomUUID()}.staged.tmp`, // not dot-prefixed
      `.${randomUUID()}.staged.tmp.bak`,
      `.${randomUUID().toUpperCase()}.staged.tmp`,
      `.${randomUUID().slice(0, 35)}.staged.tmp`,
      `.${randomUUID()}x.staged.tmp`,
      `.${randomUUID()}.tmp`,
      `.${randomUUID()}.staged`,
      'report.staged.tmp',
      '.upload.part',
    ]) {
      expect(STAGED_LEFTOVER_NAME.test(name), name).toBe(false);
    }
  });
});

describe('sweepStagedLeftovers', () => {
  it('removes only old staging files, and only under the files root', async () => {
    const oldTop = await put(path.join(root, staged()), 2 * HOUR);
    const oldDeep = await put(path.join(root, 'work', 'acme', 'q3', staged()), 3 * HOUR);
    const fresh = await put(path.join(root, 'work', staged()), 10 * 60 * 1000);
    // Near names, old: user files that only look like staging files.
    const near = [
      await put(path.join(root, 'work', `${randomUUID()}.staged.tmp`), 5 * HOUR),
      await put(path.join(root, 'work', `.${randomUUID()}.staged.tmp.keep`), 5 * HOUR),
      await put(path.join(root, 'work', 'notes.tmp'), 5 * HOUR),
      await put(path.join(root, 'work', 'plain.txt'), 5 * HOUR),
    ];
    // A dot folder (the upload spool, thumbnails) is never entered.
    const inDot = await put(path.join(root, '.upload-spool', staged()), 5 * HOUR);
    // A staging-named DIRECTORY is not a file, and a dot folder: left be,
    // its content too.
    const dirNamed = path.join(root, 'work', staged());
    const insideDirNamed = await put(path.join(dirNamed, 'kept.txt'), 5 * HOUR);
    const insideDirStaged = await put(path.join(dirNamed, staged()), 5 * HOUR);

    // Dry run counts without removing.
    const dry = await sweepStagedLeftovers({ root, dryRun: true });
    expect(dry).toEqual({ removed: 2, skipped: null });
    expect(await exists(oldTop)).toBe(true);

    const r = await sweepStagedLeftovers({ root });
    expect(r).toEqual({ removed: 2, skipped: null });
    expect(await exists(oldTop)).toBe(false);
    expect(await exists(oldDeep)).toBe(false);
    expect(await exists(insideDirStaged)).toBe(true);
    expect(await exists(fresh)).toBe(true);
    for (const p of near) expect(await exists(p), p).toBe(true);
    expect(await exists(inDot)).toBe(true);
    expect(await exists(dirNamed)).toBe(true);
    expect(await exists(insideDirNamed)).toBe(true);

    // Idempotent: a second run finds nothing.
    expect(await sweepStagedLeftovers({ root })).toEqual({ removed: 0, skipped: null });
  });

  it('never follows a symlink: a linked file or folder keeps its target', async () => {
    const target = await put(path.join(outside, 'precious.bin'), 5 * HOUR, 'keep me');
    const targetDirFile = await put(path.join(outside, 'tree', staged()), 5 * HOUR);
    // A symlink named like a staging file, pointing at a file outside.
    const link = path.join(root, 'linked', staged());
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link);
    const old = new Date(Date.now() - 5 * HOUR);
    await utimes(target, old, old);
    // A symlinked folder holding an old staging file.
    await symlink(path.join(outside, 'tree'), path.join(root, 'linked', 'tree'));

    expect(await sweepStagedLeftovers({ root })).toEqual({ removed: 0, skipped: null });
    expect((await readFile(target)).toString()).toBe('keep me');
    expect(await exists(targetDirFile)).toBe(true);
    expect((await readdir(path.dirname(link))).sort()).toEqual(
      [path.basename(link), 'tree'].sort(),
    );
    await rm(path.join(root, 'linked'), { recursive: true, force: true });
  });

  it('never enters an excluded store mounted inside the files root', async () => {
    const appDbs = path.join(root, 'app-dbs');
    const inStore = await put(path.join(appDbs, 'owner', staged()), 5 * HOUR);
    const tables = path.join(root, 'work', 'tables');
    const inTables = await put(path.join(tables, staged()), 5 * HOUR);
    const beside = await put(path.join(root, 'work', staged()), 5 * HOUR);

    const r = await sweepStagedLeftovers({ root, exclude: [appDbs, tables, ''] });
    expect(r).toEqual({ removed: 1, skipped: null });
    expect(await exists(inStore)).toBe(true);
    expect(await exists(inTables)).toBe(true);
    expect(await exists(beside)).toBe(false);
    await rm(appDbs, { recursive: true, force: true });
    await rm(tables, { recursive: true, force: true });
  });

  it('walks nothing when the files root sits inside an excluded store, or is a link', async () => {
    const left = await put(path.join(root, staged()), 5 * HOUR);
    expect(await sweepStagedLeftovers({ root, exclude: [base] })).toEqual({
      removed: 0,
      skipped: 'the files root sits inside another store',
    });
    expect(await sweepStagedLeftovers({ root, exclude: [root] })).toMatchObject({ removed: 0 });
    const linkedRoot = path.join(base, 'files-link');
    await symlink(root, linkedRoot);
    expect(await sweepStagedLeftovers({ root: linkedRoot })).toEqual({
      removed: 0,
      skipped: 'the files root is not a directory',
    });
    expect(await sweepStagedLeftovers({ root: path.join(base, 'missing') })).toEqual({
      removed: 0,
      skipped: 'the files root does not exist',
    });
    expect(await exists(left)).toBe(true);
  });
});
