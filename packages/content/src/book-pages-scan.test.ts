/**
 * The Scan reader's pages of a book, their free evidence, and how each page
 * was read, from a made-up book database (the reader's tab Pages and the
 * Agent's tab Page text), through the reader pool like a run.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureWorkbookDoc } from '@mantle/content-core/table-model';
import { pipelineStampOf } from '@mantle/files';
import { tabsOfSheets } from './file-database';
import { writeFileDatabaseDoc } from './table-broker';
import { bookPageMethodsOf, bookScanEvidenceOf, bookScanPagesOf } from './book-pages';

const dir = mkdtempSync(path.join(os.tmpdir(), 'book-pages-scan-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const READER = {
  id: 'made-up-book',
  version: '1.0.0',
  produces: { text: true, pages: true },
  match: { ext: ['pdf'], kind: ['book'] },
};

/** A book of six pages: typed, OCR, blank, a figure, and two read badly. */
const PAGES_ROWS: (string | number | null)[][] = [
  [1, 'text', null, null, null, 'Introduction'],
  [2, 'ocr', null, null, null, 'SPEC A2'],
  [3, 'blank', null, null, null, ''],
  [4, 'vision', 'figure', null, null, ''],
  [5, 'vision', 'ocr', 44, 'FLANGE ASTM A105', 'FLANGF A5TM'],
  [6, 'vision', 'ocr', 41, '', ''],
];

function database(opts: { why: boolean; agent?: (string | null)[][] }): string {
  const file = path.join(dir, `${randomUUID()}.sqlite`);
  const names = opts.why
    ? ['Page', 'Method', 'Why', 'Lines', 'Sure words', 'Text']
    : ['Page', 'Method', 'Text'];
  const rows = opts.why ? PAGES_ROWS : PAGES_ROWS.map((r) => [r[0]!, r[1]!, r[5]!]);
  const sheets = [
    {
      name: 'Pages',
      columns: names.map((name) => ({
        name,
        type: name === 'Page' || name === 'Lines' ? ('number' as const) : ('text' as const),
      })),
      rows,
    },
    ...(opts.agent
      ? [
          {
            name: 'Page text',
            columns: ['Key', 'Text', 'Model', 'Input hash'].map((name) => ({
              name,
              type: 'text' as const,
            })),
            rows: opts.agent,
          },
        ]
      : []),
  ];
  writeFileDatabaseDoc(file, ensureWorkbookDoc({ tabs: tabsOfSheets(sheets as never) }), {
    fileId: randomUUID(),
    ownerId: randomUUID(),
    stamp: pipelineStampOf(READER as never, []),
  });
  return file;
}

describe('the pages the Scan reader reads first', () => {
  it('are the pages left to vision because OCR read them badly; a figure is not one', async () => {
    expect(await bookScanPagesOf(database({ why: true }))).toEqual([5, 6]);
  });

  it('a book read by an older reader (no Why) has none: its pages keep vision', async () => {
    expect(await bookScanPagesOf(database({ why: false }))).toEqual([]);
    expect(await bookScanPagesOf(path.join(dir, 'none.sqlite'))).toEqual([]);
  });

  it('each has its free evidence: the sure words and the lines', async () => {
    const got = await bookScanEvidenceOf(database({ why: true }), [5, 6, 4, 2, 99]);
    expect([...got.entries()]).toEqual([
      [5, { words: ['FLANGE', 'ASTM', 'A105'], lines: 44 }],
      [6, { words: [], lines: 41 }],
    ]);
    expect((await bookScanEvidenceOf(database({ why: true }), [])).size).toBe(0);
  });
});

describe('how each page of a book was read', () => {
  it('counts the readers, the Agent row of a marked page saying which', async () => {
    const file = database({
      why: true,
      agent: [
        ['page-5', 'FLANGE ASTM A105', 'scan_reader:mistral-ocr', 'h5'],
        ['page-4', 'A figure of a valve', 'google/gemini-3.5-flash-lite', 'h4'],
        ['page-6', '', 'google/gemini-3.5-flash-lite', 'h6'],
      ],
    });
    expect(await bookPageMethodsOf(file)).toEqual({
      text: 1,
      ocr: 1,
      blank: 1,
      scanReader: 1,
      vision: 1,
      unread: 1,
    });
  });

  it('before the Agent ran, every marked page is unread; no book, null', async () => {
    expect(await bookPageMethodsOf(database({ why: true }))).toEqual({
      text: 1,
      ocr: 1,
      blank: 1,
      scanReader: 0,
      vision: 0,
      unread: 3,
    });
    expect(await bookPageMethodsOf(path.join(dir, 'none.sqlite'))).toBeNull();
  });
});
