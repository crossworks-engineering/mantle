/**
 * Unit tests for ensureBlockIds + allBlocksHaveIds.
 *
 * The block-id layer is the foundation of Phase 2b (block-addressed
 * editing) — every test below locks down an invariant the editor / tool
 * surface depends on: every block-type node has an id, existing ids are
 * preserved, non-block nodes (text, inline math) stay untouched, and the
 * helper is idempotent + structurally stable when nothing needs adding.
 */

import { describe, expect, it } from 'vitest';
import { allBlocksHaveIds, ensureBlockIds, repairTableRows } from './block-ids';

describe('ensureBlockIds', () => {
  it('injects an id on every top-level block', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hi' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
        { type: 'horizontalRule' },
      ],
    };
    const out = ensureBlockIds(doc);
    const blocks = (out as { content: { attrs?: { id?: string } }[] }).content;
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      expect(typeof b.attrs?.id).toBe('string');
      expect(b.attrs!.id!.length).toBeGreaterThan(8);
    }
    // All ids unique within the doc
    const ids = blocks.map((b) => b.attrs!.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('descends into containers — callout body + columns + lists each get ids per block', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { variant: 'info' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Inside' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'callout' }] },
          ],
        },
        {
          type: 'columnList',
          content: [
            {
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'L' }] }],
            },
            {
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'R' }] }],
            },
          ],
        },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
          ],
        },
      ],
    };
    const out = ensureBlockIds(doc);
    expect(allBlocksHaveIds(out)).toBe(true);
  });

  it('preserves existing ids — does NOT regenerate', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'keep-me' }, content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
      ],
    };
    const out = ensureBlockIds(doc) as {
      content: { attrs?: { id?: string } }[];
    };
    expect(out.content[0]!.attrs?.id).toBe('keep-me');
    expect(typeof out.content[1]!.attrs?.id).toBe('string');
    expect(out.content[1]!.attrs?.id).not.toBe('keep-me');
  });

  it('returns the SAME reference when every block already has an id (no-op fast path)', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'a' }, content: [{ type: 'text', text: 'x' }] },
        {
          type: 'callout',
          attrs: { id: 'b', variant: 'info' },
          content: [
            { type: 'paragraph', attrs: { id: 'c' }, content: [{ type: 'text', text: 'y' }] },
          ],
        },
      ],
    };
    const out = ensureBlockIds(doc);
    // Identity equality — proves no allocation on the no-op path. This is
    // the lazy-backfill happy case (every page after the first read).
    expect(out).toBe(doc);
  });

  it('does NOT inject ids on inline-only nodes (text, marks, inline math)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Plain ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'inlineMath', attrs: { latex: 'E=mc^2' } },
          ],
        },
      ],
    };
    const out = ensureBlockIds(doc) as {
      content: {
        attrs?: { id?: string };
        content: { type: string; attrs?: { id?: string } }[];
      }[];
    };
    const para = out.content[0]!;
    // The paragraph itself gets an id (it's a block).
    expect(typeof para.attrs?.id).toBe('string');
    // But its inline children stay un-id'd — they're not addressable units.
    for (const inline of para.content) {
      expect(inline.attrs?.id).toBeUndefined();
    }
  });

  it('injects an id on a childPage atom (Phase 4a — addressable sub-page card)', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'childPage', attrs: { pageId: 'p1', title: 'Sub' } }],
    };
    const out = ensureBlockIds(doc) as {
      content: { attrs?: { id?: string; pageId?: string } }[];
    };
    expect(typeof out.content[0]!.attrs?.id).toBe('string');
    // The id is added alongside the existing attrs, never replacing them.
    expect(out.content[0]!.attrs?.pageId).toBe('p1');
  });

  it('idempotent — running twice produces the same ids', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
      ],
    };
    const first = ensureBlockIds(doc) as { content: { attrs?: { id?: string } }[] };
    const second = ensureBlockIds(first) as { content: { attrs?: { id?: string } }[] };
    expect(first.content[0]!.attrs!.id).toBe(second.content[0]!.attrs!.id);
    expect(first.content[1]!.attrs!.id).toBe(second.content[1]!.attrs!.id);
    // And the no-op fast path: ref equality on the second pass.
    expect(first).toBe(second);
  });
});

