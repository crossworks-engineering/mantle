import { describe, expect, it } from 'vitest';
import { mentionEntityIds } from './mention-refs';

describe('mentionEntityIds', () => {
  it('returns [] for nullish / mention-free docs', () => {
    expect(mentionEntityIds(null)).toEqual([]);
    expect(mentionEntityIds({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual([]);
  });

  it('collects ids from mention nodes, deduped + order-preserving', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'met ' },
            { type: 'mention', attrs: { id: 'e1', label: 'Sarah' } },
            { type: 'text', text: ' and ' },
            { type: 'mention', attrs: { id: 'e2', label: 'Alex' } },
          ],
        },
        {
          type: 'callout',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'mention', attrs: { id: 'e1', label: 'Sarah' } }],
            },
          ],
        },
      ],
    };
    expect(mentionEntityIds(doc)).toEqual(['e1', 'e2']);
  });

  it('ignores mentions without a string id', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { label: 'orphan' } }] }],
    };
    expect(mentionEntityIds(doc)).toEqual([]);
  });
});
