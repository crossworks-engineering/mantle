/**
 * Unit tests for the block-edit helpers (findBlock / replaceBlock /
 * insertAfterBlock / deleteBlock). These are the foundation for the
 * Phase 2b page_block_* tools — every invariant below is something the
 * tool surface depends on:
 *
 *   - Block ids survive a replace (first new block inherits the old id)
 *   - Deletion refuses to empty a non-root container
 *   - All four helpers descend into containers (callout, column, listItem)
 *   - Pure: the input doc reference is never mutated
 */

import { describe, expect, it } from 'vitest';
import { ensureBlockIds } from './block-ids';
import {
  appendBlocks,
  deleteBlock,
  findBlock,
  insertAfterBlock,
  insertBeforeBlock,
  replaceBlock,
  wrapBlocks,
} from './block-edit';

function blocked(doc: Record<string, unknown>): Record<string, unknown> {
  return ensureBlockIds(doc);
}

describe('findBlock', () => {
  it('finds a top-level block by id', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'P' }] },
      ],
    });
    const id = (doc as { content: { attrs: { id: string } }[] }).content[1]!.attrs.id;
    const r = findBlock(doc, id);
    expect(r).not.toBeNull();
    expect(r!.block.type).toBe('paragraph');
    expect(r!.index).toBe(1);
    expect(r!.siblingCount).toBe(2);
    expect(r!.parent.type).toBe('doc');
  });

  it('finds a nested block inside a callout', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { variant: 'info' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inside' }] }],
        },
      ],
    });
    type N = { attrs: { id: string }; content?: N[] };
    const inner = (doc as { content: N[] }).content[0]!.content![0]!;
    const r = findBlock(doc, inner.attrs.id);
    expect(r).not.toBeNull();
    expect(r!.block.type).toBe('paragraph');
    expect(r!.parent.type).toBe('callout');
    expect(r!.siblingCount).toBe(1);
  });

  it('returns null when the id is unknown', () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'P' }] }],
    });
    expect(findBlock(doc, 'no-such-id')).toBeNull();
  });
});

