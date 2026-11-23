/**
 * A file's text by page (P3, docs/pipelines.md "Page windows"): read from a
 * real file database written here. The Reader's `Pages` tab gives each page
 * of the ORIGINAL file; an Agent's `page-<N>` answer stands over the
 * Reader's text of that page; `_meta` gives the pages read; a database of a
 * Reader that does not say `produces.pages` gives none. Made-up rows only.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ensureWorkbookDoc } from '@mantle/content-core/table-model';
import type * as Files from '@mantle/files';

const dir = mkdtempSync(path.join(os.tmpdir(), 'page-passages-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof Files>()),
  fileDbPaths: (id: string) => ({ sqlite: path.join(dir, `${id}.sqlite`), none: '' }),
}));

const BOOK = {
  id: 'made-up-book',
  version: '1.0.0',
  produces: { text: true, pages: true },
  match: { ext: ['pdf'], kind: ['book'] },
};
const PLAIN = { ...BOOK, id: 'made-up-plain', produces: { text: true } };
const AGENT = { id: 'made-up-page-read', produces: { pages: true, tabs: ['Page text'] } };
const pipelines = {
  byId: (id: string) => [BOOK, PLAIN].find((p) => p.id === id) ?? null,
  agents: [AGENT],
};
vi.mock('./pipeline-registry', () => ({ boxPipelines: async () => pipelines }));

const { pipelineStampOf } = await import('@mantle/files');
const { tabsOfSheets } = await import('./file-database');
const { writeFileDatabaseDoc } = await import('./table-broker');
const { filePagesOf, pagesText } = await import('./page-passages');
const { bookVisionPageCountOf, bookVisionPageSetOf, bookVisionPagesOf } =
  await import('./book-pages');

const SHA = 'b'.repeat(64);

function database(reader: typeof BOOK | typeof PLAIN, withAgent: boolean): string {
  const id = randomUUID();
  const sheets = [
    {
      name: 'Pages',
      columns: [
        { name: 'Page', type: 'number' as const },
        { name: 'Method', type: 'text' as const },
        { name: 'Text', type: 'text' as const },
      ],
      rows: [
        [412, 'ocr', 'SPEC A2 REV 3 corrosion allowance 3 mm'],
        [3, 'text', 'Introduction'],
        [7, 'vision', 'unreadable OCR'],
        [8, 'ocr', ''],
      ],
    },
    ...(withAgent
      ? [
          {
            name: 'Page text',
            columns: ['Key', 'Text', 'Model', 'Input hash'].map((name) => ({
              name,
              type: 'text' as const,
            })),
            rows: [
              ['page-7', 'A drawing of a gate valve, flanged ends', 'm', 'h1'],
              ['page-x', 'not a page key', 'm', 'h2'],
              ['page-3', 'A flow diagram: feed drum to column', 'm', 'h3'],
            ],
          },
        ]
      : []),
  ];
  writeFileDatabaseDoc(
    path.join(dir, `${id}.sqlite`),
    ensureWorkbookDoc({ tabs: tabsOfSheets(sheets) }),
    {
      fileId: id,
      ownerId: randomUUID(),
      stamp: pipelineStampOf(reader as never, []),
      pages: { read: 450, total: 500 },
    },
  );
  return id;
}

describe('filePagesOf', () => {
  it('gives the Reader pages in page order, an Agent page over the Reader, and the pages read', async () => {
    const id = database(BOOK, true);
    const got = await filePagesOf({ id, ownerId: 'o', sha256: SHA });
    expect(got!.pages).toEqual([
      // A page with its own text layer (M4: a kept picture, a drawing page
      // of a book): the Reader's text stays, the Agent's after it.
      { page: 3, text: 'Introduction\n\nA flow diagram: feed drum to column' },
      { page: 7, text: 'A drawing of a gate valve, flanged ends' },
      { page: 412, text: 'SPEC A2 REV 3 corrosion allowance 3 mm' },
    ]);
    expect(got!.read).toEqual({ read: 450, total: 500 });
    expect(pagesText(got!.pages)).toBe(
      '## Page 3\nIntroduction\n\nA flow diagram: feed drum to column\n\n## Page 7\nA drawing of a gate valve, flanged ends\n\n## Page 412\nSPEC A2 REV 3 corrosion allowance 3 mm',
    );
  });

  it('gives none for a Reader that does not say produces.pages, or no database', async () => {
    expect(await filePagesOf({ id: database(PLAIN, false), ownerId: 'o', sha256: SHA })).toBeNull();
    expect(await filePagesOf({ id: randomUUID(), ownerId: 'o', sha256: SHA })).toBeNull();
  });
});

describe("a book's scanned pages and its marked pages", () => {
  it('the core keeps no picture of a page left to vision: those pages, as a set; OCR pages are not among them', async () => {
    const id = database(BOOK, false);
    expect([...(await bookVisionPageSetOf({ id, sha256: SHA }))]).toEqual([7]);
    expect((await bookVisionPageSetOf({ id: randomUUID(), sha256: SHA })).size).toBe(0);
  });

  it('the marked pages are those left to vision', async () => {
    const id = database(BOOK, false);
    expect(await bookVisionPageCountOf({ id, sha256: SHA })).toBe(1);
    expect(await bookVisionPageCountOf({ id: randomUUID(), sha256: SHA })).toBe(0);
    expect(await bookVisionPagesOf(path.join(dir, `${id}.sqlite`))).toEqual([7]);
  });
});
