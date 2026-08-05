/**
 * The shared reference-scheme helpers. Small surface, but two converters, the
 * turn finalizer and the Telegram sender all read it, so the edges (partial
 * markers mid-stream, a link that is not an image) are pinned here rather than
 * re-discovered in each caller.
 */
import { describe, expect, it } from 'vitest';
import {
  fileRawSrc,
  inlineMediaImageIds,
  markdownRefs,
  mediaFileId,
  stripInlineMediaImages,
} from './markdown-refs';

describe('mediaFileId', () => {
  it('extracts the id from a media: href', () => {
    expect(mediaFileId('media:f-1')).toBe('f-1');
    expect(mediaFileId('media:0e5c1a4e-1111-2222-3333-444455556666')).toBe(
      '0e5c1a4e-1111-2222-3333-444455556666',
    );
  });

  it('returns null for anything else', () => {
    for (const href of ['https://x/y.png', 'page:p-9', 'mention:node:n-1', 'media:', '', undefined])
      expect(mediaFileId(href)).toBeNull();
  });
});

describe('fileRawSrc', () => {
  it('builds the same path PageImage.renderHTML derives from nodeId', () => {
    expect(fileRawSrc('f-1')).toBe('/api/files/files/f-1?raw=1');
  });
});

describe('inlineMediaImageIds', () => {
  it('collects every id the reply placed itself', () => {
    const ids = inlineMediaImageIds('Step 1\n\n![a](media:f-1)\n\nStep 2\n\n![b](media:f-2)');
    expect([...ids].sort()).toEqual(['f-1', 'f-2']);
  });

  it('counts a marker written mid-prose', () => {
    expect([...inlineMediaImageIds('see ![x](media:f-9) here')]).toEqual(['f-9']);
  });

  it('ignores a file-embed LINK, which does not render the picture', () => {
    expect(inlineMediaImageIds('[spec.pdf](media:f-2)').size).toBe(0);
  });

  it('ignores partial markers and non-media images', () => {
    expect(inlineMediaImageIds('![a](media:').size).toBe(0);
    expect(inlineMediaImageIds('![a](https://x/y.png)').size).toBe(0);
    expect(inlineMediaImageIds('').size).toBe(0);
    expect(inlineMediaImageIds(null).size).toBe(0);
  });
});

describe('stripInlineMediaImages', () => {
  it('drops a marker that owns its line, and the blank run it leaves', () => {
    const { text, stripped } = stripInlineMediaImages(
      'Step one.\n\n![the form](media:f-1)\n\nStep two.',
    );
    expect(text).toBe('Step one.\n\nStep two.');
    expect(stripped).toBe(1);
  });

  it('leaves the alt text behind for a marker sitting in prose', () => {
    const { text, stripped } = stripInlineMediaImages('Open ![the form](media:f-1) now.');
    expect(text).toBe('Open the form now.');
    expect(stripped).toBe(1);
  });

  it('leaves ordinary images and file-embed links alone', () => {
    const src = 'See ![arch](https://x/y.png) and [spec.pdf](media:f-2).';
    expect(stripInlineMediaImages(src)).toEqual({ text: src, stripped: 0 });
  });

  it('is a no-op on text with no markers', () => {
    expect(stripInlineMediaImages('Just prose.')).toEqual({ text: 'Just prose.', stripped: 0 });
  });
});

describe('markdownRefs', () => {
  it('collects media, page and explicit node mentions with their required type', () => {
    const refs = markdownRefs(
      'Intro\n\n![a](media:f-1)\n\n[Spec](page:p-2) and [Bob](mention:node:n-3).',
    );
    expect(refs).toEqual([
      { scheme: 'media', id: 'f-1', nodeType: 'file' },
      { scheme: 'page', id: 'p-2', nodeType: 'page' },
      { scheme: 'mention', id: 'n-3' },
    ]);
  });

  it('treats a media file-EMBED link the same as an image — both need a real id', () => {
    expect(markdownRefs('[spec.pdf](media:f-2)')).toEqual([
      { scheme: 'media', id: 'f-2', nodeType: 'file' },
    ]);
  });

  it('skips entity mentions, which name no node', () => {
    expect(markdownRefs('[Acme](mention:entity:e-1) and [Acme](mention:e-2)')).toEqual([]);
  });

  it('ignores ordinary links and images', () => {
    expect(markdownRefs('[docs](https://x/y) ![pic](https://x/y.png) ![a](media:')).toEqual([]);
  });

  it('dedupes a ref used twice', () => {
    expect(markdownRefs('![a](media:f-1)\n\n![again](media:f-1)')).toEqual([
      { scheme: 'media', id: 'f-1', nodeType: 'file' },
    ]);
  });

  it('is safe on empty input', () => {
    expect(markdownRefs('')).toEqual([]);
    expect(markdownRefs(null)).toEqual([]);
  });
});
