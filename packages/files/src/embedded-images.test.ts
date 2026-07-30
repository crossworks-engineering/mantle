import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildImageFilename,
  buildImageTitles,
  describeImageBytes,
  MIN_IMAGE_DIMENSION,
  passesGate,
  type EmbeddedImage,
} from './embedded-images';

/** A PNG header of the given size, padded out to a plausible encoded length
 *  so size-based rules can be exercised independently of dimension rules. */
function png(width: number, height: number, totalBytes = 4_000): Buffer {
  const b = Buffer.alloc(Math.max(24, totalBytes));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const gateInput = (bytes: Buffer, ext = 'png') => ({
  bytes,
  ext,
  sha256: createHash('sha256').update(bytes).digest('hex'),
});

describe('passesGate', () => {
  it('keeps a normal diagram', () => {
    expect(passesGate(gateInput(png(600, 260)), new Set())).toEqual({ keep: true });
  });

  it('keeps a lightweight but full-size diagram', () => {
    // Regression: flat line art compresses to ~2 KB. An earlier 8 KB floor
    // rejected exactly the diagrams and screenshots this feature exists for.
    expect(passesGate(gateInput(png(600, 260, 2_137)), new Set())).toEqual({ keep: true });
  });

  it('drops icons and bullets on dimensions', () => {
    expect(passesGate(gateInput(png(16, 16)), new Set())).toEqual({
      keep: false,
      reason: 'too_small',
    });
    expect(passesGate(gateInput(png(MIN_IMAGE_DIMENSION - 1, 800)), new Set())).toEqual({
      keep: false,
      reason: 'too_small',
    });
  });

  it('drops Windows metafiles, which no browser can render', () => {
    expect(passesGate(gateInput(png(600, 600), 'emf'), new Set())).toEqual({
      keep: false,
      reason: 'metafile',
    });
    expect(passesGate(gateInput(png(600, 600), 'wmf'), new Set())).toEqual({
      keep: false,
      reason: 'metafile',
    });
  });

  it('drops containers it cannot identify', () => {
    const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(4_000)]);
    expect(passesGate(gateInput(tiff, 'tiff'), new Set())).toEqual({
      keep: false,
      reason: 'unrenderable',
    });
  });

  it('keeps a vector diagram — every display path embeds SVG via <img>', () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><!--${'x'.repeat(2000)}--></svg>`,
    );
    expect(passesGate(gateInput(svg, 'svg'), new Set())).toEqual({ keep: true });
  });

  it('still drops a vector ICON on its viewBox proportions', () => {
    const icon = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><!--${'x'.repeat(2000)}--></svg>`,
    );
    expect(passesGate(gateInput(icon, 'svg'), new Set())).toEqual({
      keep: false,
      reason: 'too_small',
    });
  });

  it('drops stubs below the absolute byte floor before decoding anything', () => {
    expect(passesGate(gateInput(png(600, 600, 200)), new Set())).toEqual({
      keep: false,
      reason: 'too_few_bytes',
    });
  });

  it('collapses the logo repeated on every slide', () => {
    const logo = gateInput(png(400, 400));
    const seen = new Set<string>();
    expect(passesGate(logo, seen)).toEqual({ keep: true });
    seen.add(logo.sha256);
    expect(passesGate(logo, seen)).toEqual({ keep: false, reason: 'duplicate' });
  });
});

describe('describeImageBytes', () => {
  it('trusts the bytes over the part name', () => {
    // Decks built by conversion tools routinely hold JPEG bytes in a part
    // named .png; the sniffed container is what a browser will honour.
    expect(describeImageBytes(png(80, 40), 'jpg')).toMatchObject({
      ext: 'png',
      width: 80,
      height: 40,
    });
  });

  it('falls back to the supplied extension when it cannot identify the bytes', () => {
    expect(describeImageBytes(Buffer.from('????'), 'emf')).toMatchObject({ ext: 'emf' });
  });
});

const img = (over: Partial<EmbeddedImage>): EmbeddedImage => ({
  bytes: png(600, 400),
  ext: 'png',
  ordinal: 1,
  sha256: 'deadbeef',
  ...over,
});

