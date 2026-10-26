import { describe, expect, it } from 'vitest';
import { htmlToText, parseMarkupBytes, xmlToText } from './markup';
import { parseDocumentBytes } from './parse';

describe('htmlToText', () => {
  it('keeps the content, drops scripts, styles and the head', () => {
    const html = `<!doctype html><html><head><title>Tab title</title><style>p{}</style></head>
      <body><script>track()</script><h1>Pump P-101</h1><p>Seal  replaced<br>on 3 May.</p>
      <!-- a comment --><noscript>enable JS</noscript></body></html>`;
    expect(htmlToText(html)).toBe('Pump P-101\n\nSeal replaced\non 3 May.');
  });

  it('keeps table rows apart and cells tab-separated', () => {
    const html =
      '<table><tr><th>Tag</th><th>Size</th></tr><tr><td>P-101</td><td>4 in</td></tr></table>';
    expect(htmlToText(html).split('\n')).toEqual(['Tag\tSize', 'P-101\t4 in']);
  });

  it('decodes named and numeric references, and leaves unknown names alone', () => {
    expect(htmlToText('<p>A &amp; B &#8211; C &#x2014; D &nbsp;E &bogus;</p>')).toBe(
      'A & B – C — D E &bogus;',
    );
  });

  it('drops control characters from numeric references', () => {
    expect(htmlToText('<p>a&#0;b&#7;c</p>')).toBe('abc');
  });
});

describe('xmlToText', () => {
  it('gives each element its own line, in order, without attributes', () => {
    const xml = `<?xml version="1.0"?><items><item id="1"><name>Valve</name><note>Check
      monthly</note></item><item id="2"><name><![CDATA[Pump & motor]]></name></item></items>`;
    expect(xmlToText(xml)).toBe('Valve\nCheck monthly\nPump & motor');
  });

  it('falls back to the tag scanner for a document saxes rejects', () => {
    expect(xmlToText('<a><b>one</b><c>two</a>')).toBe('onetwo');
  });
});

describe('parseMarkupBytes', () => {
  it('routes .xml to the XML reader and .html to the HTML scanner, BOM dropped', () => {
    const bom = '\uFEFF';
    expect(parseMarkupBytes(Buffer.from(`${bom}<r><v>1</v><v>2</v></r>`), 'xml')).toBe('1\n2');
    expect(parseMarkupBytes(Buffer.from(`${bom}<p>x</p><p>y</p>`), 'htm')).toBe('x\n\ny');
  });

  it('is what parseDocumentBytes uses for markup files', async () => {
    await expect(parseDocumentBytes(Buffer.from('<p>Saved page</p>'), 'html')).resolves.toBe(
      'Saved page',
    );
    await expect(parseDocumentBytes(Buffer.from('<a><b>x</b></a>'), 'xml')).resolves.toBe('x');
  });
});
