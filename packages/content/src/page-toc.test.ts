import { describe, expect, it } from 'vitest';
import { buildPageToc } from './page-toc';

const h = (level: number, id: string, text: string) => ({
  type: 'heading',
  attrs: { id, level },
  content: [{ type: 'text', text }],
});
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const child = (id: string, title: string) => ({ type: 'childPage', attrs: { id, title } });
const doc = (content: unknown[]) => ({ type: 'doc', content });

describe('buildPageToc', () => {
  it('returns empty for nullish / non-doc input', () => {
    expect(buildPageToc(null)).toEqual([]);
    expect(buildPageToc({})).toEqual([]);
  });

  it('extracts headings in order with depth = level - 1', () => {
    const toc = buildPageToc(
      doc([h(1, 'a', 'Intro'), p('body'), h(2, 'b', 'Details'), h(3, 'c', 'Fine print')]),
    );
    expect(toc).toEqual([
      { id: 'a', kind: 'heading', level: 1, depth: 0, label: 'Intro' },
      { id: 'b', kind: 'heading', level: 2, depth: 1, label: 'Details' },
      { id: 'c', kind: 'heading', level: 3, depth: 2, label: 'Fine print' },
    ]);
  });

  it('nests a sub-page one level deeper than its enclosing heading section', () => {
    const toc = buildPageToc(doc([h(2, 'b', 'Section'), child('p1', 'Sub doc')]));
    const sub = toc.find((e) => e.kind === 'page')!;
    expect(sub).toEqual({ id: 'p1', kind: 'page', level: 2, depth: 2, label: 'Sub doc' });
  });

  it('places a sub-page before any heading at depth 0', () => {
    const toc = buildPageToc(doc([child('p1', 'Top sub')]));
    expect(toc[0]).toEqual({ id: 'p1', kind: 'page', level: 0, depth: 0, label: 'Top sub' });
  });

  it('skips headings / sub-pages without a block id (cannot be jump targets)', () => {
    const toc = buildPageToc(
      doc([{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'No id' }] }]),
    );
    expect(toc).toEqual([]);
  });

  it('falls back to placeholder labels for empty headings / untitled pages', () => {
    const toc = buildPageToc(
      doc([
        { type: 'heading', attrs: { id: 'a', level: 1 } },
        { type: 'childPage', attrs: { id: 'p1' } },
      ]),
    );
    expect(toc[0]!.label).toBe('Untitled heading');
    expect(toc[1]!.label).toBe('Untitled page');
  });
});
