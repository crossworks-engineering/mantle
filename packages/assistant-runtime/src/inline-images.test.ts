/**
 * The double-render rule: a picture the reply placed itself must not also show
 * up in the strip below it.
 */
import { describe, expect, it } from 'vitest';
import { artifactsNotPlacedInline } from './inline-images';

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
