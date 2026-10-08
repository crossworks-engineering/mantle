import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseDocumentBytes } from './parse';
import { chartLine, paragraphsOf, parsePptx } from './pptx';

const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const NOTES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const CHART_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const DIAGRAM_DATA_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData';

const rels = (entries: Array<[string, string, string?]>) =>
  `<?xml version="1.0"?><Relationships>${entries
    .map(
      ([id, target, type]) =>
        `<Relationship Id="${id}"${type ? ` Type="${type}"` : ''} Target="${target}"/>`,
    )
    .join('')}</Relationships>`;

const shape = (...paras: string[]) =>
  `<p:sp><p:txBody>${paras.map((t) => `<a:p><a:r><a:rPr lang="en"/><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;

/**
 * A deck shaped like the one that exposed the Tika 4 bug: slide rIds that
 * sort wrongly as strings (rId9 before rId10 numerically, after it lexically),
 * and part numbers that disagree with the presentation's own order.
 */
async function deck(): Promise<Buffer> {
  const zip = new JSZip();
  const order: Array<[string, string]> = [];
  for (let i = 1; i <= 11; i++) order.push([`rId${i + 6}`, `slides/slide${12 - i}.xml`]);
  zip.file(
    'ppt/presentation.xml',
    `<p:presentation><p:sldIdLst>${order
      .map(([rId], i) => `<p:sldId id="${256 + i}" r:id="${rId}"/>`)
      .join('')}</p:sldIdLst></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels(order.map(([rId, target]) => [rId, target, SLIDE_REL])),
  );
  order.forEach(([, target], i) => {
    zip.file(`ppt/${target}`, `<p:sld>${shape(`Slide ${i + 1} title`)}</p:sld>`);
  });
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

describe('parsePptx', () => {
  it('reads slides in the presentation order, not rId string order or part numbering', async () => {
    const text = await parsePptx(await deck());
    const titles = text.split('\n\n');
    expect(titles).toEqual(Array.from({ length: 11 }, (_, i) => `Slide ${i + 1} title`));
  });

  it('adds speaker notes after the slide text and drops field runs', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/presentation.xml',
      '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
    );
    zip.file('ppt/_rels/presentation.xml.rels', rels([['rId2', 'slides/slide1.xml', SLIDE_REL]]));
    zip.file(
      'ppt/slides/slide1.xml',
      `<p:sld>${shape('Turnaround plan', 'Check the flange &amp; gasket')}<p:sp><p:txBody><a:p><a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp></p:sld>`,
    );
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      rels([
        ['rId1', '../slideLayouts/slideLayout1.xml', 'x/slideLayout'],
        ['rId3', '../notesSlides/notesSlide1.xml', NOTES_REL],
      ]),
    );
    zip.file(
      'ppt/notesSlides/notesSlide1.xml',
      `<p:notes>${shape('Speaker note: torque first')}<p:sp><p:txBody><a:p><a:fld type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp></p:notes>`,
    );
    const text = await parsePptx(Buffer.from(await zip.generateAsync({ type: 'uint8array' })));
    expect(text).toBe('Turnaround plan\nCheck the flange & gasket\n\nSpeaker note: torque first');
  });

  it('adds chart values and SmartArt text after the slide text', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', `<p:sld>${shape('Wall loss by area')}</p:sld>`);
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      rels([
        ['rId2', '../charts/chart1.xml', CHART_REL],
        ['rId3', '../diagrams/data1.xml', DIAGRAM_DATA_REL],
        [
          'rId4',
          '../diagrams/drawing1.xml',
          'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing',
        ],
      ]),
    );
    zip.file(
      'ppt/charts/chart1.xml',
      '<c:chartSpace><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Loss</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
        '<c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>North</c:v></c:pt><c:pt idx="1"><c:v>South</c:v></c:pt></c:strCache></c:strRef></c:cat>' +
        '<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>12.5</c:v></c:pt><c:pt idx="1"><c:v>7</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>',
    );
    zip.file(
      'ppt/diagrams/data1.xml',
      '<dgm:dataModel><dgm:ptLst><dgm:pt><dgm:t><a:p><a:r><a:t>Plan</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt><dgm:t><a:p><a:r><a:t>Inspect</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>',
    );
    zip.file('ppt/diagrams/drawing1.xml', `<dsp:drawing>${shape('Plan', 'Inspect')}</dsp:drawing>`);
    const text = await parsePptx(Buffer.from(await zip.generateAsync({ type: 'uint8array' })));
    expect(text).toBe('Wall loss by area\n\nLoss\tNorth\tSouth\t12.5\t7\n\nPlan\nInspect');
  });

  it('falls back to part numbering when the presentation lists no slides', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide10.xml', `<p:sld>${shape('ten')}</p:sld>`);
    zip.file('ppt/slides/slide2.xml', `<p:sld>${shape('two')}</p:sld>`);
    const text = await parsePptx(Buffer.from(await zip.generateAsync({ type: 'uint8array' })));
    expect(text).toBe('two\n\nten');
  });

  it('throws on bytes that are not a zip (parseDocumentBytes then tries Tika)', async () => {
    await expect(parsePptx(Buffer.from('not a deck'))).rejects.toThrow();
  });
});

describe('paragraphsOf', () => {
  it('joins runs within a paragraph and keeps breaks, tabs and entities', () => {
    const xml =
      '<a:p><a:r><a:t>Café </a:t></a:r><a:r><a:t>€42 &lt;net&gt;</a:t></a:r><a:br/><a:r><a:t>line&#x20;two</a:t></a:r></a:p>' +
      '<a:p/><a:p><a:pPr/><a:r><a:t>a</a:t></a:r><a:tab/><a:r><a:t>b</a:t></a:r></a:p>';
    expect(paragraphsOf(xml)).toEqual(['Café €42 <net>\nline two', 'a\tb']);
  });

  it('does not mistake table, tab or pPr tags for text', () => {
    const xml =
      '<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>R0C0</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>' +
      '<a:tc><a:txBody><a:p><a:r><a:t>R0C1</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>';
    expect(paragraphsOf(xml)).toEqual(['R0C0\tR0C1']);
  });

  it('renders each table row as one tab-joined line, empty cells kept in place', () => {
    const cellXml = (t: string) =>
      `<a:tc><a:txBody>${t ? `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>` : '<a:p/>'}</a:txBody></a:tc>`;
    const xml =
      '<a:p><a:r><a:t>Before</a:t></a:r></a:p><a:tbl>' +
      `<a:tr h="1">${cellXml('Area')}${cellXml('')}${cellXml('Loss')}</a:tr>` +
      `<a:tr h="1">${cellXml('North')}${cellXml('x')}${cellXml('12%')}</a:tr>` +
      '</a:tbl><a:p><a:r><a:t>After</a:t></a:r></a:p>';
    expect(paragraphsOf(xml)).toEqual(['Before', 'Area\t\tLoss', 'North\tx\t12%', 'After']);
  });
});

describe('chartLine', () => {
  it('keeps the chart title runs and skips empty cached values', () => {
    expect(
      chartLine(
        '<c:title><a:p><a:r><a:t>Readings &amp; limits</a:t></a:r></a:p></c:title><c:v></c:v><c:v>3</c:v>',
      ),
    ).toBe('Readings & limits\t3');
  });
});

describe('parseDocumentBytes: pptx', () => {
  it('uses the in-process reader for a readable deck', async () => {
    const text = await parseDocumentBytes(await deck(), 'pptx');
    expect(text.startsWith('Slide 1 title\n\nSlide 2 title')).toBe(true);
  });
});
