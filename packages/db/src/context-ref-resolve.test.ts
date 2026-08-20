import { describe, expect, it } from 'vitest';
import { CONTEXT_KINDS, NODE_TYPE_BY_KIND } from './context-ref-resolve';
import { nodeType } from './schema/nodes';

/**
 * The resolver's own queries need a live database, so they are not covered here.
 * The mapping is pure, and it is where the sharp edges are: the client's kind
 * vocabulary and the `node_type` enum are two different lists that mostly — but
 * NOT always — share their names. `folder`/`branch` already disagree, and the
 * failure mode is silent (a ref that resolves to nothing, so the agent simply
 * never sees what the user is looking at).
 */
describe('context ref kind → node type', () => {
  it('maps every kind except email, which is a lookup not a mapping', () => {
    const mapped = new Set(Object.keys(NODE_TYPE_BY_KIND));
    const expected = CONTEXT_KINDS.filter((k) => k !== 'email');

    expect([...mapped].sort()).toEqual([...expected].sort());
    expect(mapped.has('email')).toBe(false);
  });

  it('only ever names real node types', () => {
    const real = new Set<string>(nodeType.enumValues);
    for (const [kind, type] of Object.entries(NODE_TYPE_BY_KIND)) {
      expect(real.has(type), `${kind} → ${type} is not a node_type`).toBe(true);
    }
  });

  it('keeps folder pointing at branch', () => {
    // Pinned deliberately: `branch` is the generic container type behind note,
    // journal, event and mail folders alike. A tidy-up that "corrected" this to
    // `folder` would compile — there is no such node type, so it would not —
    // but a rename in the enum could quietly make it wrong.
    expect(NODE_TYPE_BY_KIND.folder).toBe('branch');
  });

  it('leaves the identity kinds alone', () => {
    // Everything except folder happens to share its name with its node type.
    // If that stops being true, this test should be updated with intent rather
    // than the map being bent to match it.
    for (const kind of CONTEXT_KINDS) {
      if (kind === 'email' || kind === 'folder') continue;
      expect(NODE_TYPE_BY_KIND[kind]).toBe(kind);
    }
  });
});
