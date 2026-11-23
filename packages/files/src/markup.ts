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
import { noteReadCut } from './read-cut-sink';
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
  return xmlRead([[xml, xml.length]], Infinity)?.text ?? htmlToText(xml);
}

/** A window of a markup file: its text and the byte where it ends. */
type Window = [text: string, end: number];

/** A read of markup: its text, and the bytes it read before the text cap. */
type MarkupRead = { text: string; bytes: number };

/** XML windows to text through one streaming parser, or null when the
 *  bytes are no well-formed XML (the HTML scanner reads them then). */
function xmlRead(windows: Iterable<Window>, maxChars: number): MarkupRead | null {
  const lines: string[] = [];
  let chars = 0;
  let current = '';
  const end = () => {
    const line = current.replace(/\s+/g, ' ').trim();
    if (line) {
      lines.push(line);
      chars += line.length + 1;
    }
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
  let bytes = 0;
  try {
    for (const [text, at] of windows) {
      parser.write(text);
      bytes = at;
      if (chars >= maxChars) break;
    }
    if (chars < maxChars) parser.close();
  } catch {
    return null;
  }
  end();
  return { text: lines.join('\n'), bytes };
}

/** HTML windows to text, a window at a time. */
function htmlRead(windows: Iterable<Window>, maxChars: number): MarkupRead {
  const parts: string[] = [];
  let chars = 0;
  let bytes = 0;
  for (const [text, at] of windows) {
    const part = htmlToText(text);
    if (part) {
      parts.push(part);
      chars += part.length + 1;
    }
    bytes = at;
    if (chars >= maxChars) break;
  }
  return { text: parts.join('\n'), bytes };
}

/** A markup file is read in windows of this many bytes (a window is one
 *  string in the parse job, never the whole file: uploads go to 512 MB). */
const MARKUP_WINDOW_BYTES = 32 * 1024 * 1024;

/** The text a markup read keeps: it goes back in the parser's answer
 *  (96 MB), so the read stops past it and the cut is said on the file
 *  (read_cut `markup_bytes`: the bytes read of all). Tags are most of a
 *  page, so this is far more text than any document holds. */
const MAX_MARKUP_TEXT_CHARS = 32 * 1024 * 1024;

/** The windows of a markup file. Each ends just before a `<` (between
 *  tags, and never inside a UTF-8 character, as `<` is one byte), or at the
 *  end of the file. A UTF-8 BOM is dropped. */
function* windowsOf(bytes: Buffer): Generator<Window> {
  let at = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (at < bytes.length) {
    let end = Math.min(bytes.length, at + MARKUP_WINDOW_BYTES);
    if (end < bytes.length) {
      const lt = bytes.lastIndexOf(0x3c, end - 1);
      if (lt > at) end = lt;
    }
    yield [bytes.toString('utf8', at, end), end];
    at = end;
  }
}

/** File-ingest entry: `.xml` takes the XML reader, everything else the HTML
 *  scanner. The whole file is read, as a stream of windows (the ingest
 *  program); only the text cap stops it, and that cut is said on the file. */
export function parseMarkupBytes(bytes: Buffer, ext: string): string {
  const read =
    (ext === 'xml' ? xmlRead(windowsOf(bytes), MAX_MARKUP_TEXT_CHARS) : null) ??
    htmlRead(windowsOf(bytes), MAX_MARKUP_TEXT_CHARS);
  // The rest is not read: said on the file (./read-cut.ts). A read that
  // stopped early ends before the file (a file of a BOM alone reads 0).
  if (read.bytes > 0 && read.bytes < bytes.length) {
    noteReadCut('markup_bytes', {
      what: 'bytes',
      read: read.bytes,
      total: bytes.length,
      limit: MAX_MARKUP_TEXT_CHARS,
    });
  }
  return read.text;
}