describe('ensureBlockIds — duplicate-id self-heal', () => {
  // Reproduces the refinery-SOP draft corruption (2026-07-06):
  // four top-level step paragraphs sharing one id, produced by the editor
  // copying ids on split/paste. Every later occurrence must be re-minted;
  // the FIRST keeps the id (that's the block findBlock already resolved
  // to, so any address the agent holds stays valid).
  const DUP = 'a7f08640-07b3-44a5-bcb3-4bafb4fe3735';
  const stepDoc = () => ({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: 'h-55', level: 3 }, content: [{ type: 'text', text: '5.5 Service Import' }] },
      { type: 'paragraph', attrs: { id: DUP }, content: [{ type: 'text', text: 'Step 1' }] },
      { type: 'paragraph', attrs: { id: DUP }, content: [{ type: 'text', text: 'Step 2' }] },
      { type: 'paragraph', attrs: { id: DUP }, content: [{ type: 'text', text: 'Step 3' }] },
      { type: 'paragraph', attrs: { id: 'unique-78' }, content: [{ type: 'text', text: 'Note' }] },
      { type: 'paragraph', attrs: { id: DUP }, content: [{ type: 'text', text: 'Step 4' }] },
    ],
  });

  it('re-mints every duplicate; the first occurrence keeps its id', () => {
    const out = ensureBlockIds(stepDoc()) as { content: { attrs: { id: string } }[] };
    const ids = out.content.map((b) => b.attrs.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids[1]).toBe(DUP); // first dup keeps the id
    expect(ids[0]).toBe('h-55'); // untouched
    expect(ids[4]).toBe('unique-78'); // untouched
    for (const later of [ids[2], ids[3], ids[5]]) {
      expect(later).not.toBe(DUP);
    }
  });

  it('heals a duplicate nested inside a container (pre-order: outer first)', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'x' }, content: [{ type: 'text', text: 'top' }] },
        {
          type: 'callout',
          attrs: { id: 'c', variant: 'info' },
          content: [{ type: 'paragraph', attrs: { id: 'x' }, content: [{ type: 'text', text: 'inner' }] }],
        },
      ],
    };
    const out = ensureBlockIds(doc) as unknown as {
      content: [{ attrs: { id: string } }, { attrs: { id: string }; content: { attrs: { id: string } }[] }];
    };
    expect(out.content[0].attrs.id).toBe('x');
    expect(out.content[1].content[0]!.attrs.id).not.toBe('x');
  });

  it('is idempotent after the heal (second pass is a ref-equal no-op)', () => {
    const healed = ensureBlockIds(stepDoc());
    expect(ensureBlockIds(healed)).toBe(healed);
  });
});

describe('allBlocksHaveIds', () => {
  it('returns false when two blocks share an id (dup counts as broken)', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'same' } },
        { type: 'paragraph', attrs: { id: 'same' } },
      ],
    };
    expect(allBlocksHaveIds(doc)).toBe(false);
  });

  it('returns true on a fully-id\'d doc', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: '1', level: 1 } },
        { type: 'paragraph', attrs: { id: '2' } },
      ],
    };
    expect(allBlocksHaveIds(doc)).toBe(true);
  });

  it('returns false if any block is missing an id', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: '1', level: 1 } },
        { type: 'paragraph' }, // missing id
      ],
    };
    expect(allBlocksHaveIds(doc)).toBe(false);
  });

  it('returns false if any nested block is missing an id', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { id: 'c1', variant: 'info' },
          content: [
            { type: 'paragraph' }, // nested missing id
          ],
        },
      ],
    };
    expect(allBlocksHaveIds(doc)).toBe(false);
  });
});

describe('repairTableRows', () => {
  const cell = (t: string) => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
  const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });

  it('wraps a bare paragraph child of a tableRow back into a tableCell', () => {
    // The exact production shape: a 3-col row where 2 cells lost their wrapper.
    const doc = {
      type: 'doc',
      content: [
        { type: 'table', content: [{ type: 'tableRow', content: [cell('SOP / Procedure'), para('Refinery SOP Rev.0'), para('✅ Complete')] }] },
      ],
    };
    const fixed = repairTableRows(doc) as typeof doc;
    const row = (fixed.content[0] as { content: Array<{ type: string; content: unknown[] }> }).content[0] as {
      content: Array<{ type: string; content: Array<{ type: string }> }>;
    };
    // All three children are now cells (the intended 3-column row).
    expect(row.content.map((c) => c.type)).toEqual(['tableCell', 'tableCell', 'tableCell']);
    // The wrapped cells hold the original paragraph as their block content.
    expect(row.content[1]?.content[0]?.type).toBe('paragraph');
  });

  it('leaves a valid table untouched (same reference)', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell('A'), cell('B')] }] }],
    };
    expect(repairTableRows(doc)).toBe(doc);
  });

  it('repairs a table nested inside a column', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'columnList',
          content: [{ type: 'column', content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell('X'), para('Y')] }] }] }],
        },
      ],
    };
    const fixed = repairTableRows(doc) as typeof doc;
    const row = (((fixed.content[0] as any).content[0].content[0].content[0]) as { content: Array<{ type: string }> });
    expect(row.content.map((c) => c.type)).toEqual(['tableCell', 'tableCell']);
  });
});
