import { describe, expect, it } from 'vitest';
import { renderCorpusMapBlock, type CorpusMapEntry } from './messages';

const entry = (over: Partial<CorpusMapEntry>): CorpusMapEntry => ({
  nodeId: '00000000-0000-4000-8000-000000000000',
  type: 'page',
  title: 'Untitled',
  branch: 'pages',
  summary: null,
  ...over,
});

describe('renderCorpusMapBlock', () => {
  it('returns null for an empty map (no block emitted)', () => {
    expect(renderCorpusMapBlock([])).toBeNull();
  });

  it('groups by branch, sorts branches and titles, and tags each entry with type#shortid', () => {
    const out = renderCorpusMapBlock([
      entry({ title: 'Zeta', branch: 'pages', nodeId: 'aaaaaaaa-0000-4000-8000-000000000000' }),
      entry({ title: 'Alpha', branch: 'pages', nodeId: 'bbbbbbbb-0000-4000-8000-000000000000' }),
      entry({ title: 'Grid', branch: 'files', type: 'file' }),
    ])!;
    expect(out.indexOf('files (1):')).toBeGreaterThan(-1);
    expect(out.indexOf('files (1):')).toBeLessThan(out.indexOf('pages (2):'));
    expect(out.indexOf('"Alpha"')).toBeLessThan(out.indexOf('"Zeta"'));
    expect(out).toContain('(page#aaaaaaaa)');
    expect(out).toContain('(file#00000000)');
  });

  it('appends summaries only when present, snipped to a line', () => {
    const out = renderCorpusMapBlock([
      entry({ title: 'Doc', summary: `multi\nline   ${'x'.repeat(200)}` }),
    ])!;
    expect(out).toContain('— multi line');
    expect(out).not.toContain('\n line'); // whitespace collapsed
    expect(out).toContain('…'); // snipped
  });

  it('appends a table schema digest in brackets after the summary', () => {
    const out = renderCorpusMapBlock([
      entry({
        title: 'Cars',
        type: 'table',
        branch: 'tables',
        summary: 'Fleet register.',
        schema: 'Fleet(2r): Model, Make, Year, EV',
      }),
      entry({ title: 'Plain', schema: null }),
    ])!;
    expect(out).toContain('— Fleet register. [Fleet(2r): Model, Make, Year, EV]');
    expect(out).not.toContain('Plain" (page#00000000) ['); // no empty brackets
  });

  it('is byte-stable regardless of input order (prompt-cache friendliness)', () => {
    const a = entry({ title: 'A' });
    const b = entry({ title: 'B', branch: 'files', type: 'file' });
    expect(renderCorpusMapBlock([a, b])).toBe(renderCorpusMapBlock([b, a]));
  });

  it('clips at the char budget with an honest truncation note', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      entry({ title: `Document number ${i} with a reasonably long title` }),
    );
    const out = renderCorpusMapBlock(many, { maxChars: 2000 })!;
    expect(out.length).toBeLessThan(2600); // header + note overhead on top of budget
    expect(out).toContain('[map truncated');
  });

  it('carries the upstream truncation flag even when the budget is not hit', () => {
    const out = renderCorpusMapBlock([entry({})], { truncated: true })!;
    expect(out).toContain('[map truncated');
  });
});
