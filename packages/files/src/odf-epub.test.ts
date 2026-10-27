/**
 * OpenDocument spreadsheets and presentations, and EPUB, through the
 * parser's readers (./read-document.ts for text, ./embedded-images-read.ts
 * for pictures), on small zip fixtures built here. These formats came to
 * anydoc and the zip walk with the parser service (Tika read them before);
 * each fixture carries one picture so the picture path is exercised too.
 */
import { createCanvas } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { readEmbeddedImages } from './embedded-images-read';
import { readDocumentText } from './read-document';

/** A 320x240 PNG of noise: past the picture gate's size and byte floors. */
async function picture(): Promise<Buffer> {
  const canvas = createCanvas(320, 240);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(320, 240);
  let seed = 7;
  for (let i = 0; i < img.data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = i % 4 === 3 ? 255 : seed & 0xff;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.encode('png');
}

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
};

const DECLS = Object.entries(NS)
  .filter(([k]) => k !== 'manifest')
  .map(([k, v]) => `xmlns:${k}="${v}"`)
  .join(' ');

async function odf(mime: string, body: string, png: Buffer): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', mime, { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0"?><manifest:manifest xmlns:manifest="${NS.manifest}"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="Pictures/chart.png" manifest:media-type="image/png"/></manifest:manifest>`,
  );
  zip.file(
    'content.xml',
    `<?xml version="1.0"?><office:document-content ${DECLS} office:version="1.2"><office:body>${body}</office:body></office:document-content>`,
  );
  zip.file('Pictures/chart.png', png);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const FRAME =
  '<draw:frame svg:width="8cm" svg:height="6cm"><draw:image xlink:href="Pictures/chart.png" xlink:type="simple"/></draw:frame>';

async function ods(png: Buffer): Promise<Buffer> {
  const cell = (v: string) =>
    `<table:table-cell office:value-type="string"><text:p>${v}</text:p></table:table-cell>`;
  return odf(
    'application/vnd.oasis.opendocument.spreadsheet',
    `<office:spreadsheet><table:table table:name="Pumps"><table:shapes>${FRAME}</table:shapes><table:table-row>${cell('Tag')}${cell('Service')}</table:table-row><table:table-row>${cell('P-101')}${cell('Feed pump')}</table:table-row></table:table></office:spreadsheet>`,
    png,
  );
}

async function odp(png: Buffer): Promise<Buffer> {
  return odf(
    'application/vnd.oasis.opendocument.presentation',
    `<office:presentation><draw:page draw:name="page1"><draw:frame presentation:class="title" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>Seal replacement plan</text:p></draw:text-box></draw:frame>${FRAME}</draw:page></office:presentation>`,
    png,
  );
}

async function epub(png: Buffer): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file(
    'OEBPS/content.opf',
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:00000000-0000-4000-8000-000000000000</dc:identifier><dc:title>Pump manual</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="images/chart.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/></spine></package>',
  );
  zip.file(
    'OEBPS/nav.xhtml',
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">Chapter 1</a></li></ol></nav></body></html>',
  );
  zip.file(
    'OEBPS/chapter1.xhtml',
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head><body><h1>Chapter 1</h1><p>Replace the mechanical seal on P-101 every two years.</p><img src="images/chart.png" alt="Seal chart"/></body></html>',
  );
  zip.file('OEBPS/images/chart.png', png);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('OpenDocument and EPUB through the parser readers', () => {
  it('.ods: the cells read as text, the picture comes out', async () => {
    const png = await picture();
    const bytes = await ods(png);
    const text = await readDocumentText(bytes, 'ods');
    expect(text).toContain('P-101');
    expect(text).toContain('Feed pump');
    const pics = await readEmbeddedImages(bytes, 'ods');
    expect(pics.images).toHaveLength(1);
    expect(pics.images[0]!.bytes.equals(png)).toBe(true);
  });

  it('.odp: the slide text reads, the picture comes out', async () => {
    const png = await picture();
    const bytes = await odp(png);
    expect(await readDocumentText(bytes, 'odp')).toContain('Seal replacement plan');
    const pics = await readEmbeddedImages(bytes, 'odp');
    expect(pics.images).toHaveLength(1);
    expect(pics.images[0]!.bytes.equals(png)).toBe(true);
  });

  it('.epub: the chapter reads, the picture comes out', async () => {
    const png = await picture();
    const bytes = await epub(png);
    expect(await readDocumentText(bytes, 'epub')).toContain(
      'Replace the mechanical seal on P-101 every two years.',
    );
    const pics = await readEmbeddedImages(bytes, 'epub');
    expect(pics.images.length).toBeGreaterThanOrEqual(1);
    expect(pics.images.some((i) => i.bytes.equals(png))).toBe(true);
  });
});
