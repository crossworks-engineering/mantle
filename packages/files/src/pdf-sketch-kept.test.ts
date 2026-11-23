/**
 * An older sketch read kept over a read again (./pdf-drawing-sheets.ts
 * withSketchKept; M4, Jason 2026-11-23): a person's run of one PDF reads a
 * file with a paid vision read again, and its paid rows and the File tab's
 * word that it ran are kept, so nothing is thrown away and nothing is paid
 * again.
 */
import { describe, expect, it } from 'vitest';
import {
  SKETCH_KEPT_COLUMNS,
  SKETCH_KEPT_TAB,
  VISION_TEXT,
  pdfFileTabOf,
  withSketchKept,
} from './pdf-drawing-sheets';
import type { ParsedSheet } from './sheet-to-grid';

const row = (page: number, text: string) =>
  SKETCH_KEPT_COLUMNS.map((c) =>
    c.name === 'Page' ? page : c.name === 'Text' ? text : c.name === 'Source' ? 'ocr' : null,
  );

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

describe('withSketchKept', () => {
  it('keeps the paid rows in their own tab, and the File tab says the vision read ran', () => {
    const out = withSketchKept([file], { rows: [row(1, 'P-101')], model: 'vision-m' });
    const kept = out.find((s) => s.name === SKETCH_KEPT_TAB)!;
    expect(kept.rows).toEqual([row(1, 'P-101')]);
    expect(kept.columns.map((c) => c.name)).toEqual(SKETCH_KEPT_COLUMNS.map((c) => c.name));
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

  it("a read's own tab of that name gives way; no rows, no tab, the word stays", () => {
    const own: ParsedSheet = { name: SKETCH_KEPT_TAB, columns: [], rows: [['x']] };
    const out = withSketchKept([file, own], { rows: [], model: null });
    expect(out.map((s) => s.name)).toEqual(['File']);
    const tab = out[0]!;
    expect(tab.rows[0]![tab.columns.findIndex((c) => c.name === 'Vision read')]).toBe(true);
  });
});
