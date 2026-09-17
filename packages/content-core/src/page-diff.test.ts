import { describe, expect, it } from 'vitest';
import { computeDiffOverlay } from './page-diff';

const p = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});
const doc = (content: unknown[]) => ({ type: 'doc', content });

describe('computeDiffOverlay', () => {
  it('flags added blocks (top-most) and counts them', () => {
    const committed = doc([p('a', 'one')]);
    const draft = doc([p('a', 'one'), p('b', 'two')]);
    const o = computeDiffOverlay(committed, draft);
    expect(o.addedIds).toEqual(['b']);
    expect(o.changedIds).toEqual([]);
    expect(o.removed).toEqual([]);
    expect(o.counts).toEqual({ added: 1, changed: 0, removed: 0 });
  });

  it('flags changed blocks', () => {
    const committed = doc([p('a', 'one'), p('b', 'two')]);
    const draft = doc([p('a', 'one EDITED'), p('b', 'two')]);
    const o = computeDiffOverlay(committed, draft);
    expect(o.changedIds).toEqual(['a']);
    expect(o.counts.changed).toBe(1);
  });

  it('emits a removed ghost anchored after the previous surviving block', () => {
    const committed = doc([p('a', 'keep'), p('b', 'goner'), p('c', 'tail')]);
    const draft = doc([p('a', 'keep'), p('c', 'tail')]);
    const o = computeDiffOverlay(committed, draft);
    expect(o.removed).toHaveLength(1);
    expect(o.removed[0]).toMatchObject({ id: 'b', kind: 'paragraph', text: 'goner', afterId: 'a' });
    expect(o.counts.removed).toBe(1);
  });

  it('anchors a removed first block at the top (afterId null)', () => {
    const committed = doc([p('a', 'first'), p('b', 'second')]);
    const draft = doc([p('b', 'second')]);
    const o = computeDiffOverlay(committed, draft);
    expect(o.removed[0]).toMatchObject({ id: 'a', afterId: null });
  });

  it('borders the DEEPEST changed block, not its unchanged container shell', () => {
    const callout = (id: string, childId: string, text: string) => ({
      type: 'callout',
      attrs: { id, variant: 'info' },
      content: [p(childId, text)],
    });
    const committed = doc([callout('c1', 'p1', 'inner')]);
    const draft = doc([callout('c1', 'p1', 'inner CHANGED')]);
    const o = computeDiffOverlay(committed, draft);
    // both c1 (its JSON changed because a child changed) and p1 are "changed",
    // but only the deepest (p1) gets the border.
    expect(o.changedIds).toEqual(['p1']);
  });

  it('borders an added subtree once (top-most), not every new child', () => {
    const callout = (id: string, childId: string) => ({
      type: 'callout',
      attrs: { id, variant: 'info' },
      content: [p(childId, 'x')],
    });
    const committed = doc([p('a', 'one')]);
    const draft = doc([p('a', 'one'), callout('c1', 'p1')]);
    const o = computeDiffOverlay(committed, draft);
    expect(o.addedIds).toEqual(['c1']); // not p1
  });

  it('is empty when docs match', () => {
    const same = doc([p('a', 'one')]);
    const o = computeDiffOverlay(same, structuredClone(same));
    expect(o).toMatchObject({
      addedIds: [],
      changedIds: [],
      removed: [],
      counts: { added: 0, changed: 0, removed: 0 },
    });
  });
});