describe('buildImageTitles', () => {
  it('prefers the author’s alt text', () => {
    const titles = buildImageTitles(
      [img({ altText: 'The APN settings screen', caption: 'Figure 4', heading: 'Step 3' })],
      'APN Configuration Manual.docx',
    );
    expect(titles[0]).toBe('APN Configuration Manual — The APN settings screen');
  });

  it('ignores Office’s default shape names and falls through the cascade', () => {
    for (const junk of ['Picture 1', 'image1.png', 'Content Placeholder 2', 'Rectangle', '7']) {
      const titles = buildImageTitles(
        [img({ altText: junk, heading: 'Step 3 — Add an APN' })],
        'M.docx',
      );
      expect(titles[0], `alt text ${junk} should be rejected`).toBe('M — Step 3 — Add an APN');
    }
  });

  it('falls back to caption, then heading, then position', () => {
    expect(buildImageTitles([img({ caption: 'Figure 4: the APN screen' })], 'M.docx')[0]).toBe(
      'M — Figure 4: the APN screen',
    );
    expect(buildImageTitles([img({ heading: 'Step 3' })], 'M.docx')[0]).toBe('M — Step 3');
    expect(buildImageTitles([img({ ordinal: 5 })], 'M.docx')[0]).toBe('M — image 5');
  });

  it('appends the location so a page or slide reference is usable', () => {
    expect(buildImageTitles([img({ heading: 'Step 3', location: { page: 12 } })], 'M.pdf')[0]).toBe(
      'M — Step 3 (p12)',
    );
    expect(buildImageTitles([img({ location: { slide: 3 } })], 'M.pptx')[0]).toBe(
      'M — image 1 (slide 3)',
    );
    expect(buildImageTitles([img({ location: { sheet: 'Setup' } })], 'M.xlsx')[0]).toBe(
      'M — image 1 (Setup)',
    );
  });

  it('disambiguates several images sharing one heading', () => {
    const titles = buildImageTitles(
      [
        img({ ordinal: 1, heading: 'Step 3' }),
        img({ ordinal: 2, heading: 'Step 3' }),
        img({ ordinal: 3, heading: 'Step 3' }),
      ],
      'M.docx',
    );
    expect(new Set(titles).size).toBe(3);
    expect(titles).toEqual(['M — Step 3', 'M — Step 3 #2', 'M — Step 3 #3']);
  });

  it('clamps a runaway caption instead of writing an essay into the title', () => {
    const titles = buildImageTitles([img({ caption: 'x'.repeat(500) })], 'M.docx');
    expect(titles[0]!.length).toBeLessThanOrEqual(180);
    expect(titles[0]!.endsWith('…')).toBe(true);
  });
});

describe('buildImageFilename', () => {
  it('zero-pads the ordinal so lexical sort is reading order', () => {
    const names = [img({ ordinal: 2 }), img({ ordinal: 10 })].map((i) =>
      buildImageFilename(i, 'apn-manual'),
    );
    expect(names).toEqual(['002-apn-manual.png', '010-apn-manual.png']);
    expect([...names].sort()).toEqual(names);
  });

  it('records where the image came from', () => {
    expect(buildImageFilename(img({ ordinal: 1, location: { page: 12 } }), 'm')).toBe(
      '001-m-p12.png',
    );
    expect(buildImageFilename(img({ ordinal: 1, location: { slide: 3 } }), 'm')).toBe(
      '001-m-slide3.png',
    );
    expect(buildImageFilename(img({ ordinal: 1, location: { sheet: 'Site Register' } }), 'm')).toBe(
      '001-m-site-register.png',
    );
  });

  it('carries no content-derived text, so a reworded caption cannot orphan bytes', () => {
    const a = buildImageFilename(img({ ordinal: 1, caption: 'Figure 4' }), 'm');
    const b = buildImageFilename(img({ ordinal: 1, caption: 'Figure 4 (revised)' }), 'm');
    expect(a).toBe(b);
  });
});