describe('replaceBlock', () => {
  it('inherits the old id on the first new block (agent continuity)', () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old' }] }],
    });
    const oldId = (doc as { content: { attrs: { id: string } }[] }).content[0]!.attrs.id;

    const r = replaceBlock(doc, oldId, [
      { type: 'paragraph', content: [{ type: 'text', text: 'new' }] },
    ]);
    expect(r.found).toBe(true);
    const newBlock = (r.doc as { content: { attrs: { id: string } }[] }).content[0]!;
    expect(newBlock.attrs.id).toBe(oldId);
  });

  it('splices multiple new blocks in place of one — first inherits id', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
      ],
    });
    type N = { type: string; attrs: { id: string }; content?: unknown };
    const targetId = (doc as { content: N[] }).content[0]!.attrs.id;

    const r = replaceBlock(doc, targetId, [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'P' }] },
    ]);
    expect(r.found).toBe(true);
    const blocks = (r.doc as { content: N[] }).content;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.type).toBe('heading');
    expect(blocks[0]!.attrs.id).toBe(targetId); // first inherits
    expect(blocks[1]!.type).toBe('paragraph'); // newly inserted
    expect(blocks[2]!.type).toBe('paragraph'); // original 'two' shifted
  });

  it('overwrites a parse-minted id on the first new block with the target id', () => {
    // Production path: markdownToDoc runs ensureBlockIds at parse, so new
    // blocks ALWAYS arrive with fresh ids. Inheritance must still win —
    // otherwise the target's id churns on every update and the agent's
    // held address goes stale (and a caller-supplied id could smuggle a
    // duplicate into the doc).
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old' }] }],
    });
    type N = { attrs: { id: string } };
    const targetId = (doc as { content: N[] }).content[0]!.attrs.id;

    const r = replaceBlock(doc, targetId, [
      {
        type: 'paragraph',
        attrs: { id: 'parse-minted-id' },
        content: [{ type: 'text', text: 'new' }],
      },
    ]);
    expect(r.found).toBe(true);
    expect((r.doc as { content: N[] }).content[0]!.attrs.id).toBe(targetId);
  });

  it('returns found=false on unknown id, leaves doc unchanged', () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
    });
    const r = replaceBlock(doc, 'missing', [
      { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
    ]);
    expect(r.found).toBe(false);
    expect(r.doc).toBe(doc); // same reference — no mutation, no clone
  });

  it('descends into a callout to replace a nested block', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { variant: 'info' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old' }] }],
        },
      ],
    });
    type N = { type: string; attrs: { id: string }; content?: N[] };
    const innerId = (doc as { content: N[] }).content[0]!.content![0]!.attrs.id;
    const r = replaceBlock(doc, innerId, [
      { type: 'paragraph', content: [{ type: 'text', text: 'new' }] },
    ]);
    expect(r.found).toBe(true);
    const inner = (r.doc as { content: N[] }).content[0]!.content![0]!;
    expect(inner.attrs.id).toBe(innerId);
    expect((inner.content as unknown as Array<{ text: string }>)[0]!.text).toBe('new');
  });

  it('does not mutate the input doc', () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before' }] }],
    });
    const before = JSON.stringify(doc);
    type N = { attrs: { id: string } };
    const id = (doc as { content: N[] }).content[0]!.attrs.id;
    replaceBlock(doc, id, [{ type: 'paragraph', content: [{ type: 'text', text: 'after' }] }]);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('insertAfterBlock', () => {
  it('inserts a new block directly after the target', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
      ],
    });
    type N = { attrs: { id: string }; content?: Array<{ text?: string }> };
    const firstId = (doc as { content: N[] }).content[0]!.attrs.id;
    const r = insertAfterBlock(doc, firstId, [
      { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
    ]);
    expect(r.found).toBe(true);
    const blocks = (r.doc as { content: N[] }).content;
    expect(blocks).toHaveLength(3);
    expect(blocks[1]!.content![0]!.text).toBe('two');
  });

  it('inserts multiple blocks in order', () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
    });
    type N = { attrs: { id: string }; type: string };
    const id = (doc as { content: N[] }).content[0]!.attrs.id;
    const r = insertAfterBlock(doc, id, [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'P' }] },
    ]);
    expect(r.found).toBe(true);
    const blocks = (r.doc as { content: N[] }).content;
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'heading', 'paragraph']);
  });

  it('returns found=false on unknown id, leaves doc unchanged', () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
    });
    const r = insertAfterBlock(doc, 'missing', [
      { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
    ]);
    expect(r.found).toBe(false);
    expect(r.doc).toBe(doc);
  });
});

describe('deleteBlock', () => {
  it('removes a top-level block', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
      ],
    });
    type N = { attrs: { id: string }; content?: Array<{ text?: string }> };
    const id = (doc as { content: N[] }).content[0]!.attrs.id;
    const r = deleteBlock(doc, id);
    expect(r.found).toBe(true);
    expect(r.refused).toBeUndefined();
    expect((r.doc as { content: N[] }).content).toHaveLength(1);
    expect((r.doc as { content: N[] }).content[0]!.content![0]!.text).toBe('B');
  });

  it('refuses to leave a callout empty (would produce invalid doc)', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { variant: 'info' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'only' }] }],
        },
      ],
    });
    type N = { attrs: { id: string }; content?: N[] };
    const innerId = (doc as { content: N[] }).content[0]!.content![0]!.attrs.id;
    const r = deleteBlock(doc, innerId);
    expect(r.found).toBe(true);
    expect(r.refused).toBe(true);
    expect(r.reason).toContain('callout');
    expect(r.doc).toBe(doc); // unchanged
  });

  it('allows deleting one of N children in a container', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { variant: 'info' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
          ],
        },
      ],
    });
    type N = { attrs: { id: string }; content?: N[] };
    const innerId = (doc as { content: N[] }).content[0]!.content![0]!.attrs.id;
    const r = deleteBlock(doc, innerId);
    expect(r.found).toBe(true);
    expect(r.refused).toBeUndefined();
    const callout = (r.doc as { content: N[] }).content[0]!;
    expect(callout.content).toHaveLength(1);
  });

  it('allows deleting the last top-level block (doc root is exempt)', () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'only' }] }],
    });
    type N = { attrs: { id: string } };
    const id = (doc as { content: N[] }).content[0]!.attrs.id;
    const r = deleteBlock(doc, id);
    expect(r.found).toBe(true);
    expect(r.refused).toBeUndefined();
    expect((r.doc as { content: unknown[] }).content).toHaveLength(0);
  });

  it('returns found=false on unknown id, leaves doc unchanged', () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
    });
    const r = deleteBlock(doc, 'missing');
    expect(r.found).toBe(false);
    expect(r.doc).toBe(doc);
  });
});

