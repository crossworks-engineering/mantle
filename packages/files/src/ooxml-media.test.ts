import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractOdfImages, extractOoxmlImages } from './ooxml-media';

/** Distinct PNG bytes per image, so ordering assertions can't pass by luck. */
function png(seed: number, width = 600, height = 400): Buffer {
  const b = Buffer.alloc(2_048);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b.writeUInt32BE(seed, 1_000); // payload that differs per image
  return b;
}

const rels = (entries: Array<[string, string]>) =>
  `<?xml version="1.0"?><Relationships>${entries
    .map(([id, target]) => `<Relationship Id="${id}" Target="${target}"/>`)
    .join('')}</Relationships>`;

const pic = (rId: string, descr?: string) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture 2"${
    descr ? ` descr="${descr}"` : ''
  }/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/></p:blipFill></p:pic>`;

describe('extractOoxmlImages — pptx', () => {
  async function deck(): Promise<Buffer> {
    const zip = new JSZip();
    // Deliberately add slide10 before slide2 and store media under names
    // whose numbering disagrees with slide order — the two traps that make
    // "just list ppt/media/" wrong.
    zip.file('ppt/slides/slide1.xml', `<p:sld>${pic('rId1', 'First screenshot')}</p:sld>`);
    zip.file('ppt/slides/_rels/slide1.xml.rels', rels([['rId1', '../media/image9.png']]));
    zip.file('ppt/slides/slide10.xml', `<p:sld>${pic('rId1')}</p:sld>`);
    zip.file('ppt/slides/_rels/slide10.xml.rels', rels([['rId1', '../media/image1.png']]));
    zip.file('ppt/slides/slide2.xml', `<p:sld>${pic('rId1')}${pic('rId2')}</p:sld>`);
    zip.file(
      'ppt/slides/_rels/slide2.xml.rels',
      rels([
        ['rId1', '../media/image5.png'],
        ['rId2', '../media/image3.png'],
      ]),
    );
    zip.file('ppt/media/image9.png', png(1));
    zip.file('ppt/media/image5.png', png(2));
    zip.file('ppt/media/image3.png', png(3));
    zip.file('ppt/media/image1.png', png(4));
    return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
  }

  it('walks slides in numeric order, not lexical or media-part order', async () => {
    const images = await extractOoxmlImages(await deck(), 'pptx');
    expect(images.map((i) => i.location?.slide)).toEqual([1, 2, 2, 10]);
    // Slide 10's image is media/image1 — first by name, last by document order.
    expect(images.at(-1)!.bytes.readUInt32BE(1_000)).toBe(4);
    expect(images[0]!.bytes.readUInt32BE(1_000)).toBe(1);
  });

  it('keeps two images on one slide in the order they appear', async () => {
    const images = await extractOoxmlImages(await deck(), 'pptx');
    const onSlide2 = images.filter((i) => i.location?.slide === 2);
    expect(onSlide2.map((i) => i.bytes.readUInt32BE(1_000))).toEqual([2, 3]);
  });

  it('takes the author’s alt text and leaves the default shape name to the naming layer', async () => {
    const images = await extractOoxmlImages(await deck(), 'pptx');
    expect(images[0]!.altText).toBe('First screenshot');
    // No descr → falls back to the shape name, which naming rejects as junk.
    expect(images[1]!.altText).toBe('Picture 2');
  });

  it('ignores a reference whose part is missing rather than throwing', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', `<p:sld>${pic('rId1')}${pic('rId2')}</p:sld>`);
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      rels([
        ['rId1', '../media/gone.png'],
        ['rId2', '../media/here.png'],
      ]),
    );
    zip.file('ppt/media/here.png', png(7));
    const images = await extractOoxmlImages(
      Buffer.from(await zip.generateAsync({ type: 'uint8array' })),
      'pptx',
    );
    expect(images).toHaveLength(1);
    expect(images[0]!.bytes.readUInt32BE(1_000)).toBe(7);
  });

  it('skips external (linked) relationships, which point outside the archive', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', `<p:sld>${pic('rId1')}</p:sld>`);
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<Relationships><Relationship Id="rId1" Target="https://example.com/a.png" TargetMode="External"/></Relationships>`,
    );
    const images = await extractOoxmlImages(
      Buffer.from(await zip.generateAsync({ type: 'uint8array' })),
      'pptx',
    );
    expect(images).toEqual([]);
  });
});

