import { describe, expect, it } from 'vitest';
import { referencedFileIds } from './doc-assets';

describe('referencedFileIds', () => {
  it('collects image + fileEmbed nodeIds, deduped, walking nested nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: 'a' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
        {
          type: 'callout',
          content: [
            { type: 'fileEmbed', attrs: { nodeId: 'b' } },
            { type: 'image', attrs: { nodeId: 'a' } }, // dup
          ],
        },
      ],
    };
    expect(referencedFileIds(doc).sort()).toEqual(['a', 'b']);
  });

  it('returns [] for nullish / asset-free docs', () => {
    expect(referencedFileIds(null)).toEqual([]);
    expect(referencedFileIds({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual([]);
    expect(referencedFileIds({ type: 'image', attrs: {} })).toEqual([]); // no nodeId
  });
});
