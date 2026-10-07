/**
 * Foldable headings: the markdown marker round-trips losslessly, old docs are
 * untouched, and the shared section rule + reader-choice store behave.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markdownToDoc } from './markdown-to-doc';
import { docToMarkdown } from './doc-to-markdown';
import { listBlocks } from './block-list';
import {
  FOLD_CHOICES_MAX,
  FOLD_STORAGE_KEY,
  foldSections,
  isFolded,
  normalizeFold,
  readFoldChoices,
  writeFoldChoice,
} from './heading-fold';

type N = { type?: string; attrs?: Record<string, unknown>; content?: N[]; text?: string };

const blocks = (md: string) => (markdownToDoc(md) as { content: N[] }).content;
const heading = (md: string) => blocks(md).find((b) => b.type === 'heading')!;
const text = (n: N) => (n.content ?? []).map((c) => c.text ?? '').join('');

describe('foldable heading markdown', () => {
  it('`{fold}` makes a foldable heading that starts open', () => {
    const h = heading('## Plans {fold}');
    expect(h.attrs).toMatchObject({ level: 2, fold: 'open' });
    expect(text(h)).toBe('Plans');
  });

  it('`{fold=closed}` starts folded; `{fold=open}` is the same as `{fold}`', () => {
    expect(heading('# A {fold=closed}').attrs?.fold).toBe('closed');
    expect(heading('# A {fold=open}').attrs?.fold).toBe('open');
  });

  it('keeps inline marks before the marker', () => {
    const h = heading('### **Bold** and `code` {fold}');
    expect(h.attrs?.fold).toBe('open');
    expect(docToMarkdown({ type: 'doc', content: [h] })).toBe('### **Bold** and `code` {fold}');
  });

  it('a heading without a marker has NO fold attr (old docs unchanged)', () => {
    const h = heading('## Plans');
    expect(h.attrs).not.toHaveProperty('fold');
    expect(Object.keys(h.attrs ?? {}).sort()).toEqual(['id', 'level']);
  });

  it('only the trailing marker counts, and only on headings', () => {
    expect(heading('## a {fold} b').attrs).not.toHaveProperty('fold');
    expect(text(heading('## a {fold} b'))).toBe('a {fold} b');
    const p = blocks('text {fold}')[0]!;
    expect(p.type).toBe('paragraph');
    expect(text(p)).toBe('text {fold}');
    expect(heading('## a {folded}').attrs).not.toHaveProperty('fold');
  });

  it('an escaped marker is plain heading text', () => {
    const h = heading('## Use \\{fold} here \\{fold}');
    expect(h.attrs).not.toHaveProperty('fold');
    expect(text(h)).toBe('Use {fold} here {fold}');
  });

  it('works inside containers (callout, list item)', () => {
    const callout = blocks(':::info\n## Inner {fold=closed}\nbody\n:::')[0]!;
    expect(callout.content?.[0]?.attrs?.fold).toBe('closed');
  });
});

describe('foldable heading round-trip (markdown -> doc -> markdown)', () => {
  const cases = [
    '## Plans {fold}',
    '# Top {fold=closed}\n\nBody text.\n\n## Child {fold}\n\n- a\n- b',
    '### **Bold** and *em* {fold}',
    '## Plain heading\n\nNo fold here.',
    '## Literal \\{fold}',
    ':::info\n## In a callout {fold}\n\nx\n:::',
  ];
  for (const md of cases) {
    it(`is identical: ${JSON.stringify(md)}`, () => {
      expect(docToMarkdown(markdownToDoc(md))).toBe(md);
    });
  }

  it('a heading whose WORDS end in a marker survives an editor save', () => {
    // As the editor stores it: plain text, no fold attr.
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'x {fold}' }] },
      ],
    };
    const md = docToMarkdown(doc);
    expect(md).toBe('## x \\{fold}');
    const back = heading(md);
    expect(back.attrs).not.toHaveProperty('fold');
    expect(text(back)).toBe('x {fold}');
  });

  it('`{fold=closed}` as heading WORDS stays words (its `=` is escaped)', () => {
    const md = docToMarkdown(markdownToDoc('## Literal \\{fold=closed}'));
    expect(md).toBe('## Literal {fold\\=closed}');
    expect(heading(md).attrs).not.toHaveProperty('fold');
    expect(text(heading(md))).toBe('Literal {fold=closed}');
  });

  it('a literal backslash before the words stays text too', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'a\\{fold}' }] },
      ],
    };
    const back = heading(docToMarkdown(doc));
    expect(back.attrs).not.toHaveProperty('fold');
    expect(text(back)).toBe('a\\{fold}');
  });

  it('an editor-saved non-foldable heading (fold: null) writes plain markdown', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2, fold: null },
          content: [{ type: 'text', text: 'T' }],
        },
      ],
    };
    expect(docToMarkdown(doc)).toBe('## T');
  });
});

describe('page_blocks_list meta', () => {
  it('names the fold of a foldable heading only', () => {
    const list = listBlocks(markdownToDoc('## A {fold=closed}\n\n## B') as Record<string, unknown>);
    expect(list[0]!.meta).toEqual({ level: 2, fold: 'closed' });
    expect(list[1]!.meta).toEqual({ level: 2 });
  });
});

describe('foldSections', () => {
  // h1 p h2 p h3 p h2 p h1 p
  const levels = [1, null, 2, null, 3, null, 2, null, 1, null];
  const lv = (i: number) => levels[i] ?? null;

  it('a section runs to the next heading of the same or a higher level', () => {
    const all = foldSections(levels.length, lv, () => true);
    expect(all.get(0)).toBe(8); // h1 → next h1
    expect(all.get(2)).toBe(6); // h2 → next h2 (skips the h3)
    expect(all.get(4)).toBe(6); // h3 → the h2
    expect(all.get(6)).toBe(8); // h2 → the h1
    expect(all.get(8)).toBe(10); // last h1 → the end
  });

  it('only foldable headings get a section', () => {
    const one = foldSections(levels.length, lv, (i) => i === 2);
    expect([...one.keys()]).toEqual([2]);
  });
});

describe('fold choices', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('normalizeFold accepts only open/closed', () => {
    expect(normalizeFold('open')).toBe('open');
    expect(normalizeFold('closed')).toBe('closed');
    expect(normalizeFold(null)).toBeNull();
    expect(normalizeFold('x')).toBeNull();
  });

  it('the reader choice wins over the doc default; no choice = the default', () => {
    expect(isFolded('h1', 'closed', {})).toBe(true);
    expect(isFolded('h1', 'open', {})).toBe(false);
    expect(isFolded('h1', 'closed', { h1: false })).toBe(false);
    expect(isFolded('h1', 'open', { h1: true })).toBe(true);
    expect(isFolded('h1', null, { h1: true })).toBe(false); // not foldable = never folded
  });

  it('writes, reads back, and keeps only the newest choices', () => {
    writeFoldChoice('a', true);
    writeFoldChoice('b', false);
    expect(readFoldChoices()).toEqual({ a: true, b: false });
    for (let i = 0; i < FOLD_CHOICES_MAX + 5; i++) writeFoldChoice(`k${i}`, true);
    const keys = Object.keys(readFoldChoices());
    expect(keys).toHaveLength(FOLD_CHOICES_MAX);
    expect(keys).not.toContain('a');
    expect(keys[keys.length - 1]).toBe(`k${FOLD_CHOICES_MAX + 4}`);
  });

  it('survives junk in storage and no storage at all', () => {
    store.set(FOLD_STORAGE_KEY, 'not json');
    expect(readFoldChoices()).toEqual({});
    store.set(FOLD_STORAGE_KEY, '{"a":true,"b":"x"}');
    expect(readFoldChoices()).toEqual({ a: true });
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(readFoldChoices()).toEqual({});
    expect(() => writeFoldChoice('a', true)).not.toThrow();
  });
});
