/**
 * readTabColumns: whole tabs by display name, read only, for a reader whose
 * tabs the builder capped (drawing_redraw). A tab or a column the file lacks
 * reads as null, and the file is never written.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { readTabColumns, writeDocFile } from './engine';
import type { TableDocLike } from './doc-types';

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-readtab-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function drawing(): TableDocLike {
  return {
    columns: [],
    rows: [],
    tabs: [
      {
        id: 't-texts',
        name: 'Texts',
        columns: [
          { id: 'c-text', name: 'Text', type: 'text' },
          { id: 'c-x', name: 'X', type: 'number' },
          { id: 'c-q', name: 'Quote "here"', type: 'text' },
        ],
        rows: [
          { id: 'r1', cells: { 'c-text': 'P-101', 'c-x': 2.5, 'c-q': 'a' } },
          { id: 'r2', cells: { 'c-text': 'V-7' } },
        ],
      },
    ],
  } as TableDocLike;
}

describe('readTabColumns', () => {
  const abs = path.join(dir, 'drawing.sqlite');
  writeDocFile(abs, drawing(), { nodeId: 'n1', ownerId: 'o1' });

  it('reads asked columns by name; a missing column or tab is null', () => {
    const before = statSync(abs).mtimeMs;
    const [texts, symbols] = readTabColumns(abs, [
      { tab: 'Texts', columns: ['Text', 'X', 'Height', 'Quote "here"'] },
      { tab: 'Symbols', columns: ['Key'] },
    ]);
    expect(texts).toEqual([
      { Text: 'P-101', X: 2.5, Height: null, 'Quote "here"': 'a' },
      { Text: 'V-7', X: null, Height: null, 'Quote "here"': null },
    ]);
    expect(symbols).toBeNull();
    expect(statSync(abs).mtimeMs).toBe(before);
  });
});
