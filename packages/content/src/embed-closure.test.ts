/**
 * What counts as an embed (embedding means sharing, embed-closure.ts): the
 * pure readers of a page doc, a note's markdown and a drawing's file map.
 * The walk and the lowering run against Postgres in embed-closure.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { referencedEmbedIds } from './doc-assets';
import { drawEmbedIds, drawPlacedFileIds, noteEmbedIds } from './embed-closure';

const F = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const P = '33333333-3333-4333-8333-333333333333';
const L = '44444444-4444-4444-8444-444444444444';

describe('referencedEmbedIds (a page)', () => {
  it('takes images, file embeds, embedded drawings and child page cards, nested', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: F } },
        {
          type: 'callout',
          content: [
            { type: 'image', attrs: { drawId: D } },
            { type: 'fileEmbed', attrs: { nodeId: F } },
            { type: 'childPage', attrs: { pageId: P, title: 'Child' } },
          ],
        },
      ],
    };
    expect(referencedEmbedIds(doc).sort()).toEqual([F, D, P].sort());
  });

  it('leaves links out: a link mark and a mention chip name an item without showing it', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'see', marks: [{ type: 'link', attrs: { href: `page:${L}` } }] },
            { type: 'mention', attrs: { ref: 'node', id: L } },
          ],
        },
      ],
    };
    expect(referencedEmbedIds(doc)).toEqual([]);
  });
});

describe('noteEmbedIds (a note)', () => {
  it('takes images, file embeds and drawings from the markdown, not a page link', () => {
    const md = [
      `![photo](media:${F})`,
      '',
      `![sketch](draw:${D})`,
      '',
      `[Child](page:${P})`,
      '',
      `A [link](page:${L}) in text.`,
    ].join('\n');
    expect(noteEmbedIds(md).sort()).toEqual([F, D].sort());
  });

  it('is empty for an empty note', () => {
    expect(noteEmbedIds('')).toEqual([]);
  });
});

describe('a drawing', () => {
  it('embeds every file in its file map', () => {
    expect(drawEmbedIds({ a: F, b: D, c: F })).toEqual([F, D]);
    expect(drawEmbedIds(null)).toEqual([]);
  });

  it('its snapshot carries only the images the scene places', () => {
    const scene = {
      elements: [
        { type: 'image', fileId: 'a' },
        { type: 'image', fileId: 'b', isDeleted: true },
        { type: 'rectangle' },
        { type: 'image', fileId: 'missing' },
      ],
    };
    expect(drawPlacedFileIds(scene, { a: F, b: D })).toEqual([F]);
    expect(drawPlacedFileIds(null, { a: F })).toEqual([]);
  });
});
