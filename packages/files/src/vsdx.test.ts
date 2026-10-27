import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseVsdx, shapeTextsOf } from './vsdx';
import { readDocumentText } from './read-document';

const NS = "xmlns='http://schemas.microsoft.com/office/visio/2012/main'";
const R_NS = "xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'";

/** A page part with one shape per label, the way Visio writes them: single
 *  quotes, formatting markers inside `<Text>`. */
function pageXml(labels: string[]): string {
  const shapes = labels
    .map((l, i) => `<Shape ID='${i + 1}'><Text><cp IX='0'/>${l}</Text></Shape>`)
    .join('');
  return `<?xml version='1.0' encoding='utf-8' ?><PageContents ${NS}><Shapes>${shapes}</Shapes></PageContents>`;
}

/** A .vsdx with pages listed in `pages.xml` in the given order. Page parts
 *  are numbered in reverse so the test proves pages.xml order wins. */
async function vsdx(pages: { name: string; labels: string[] }[]): Promise<Buffer> {
  const zip = new JSZip();
  const rels: string[] = [];
  const entries: string[] = [];
  pages.forEach((p, i) => {
    const part = `page${pages.length - i}.xml`;
    zip.file(`visio/pages/${part}`, pageXml(p.labels));
    rels.push(
      `<Relationship Id="rId${i + 1}" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="${part}"/>`,
    );
    entries.push(
      `<Page ID='${i}' NameU='${p.name}' Name='${p.name}'><PageSheet/><Rel r:id='rId${i + 1}'/></Page>`,
    );
  });
  zip.file(
    'visio/pages/pages.xml',
    `<?xml version='1.0' ?><Pages ${NS} ${R_NS}>${entries.join('')}</Pages>`,
  );
  zip.file(
    'visio/pages/_rels/pages.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('shapeTextsOf', () => {
  it('reads each <Text> as one line, markers and entities handled', () => {
    expect(shapeTextsOf(pageXml(['Pump &amp; motor', 'Line\n  2']))).toEqual([
      'Pump & motor',
      'Line 2',
    ]);
  });
});

describe('parseVsdx', () => {
  it('gives the pages in pages.xml order, each under its name', async () => {
    const bytes = await vsdx([
      { name: 'Overview', labels: ['Unit 100'] },
      { name: 'Detail', labels: ['P-101', 'V-102'] },
    ]);
    expect(await parseVsdx(bytes)).toBe('## Overview\n\nUnit 100\n\n## Detail\n\nP-101\nV-102');
  });

  it('returns empty for a drawing with no shape text', async () => {
    expect(await parseVsdx(await vsdx([{ name: 'Blank', labels: [] }]))).toBe('');
  });

  it('is what readDocumentText uses for .vsdx', async () => {
    const bytes = await vsdx([{ name: 'Page-1', labels: ['This is a test.'] }]);
    await expect(readDocumentText(bytes, 'vsdx')).resolves.toBe('## Page-1\n\nThis is a test.');
  });

  it('throws on bytes that are not a zip', async () => {
    await expect(parseVsdx(Buffer.from('not a zip'))).rejects.toThrow();
  });
});
