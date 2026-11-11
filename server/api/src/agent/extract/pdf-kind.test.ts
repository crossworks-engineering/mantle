import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfDrawing, PdfDrawingPage } from '@mantle/files';

const h = vi.hoisted(() => ({ allowed: true, guard: [] as string[], asked: [] as unknown[] }));
vi.mock('@mantle/db', () => ({
  llmWorkAllowed: async (nodeId: string) => {
    h.guard.push(nodeId);
    return h.allowed;
  },
}));
vi.mock('@mantle/decisions', () => ({
  decidePdfKind: async (ownerId: string, state: unknown) => {
    h.asked.push([ownerId, state]);
    return { kind: 'pid', confidence: 0.9, model: 'm', mode: 'live', used: true };
  },
}));

import { askPdfKind, pdfKindState } from './pdf-kind';

beforeEach(() => {
  h.allowed = true;
  h.guard.length = 0;
  h.asked.length = 0;
});

const page = (over: Partial<PdfDrawingPage>): PdfDrawingPage => ({
  page: 1,
  status: 'ok',
  kindFrom: 'rules',
  chars: 0,
  runs: 0,
  hiddenShare: 0,
  imageCover: 0,
  segments: 0,
  axes: null,
  tagLike: 0,
  instruments: 0,
  lineNumbers: 0,
  markups: 0,
  markupsWithText: 0,
  readMs: 5,
  kind: 'unsure',
  eye: null,
  ...over,
});

describe('pdfKindState', () => {
  it('sends counts and the sample: no page text, no positions, no file name', () => {
    const drawing: PdfDrawing = {
      numPages: 4,
      pageCountMayBeShort: false,
      largeImageNotRead: false,
      allRead: true,
      kind: 'unsure',
      sample: 'MADE UP TITLE',
      pages: [
        page({
          page: 1,
          class: 'vector_text',
          size: 'a1',
          instruments: 3,
          lineNumbers: 1,
          tagLike: 9,
        }),
        page({ page: 2, class: 'vector_text', size: 'a1', instruments: 2, tagLike: 4 }),
        page({ page: 3, class: 'text', size: 'a4' }),
        // A page that was not read has no class and no size: it is not counted.
        page({ page: 4, status: 'failed', why: 'FormatError', kind: 'none' }),
      ],
    };
    expect(pdfKindState(drawing)).toEqual({
      pages: 4,
      page_classes: { vector_text: 2, text: 1 },
      page_sizes: { a1: 2, a4: 1 },
      instrument_tags: 5,
      line_numbers: 1,
      tag_like_tokens: 13,
      text_sample: 'MADE UP TITLE',
    });
  });
});

describe('askPdfKind', () => {
  const drawing: PdfDrawing = {
    numPages: 1,
    pageCountMayBeShort: false,
    largeImageNotRead: false,
    allRead: true,
    kind: 'unsure',
    sample: 'A MADE UP TITLE OF A MADE UP DRAWING SHEET',
    pages: [page({ class: 'vector_text', size: 'a1' })],
  };

  it('asks the decider for a file that may get model work', async () => {
    expect(await askPdfKind('owner', 'node-1', drawing)).toMatchObject({ kind: 'pid', used: true });
    expect(h.guard).toEqual(['node-1']);
    expect(h.asked).toEqual([['owner', pdfKindState(drawing)]]);
  });

  it('a file that gets no model work gets no decider call: nothing leaves the box', async () => {
    h.allowed = false;
    expect(await askPdfKind('owner', 'node-1', drawing)).toBeNull();
    expect(h.asked).toEqual([]);
  });
});