describe('extractOoxmlImages — xlsx', () => {
  it('attributes images to their sheet, in workbook order', async () => {
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      `<workbook><sheets><sheet name="Setup" r:id="rIdA"/><sheet name="Results" r:id="rIdB"/></sheets></workbook>`,
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      rels([
        ['rIdA', 'worksheets/sheet1.xml'],
        ['rIdB', 'worksheets/sheet2.xml'],
      ]),
    );
    zip.file('xl/worksheets/sheet1.xml', `<worksheet><drawing r:id="rIdD1"/></worksheet>`);
    zip.file('xl/worksheets/_rels/sheet1.xml.rels', rels([['rIdD1', '../drawings/drawing1.xml']]));
    zip.file('xl/worksheets/sheet2.xml', `<worksheet><drawing r:id="rIdD2"/></worksheet>`);
    zip.file('xl/worksheets/_rels/sheet2.xml.rels', rels([['rIdD2', '../drawings/drawing2.xml']]));
    zip.file('xl/drawings/drawing1.xml', `<xdr:wsDr>${pic('rId1')}</xdr:wsDr>`);
    zip.file('xl/drawings/_rels/drawing1.xml.rels', rels([['rId1', '../media/a.png']]));
    zip.file('xl/drawings/drawing2.xml', `<xdr:wsDr>${pic('rId1')}</xdr:wsDr>`);
    zip.file('xl/drawings/_rels/drawing2.xml.rels', rels([['rId1', '../media/b.png']]));
    zip.file('xl/media/a.png', png(11));
    zip.file('xl/media/b.png', png(12));

    const images = await extractOoxmlImages(
      Buffer.from(await zip.generateAsync({ type: 'uint8array' })),
      'xlsx',
    );
    expect(images.map((i) => i.location?.sheet)).toEqual(['Setup', 'Results']);
    expect(images.map((i) => i.bytes.readUInt32BE(1_000))).toEqual([11, 12]);
  });

  it('returns nothing for a workbook with no drawings', async () => {
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      `<workbook><sheets><sheet name="S" r:id="rIdA"/></sheets></workbook>`,
    );
    zip.file('xl/_rels/workbook.xml.rels', rels([['rIdA', 'worksheets/sheet1.xml']]));
    zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData/></worksheet>`);
    expect(
      await extractOoxmlImages(
        Buffer.from(await zip.generateAsync({ type: 'uint8array' })),
        'xlsx',
      ),
    ).toEqual([]);
  });
});

describe('extractOdfImages', () => {
  it('reads content.xml references in document order', async () => {
    const zip = new JSZip();
    zip.file(
      'content.xml',
      `<office:document-content><office:body>
         <draw:image xlink:href="Pictures/second.png"/>
         <draw:image xlink:href="Pictures/first.png"/>
       </office:body></office:document-content>`,
    );
    zip.file('Pictures/second.png', png(21));
    zip.file('Pictures/first.png', png(22));
    const images = await extractOdfImages(
      Buffer.from(await zip.generateAsync({ type: 'uint8array' })),
    );
    // Document order, NOT the alphabetical order of the Pictures folder.
    expect(images.map((i) => i.bytes.readUInt32BE(1_000))).toEqual([21, 22]);
  });

  it('returns nothing when content.xml is absent', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
    expect(
      await extractOdfImages(Buffer.from(await zip.generateAsync({ type: 'uint8array' }))),
    ).toEqual([]);
  });
});