describe('insertBeforeBlock', () => {
  it('inserts before the FIRST block (index 0, the case insert_after cannot express)', () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
    });
    type N = { attrs: { id: string }; type: string; content?: Array<{ text?: string }> };
    const firstId = (doc as { content: N[] }).content[0]!.attrs.id;
    const r = insertBeforeBlock(doc, firstId, [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
    ]);
    expect(r.found).toBe(true);
    const blocks = (r.doc as { content: N[] }).content;
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph']);
    expect(blocks[1]!.attrs.id).toBe(firstId); // anchor unchanged, just shifted
  });

  it('inserts before a nested block inside a callout', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { variant: 'info' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inside' }] }],
        },
      ],
    });
    type N = { attrs: { id: string }; type: string; content?: N[] & Array<{ text?: string }> };
    const innerId = (doc as { content: N[] }).content[0]!.content![0]!.attrs.id;
    const r = insertBeforeBlock(doc, innerId, [
      { type: 'paragraph', content: [{ type: 'text', text: 'lead-in' }] },
    ]);
    expect(r.found).toBe(true);
    const callout = (r.doc as { content: N[] }).content[0]!;
    expect(callout.content).toHaveLength(2);
    expect((callout.content![0] as { content?: Array<{ text?: string }> }).content![0]!.text).toBe(
      'lead-in',
    );
  });

  it('returns found=false on unknown id, leaves doc unchanged', () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
    });
    const r = insertBeforeBlock(doc, 'missing', [
      { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
    ]);
    expect(r.found).toBe(false);
    expect(r.doc).toBe(doc);
  });
});

describe('appendBlocks', () => {
  it("position 'end' adds after the last block", () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
    });
    type N = { type: string; content?: Array<{ text?: string }> };
    const r = appendBlocks(
      doc,
      [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }],
      'end',
    );
    const blocks = (r.doc as { content: N[] }).content;
    expect(blocks.map((b) => b.content![0]!.text)).toEqual(['one', 'two']);
    // Pure: the input doc is untouched.
    expect((doc as { content: N[] }).content).toHaveLength(1);
  });

  it("position 'start' adds before the first block", () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
    });
    type N = { type: string; content?: Array<{ text?: string }> };
    const r = appendBlocks(
      doc,
      [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] }],
      'start',
    );
    const blocks = (r.doc as { content: N[] }).content;
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph']);
  });

  it('works on an empty doc (no content array)', () => {
    const r = appendBlocks(
      { type: 'doc' },
      [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
      'end',
    );
    expect((r.doc as { content: unknown[] }).content).toHaveLength(1);
  });
});

