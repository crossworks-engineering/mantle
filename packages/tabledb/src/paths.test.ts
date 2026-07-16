import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tableDbRoot } from './paths';

describe('tableDbRoot default', () => {
  const saved = process.env.TABLE_DB_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.TABLE_DB_DIR;
    else process.env.TABLE_DB_DIR = saved;
  });

  it('honors TABLE_DB_DIR when set (prod bind mount)', () => {
    process.env.TABLE_DB_DIR = '/data/table-dbs';
    expect(tableDbRoot()).toBe('/data/table-dbs');
  });

  it('falls back to a single monorepo-root .table-dbs, not a per-app cwd', () => {
    // The old default was path.join(process.cwd(), '.table-dbs'), which made
    // web (cwd apps/web) and api (cwd apps/api) disagree → TableFileMissing 500.
    delete process.env.TABLE_DB_DIR;
    const root = tableDbRoot();
    expect(path.isAbsolute(root)).toBe(true);
    expect(path.basename(root)).toBe('.table-dbs');
    // Its parent must be the workspace root (the dir holding pnpm-workspace.yaml),
    // so every workspace process resolves the same directory regardless of cwd.
    expect(fs.existsSync(path.join(path.dirname(root), 'pnpm-workspace.yaml'))).toBe(true);
    expect(root).not.toContain(`${path.sep}apps${path.sep}`);
  });
});
