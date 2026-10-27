import { describe, expect, it } from 'vitest';
import { parseTextToGrid } from './sheet-to-grid';

describe('parseTextToGrid', () => {
  it('parses a markdown pipe table, dropping the separator row', async () => {
    const md = `
| Item   | Qty | Price |
|--------|----:|-------|
| Widget | 2   | 9.5   |
| Gadget | 3   | 4     |
`;
    const [sheet] = await parseTextToGrid(md);
    expect(sheet!.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      'Item:text',
      'Qty:number',
      'Price:number',
    ]);
    expect(sheet!.rows).toEqual([
      ['Widget', 2, 9.5],
      ['Gadget', 3, 4],
    ]);
  });

  it('parses TSV', async () => {
    const [sheet] = await parseTextToGrid('Name\tAge\nAda\t36\nGrace\t40');
    expect(sheet!.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['Name:text', 'Age:number']);
    expect(sheet!.rows).toEqual([
      ['Ada', 36],
      ['Grace', 40],
    ]);
  });

  it('parses CSV (quote-aware)', async () => {
    const [sheet] = await parseTextToGrid('City,Pop\n"Cape Town, ZA",433688\nOslo,700000');
    expect(sheet!.columns.map((c) => c.name)).toEqual(['City', 'Pop']);
    expect(sheet!.rows[0]).toEqual(['Cape Town, ZA', 433688]);
  });

  it('keeps a newline embedded in a quoted CSV field', async () => {
    // The case a line-splitting parser gets wrong, and the reason this path
    // uses fast-csv rather than a hand-rolled split.
    const [sheet] = await parseTextToGrid('Name,Note\nAda,"line one\nline two"\n');
    expect(sheet!.rows).toEqual([['Ada', 'line one\nline two']]);
  });

  it('does not let a tab inside a quoted CSV field flip the delimiter', async () => {
    const [sheet] = await parseTextToGrid('Name,Note\nAda,"a\tb"\n');
    expect(sheet!.columns.map((c) => c.name)).toEqual(['Name', 'Note']);
    expect(sheet!.rows).toEqual([['Ada', 'a\tb']]);
  });

  it('returns [] for non-tabular / empty text', async () => {
    expect(await parseTextToGrid('')).toEqual([]);
    expect(await parseTextToGrid('just a sentence with no structure')).toHaveLength(1); // single column, still a (degenerate) table
  });
});
