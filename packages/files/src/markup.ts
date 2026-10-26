/**
 * HTML and XML → readable text, in-process. The one place markup is turned
 * into text: file ingest (`.html`/`.htm`/`.xml`) and the `web_fetch` tool
 * both come here. Tika used to do this job; for markup it only ever stripped
 * tags, which needs no JVM.
 *
 * HTML is read with a tolerant tag scanner, not an XML parser: real pages are
 * not well-formed. Block elements become line breaks and table cells tabs,
 * so paragraphs and rows stay apart for the chunker. Scripts, styles and the
 * like are dropped with their content.
 *
 * XML is read with saxes: every element's own text becomes a line, in
 * document order, and attributes are left out (they are mostly ids and
 * namespaces). A document saxes rejects falls back to the HTML scanner, so a
 * broken file still gives its text rather than nothing.
 *
 * Never throws. An empty result means the markup held no text.
 */

import { SaxesParser } from 'saxes';

/** Elements whose content is never readable text. */
const DROPPED = ['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'object'];

/** Elements that end a line of text. A table row ends one at its close only,
 *  so rows are not separated by an empty line. */
const BLOCK =
  'address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|thead|tfoot|ul';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  deg: '°',
  euro: '€',
  pound: '£',
};

/** Decode character references. An unknown name is left as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      // A control character or an invalid code point is dropped, not kept.
      if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Collapse runs of spaces inside lines and runs of empty lines. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\xa0]+/g, (run) => (run.includes('\t') ? '\t' : ' ')).trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Readable text from an HTML page (or any tag soup). */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<!doctype[^>]*>/gi, ' ')
    .replace(/<\?[\s\S]*?\?>/g, ' ');
  for (const tag of DROPPED) {
    text = text.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');
  }
  text = text
    .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, '\t')
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n?/g, '\n');
  return tidy(decodeEntities(text));
}

/** Readable text from an XML document: each element's own text, one per line. */
export function xmlToText(xml: string): string {
  const lines: string[] = [];
  let current = '';
  const end = () => {
    const line = current.replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
    current = '';
  };
  const parser = new SaxesParser();
  parser.on('text', (t) => {
    current += t;
  });
  parser.on('cdata', (t) => {
    current += t;
  });
  parser.on('opentag', end);
  parser.on('closetag', end);
  try {
    parser.write(xml).close();
  } catch {
    return htmlToText(xml);
  }
  end();
  return lines.join('\n');
}

/** Only this much of a markup file is read. Tags are most of a page, so 32 MB
 *  of markup is far more text than any document holds, and the cap keeps a
 *  huge export (uploads go to 512 MB) from holding the whole file as a string
 *  in the worker. Tika parsed in its own capped heap; this is the in-process
 *  bound in its place. */
const MAX_MARKUP_BYTES = 32 * 1024 * 1024;

/** File-ingest entry: `.xml` takes the XML reader, everything else the HTML
 *  scanner. A UTF-8 BOM is dropped first. */
export function parseMarkupBytes(bytes: Buffer, ext: string): string {
  const head = bytes.length > MAX_MARKUP_BYTES ? bytes.subarray(0, MAX_MARKUP_BYTES) : bytes;
  const source = head.toString('utf8').replace(/^\uFEFF/, '');
  return ext === 'xml' ? xmlToText(source) : htmlToText(source);
}
