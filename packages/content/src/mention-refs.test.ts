import { describe, expect, it } from 'vitest';
import { mentionRefs } from './mention-refs';

describe('mentionRefs', () => {
  it('returns empty sets for nullish / mention-free docs', () => {
    expect(mentionRefs(null)).toEqual({ entityIds: [], nodeIds: [] });
    expect(mentionRefs({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual({
      entityIds: [],
      nodeIds: [],
    });
  });

  it('splits entity and node refs, deduped + order-preserving', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: 'ent1', label: 'Sarah', ref: 'entity' } },
            { type: 'mention', attrs: { id: 'page1', label: 'Plan', ref: 'node' } },
            { type: 'mention', attrs: { id: 'ent1', label: 'Sarah', ref: 'entity' } },
          ],
        },
        {
          type: 'callout',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'mention', attrs: { id: 'note1', label: 'Idea', ref: 'node' } }],
            },
          ],
        },
      ],
    };
    expect(mentionRefs(doc)).toEqual({ entityIds: ['ent1'], nodeIds: ['page1', 'note1'] });
  });

  it('treats a missing ref as an entity (back-compat)', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'e9' } }] }],
    };
    expect(mentionRefs(doc)).toEqual({ entityIds: ['e9'], nodeIds: [] });
  });
});
