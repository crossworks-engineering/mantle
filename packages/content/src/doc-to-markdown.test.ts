/**
 * docToMarkdown contract tests. The bar is round-trip STABILITY against
 * markdownToDoc: serializing a doc back to markdown and re-parsing must yield
 * the same doc (modulo regenerated block ids and an aside's decorative angle).
 * If these hold across the full dialect, the serializer is faithful.
 */

import { describe, expect, it } from 'vitest';
import { markdownToDoc } from './markdown-to-doc';
import { docToMarkdown } from './doc-to-markdown';

type N = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: N[];
  text?: string;
  marks?: unknown;
};

/** Merge consecutive text nodes that share the exact mark set. Adjacent
 *  same-mark text nodes are semantically identical regardless of how the
 *  parser split them (escapes emit separate text tokens), so collapsing them
 *  is the right granularity for a semantic comparison. */
function coalesce(nodes: N[]): N[] {
  const out: N[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (
      n.type === 'text' &&
      prev?.type === 'text' &&
      JSON.stringify(prev.marks ?? null) === JSON.stringify(n.marks ?? null)
    ) {
      prev.text = (prev.text ?? '') + (n.text ?? '');
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Strip the volatile bits before comparing: block `id`s (regenerated every
 *  parse) and an aside's `angle` (a `:::aside` fence always re-parses to 135,
 *  by design — colour IS preserved); and coalesce text runs (see above). */
function normalize(node: N): N {
  const attrs = node.attrs ? { ...node.attrs } : undefined;
  if (attrs) {
    delete attrs.id;
    if (node.type === 'aside') delete attrs.angle;
  }
  const out: N = { type: node.type };
  if (attrs && Object.keys(attrs).length) out.attrs = attrs;
  if (node.text !== undefined) out.text = node.text;
  if (node.marks !== undefined) out.marks = node.marks;
  if (node.content) out.content = coalesce(node.content.map(normalize));
  return out;
}

/** markdownToDoc(m) and markdownToDoc(docToMarkdown(markdownToDoc(m))) agree. */
function roundTrips(md: string): void {
  const once = markdownToDoc(md) as N;
  const back = docToMarkdown(once);
  const twice = markdownToDoc(back) as N;
  expect(normalize(twice)).toEqual(normalize(once));
}

describe('docToMarkdown — round-trip stability', () => {
  it('headings + paragraphs', () => {
    roundTrips('# Title\n\nA paragraph of plain text.\n\n## Sub\n\nMore text.');
  });

  it('inline marks: bold, italic, strike, code, link', () => {
    roundTrips('Some **bold**, *italic*, ~~struck~~, `code`, and a [link](https://x.io/a).');
  });

  it('nested + combined marks', () => {
    roundTrips('A ***bold-italic*** word and a **[bold link](https://x.io)**.');
  });

  it('highlight and themed colour spans', () => {
    roundTrips('Plain ==highlight== then [coloured]{color=chart-2} and [both]{color=chart-1 highlight=chart-3}.');
  });

  it('bullet, ordered, and task lists (incl. nesting)', () => {
    roundTrips('- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done');
  });

  it('blockquote, code block, horizontal rule', () => {
    roundTrips('> quoted line\n> second line\n\n```ts\nconst x = 1;\n```\n\n---\n\nafter');
  });

  it('tables', () => {
    roundTrips('| Name | Role |\n| --- | --- |\n| Ash | Analyst |\n| Jay | Owner |');
  });

  it('callouts and asides', () => {
    roundTrips(':::info\nHeads up — something to note.\n:::\n\n:::aside chart-3\nA themed aside.\n:::');
  });

  it('columns', () => {
    roundTrips(':::columns\nLeft column text.\n+++\nRight column text.\n:::');
  });

  it('math (inline + block)', () => {
    roundTrips('Inline $E=mc^2$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$');
  });

  it('text that LOOKS like markdown stays literal', () => {
    roundTrips('A line with a literal * star and _under_score_ and [brackets] and # hash.');
  });

  it('a paragraph starting with block markers stays a paragraph', () => {
    roundTrips('- not a list, just a dash sentence.');
    roundTrips('# not a heading either');
    roundTrips('1. not an ordered item');
  });

  it('the full kitchen sink in one doc', () => {
    roundTrips(
      [
        '# Report',
        '',
        'Intro with **bold** and a [link](https://x.io).',
        '',
        ':::warning',
        'Careful here.',
        ':::',
        '',
        '- alpha',
        '- beta',
        '  - beta.1',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '> a quote',
        '',
        '```js',
        'return 42;',
        '```',
      ].join('\n'),
    );
  });
});

describe('docToMarkdown — direct output + edges', () => {
  it('passes a string through unchanged and tolerates junk', () => {
    expect(docToMarkdown('# already markdown')).toBe('# already markdown');
    expect(docToMarkdown(null)).toBe('');
    expect(docToMarkdown(42)).toBe('');
    expect(docToMarkdown({ type: 'doc' })).toBe('');
  });

  it('produces clean markdown for a simple doc', () => {
    const md = docToMarkdown(markdownToDoc('# Hi\n\nHello **world**.'));
    expect(md).toBe('# Hi\n\nHello **world**.');
  });

  it('round-trips through a note-shaped export (doc → md → doc)', () => {
    const md = '## Notes\n\n- buy milk\n- [x] ship it\n\nDone.';
    expect(docToMarkdown(markdownToDoc(md))).toContain('- [x] ship it');
  });
});
