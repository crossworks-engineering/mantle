/**
 * Unit tests for diffBlocks — drives the AI-assist panel's diff summary
 * + (later) the editor's per-block diff view. Stable per-block ids are
 * the foundation; this test layer locks down the matching semantics.
 */

import { describe, expect, it } from 'vitest';
import { ensureBlockIds } from './block-ids';
import { diffBlocks } from './block-diff';

function blocked(doc: Record<string, unknown>): Record<string, unknown> {
  return ensureBlockIds(doc);
}

describe('diffBlocks', () => {
  it('reports zero changes when doc and draft are identical', () => {
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hi' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'world' }] },
      ],
    });
    const d = diffBlocks(doc, doc);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.unchangedCount).toBe(2);
    expect(d.ordered).toEqual([]);
  });

  it('reports an added block when the draft has one the doc doesn\'t', () => {
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
    });
    // Draft = doc + a new paragraph (fresh id).
    const draftContent = [
      ...(doc as { content: unknown[] }).content,
      { type: 'paragraph', attrs: { id: 'new-block' }, content: [{ type: 'text', text: 'two' }] },
    ];
    const draft = { type: 'doc', content: draftContent };

    const d = diffBlocks(doc, draft);
    expect(d.added).toHaveLength(1);
    expect(d.added[0]!.id).toBe('new-block');
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.unchangedCount).toBe(1);
    expect(d.ordered).toHaveLength(1);
    expect(d.ordered[0]!.kind).toBe('added');
  });

  it('reports a removed block when the draft is missing one the doc has', () => {
    type N = { attrs: { id: string } };
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'keep' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'drop' }] },
      ],
    });
    const keepId = (doc as { content: N[] }).content[0]!.attrs.id;
    const draft = blocked({
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: keepId }, content: [{ type: 'text', text: 'keep' }] },
      ],
    });

    const d = diffBlocks(doc, draft);
    expect(d.added).toEqual([]);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0]!.preview).toBe('drop');
    expect(d.changed).toEqual([]);
    expect(d.unchangedCount).toBe(1);
  });

  it('reports a changed block when same id has different content', () => {
    type N = { attrs: { id: string } };
    const doc = blocked({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old text' }] }],
    });
    const id = (doc as { content: N[] }).content[0]!.attrs.id;
    const draft = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id }, content: [{ type: 'text', text: 'new text' }] },
      ],
    };

    const d = diffBlocks(doc, draft);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.from.preview).toBe('old text');
    expect(d.changed[0]!.to.preview).toBe('new text');
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.unchangedCount).toBe(0);
  });

  it('detects style-only changes (callout variant flip) as changed, not unchanged', () => {
    const id = 'call-1';
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { id, variant: 'info' },
          content: [{ type: 'paragraph', attrs: { id: 'p-1' }, content: [{ type: 'text', text: 'note' }] }],
        },
      ],
    };
    const draft = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { id, variant: 'warning' }, // only the variant changed
          content: [{ type: 'paragraph', attrs: { id: 'p-1' }, content: [{ type: 'text', text: 'note' }] }],
        },
      ],
    };

    const d = diffBlocks(doc, draft);
    // The callout (id call-1) is changed; the inner paragraph (id p-1) is unchanged.
    expect(d.changed.map((c) => c.to.id)).toContain(id);
    // p-1's text is the same, JSON identical → unchanged.
    expect(d.changed.map((c) => c.to.id)).not.toContain('p-1');
  });

  it('handles a complete restyle (every block changed)', () => {
    type N = { attrs: { id: string } };
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'C' }] },
      ],
    });
    const ids = (doc as { content: N[] }).content.map((b) => b.attrs.id);
    const draft = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: ids[0] }, content: [{ type: 'text', text: 'AA' }] },
        { type: 'paragraph', attrs: { id: ids[1] }, content: [{ type: 'text', text: 'BB' }] },
        { type: 'paragraph', attrs: { id: ids[2] }, content: [{ type: 'text', text: 'CC' }] },
      ],
    };
    const d = diffBlocks(doc, draft);
    expect(d.changed).toHaveLength(3);
    expect(d.unchangedCount).toBe(0);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('ordered output preserves the document-walk order', () => {
    type N = { attrs: { id: string } };
    const doc = blocked({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'C' }] },
      ],
    });
    const [aId, bId, cId] = (doc as { content: N[] }).content.map((b) => b.attrs.id);
    // Draft: change A, leave B, drop C, add a new D at the end.
    const draft = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: aId }, content: [{ type: 'text', text: 'AA' }] },
        { type: 'paragraph', attrs: { id: bId }, content: [{ type: 'text', text: 'B' }] },
        { type: 'paragraph', attrs: { id: 'new-d' }, content: [{ type: 'text', text: 'D' }] },
      ],
    };
    const d = diffBlocks(doc, draft);
    // Expected ordering: walk draft (A=changed, B=unchanged-skipped, D=added),
    // then removals from doc (C=removed).
    expect(d.ordered.map((c) => c.kind)).toEqual(['changed', 'added', 'removed']);
    expect((d.ordered[0]! as { kind: 'changed'; to: { id: string } }).to.id).toBe(aId);
    expect((d.ordered[1]! as { kind: 'added'; block: { id: string } }).block.id).toBe('new-d');
    expect((d.ordered[2]! as { kind: 'removed'; block: { id: string } }).block.id).toBe(cId);
  });
});
