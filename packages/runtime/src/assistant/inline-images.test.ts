/**
 * The double-render rule: a picture the reply placed itself must not also show
 * up in the strip below it.
 */
import { describe, expect, it } from 'vitest';
import { artifactsNotPlacedInline, durableAttachmentsFor } from './inline-images';

const img = (nodeId: string) => ({ kind: 'image' as const, nodeId });

describe('artifactsNotPlacedInline', () => {
  it('drops the gallery copy of a picture the reply placed inline', () => {
    const kept = artifactsNotPlacedInline(
      [img('f-1'), img('f-2')],
      'Step 1\n\n![a](media:f-1)\n\nStep 2, see below.',
    );
    expect(kept.map((a) => a.nodeId)).toEqual(['f-2']);
  });

  it('keeps everything when the reply placed nothing', () => {
    const artifacts = [img('f-1'), img('f-2')];
    expect(artifactsNotPlacedInline(artifacts, 'Here are the two screenshots.')).toEqual(artifacts);
  });

  it('never suppresses a non-image artifact', () => {
    // Markdown can't place audio, so there is no inline copy to duplicate,
    // even if some file id collided.
    const audio = { kind: 'audio' as const, nodeId: 'f-1' };
    expect(artifactsNotPlacedInline([audio], '![a](media:f-1)')).toEqual([audio]);
  });

  it('keeps an artifact with no node id', () => {
    const orphan = { kind: 'image' as const };
    expect(artifactsNotPlacedInline([orphan], '![a](media:f-1)')).toEqual([orphan]);
  });

  it('is not fooled by a file-embed LINK, which shows no picture', () => {
    const artifacts = [img('f-2')];
    expect(artifactsNotPlacedInline(artifacts, 'see [spec.pdf](media:f-2)')).toEqual(artifacts);
  });
});

/**
 * The column a turn actually writes. Every surface persists a turn the same
 * three ways — drop what the reply placed, keep only what has a node, carry the
 * reference and not the bytes — and the two member surfaces used to do none of
 * it, which is why `show_image` worked and no member ever saw a picture.
 */
describe('durableAttachmentsFor', () => {
  const img = (nodeId: string, extra: Record<string, unknown> = {}) =>
    ({ kind: 'image', nodeId, mimeType: 'image/png', ...extra }) as never;

  it('carries the node reference, never the bytes', () => {
    const rows = durableAttachmentsFor([img('f-1', { base64: 'AAAA' })], 'here it is');
    expect(rows).toEqual([{ kind: 'image', nodeId: 'f-1', mime: 'image/png' }]);
    expect(JSON.stringify(rows)).not.toContain('AAAA');
  });

  it('drops an artifact with no node — nothing a client could fetch', () => {
    expect(durableAttachmentsFor([{ kind: 'image', mimeType: 'image/png' } as never], 'x')).toEqual(
      [],
    );
  });

  it('omits a picture the reply already placed inline', () => {
    expect(durableAttachmentsFor([img('f-1')], 'see ![chart](media:f-1)')).toEqual([]);
  });

  it('keeps the ones the reply did not place', () => {
    const rows = durableAttachmentsFor([img('f-1'), img('f-2')], '![a](media:f-1)');
    expect(rows.map((r) => r.nodeId)).toEqual(['f-2']);
  });

  it('keeps a caption when the artifact has one', () => {
    expect(durableAttachmentsFor([img('f-1', { caption: 'LVC' })], 'x')[0]).toMatchObject({
      caption: 'LVC',
    });
  });
});
