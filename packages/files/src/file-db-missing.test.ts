/**
 * A missing file database (file-db-missing.ts), the one rule of the coverage
 * check's `noDb` and of `pipeline_reread` with `missing`: on a temporary
 * files root with real names and words; no database server.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dbExpected,
  fileDbKeyOf,
  fileWasRead,
  heldDatabaseKeys,
  missesDatabase,
  type ReadStateFile,
} from './file-db-missing';
import { fileDbPaths, listFileDbFolder, writeFileDbNone } from './file-dbs';

const SHA = 'c'.repeat(64);
const DB_EXTS = new Set(['xlsx', 'csv', 'msg', 'pdf', 'xml']);
const READ = { extract_completed_at: '2026-06-01T00:00:00Z', sha256: SHA };

let n = 0;
const file = (ext: string, data: Record<string, unknown> = READ): ReadStateFile => ({
  id: `33333333-3333-4333-8333-${String(++n).padStart(12, '0')}`,
  ext,
  data,
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mantle-file-db-missing-'));
  vi.stubEnv('MANTLE_FILES_ROOT', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('dbExpected', () => {
  it('expects a database where a Reader takes every file of the type', () => {
    expect(dbExpected('xlsx', DB_EXTS)).toBe(true);
    expect(dbExpected('msg', DB_EXTS)).toBe(true);
    expect(dbExpected('docx', DB_EXTS)).toBe(false);
    expect(dbExpected('pdf', DB_EXTS)).toBe(false);
    expect(dbExpected('xml', DB_EXTS)).toBe(false);
  });
});

describe('fileWasRead', () => {
  it('is true for indexed and partial, false for every other state', () => {
    expect(fileWasRead(READ)).toBe(true);
    expect(
      fileWasRead({
        ...READ,
        read_cut: { sheet_rows: { what: 'rows', read: 1, total: 2, limit: 1 } },
      }),
    ).toBe(true);
    expect(fileWasRead({ sha256: SHA })).toBe(false);
    expect(fileWasRead({ extract_skipped: { reason: 'no_parser' } })).toBe(false);
    expect(fileWasRead({ ...READ, indexing_applied: 'metadata' })).toBe(false);
  });
});

describe('heldDatabaseKeys and missesDatabase', () => {
  it('a database or a word of no-rows or too-large holds; unreadable and nothing do not', async () => {
    const built = file('xlsx');
    const noRows = file('xlsx');
    const tooLarge = file('csv');
    const unreadable = file('csv');
    const nothing = file('msg');
    const older = file('xlsx');
    const sqlite = fileDbPaths(built.id, SHA)!.sqlite;
    mkdirSync(path.dirname(sqlite), { recursive: true });
    writeFileSync(sqlite, 'x');
    await writeFileDbNone(noRows.id, SHA, 'no-rows');
    await writeFileDbNone(tooLarge.id, SHA, 'too-large');
    await writeFileDbNone(unreadable.id, SHA, 'unreadable');
    // A name of other bytes holds nothing for these.
    const otherBytes = fileDbPaths(older.id, 'd'.repeat(64))!.sqlite;
    writeFileSync(otherBytes, 'x');
    const all = [built, noRows, tooLarge, unreadable, nothing, older];
    const held = await heldDatabaseKeys(await listFileDbFolder(), all);
    expect(all.map((f) => held.has(fileDbKeyOf(f)!))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(all.map((f) => missesDatabase(f, DB_EXTS, held))).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it('judges only read files of a type that expects a database', () => {
    const held = new Set<string>();
    expect(missesDatabase(file('docx'), DB_EXTS, held)).toBe(false);
    expect(missesDatabase(file('pdf'), DB_EXTS, held)).toBe(false);
    expect(missesDatabase(file('xlsx', { sha256: SHA }), DB_EXTS, held)).toBe(false);
    expect(
      missesDatabase(file('xlsx', { extract_skipped: { reason: 'no_parser' } }), DB_EXTS, held),
    ).toBe(false);
    expect(missesDatabase(file('xlsx'), DB_EXTS, held)).toBe(true);
    // No checksum: nothing can name its database, so it has none.
    expect(missesDatabase(file('xlsx', { extract_completed_at: 'x' }), DB_EXTS, held)).toBe(true);
  });
});