describe('wrapBlocks', () => {
  type N = {
    type: string;
    attrs?: { id: string; variant?: string; color?: string };
    content?: N[] & Array<{ text?: string }>;
  };
  /** Three top-level paragraphs + their ids. */
  function threePara() {
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'C' }] },
      ],
    });
    const ids = (doc as { content: N[] }).content.map((b) => b.attrs!.id);
    return { doc, ids };
  }

  it('wraps a contiguous run in a callout, byte-for-byte, ids kept', () => {
    const { doc, ids } = threePara();
    const r = wrapBlocks(doc, [ids[0]!, ids[1]!], 'callout', 'warning');
    expect(r.found).toBe(true);
    expect(r.refused).toBeUndefined();
    const blocks = (r.doc as { content: N[] }).content!;
    expect(blocks).toHaveLength(2);
    const callout = blocks[0]!;
    expect(callout.type).toBe('callout');
    expect(callout.attrs!.variant).toBe('warning');
    expect(callout.attrs!.id).toBe(r.wrapperId);
    // The wrapped blocks moved inside UNCHANGED: same ids, same text.
    expect(callout.content!.map((b) => (b as N).attrs!.id)).toEqual([ids[0], ids[1]]);
    expect(callout.content!.map((b) => (b as N).content![0]!.text)).toEqual(['A', 'B']);
    expect(blocks[1]!.attrs!.id).toBe(ids[2]);
  });

  it('accepts ids out of document order and wraps in document order', () => {
    const { doc, ids } = threePara();
    const r = wrapBlocks(doc, [ids[1]!, ids[0]!], 'callout');
    expect(r.refused).toBeUndefined();
    const callout = (r.doc as { content: N[] }).content![0]!;
    expect(callout.content!.map((b) => (b as N).attrs!.id)).toEqual([ids[0], ids[1]]);
  });

  it('refuses a non-contiguous run', () => {
    const { doc, ids } = threePara();
    const r = wrapBlocks(doc, [ids[0]!, ids[2]!], 'callout');
    expect(r.refused).toBe(true);
    expect(r.reason).toContain('not contiguous');
    expect(r.doc).toBe(doc);
  });

  it('refuses blocks under different parents', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'top' }] },
        {
          type: 'callout',
          attrs: { variant: 'info' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }],
        },
      ],
    });
    const top = (doc as { content: N[] }).content[0]!.attrs!.id;
    const nested = ((doc as { content: N[] }).content[1]!.content![0] as N).attrs!.id;
    const r = wrapBlocks(doc, [top, nested], 'callout');
    expect(r.refused).toBe(true);
    expect(r.reason).toContain('different parents');
  });

  it('refuses a callout inside a callout', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { variant: 'info' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }],
        },
      ],
    });
    const nested = ((doc as { content: N[] }).content[0]!.content![0] as N).attrs!.id;
    const r = wrapBlocks(doc, [nested], 'callout');
    expect(r.refused).toBe(true);
    expect(r.reason).toContain('callout');
  });

  it('refuses columns nested inside a column', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'columnList',
          content: [
            {
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'in col' }] }],
            },
            {
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'other' }] }],
            },
          ],
        },
      ],
    });
    const inCol = (((doc as { content: N[] }).content[0]!.content![0] as N).content![0] as N)
      .attrs!.id;
    const r = wrapBlocks(doc, [inCol], 'columns');
    expect(r.refused).toBe(true);
    expect(r.reason).toContain('columns');
  });

  it('refuses structural children (list items cannot leave their list)', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
      ],
    });
    const li = ((doc as { content: N[] }).content[0]!.content![0] as N).attrs!.id;
    const r = wrapBlocks(doc, [li], 'callout');
    expect(r.refused).toBe(true);
    expect(r.reason).toContain('structural child');
  });

  it('columns fan-out: one column per block, wrapper id minted', () => {
    const { doc, ids } = threePara();
    const r = wrapBlocks(doc, [ids[0]!, ids[1]!, ids[2]!], 'columns');
    expect(r.refused).toBeUndefined();
    const blocks = (r.doc as { content: N[] }).content!;
    expect(blocks).toHaveLength(1);
    const list = blocks[0]!;
    expect(list.type).toBe('columnList');
    expect(list.attrs!.id).toBe(r.wrapperId);
    expect(list.content!.map((c) => (c as N).type)).toEqual(['column', 'column', 'column']);
    expect(
      list.content!.map((c) => ((c as N).content![0] as N).attrs!.id),
    ).toEqual([ids[0], ids[1], ids[2]]);
  });

  it('refuses a columns wrap of more than 4 blocks', () => {
    const doc = blocked({
      type: 'doc',
      content: ['A', 'B', 'C', 'D', 'E'].map((t) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: t }],
      })),
    });
    const ids = (doc as { content: N[] }).content.map((b) => b.attrs!.id);
    const r = wrapBlocks(doc, ids, 'columns');
    expect(r.refused).toBe(true);
    expect(r.reason).toContain('caps at 4');
  });

  it('reports found=false with the missing id', () => {
    const { doc, ids } = threePara();
    const r = wrapBlocks(doc, [ids[0]!, 'missing'], 'callout');
    expect(r.found).toBe(false);
    expect(r.missingId).toBe('missing');
    expect(r.doc).toBe(doc);
  });

  it('aside wrap carries the themed colour variant', () => {
    const { doc, ids } = threePara();
    const r = wrapBlocks(doc, [ids[0]!], 'aside', 'chart-3');
    expect(r.refused).toBeUndefined();
    const aside = (r.doc as { content: N[] }).content![0]!;
    expect(aside.type).toBe('aside');
    expect(aside.attrs!.color).toBe('chart-3');
  });
});
