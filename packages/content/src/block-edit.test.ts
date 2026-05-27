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
  deleteBlock,
  findBlock,
  insertAfterBlock,
  replaceBlock,
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
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'inside' }] },
          ],
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
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'old' }] },
      ],
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
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'old' }] },
          ],
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
    expect((inner.content as Array<{ text: string }>)[0]!.text).toBe('new');
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
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'only' }] },
          ],
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
