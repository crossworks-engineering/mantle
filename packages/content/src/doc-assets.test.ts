import { describe, expect, it } from 'vitest';
import { referencedFileIds, referencedDrawIds } from './doc-assets';

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

describe('referencedDrawIds', () => {
  it('collects embedded drawings and ignores uploaded images', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { drawId: 'd1', alt: 'Architecture' } },
        { type: 'image', attrs: { nodeId: 'f1', alt: 'Screenshot' } },
        { type: 'paragraph', content: [{ type: 'image', attrs: { drawId: 'd2' } }] },
        { type: 'image', attrs: { drawId: 'd1' } },
      ],
    };
    expect(referencedDrawIds(doc).sort()).toEqual(['d1', 'd2']);
    // The two scopes stay separate: a share must not serve a drawing as a file.
    expect(referencedFileIds(doc)).toEqual(['f1']);
  });

  it('is empty for a doc with no drawings', () => {
    expect(referencedDrawIds({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual([]);
    expect(referencedDrawIds(null)).toEqual([]);
  });
});
