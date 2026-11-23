/**
 * The coverage check's counting rule (file-coverage.ts), on made-up rows:
 * the read states, the "not full" rule (failed, a skip that is not an empty
 * body, no reader, a shortcut cut, no database where one is expected), the
 * route of a type, and the audit line (numbers by type only).
 */
import { describe, expect, it } from 'vitest';
import {
  coverageCheck,
  coverageOf,
  dbExpected,
  routeOfExt,
  type CoverageFile,
} from './file-coverage';

const SHA = 'a'.repeat(64);
const DB_EXTS = new Set(['xlsx', 'xls', 'csv', 'pdf', 'dwg', 'xml', 'tif']);
const done = { extract_completed_at: '2026-11-23T00:00:00Z', sha256: SHA };

let n = 0;
const file = (ext: string, data: Record<string, unknown>): CoverageFile => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  ext,
  data,
});

describe('routeOfExt', () => {
  it('names how each kind of type is read', () => {
    expect(routeOfExt('txt', DB_EXTS)).toBe('text');
    expect(routeOfExt('docx', DB_EXTS)).toBe('parser');
    expect(routeOfExt('dwg', DB_EXTS)).toBe('parser');
    expect(routeOfExt('png', DB_EXTS)).toBe('vision');
    expect(routeOfExt('mp4', DB_EXTS)).toBe('media');
    expect(routeOfExt('mpp', DB_EXTS)).toBe('export');
    expect(routeOfExt('eml', DB_EXTS)).toBe('none');
    expect(routeOfExt('log', DB_EXTS)).toBe('none');
  });

  it('takes a type with only an own Reader as a pipeline', () => {
    expect(routeOfExt('ifc', new Set(['ifc']))).toBe('pipeline');
  });
});

describe('dbExpected', () => {
  it('expects a database where a Reader takes every file of the type', () => {
    expect(dbExpected('xlsx', DB_EXTS)).toBe(true);
    expect(dbExpected('dwg', DB_EXTS)).toBe(true);
    expect(dbExpected('docx', DB_EXTS)).toBe(false);
    // The router sends only some PDFs to a Reader; a Reader takes only
    // some XML and TIFF files.
    expect(dbExpected('pdf', DB_EXTS)).toBe(false);
    expect(dbExpected('xml', DB_EXTS)).toBe(false);
    expect(dbExpected('tif', DB_EXTS)).toBe(false);
  });
});

describe('coverageOf', () => {
  it('counts the states and the files not read in full', () => {
    const withDb = file('xlsx', done);
    const noDb = file('xlsx', done);
    const shortcut = file('xlsx', {
      ...done,
      read_cut: { sheet_rows: { what: 'rows', read: 5000, total: 9000, limit: 5000 } },
    });
    const failed = file('xlsx', {
      sha256: SHA,
      extract_skipped: { reason: 'document_unreadable' },
    });
    const pending = file('xlsx', { sha256: SHA });
    const named = new Set([
      `${withDb.id}.${SHA.slice(0, 16)}`,
      `${shortcut.id}.${SHA.slice(0, 16)}`,
    ]);
    const [row] = coverageOf([withDb, noDb, shortcut, failed, pending], DB_EXTS, named);
    expect(row).toMatchObject({
      ext: 'xlsx',
      route: 'parser',
      popular: true,
      files: 5,
      indexed: 2,
      partial: 1,
      failed: 1,
      pending: 1,
      withDb: 2,
      noDb: 1,
      shortcut: 1,
      // noDb, shortcut, failed; the pending file is not counted.
      notFull: 3,
      reasons: { document_unreadable: 1 },
      cuts: { sheet_rows: 1 },
    });
    void noDb;
  });

  it('counts a safety cut, but not as a shortfall', () => {
    const big = file('docx', {
      ...done,
      read_cut: { text_store: { what: 'characters', read: 1, total: 2, limit: 1 } },
    });
    const [row] = coverageOf([big], DB_EXTS, new Set());
    expect(row).toMatchObject({ partial: 1, shortcut: 0, notFull: 0, withDb: null });
    expect(row!.cuts).toEqual({ text_store: 1 });
  });

  it('takes an empty file as read, any other skip as not full', () => {
    const empty = file('txt', { extract_skipped: { reason: 'body_too_short' } });
    const noParser = file('dwg', { extract_skipped: { reason: 'no_parser' } });
    const rows = coverageOf([empty, noParser], DB_EXTS, new Set());
    const txt = rows.find((r) => r.ext === 'txt')!;
    const dwg = rows.find((r) => r.ext === 'dwg')!;
    expect(txt).toMatchObject({ skipped: 1, notFull: 0 });
    // A skipped file is not read, so it is not judged for a database too.
    expect(dwg).toMatchObject({ skipped: 1, notFull: 1, noDb: 0, reasons: { no_parser: 1 } });
  });

  it('counts a read file of a type no reader takes as not full', () => {
    const rows = coverageOf(
      [file('eml', done), file('eml', { indexing_applied: 'metadata' })],
      DB_EXTS,
      new Set(),
    );
    expect(rows[0]).toMatchObject({ route: 'none', indexed: 1, nameOnly: 1, notFull: 1 });
  });

  it('keeps an archive indexed: its detail cut is no shortfall', () => {
    const zip = file('zip', {
      ...done,
      read_cut: { archive: { what: 'entries', read: 0, total: 3 } },
    });
    const [row] = coverageOf([zip], DB_EXTS, new Set());
    expect(row).toMatchObject({ indexed: 1, partial: 0, notFull: 0 });
  });

  it('sorts by file count', () => {
    const rows = coverageOf(
      [file('md', done), file('csv', done), file('csv', done)],
      DB_EXTS,
      new Set(),
    );
    expect(rows.map((r) => r.ext)).toEqual(['csv', 'md']);
  });
});

describe('coverageCheck', () => {
  it('counts only the popular types and names types and numbers only', () => {
    const rows = coverageOf(
      [
        file('xlsx', { extract_skipped: { reason: 'document_unreadable' } }),
        file('xlsx', { extract_skipped: { reason: 'document_unreadable' } }),
        file('eml', done),
        file('log', done),
      ],
      DB_EXTS,
      new Set(),
    );
    const check = coverageCheck(rows);
    expect(check).toMatchObject({ key: 'file_coverage', count: 3, ok: false, capped: false });
    expect(check.samples).toEqual([
      {
        id: 'xlsx',
        kind: 'type',
        detail: '2 of 2 not full (failed 2, skipped 0, shortcut cuts 0, no database 0)',
      },
      {
        id: 'eml',
        kind: 'type',
        detail: '1 of 1 not full (failed 0, skipped 0, no reader, shortcut cuts 0)',
      },
    ]);
  });

  it('is ok with nothing to report', () => {
    expect(coverageCheck([])).toMatchObject({ count: 0, ok: true, samples: [] });
  });
});
