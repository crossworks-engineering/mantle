/**
 * The compact status of a file (file-status.ts): the ingest word of each
 * extraction state, from the keys the extractor writes (extractionOf), and
 * the job and database parts as given.
 */
import { describe, expect, it } from 'vitest';
import { extractionOf, EXTRACTION_STATES } from './extraction-status';
import { fileStatusOf, ingestOf } from './file-status';

type More = Omit<Parameters<typeof fileStatusOf>[0], 'extraction'>;

const statusOfData = (data: Record<string, unknown>, more: More = {}) =>
  fileStatusOf({ extraction: extractionOf(data).state, ...more });

describe('file status', () => {
  it('maps every extraction state to one ingest word', () => {
    expect(Object.fromEntries(EXTRACTION_STATES.map((s) => [s, ingestOf(s)]))).toEqual({
      indexed: 'done',
      partial: 'partial',
      failed: 'failed',
      skipped: 'none',
      pending: 'waiting',
      name_only: 'none',
    });
  });

  it('a read that ended is done', () => {
    expect(statusOfData({ extract_completed_at: '2026-11-18T00:00:00Z' })).toEqual({
      ingest: 'done',
    });
  });

  it('a scan read in part is partial', () => {
    expect(
      statusOfData({
        extract_completed_at: '2026-11-18T00:00:00Z',
        ocr: { pages_read: 20, pages_total: 80 },
      }),
    ).toEqual({ ingest: 'partial' });
  });

  it('a read failure and a parked write are failed; a skip is none', () => {
    expect(statusOfData({ extract_skipped: { reason: 'document_unreadable' } })).toEqual({
      ingest: 'failed',
    });
    expect(statusOfData({ extract_parked: true })).toEqual({ ingest: 'failed' });
    expect(statusOfData({ extract_skipped: { reason: 'unsupported_media' } })).toEqual({
      ingest: 'none',
    });
    expect(statusOfData({ indexing_applied: 'metadata' })).toEqual({ ingest: 'none' });
  });

  it('a file not read yet is waiting, with its job when one is in the queue', () => {
    expect(statusOfData({})).toEqual({ ingest: 'waiting' });
    expect(statusOfData({}, { job: 'queued' })).toEqual({ ingest: 'waiting', job: 'queued' });
    // A file read before and in the queue again: being read again.
    expect(
      statusOfData({ extract_completed_at: '2026-11-18T00:00:00Z' }, { job: 'running' }),
    ).toEqual({ ingest: 'done', job: 'running' });
  });

  it('carries the database state only when given, and never `stale` yet', () => {
    expect(fileStatusOf({ extraction: 'indexed', db: 'ready' })).toEqual({
      ingest: 'done',
      db: 'ready',
    });
    expect(fileStatusOf({ extraction: 'pending', db: 'not-built' })).toEqual({
      ingest: 'waiting',
      db: 'not-built',
    });
    expect(fileStatusOf({ extraction: 'indexed', db: 'unreadable' })).toEqual({
      ingest: 'done',
      db: 'unreadable',
    });
    expect('stale' in fileStatusOf({ extraction: 'indexed' })).toBe(false);
  });
});
