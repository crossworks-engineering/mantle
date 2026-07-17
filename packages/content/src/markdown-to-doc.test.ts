import { describe, expect, it } from 'vitest';
import { markdownToDoc } from './markdown-to-doc';

type N = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: N[];
  text?: string;
  marks?: { type: string }[];
};
const top = (md: string) => (markdownToDoc(md) as { content: N[] }).content;
const find = (md: string, type: string) => top(md).find((n) => n.type === type);

describe('markdownToDoc', () => {
  it('always returns a doc with at least an empty paragraph', () => {
    const doc = markdownToDoc('') as N;
    expect(doc.type).toBe('doc');
    expect(doc.content?.[0]?.type).toBe('paragraph');
  });

  it('maps headings (clamped to 1–3) and inline marks', () => {
    const h = find('## Title', 'heading');
    expect(h?.attrs?.level).toBe(2);
    const big = find('###### deep', 'heading');
    expect(big?.attrs?.level).toBe(3);
    const p = find('a **b** *c* `d` ==e==', 'paragraph')!;
    const markTypes = (p.content ?? []).flatMap((t) => (t.marks ?? []).map((m) => m.type));
    expect(markTypes).toEqual(expect.arrayContaining(['bold', 'italic', 'code', 'highlight']));
  });

  it('maps [text]{color=…}/{highlight=…} to themed textColor/highlight marks', () => {
    const p = find(
      'a [b]{color=chart-2} [c]{highlight=chart-4} [d]{color=chart-1 highlight=chart-3}',
      'paragraph',
    )!;
    const marks = (p.content ?? []).flatMap(
      (t) => (t.marks ?? []) as Array<{ type: string; attrs?: { color?: string } }>,
    );
    const has = (type: string, color: string) =>
      marks.some((m) => m.type === type && m.attrs?.color === color);
    expect(has('textColor', 'chart-2')).toBe(true);
    expect(has('highlight', 'chart-4')).toBe(true);
    expect(has('textColor', 'chart-1')).toBe(true); // both keys on one span
    expect(has('highlight', 'chart-3')).toBe(true);
    // Unknown token / non-colour attr leaves plain text (no colour mark).
    const plain = find('x [y]{color=red} [z]{foo=bar}', 'paragraph')!;
    const types = (plain.content ?? []).flatMap((t) => (t.marks ?? []).map((m) => m.type));
    expect(types).not.toContain('textColor');
  });

  it('maps callouts with a variant, defaulting unknown kinds to info', () => {
    const c = find(':::warning\nbe careful\n:::', 'callout');
    expect(c?.attrs?.variant).toBe('warning');
    const d = find(':::bogus\nx\n:::', 'callout');
    expect(d?.attrs?.variant).toBe('info');
  });

  it('maps asides, reading an optional themed colour (default chart-1)', () => {
    const a = find(':::aside\na side note\n:::', 'aside');
    expect(a?.attrs?.color).toBe('chart-1');
    expect(a?.attrs?.angle).toBe(135);
    expect(a?.content?.[0]?.type).toBe('paragraph');
    const c = find(':::aside chart-3\ntinted\n:::', 'aside');
    expect(c?.attrs?.color).toBe('chart-3');
    // An out-of-range colour falls back to chart-1.
    expect(find(':::aside chart-9\nx\n:::', 'aside')?.attrs?.color).toBe('chart-1');
  });

  it("imports Notion's <aside> … </aside> callout export as an aside block", () => {
    const a = find('<aside>\n💡 A Notion callout.\n</aside>', 'aside');
    expect(a?.attrs?.color).toBe('chart-1');
    expect(a?.attrs?.angle).toBe(135);
    expect(a?.content?.[0]?.type).toBe('paragraph');
    // the leading-emoji text rides along in the body (no literal <aside> text)
    const text = JSON.stringify(a);
    expect(text).toContain('A Notion callout.');
    expect(text).not.toContain('aside>');
  });

  it('handles a single-line <aside>…</aside> and multi-block bodies', () => {
    const one = find('<aside>just one line</aside>', 'aside');
    expect(one?.content?.[0]?.type).toBe('paragraph');
    const multi = find('<aside>\n# Heading\n\nA paragraph.\n</aside>', 'aside');
    const kinds = (multi?.content ?? []).map((b) => b.type);
    expect(kinds).toContain('heading');
    expect(kinds).toContain('paragraph');
  });

  it('cycles colour/angle across multiple imported <aside> blocks', () => {
    const doc = markdownToDoc(
      '<aside>\none\n</aside>\n\n<aside>\ntwo\n</aside>\n\n<aside>\nthree\n</aside>',
    ) as { content: N[] };
    const asides = doc.content.filter((n) => n.type === 'aside');
    expect(asides.map((a) => a.attrs?.color)).toEqual(['chart-1', 'chart-2', 'chart-3']);
    expect(asides[0]?.attrs?.angle).toBe(135);
    expect(asides[1]?.attrs?.angle).toBe(60);
  });

  it('maps a columns block into columnList with 2+ columns', () => {
    const cols = find(':::columns\nleft\n+++\nright\n:::', 'columnList');
    expect(cols?.content?.length).toBe(2);
    expect(cols?.content?.[0]?.type).toBe('column');
  });

  it('degrades a single-column columns block to plain blocks', () => {
    expect(find(':::columns\nonly one\n:::', 'columnList')).toBeUndefined();
    expect(find(':::columns\nonly one\n:::', 'paragraph')).toBeTruthy();
  });

  it('maps GFM task lists to taskList/taskItem with checked state', () => {
    const tl = find('- [x] done\n- [ ] todo', 'taskList');
    expect(tl?.content?.map((i) => i.attrs?.checked)).toEqual([true, false]);
  });

  it('maps fenced code with its language', () => {
    const code = find('```ts\nconst x = 1;\n```', 'codeBlock');
    expect(code?.attrs?.language).toBe('ts');
    expect(code?.content?.[0]?.text).toContain('const x = 1;');
  });

  it('maps a GFM table to table/tableRow/tableHeader/tableCell', () => {
    const t = find('| A | B |\n|---|---|\n| 1 | 2 |', 'table')!;
    expect(t.content?.[0]?.content?.[0]?.type).toBe('tableHeader');
    expect(t.content?.[1]?.content?.[0]?.type).toBe('tableCell');
  });

  it('lifts a markdown image into a block image node', () => {
    const img = find('![arch](https://x/y.png)', 'image');
    expect(img?.attrs?.src).toBe('https://x/y.png');
    expect(img?.attrs?.alt).toBe('arch');
  });

  it('maps $…$ to inline math and $$…$$ to block math', () => {
    const p = top('Inline $E=mc^2$ here').find((n) => n.type === 'paragraph')!;
    expect((p.content ?? []).some((c) => c.type === 'inlineMath')).toBe(true);
    expect(find('$$\nx^2\n$$', 'blockMath')?.attrs?.latex).toBe('x^2');
    expect(find('$$a+b$$', 'blockMath')?.attrs?.latex).toBe('a+b');
  });
});
