/**
 * HTML and XML → readable text. The one place markup is turned into text:
 * file ingest (`.html`/`.htm`/`.xml`), the `web_fetch` tool and a mail body
 * with no text part all come here, through the parser service
 * (server/parser), the only process that runs this module.
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
import { forwardFinder } from './xml-scan';

/** Elements whose content is never readable text. */
const DROPPED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'head',
  'iframe',
  'object',
]);

/** Elements that end a line of text. A table row ends one at its close only,
 *  so rows are not separated by an empty line. */
const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'ul',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bull: '\u2022',
  middot: '\u00b7',
  deg: '\u00b0',
  euro: '\u20ac',
  pound: '\u00a3',
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

/** True for a character that can start an element name. */
function isNameStart(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
}

/** True for a character inside an element name (`h1`, `o:p`, `my-tag`). */
function isNameChar(c: number): boolean {
  return isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x3a || c === 0x2d || c === 0x5f;
}

/**
 * Readable text from an HTML page (or any tag soup). One forward pass:
 * comments, the doctype and processing instructions go; CDATA keeps its
 * text; the DROPPED elements go with their content; block elements become
 * line breaks, a row end a line break and a cell a tab; every other tag goes.
 * A `<` that does not start a tag is text. Linear in the input.
 */
export function htmlToText(html: string): string {
  const out: string[] = [];
  const gt = forwardFinder((from) => html.indexOf('>', from));
  const commentEnd = forwardFinder((from) => html.indexOf('-->', from));
  const cdataEnd = forwardFinder((from) => html.indexOf(']]>', from));
  const piEnd = forwardFinder((from) => html.indexOf('?>', from));
  const closers = new Map<string, (from: number) => number>();
  const closerOf = (name: string) => {
    let f = closers.get(name);
    if (!f) {
      const re = new RegExp(`</${name}\\s*>`, 'gi');
      f = forwardFinder((from) => {
        re.lastIndex = from;
        return re.exec(html) ? re.lastIndex : -1;
      });
      closers.set(name, f);
    }
    return f;
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));
    i = lt;

    if (html.startsWith('<!--', i)) {
      const end = commentEnd(i + 4);
      out.push(' ');
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', i)) {
      const end = cdataEnd(i + 9);
      if (end === -1) {
        i = n;
      } else {
        out.push(html.slice(i + 9, end));
        i = end + 3;
      }
      continue;
    }
    if (html.startsWith('<?', i)) {
      const end = piEnd(i + 2);
      if (end !== -1) {
        out.push(' ');
        i = end + 2;
        continue;
      }
      // An unclosed `<?` is a tag up to the next `>`, as below.
    }

    const close = html.charCodeAt(i + 1) === 0x2f; // '/'
    const nameAt = close ? i + 2 : i + 1;
    const first = html.charCodeAt(nameAt);
    if (!(isNameStart(first) || first === 0x21 || first === 0x3f)) {
      // `a < b`, `<3`, a stray `<`: text.
      out.push('<');
      i += 1;
      continue;
    }
    const tagEnd = gt(nameAt);
    if (tagEnd === -1) {
      // A tag that never closes: the rest is not text.
      break;
    }
    let nameEnd = nameAt;
    while (nameEnd < tagEnd && isNameChar(html.charCodeAt(nameEnd))) nameEnd++;
    const name = html.slice(nameAt, nameEnd).toLowerCase();
    i = tagEnd + 1;

    if (!close && DROPPED.has(name) && html.charCodeAt(tagEnd - 1) !== 0x2f) {
      const end = closerOf(name)(i);
      // An element that is never closed takes the rest of the page with it,
      // as it does in a browser.
      out.push(' ');
      i = end === -1 ? n : end;
      continue;
    }
    if (BLOCK.has(name)) out.push('\n');
    else if (close && name === 'tr') out.push('\n');
    else if (name === 'td' || name === 'th') out.push('\t');
  }
  return tidy(decodeEntities(out.join('').replace(/\r\n?/g, '\n')));
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
 *  huge export (uploads go to 512 MB) from holding the whole file as a
 *  string in the parse job. */
const MAX_MARKUP_BYTES = 32 * 1024 * 1024;

/** File-ingest entry: `.xml` takes the XML reader, everything else the HTML
 *  scanner. A UTF-8 BOM is dropped first. */
export function parseMarkupBytes(bytes: Buffer, ext: string): string {
  const head = bytes.length > MAX_MARKUP_BYTES ? bytes.subarray(0, MAX_MARKUP_BYTES) : bytes;
  const source = head.toString('utf8').replace(/^\uFEFF/, '');
  return ext === 'xml' ? xmlToText(source) : htmlToText(source);
}
