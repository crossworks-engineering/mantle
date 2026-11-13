/**
 * withDataView: whether Files shows a file's Data view, by file_sql's rule.
 * A table type has one; an XML only with a name at its bytes (most XML is no
 * plan); a PDF only with a database (most PDFs are documents). On a
 * temporary files root; no database.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withDataView } from './file-data';
import { fileDbPaths, fileDbsDir } from './file-dbs';

const SHA = 'a'.repeat(64);
const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mantle-data-view-'));
  vi.stubEnv('MANTLE_FILES_ROOT', root);
  mkdirSync(fileDbsDir(), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const touch = (abs: string, body = 'x') => writeFileSync(abs, body);

describe('withDataView', () => {
  it('a CSV has one, built or not; a text file has none', async () => {
    const rows = [
      { id: id(1), filename: 'Pumps.CSV', sha256: SHA },
      { id: id(2), filename: 'notes.txt', sha256: SHA },
    ];
    const out = await withDataView(rows);
    expect(out.map((r) => r.dataView)).toEqual([true, false]);
    expect(out[0]).toEqual({ ...rows[0], dataView: true });
  });

  it('a PDF only with a database: a drawing has one, a document has none', async () => {
    touch(fileDbPaths(id(1), SHA)!.sqlite);
    // A word alone (a PDF the parser could not read) is no database.
    touch(fileDbPaths(id(3), SHA)!.none, 'unreadable\n');
    const out = await withDataView([
      { id: id(1), filename: 'drawing.pdf', sha256: SHA },
      { id: id(2), filename: 'report.pdf', sha256: SHA },
      { id: id(3), filename: 'scan.pdf', sha256: SHA },
    ]);
    expect(out.map((r) => r.dataView)).toEqual([true, false, false]);
  });

  it('an XML only with a name at its bytes: a plan has one, other XML none', async () => {
    touch(fileDbPaths(id(1), SHA)!.sqlite);
    touch(fileDbPaths(id(2), SHA)!.none, 'no-rows\n');
    const out = await withDataView([
      { id: id(1), filename: 'plan.xml', sha256: SHA },
      { id: id(2), filename: 'empty-plan.xml', sha256: SHA },
      { id: id(3), filename: 'feed.xml', sha256: SHA },
      { id: id(4), filename: 'nosha.xml', sha256: null },
    ]);
    expect(out.map((r) => r.dataView)).toEqual([true, true, false, false]);
  });

  it('a name of other bytes does not count', async () => {
    touch(fileDbPaths(id(1), 'b'.repeat(64))!.sqlite);
    const [row] = await withDataView([{ id: id(1), filename: 'drawing.pdf', sha256: SHA }]);
    expect(row!.dataView).toBe(false);
  });
});
