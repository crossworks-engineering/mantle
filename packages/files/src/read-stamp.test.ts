/**
 * What read a file and whether a newer one is there (read-stamp.ts): the
 * reader of a file type, the stamp a completed read writes, and the stale
 * rule. A file with no stamp is never stale (unknown), so a roll paints
 * nothing stale; a stamp below the version in force is.
 */
import { describe, expect, it } from 'vitest';
import { fileStatusOf } from './file-status';
import {
  READER_VERSIONS,
  currentReaderVersion,
  readByOf,
  readByStampOf,
  readStampsOf,
  readerKeyOf,
  staleOf,
} from './read-stamp';
import { CAD_EXT_LIST } from './cad-sniff';

const installed = new Map([['sheet', '1.2.0']]);

describe('the reader of a file', () => {
  it('is the parser route of its type, or image for a picture', () => {
    expect(readerKeyOf('plan.pdf')).toBe('pdf-parse');
    expect(readerKeyOf('Notes.DOCX')).toBe('mammoth');
    expect(readerKeyOf('list.csv')).toBe('utf8');
    expect(readerKeyOf('book.xlsx')).toBe('exceljs');
    expect(readerKeyOf('site.dwg')).toBe('dwg');
    expect(readerKeyOf('photo.jpg')).toBe('image');
    expect(readerKeyOf('scan', 'image/png')).toBe('image');
    expect(readerKeyOf('archive.bin')).toBe('none');
  });

  it('every reader key has a version, starting at 1', () => {
    for (const ext of CAD_EXT_LIST) expect(READER_VERSIONS[ext]).toBeGreaterThanOrEqual(1);
    for (const v of Object.values(READER_VERSIONS)) expect(v).toBeGreaterThanOrEqual(1);
    expect(currentReaderVersion('pdf-parse')).toBe(READER_VERSIONS['pdf-parse']);
    expect(currentReaderVersion('gone-reader')).toBeNull();
  });

  it('a completed read stamps the reader and its version now', () => {
    expect(readByStampOf({ filename: 'a.pdf' }, 'ignored')).toEqual({
      reader: 'pdf-parse',
      v: READER_VERSIONS['pdf-parse'],
    });
    // No filename: the title is the name (an email attachment).
    expect(readByStampOf({ mimeType: 'image/png' }, 'scan')).toEqual({
      reader: 'image',
      v: READER_VERSIONS.image,
    });
  });

  it('reads the stamps back only in their form', () => {
    expect(readByOf({ read_by: { reader: 'utf8', v: 1 } })).toEqual({ reader: 'utf8', v: 1 });
    expect(readByOf({ read_by: { reader: 'utf8', v: '1' } })).toBeUndefined();
    expect(readStampsOf({})).toEqual({});
    expect(
      readStampsOf({ pipeline_read: { id: 'sheet', name: 'Spreadsheet', version: '1.0.0' } }),
    ).toEqual({ pipelineRead: { id: 'sheet', name: 'Spreadsheet', version: '1.0.0' } });
  });
});

describe('stale', () => {
  it('no stamp is unknown, never stale', () => {
    expect(staleOf({}, installed)).toBeNull();
    expect(fileStatusOf({ extraction: 'indexed', stale: staleOf({}, installed) })).toEqual({
      ingest: 'done',
    });
  });

  it('a stamp at the version in force is not stale', () => {
    expect(staleOf({ readBy: { reader: 'utf8', v: READER_VERSIONS.utf8 } }, installed)).toBe(false);
    expect(
      staleOf({ pipelineRead: { id: 'sheet', name: 'Sheet', version: '1.2.0' } }, installed),
    ).toBe(false);
  });

  it('a reader below its version is stale', () => {
    expect(staleOf({ readBy: { reader: 'utf8', v: READER_VERSIONS.utf8 - 1 } })).toBe(true);
  });

  it('a pipeline below the installed version is stale; one not installed decides nothing', () => {
    const old = { pipelineRead: { id: 'sheet', name: 'Sheet', version: '1.1.9' } };
    expect(staleOf(old, installed)).toBe(true);
    // Without the installed versions, the pipeline stamp decides nothing.
    expect(staleOf(old)).toBe(false);
    expect(
      staleOf({ pipelineRead: { id: 'gone', name: 'Gone', version: '0.1.0' } }, installed),
    ).toBe(false);
    // A newer stamp than installed (a rollback) is not stale.
    expect(
      staleOf({ pipelineRead: { id: 'sheet', name: 'Sheet', version: '2.0.0' } }, installed),
    ).toBe(false);
    // An unknown reader key decides nothing.
    expect(staleOf({ readBy: { reader: 'gone-reader', v: 0 } })).toBe(false);
  });

  it('the status says stale only when true, and names the pipeline', () => {
    expect(fileStatusOf({ extraction: 'indexed', stale: true, pipeline: 'Spreadsheet' })).toEqual({
      ingest: 'done',
      stale: true,
      pipeline: 'Spreadsheet',
    });
    expect(fileStatusOf({ extraction: 'indexed', stale: false })).toEqual({ ingest: 'done' });
  });
});
