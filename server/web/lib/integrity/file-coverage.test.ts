/**
 * The coverage check's counting rule (file-coverage.ts), on made-up rows:
 * the read states, the "not full" rule (failed, a skip that is not an empty
 * body, no reader, a shortcut cut, no database where one is expected), the
 * route of a type, and the audit line (numbers by type only).
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_PIPELINES, dbExtsOf } from '@mantle/files/pipelines/builtin';
import {
  coverageCheck,
  coverageOf,
  dbExpected,
  routeOfExt,
  typeOfName,
  type CoverageFile,
} from './file-coverage';

describe('typeOfName', () => {
  const none = new Set<string>();
  it('names a known type, never the words of a file name', () => {
    expect(typeOfName('Report.PDF', '', none)).toBe('pdf');
    expect(typeOfName('drawing.dwg', '', none)).toBe('dwg');
    expect(typeOfName('server.log', '', none)).toBe('log');
    expect(typeOfName('mail.EML', '', none)).toBe('eml');
    expect(typeOfName('README', '', none)).toBe('(none)');
    expect(typeOfName('notes.budget for the client', '', none)).toBe('(other)');
    expect(typeOfName('Letter to J.Smith', '', none)).toBe('(other)');
    expect(typeOfName('Offer v2.Final', '', none)).toBe('(other)');
  });

  it('names a type a Reader of the box takes', () => {
    expect(typeOfName('model.qqq', '', new Set(['qqq']))).toBe('qqq');
  });

  it('names a file with no extension by its media type', () => {
    expect(typeOfName('Scan', 'application/pdf', none)).toBe('pdf');
    expect(typeOfName('Photo', 'image/jpeg', none)).toBe('jpeg');
    expect(typeOfName('Voice Message', 'application/x-made-up', none)).toBe('(none)');
    expect(typeOfName('Invoice', 'application/octet-stream', none)).toBe('(none)');
    expect(typeOfName('Note', '', none)).toBe('(none)');
  });
});

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
    expect(routeOfExt('mpp', DB_EXTS)).toBe('parser');
    expect(routeOfExt('vsd', DB_EXTS)).toBe('export');
    expect(routeOfExt('eml', DB_EXTS)).toBe('none');
    // Code, config and logs are read as text since 2026-11-25 (CODE_EXTS).
    expect(routeOfExt('log', DB_EXTS)).toBe('text');
    expect(routeOfExt('tsx', DB_EXTS)).toBe('text');
    expect(routeOfExt('exe', DB_EXTS)).toBe('none');
    // JPEG under its other names takes the vision read; a Word backup anydoc.
    expect(routeOfExt('jfif', DB_EXTS)).toBe('vision');
    expect(routeOfExt('wbk', DB_EXTS)).toBe('parser');
  });

  it('takes the mail types as the built-in Reader mail reads them, with a database', () => {
    const builtin = dbExtsOf(BUILTIN_PIPELINES);
    for (const ext of ['eml', 'msg', 'mbox']) {
      expect(routeOfExt(ext, builtin), ext).toBe('pipeline');
      expect(dbExpected(ext, builtin), ext).toBe(true);
    }
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

  it('counts the unread pages of a scan as a shortfall', () => {
    const scan = file('pdf', { ...done, ocr: { pages_read: 3, pages_total: 5 } });
    const [row] = coverageOf([scan], DB_EXTS, new Set());
    expect(row).toMatchObject({ partial: 1, shortcut: 1, notFull: 1, cuts: { ocr_pages: 1 } });
  });

  it('counts the scan pages a sketch read did not read as a shortfall', () => {
    const scan = file('pdf', {
      ...done,
      read_cut: { scan_pages: { what: 'pages', read: 10, total: 140 } },
    });
    const [row] = coverageOf([scan], DB_EXTS, new Set());
    expect(row).toMatchObject({ partial: 1, shortcut: 1, notFull: 1, cuts: { scan_pages: 1 } });
  });

  it("leaves the detail cuts out of a partial file's cuts", () => {
    const doc = file('docx', {
      ...done,
      read_cut: {
        text_store: { what: 'characters', read: 1, total: 2, limit: 1 },
        pictures_small: { what: 'pictures', read: 0, total: 4 },
      },
    });
    const [row] = coverageOf([doc], DB_EXTS, new Set());
    expect(row!.cuts).toEqual({ text_store: 1 });
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

  it('counts a code file read as text as full, one read as a name card as not full', () => {
    const asText = file('py', { ...done, read_by: { reader: 'utf8', v: 1 } });
    const noStamp = file('py', done);
    // Read before code had a reader: its stamp says the default text.
    const asNameCard = file('py', { ...done, read_by: { reader: 'none', v: 1 } });
    const [row] = coverageOf([asText, noStamp, asNameCard], DB_EXTS, new Set());
    expect(row).toMatchObject({ ext: 'py', route: 'text', indexed: 3, notFull: 1 });
  });

  it('keeps an archive indexed: its detail cut is no shortfall', () => {
    const zip = file('zip', {
      ...done,
      read_cut: { archive: { what: 'entries', read: 0, total: 3 } },
    });
    const [row] = coverageOf([zip], DB_EXTS, new Set());
    expect(row).toMatchObject({ route: 'archive', indexed: 1, partial: 0, notFull: 0 });
  });

  it("keeps a mail indexed: its attachments' detail cut is no shortfall", () => {
    const mail = file('eml', {
      ...done,
      read_cut: { mail_attachments: { what: 'attachments', read: 0, total: 2 } },
    });
    const [row] = coverageOf([mail], new Set(['eml']), new Set([`${mail.id}.${SHA.slice(0, 16)}`]));
    expect(row).toMatchObject({ route: 'pipeline', indexed: 1, partial: 0, withDb: 1, notFull: 0 });
  });

  it('counts a mailbox read in part as partial, with its cut', () => {
    const mbox = file('mbox', {
      ...done,
      read_cut: { mail_messages: { what: 'messages', read: 3, total: 9 } },
    });
    const [row] = coverageOf(
      [mbox],
      new Set(['mbox']),
      new Set([`${mbox.id}.${SHA.slice(0, 16)}`]),
    );
    expect(row).toMatchObject({ partial: 1, withDb: 1, cuts: { mail_messages: 1 } });
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
