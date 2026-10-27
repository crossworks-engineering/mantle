import { describe, expect, it } from 'vitest';
import { htmlToText, parseMarkupBytes, xmlToText } from './markup';
import { readDocumentText } from './read-document';

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

  it('keeps a stray < as text and drops CDATA markers, PIs and the doctype', () => {
    expect(htmlToText('<!DOCTYPE html><?php x ?><p>a < b, 3<4</p><![CDATA[raw]]>')).toBe(
      'a < b, 3<4\nraw',
    );
  });

  it('drops an unclosed script to the end, as a browser does', () => {
    expect(htmlToText('<p>kept</p><script>var x = "<p>gone</p>";')).toBe('kept');
  });

  it('keeps the text between scripts when each one closes', () => {
    expect(htmlToText('<SCRIPT>a</script >one<script/>two<Script>b</SCRIPT>')).toBe('onetwo');
  });
});

/** 5 MB of each shape that made the old lazy regexes rescan the rest of the
 *  page per occurrence (128 KB of `<?` took 23.5 s). */
describe('htmlToText on hostile input', () => {
  const FIVE_MB = 5 * 1024 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(FIVE_MB / unit.length));
  const shapes: Record<string, string> = {
    'unclosed processing instructions': fill('<?'),
    'unclosed comments': fill('<!--'),
    'unclosed CDATA': fill('<![CDATA['),
    'scripts that never close': fill('<script>x'),
    'styles that never close': `${fill('<style>')}`,
    'tags that never end': fill('<a '),
    'closing tags that never end': fill('</a'),
    'nested unclosed drops': fill('<svg><head><iframe>'),
    'entity-like runs': fill('&aaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    'numeric entity runs': fill('&#99999999999999999999'),
    'whitespace runs': fill(' \t\xa0'),
    'many short tags': fill('<b>x</b>'),
  };
  for (const [name, html] of Object.entries(shapes)) {
    it(`reads ${name} in well under 500 ms`, () => {
      const start = performance.now();
      htmlToText(html);
      expect(performance.now() - start).toBeLessThan(500);
    });
  }
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

  it('is what readDocumentText uses for markup files', async () => {
    await expect(readDocumentText(Buffer.from('<p>Saved page</p>'), 'html')).resolves.toBe(
      'Saved page',
    );
    await expect(readDocumentText(Buffer.from('<a><b>x</b></a>'), 'xml')).resolves.toBe('x');
  });
});

describe('htmlToText on mail bodies (email_get, a message with no text part)', () => {
  it('collapses a marketing-mail skeleton to a fraction of its size', () => {
    // A little real text inside a lot of table/style scaffolding: the text
    // must be far smaller than the markup and keep the message.
    const filler = '<table style="width:100%"><tr><td style="padding:0">&nbsp;</td></tr></table>';
    const html =
      `<style>${'.x{margin:0} '.repeat(200)}</style>` +
      filler.repeat(50) +
      '<p>Please send your May bank statement.</p>' +
      filler.repeat(50);
    const text = htmlToText(html);
    expect(text).toContain('Please send your May bank statement.');
    expect(text.length).toBeLessThan(html.length / 10);
  });

  it('drops Outlook conditional comments', () => {
    expect(htmlToText('a<!--[if mso]>junk<![endif]-->b')).toBe('a b');
  });
});
