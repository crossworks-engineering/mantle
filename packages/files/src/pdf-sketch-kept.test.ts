/**
 * An older sketch read kept over a read again (./pdf-drawing-sheets.ts
 * withSketchKept; M4, Jason 2026-11-23): a person's run of one PDF reads a
 * file with a paid vision read again, and its paid rows (words, tags, line
 * numbers) and the File tab's word that it ran are kept, so nothing is
 * thrown away and nothing is paid again. One rule: each tab's rows go back
 * into the read's tab of that name, else into a tab of their own.
 */
import { describe, expect, it } from 'vitest';
import {
  SKETCH_KEPT_TABS,
  VISION_TEXT,
  pdfFileTabOf,
  withSketchKept,
  type SketchKept,
} from './pdf-drawing-sheets';
import type { ParsedSheet } from './sheet-to-grid';

/** The book reader's File tab: no vision columns. */
const file: ParsedSheet = {
  name: 'File',
  columns: [
    { name: 'Kind', type: 'text' },
    { name: 'Rules kind', type: 'text' },
    { name: 'Rules version', type: 'number' },
    { name: 'Pages', type: 'number' },
  ],
  rows: [['book', 'book', 5, 1478]],
};

const kept: SketchKept = {
  tabs: [
    { name: 'Texts', rows: [{ Page: 1, Line: 1, Text: 'P-101', Source: 'ocr' }] },
    { name: 'Tags', rows: [{ Page: 1, Tag: 'P-101', Source: 'ocr' }] },
    { name: 'Lines', rows: [] },
  ],
  model: 'vision-m',
};

describe('withSketchKept', () => {
  it('a book (no such tabs): the rows in tabs of their own; the File tab says the vision read ran', () => {
    const out = withSketchKept([file], kept);
    expect(out.map((s) => s.name)).toEqual(['File', SKETCH_KEPT_TABS.Texts, SKETCH_KEPT_TABS.Tags]);
    const texts = out.find((s) => s.name === SKETCH_KEPT_TABS.Texts)!;
    expect(texts.columns).toEqual([
      { name: 'Page', type: 'number' },
      { name: 'Line', type: 'number' },
      { name: 'Text', type: 'text' },
      { name: 'Source', type: 'text' },
    ]);
    expect(texts.rows).toEqual([[1, 1, 'P-101', 'ocr']]);
    const tab = out.find((s) => s.name === 'File')!;
    const stored = pdfFileTabOf(
      tab.columns.map((c) => c.name),
      tab.rows[0]!,
    );
    // So no sketch read or whole-page read of these bytes is paid again.
    expect(stored?.visionRead).toBe(true);
    const at = (n: string) => tab.columns.findIndex((c) => c.name === n);
    expect(tab.rows[0]![at('Vision text')]).toBe(VISION_TEXT.sketch);
    expect(tab.rows[0]![at('Vision model')]).toBe('vision-m');
    expect(tab.rows[0]!.slice(0, 4)).toEqual(['book', 'book', 5, 1478]);
  });

  it("a drawing read: the rows go back into its own Texts and Tags, by column name, after the read's", () => {
    const texts: ParsedSheet = {
      name: 'Texts',
      columns: [
        { name: 'Page', type: 'number' },
        { name: 'Text', type: 'text' },
        { name: 'Source', type: 'text' },
        { name: 'Line', type: 'number' },
      ],
      rows: [[1, 'NOTES', 'pdf', 1]],
    };
    const tags: ParsedSheet = {
      name: 'Tags',
      columns: [
        { name: 'Page', type: 'number' },
        { name: 'Tag', type: 'text' },
        { name: 'Source', type: 'text' },
      ],
      rows: [],
    };
    const out = withSketchKept([file, texts, tags], kept);
    expect(out.map((s) => s.name)).toEqual(['File', 'Texts', 'Tags']);
    expect(out[1]!.rows).toEqual([
      [1, 'NOTES', 'pdf', 1],
      [1, 'P-101', 'ocr', 1],
    ]);
    expect(out[2]!.rows).toEqual([[1, 'P-101', 'ocr']]);
  });

  it("a read's own tab of a kept name gives way; no rows, no tab, the word stays", () => {
    const own: ParsedSheet = { name: SKETCH_KEPT_TABS.Texts, columns: [], rows: [['x']] };
    const out = withSketchKept([file, own], { tabs: [], model: null });
    expect(out.map((s) => s.name)).toEqual(['File']);
    const tab = out[0]!;
    expect(tab.rows[0]![tab.columns.findIndex((c) => c.name === 'Vision read')]).toBe(true);
  });
});
