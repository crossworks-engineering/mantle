/**
 * The embedder rejects a whole batch when ONE input exceeds the provider's
 * token ceiling, so an uncapped piece does not degrade retrieval, it zeroes it:
 * the node indexes no chunks at all and the extract job cycles the dead-letter
 * queue on every agent start. These cover the shapes that reached the embedder
 * uncapped — the table profile/schema pieces.
 */
import { describe, expect, it } from 'vitest';
import { clampPieces } from './chunk-clamp';
import { schemaToText, type WorkbookTabRef } from '@mantle/tabledb';

const MAX = 2750;

/** The field case: a 50-tab workbook whose data dictionary blew the ceiling. */
function wideWorkbook(): WorkbookTabRef[] {
  return Array.from({ length: 50 }, (_, t) => ({
    tabId: `t${t + 1}`,
    name: `Tab ${t + 1} Data`,
    viewName: `v_tab_${t + 1}`,
    physicalTable: `tab_${t + 1}`,
    ftsTable: `fts_tab_${t + 1}`,
    rowCount: 100 + t,
    columns: Array.from({ length: 36 }, (_, c) => ({
      colId: `c${c + 1}`,
      name: `column_${t + 1}_${c + 1}_descriptive_name`,
      physical: `col_${c + 1}`,
      type: 'text' as const,
    })),
    aggregates: {},
  }));
}

describe('clampPieces', () => {
  it('passes an already-small piece through untouched', () => {
    const out = clampPieces([{ text: 'short body', headingPath: 'schema' }]);
    expect(out).toEqual([{ text: 'short body', headingPath: 'schema' }]);
  });

  it('normalises a null headingPath (DocChunk shape) to undefined', () => {
    const out = clampPieces([{ text: 'body', headingPath: null }]);
    expect(out[0]!.headingPath).toBeUndefined();
  });

  it('splits an over-budget piece instead of dropping it', () => {
    const piece = { text: Array.from({ length: 400 }, (_, i) => `line ${i} of text`).join('\n') };
    const out = clampPieces([piece]);
    expect(out.length).toBeGreaterThan(1);
    for (const p of out) expect(p.text.length).toBeLessThanOrEqual(MAX);
  });

  it('holds a real 50-tab schema dictionary under the budget', () => {
    const text = schemaToText(wideWorkbook(), { title: 'Asset Data', nodeId: 'n1' });
    // Guard the guard: if this ever stops being oversized the test proves nothing.
    expect(text.length).toBeGreaterThan(MAX * 4);

    const out = clampPieces([{ text, headingPath: 'schema' }]);
    for (const p of out) expect(p.text.length).toBeLessThanOrEqual(MAX);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((p) => p.headingPath?.startsWith('schema'))).toBe(true);
  });

  it('caps the fan-out and says so rather than implying a full dictionary', () => {
    const text = schemaToText(wideWorkbook(), { title: 'Asset Data', nodeId: 'n1' });
    const out = clampPieces([{ text, headingPath: 'schema' }]);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out.at(-1)!.text).toContain('schema truncated');
    expect(out.at(-1)!.text).toContain('table_schema');
  });

  it('numbers the parts so a retrieval hit says which slice it came from', () => {
    const text = schemaToText(wideWorkbook(), { title: 'Asset Data' });
    const out = clampPieces([{ text, headingPath: 'schema' }]);
    expect(out[0]!.headingPath).toBe('schema (1/6)');
  });

  it('clamps every piece in a batch, not just the first offender', () => {
    const big = schemaToText(wideWorkbook(), { title: 'A' });
    const out = clampPieces([
      { text: 'ok' },
      { text: big, headingPath: 'schema' },
      { text: 'ok2' },
    ]);
    for (const p of out) expect(p.text.length).toBeLessThanOrEqual(MAX);
    expect(out[0]!.text).toBe('ok');
    expect(out.at(-1)!.text).toBe('ok2');
  });
});
